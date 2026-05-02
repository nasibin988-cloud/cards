/**
 * Folder watch mode for the V5 markdown card-block format.
 *
 * Built on the File System Access API (Chromium + Edge + recent Safari):
 * the user picks a directory once, we get a `FileSystemDirectoryHandle`,
 * and we can re-scan + diff at any time. We cannot get push events; we poll
 * on app focus or via an explicit "Sync now" button.
 *
 * Diff strategy:
 *   - Each card block in `.md` files gets a stable hash of its contents.
 *   - We store a watch index: `Map<filePath#blockIndex, { hash, noteId }>`.
 *   - On rescan: re-parse, re-hash, compare. New hash → upsert note. Same
 *     hash → skip. Missing hash (block deleted) → mark note as orphaned (we
 *     don't auto-delete; the user reviews orphans in the UI).
 */

import { db } from '@/lib/db/dexie';
import { parseBulk, type BulkDraft } from '@/lib/authoring/bulk-parse';
import { createNote, getJsonSetting, setJsonSetting, updateNote } from '@/lib/db/queries';

const WATCH_INDEX_KEY = 'watch_index';
const WATCH_HANDLE_KEY = 'watch_dir_handle';   // not stored as JSON; saved via IDB

interface WatchEntry {
  hash: string;
  noteId: string;
  filePath: string;
  blockIndex: number;
}

interface WatchIndex {
  deckId: string;
  entries: WatchEntry[];
  lastScanMs: number;
}

const ZERO_INDEX: WatchIndex = { deckId: '', entries: [], lastScanMs: 0 };

export interface ScanReport {
  filesScanned: number;
  notesAdded: number;
  notesUpdated: number;
  notesUnchanged: number;
  orphans: number;
  errors: Array<{ filePath: string; reason: string }>;
}

async function hashString(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .slice(0, 8)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function* walkDirectory(
  handle: FileSystemDirectoryHandle,
  prefix = '',
): AsyncGenerator<{ path: string; file: File }> {
  // The standard `entries()` returns name + handle pairs.
  for await (const [name, child] of (handle as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
    const fullPath = prefix ? `${prefix}/${name}` : name;
    if (child.kind === 'file') {
      if (!name.endsWith('.md')) continue;
      const file = await (child as FileSystemFileHandle).getFile();
      yield { path: fullPath, file };
    } else if (child.kind === 'directory') {
      yield* walkDirectory(child as FileSystemDirectoryHandle, fullPath);
    }
  }
}

export async function pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
  const showDirectoryPicker = (window as any).showDirectoryPicker;
  if (!showDirectoryPicker) {
    throw new Error('Folder watch requires Chromium, Edge, or Safari 17+. The File System Access API is not available in this browser.');
  }
  try {
    const handle: FileSystemDirectoryHandle = await showDirectoryPicker({
      mode: 'read',
    });
    await db().settings.put({ key: WATCH_HANDLE_KEY, value: 'set' });
    // Persist the handle in the same IndexedDB used by Dexie (Dexie tables
    // can't store FileSystemHandle directly; store under the raw IDB).
    await idbPutHandle(handle);
    return handle;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return null;
    throw err;
  }
}

export async function getStoredHandle(): Promise<FileSystemDirectoryHandle | null> {
  return idbGetHandle();
}

export async function rescan(
  handle: FileSystemDirectoryHandle,
  deckId: string,
): Promise<ScanReport> {
  const report: ScanReport = {
    filesScanned: 0,
    notesAdded: 0,
    notesUpdated: 0,
    notesUnchanged: 0,
    orphans: 0,
    errors: [],
  };

  // Verify we still have permission; request if not.
  const perm = await (handle as any).requestPermission?.({ mode: 'read' });
  if (perm && perm !== 'granted') {
    throw new Error('Folder access permission denied.');
  }

  const previousIndex = await getJsonSetting<WatchIndex>('watch_index', ZERO_INDEX);
  const previousByKey = new Map<string, WatchEntry>();
  for (const e of previousIndex.entries) {
    previousByKey.set(`${e.filePath}#${e.blockIndex}`, e);
  }

  const newEntries: WatchEntry[] = [];

  for await (const { path, file } of walkDirectory(handle)) {
    report.filesScanned++;
    let text: string;
    try {
      text = await file.text();
    } catch (err) {
      report.errors.push({ filePath: path, reason: String(err) });
      continue;
    }
    const { drafts, errors } = parseBulk(text);
    for (const e of errors) {
      report.errors.push({
        filePath: `${path}#${e.blockIndex}`,
        reason: e.reason,
      });
    }

    for (let i = 0; i < drafts.length; i++) {
      const d = drafts[i];
      const hash = await hashDraft(d);
      const key = `${path}#${i}`;
      const prev = previousByKey.get(key);

      if (prev && prev.hash === hash) {
        report.notesUnchanged++;
        newEntries.push(prev);
        previousByKey.delete(key);
        continue;
      }

      if (prev) {
        // Same slot, content changed → update existing note in place.
        try {
          await updateNote(prev.noteId, {
            fields: d.fields,
            tags: d.tags,
            tier: d.tier,
          });
          newEntries.push({ ...prev, hash });
          previousByKey.delete(key);
          report.notesUpdated++;
        } catch (err) {
          report.errors.push({
            filePath: key,
            reason: `update failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      } else {
        // New block → create.
        try {
          const { note } = await createNote({
            deckId,
            modelId: d.modelId,
            fields: d.fields,
            tags: d.tags,
            tier: d.tier,
          });
          newEntries.push({ hash, noteId: note.id, filePath: path, blockIndex: i });
          report.notesAdded++;
        } catch (err) {
          report.errors.push({
            filePath: key,
            reason: `create failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    }
  }

  // Anything left in `previousByKey` is an orphan (block disappeared).
  report.orphans = previousByKey.size;

  await setJsonSetting<WatchIndex>('watch_index', {
    deckId,
    entries: newEntries,
    lastScanMs: Date.now(),
  });

  return report;
}

async function hashDraft(d: BulkDraft): Promise<string> {
  const repr = JSON.stringify({
    fields: d.fields,
    tags: d.tags,
    tier: d.tier,
    modelId: d.modelId,
  });
  return hashString(repr);
}

/* ─── Persist FileSystemHandle in raw IndexedDB ────────────── */
/* IndexedDB CAN store FileSystemDirectoryHandle objects natively, but Dexie
   doesn't know how to clone them. Use a tiny separate object store. */

const RAW_DB_NAME = 'cards-watch-handles';
const RAW_STORE = 'handles';

function openRaw(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(RAW_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(RAW_STORE)) {
        db.createObjectStore(RAW_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPutHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const dbi = await openRaw();
  await new Promise<void>((resolve, reject) => {
    const tx = dbi.transaction(RAW_STORE, 'readwrite');
    tx.objectStore(RAW_STORE).put(handle, 'dir');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  dbi.close();
}

async function idbGetHandle(): Promise<FileSystemDirectoryHandle | null> {
  const dbi = await openRaw();
  return new Promise((resolve, reject) => {
    const tx = dbi.transaction(RAW_STORE, 'readonly');
    const req = tx.objectStore(RAW_STORE).get('dir');
    req.onsuccess = () => {
      dbi.close();
      resolve((req.result as FileSystemDirectoryHandle) ?? null);
    };
    req.onerror = () => {
      dbi.close();
      reject(req.error);
    };
  });
}

export async function clearWatch(): Promise<void> {
  const dbi = await openRaw();
  await new Promise<void>((resolve, reject) => {
    const tx = dbi.transaction(RAW_STORE, 'readwrite');
    tx.objectStore(RAW_STORE).delete('dir');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  dbi.close();
  await db().settings.delete('watch_index');
  await db().settings.delete(WATCH_HANDLE_KEY);
}

export async function getWatchInfo(): Promise<{
  deckId: string;
  lastScanMs: number;
  entries: number;
} | null> {
  const idx = await getJsonSetting<WatchIndex>('watch_index', ZERO_INDEX);
  if (!idx.deckId) return null;
  return {
    deckId: idx.deckId,
    lastScanMs: idx.lastScanMs,
    entries: idx.entries.length,
  };
}
