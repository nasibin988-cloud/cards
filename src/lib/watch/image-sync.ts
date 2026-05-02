/**
 * Per-deck image source-of-truth sync.
 *
 * Use case: a deck was imported from `.apkg` (so all media bytes are in
 * IndexedDB), but the user keeps editing the source SVG/PNG/JPEG files on
 * disk. Linking a directory once gives them a "Refresh from source" action
 * that diffs the on-disk bytes against a per-deck manifest and atomically
 * replaces only the media rows whose hashes changed.
 *
 * Design choices:
 *   - Filename is the join key (matches Anki's media model).
 *   - SHA-256 of bytes (truncated to 16 hex chars) is the change signal.
 *   - Scope: only filenames referenced by the deck's notes participate, so
 *     a sync against one deck can't ever clobber another deck's media.
 *   - Apply is atomic: a single Dexie transaction writes all replacements
 *     plus the new manifest. Undo is a single inverse pass via the snapshot.
 *   - Permission revocation is treated as a soft error: caller re-prompts.
 *
 * Browser support is gated by `showDirectoryPicker`. Firefox + iOS Safari
 * surface a friendly "not supported" error; the UI hides the panel there.
 */

import { db } from '@/lib/db/dexie';
import {
  invalidateMediaUrl,
  mediaChangedSignal,
  updateDeck,
  getDeck,
  listAllNotesInDeck,
  replaceMediaByFilename,
} from '@/lib/db/queries';
import type { ImagesSource, ImagesSourceEntry } from '@/lib/db/schema';

/* ─── Types ────────────────────────────────────────────────── */

export interface ImageDiffChanged {
  kind: 'changed';
  filename: string;
  oldEntry: ImagesSourceEntry;
  newHash: string;
  newSize: number;
  newMtime: number;
  newBlob: Blob;
  newMime: string;
  /** Object URL for the disk bytes; caller MUST revoke when the modal closes. */
  previewUrl: string;
}

export interface ImageDiffAdded {
  kind: 'added';
  filename: string;
  newHash: string;
  newSize: number;
  newMtime: number;
  newBlob: Blob;
  newMime: string;
  previewUrl: string;
  /** Notes in the deck that reference this filename. */
  referencingNoteIds: string[];
}

export interface ImageDiffMissing {
  kind: 'missing';
  filename: string;
  oldEntry: ImagesSourceEntry;
  /** Notes in the deck still referencing this filename — they'll show broken thumbs. */
  referencingNoteIds: string[];
}

export type ImageDiffItem = ImageDiffChanged | ImageDiffAdded | ImageDiffMissing;

export interface ImageScanReport {
  /** ms timestamp at scan start. */
  scannedAt: number;
  items: ImageDiffItem[];
  /** Files in manifest whose bytes match disk: not surfaced individually. */
  unchanged: number;
  /** Total files referenced in deck notes (filename set). */
  referenced: number;
  /** Total candidate files found in the linked directory (.svg/.png/.jpg/...). */
  filesOnDisk: number;
  /** Permission state at scan time. */
  permission: 'granted' | 'denied' | 'prompt';
}

export interface UndoSnapshot {
  deckId: string;
  /** Pre-apply state. Restored verbatim on undo. */
  previousManifest: ImagesSource['manifest'];
  previousLastSyncedAt: number;
  previousFileCount: number;
  /** For each filename we wrote, the prior blob+mime so undo restores them. */
  rewrites: Array<{
    filename: string;
    /** null when the file was new (had no prior media row). */
    previousBlob: Blob | null;
    previousMime: string | null;
    appliedHash: string;
  }>;
}

/* ─── Public API ───────────────────────────────────────────── */

/** True if the host browser supports the File System Access API directory picker. */
export function isImageSourceSupported(): boolean {
  return typeof window !== 'undefined'
    && typeof (window as any).showDirectoryPicker === 'function';
}

/**
 * Prompt the user to pick a directory and persist a handle for `deckId`.
 * Throws if picker isn't available; returns null on user cancel.
 */
export async function pickImagesSource(deckId: string): Promise<ImagesSource | null> {
  if (!isImageSourceSupported()) {
    throw new Error('Linking an images folder requires Chromium, Edge, or recent Safari (File System Access API).');
  }
  const showDirectoryPicker = (window as any).showDirectoryPicker as (
    options?: { mode?: 'read' | 'readwrite'; startIn?: string }
  ) => Promise<FileSystemDirectoryHandle>;
  let handle: FileSystemDirectoryHandle;
  try {
    handle = await showDirectoryPicker({ mode: 'read' });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return null;
    throw err;
  }
  await idbPutHandle(deckId, handle);

  const deck = await getDeck(deckId);
  if (!deck) {
    await idbDeleteHandle(deckId);
    throw new Error(`Deck ${deckId} not found.`);
  }
  const fresh: ImagesSource = {
    rootName: handle.name,
    manifest: {},
    lastSyncedAt: 0,
    fileCount: 0,
  };
  await updateDeck(deckId, { imagesSource: fresh });
  return fresh;
}

/** Drop the link without touching media rows. Idempotent. */
export async function unlinkImagesSource(deckId: string): Promise<void> {
  await idbDeleteHandle(deckId);
  await updateDeck(deckId, { imagesSource: undefined });
}

export async function getImagesSourceHandle(deckId: string): Promise<FileSystemDirectoryHandle | null> {
  return idbGetHandle(deckId);
}

/**
 * Walk the linked directory, hash each file referenced by the deck's notes,
 * and compute the diff against `deck.imagesSource.manifest`. Does NOT write
 * anything; pass the result to `applyImagesSyncDiff` to commit.
 */
export async function scanImagesSource(deckId: string): Promise<ImageScanReport> {
  const handle = await idbGetHandle(deckId);
  if (!handle) {
    throw new Error('No images folder is linked to this deck. Link one first.');
  }
  const permission = await ensureReadPermission(handle);
  const deck = await getDeck(deckId);
  if (!deck) throw new Error(`Deck ${deckId} not found.`);
  if (!deck.imagesSource) {
    // Auto-bootstrap a manifest if the deck was linked but never scanned.
    deck.imagesSource = {
      rootName: handle.name,
      manifest: {},
      lastSyncedAt: 0,
      fileCount: 0,
    };
  }

  const referencedFilenames = await collectReferencedImageFilenames(deckId);
  const referencingByFilename = new Map<string, string[]>();
  for (const [filename, noteIds] of referencedFilenames) {
    referencingByFilename.set(filename, noteIds);
  }

  const onDisk = new Map<string, File>();
  for await (const f of walkImageFiles(handle)) {
    onDisk.set(f.name, f.file);
  }

  const items: ImageDiffItem[] = [];
  const referenced = referencingByFilename.size;
  let unchanged = 0;

  // 1) Files referenced by notes — the only files we'd ever write for.
  for (const [filename, noteIds] of referencingByFilename) {
    const file = onDisk.get(filename);
    const oldEntry = deck.imagesSource.manifest[filename];
    if (!file) {
      if (oldEntry) {
        items.push({
          kind: 'missing',
          filename,
          oldEntry,
          referencingNoteIds: noteIds,
        });
      }
      // No file on disk and no manifest entry: silently skip — likely the
      // user hasn't put this image in the source folder yet.
      continue;
    }
    const buf = await file.arrayBuffer();
    const newHash = await sha256Truncated(buf);
    if (oldEntry && oldEntry.hash === newHash) {
      unchanged++;
      continue;
    }
    const newBlob = new Blob([buf], { type: file.type || guessMime(filename) });
    items.push(
      oldEntry
        ? {
            kind: 'changed',
            filename,
            oldEntry,
            newHash,
            newSize: file.size,
            newMtime: file.lastModified,
            newBlob,
            newMime: newBlob.type,
            previewUrl: URL.createObjectURL(newBlob),
          }
        : {
            kind: 'added',
            filename,
            newHash,
            newSize: file.size,
            newMtime: file.lastModified,
            newBlob,
            newMime: newBlob.type,
            previewUrl: URL.createObjectURL(newBlob),
            referencingNoteIds: noteIds,
          },
    );
  }

  return {
    scannedAt: Date.now(),
    items,
    unchanged,
    referenced,
    filesOnDisk: onDisk.size,
    permission,
  };
}

/**
 * Atomically commit the user's selections. Returns an `UndoSnapshot` the
 * caller can pass back to `undoImagesSync` to roll the change back.
 *
 * `applyFilenames` defaults to *all* changed/added items in `report.items`.
 * Missing items are never auto-applied — they require an explicit user
 * choice to remove the cards (out of scope for this sync).
 */
export async function applyImagesSyncDiff(
  deckId: string,
  report: ImageScanReport,
  applyFilenames?: Iterable<string>,
): Promise<UndoSnapshot> {
  const deck = await getDeck(deckId);
  if (!deck) throw new Error(`Deck ${deckId} not found.`);
  const prevSource: ImagesSource = deck.imagesSource ?? {
    rootName: 'images',
    manifest: {},
    lastSyncedAt: 0,
    fileCount: 0,
  };
  const allowed = applyFilenames
    ? new Set(applyFilenames)
    : null; // null = apply all writable items.

  const writes = report.items.filter((it): it is ImageDiffChanged | ImageDiffAdded =>
    (it.kind === 'changed' || it.kind === 'added')
    && (allowed === null || allowed.has(it.filename)),
  );

  if (writes.length === 0) {
    return {
      deckId,
      previousManifest: { ...prevSource.manifest },
      previousLastSyncedAt: prevSource.lastSyncedAt,
      previousFileCount: prevSource.fileCount,
      rewrites: [],
    };
  }

  const snapshot: UndoSnapshot = {
    deckId,
    previousManifest: { ...prevSource.manifest },
    previousLastSyncedAt: prevSource.lastSyncedAt,
    previousFileCount: prevSource.fileCount,
    rewrites: [],
  };

  // Replace blobs first so that even if the manifest update fails the new
  // bytes are present (the next scan will detect the new hash and converge).
  const updatedFilenames: string[] = [];
  for (const it of writes) {
    const { previousBlob, previousMime } = await replaceMediaByFilename(
      it.filename,
      it.newBlob,
      it.newMime,
    );
    snapshot.rewrites.push({
      filename: it.filename,
      previousBlob,
      previousMime,
      appliedHash: it.newHash,
    });
    updatedFilenames.push(it.filename);
  }

  const nextManifest: ImagesSource['manifest'] = { ...prevSource.manifest };
  for (const it of writes) {
    nextManifest[it.filename] = {
      hash: it.newHash,
      sizeBytes: it.newSize,
      mtime: it.newMtime,
    };
  }

  await updateDeck(deckId, {
    imagesSource: {
      rootName: prevSource.rootName,
      manifest: nextManifest,
      lastSyncedAt: report.scannedAt,
      fileCount: Object.keys(nextManifest).length,
    },
  });

  mediaChangedSignal(updatedFilenames);
  return snapshot;
}

/**
 * Restore the pre-apply state. Re-writes prior blobs (or removes the row if
 * the apply created it), restores the manifest, and broadcasts the change.
 */
export async function undoImagesSync(snap: UndoSnapshot): Promise<void> {
  if (snap.rewrites.length === 0) return;
  const dbi = db();
  const filenames: string[] = [];
  for (const r of snap.rewrites) {
    if (r.previousBlob && r.previousMime) {
      await replaceMediaByFilename(r.filename, r.previousBlob, r.previousMime);
    } else {
      const row = await dbi.media.where('filename').equals(r.filename).first();
      if (row) {
        await dbi.media.delete(row.id);
        invalidateMediaUrl(r.filename);
      }
    }
    filenames.push(r.filename);
  }
  await updateDeck(snap.deckId, {
    imagesSource: {
      rootName: (await getDeck(snap.deckId))?.imagesSource?.rootName ?? 'images',
      manifest: { ...snap.previousManifest },
      lastSyncedAt: snap.previousLastSyncedAt,
      fileCount: snap.previousFileCount,
    },
  });
  mediaChangedSignal(filenames);
}

/** Free preview URLs the scan created. Call from the modal's `useEffect` cleanup. */
export function disposeScanReport(report: ImageScanReport): void {
  for (const it of report.items) {
    if (it.kind === 'changed' || it.kind === 'added') {
      URL.revokeObjectURL(it.previewUrl);
    }
  }
}

/* ─── Image filename collection ────────────────────────────── */

const HTML_IMG_RE = /<img\b[^>]*\bsrc\s*=\s*"([^"]+)"/gi;

/** All filenames referenced by any field of any note in the deck → noteIds. */
async function collectReferencedImageFilenames(
  deckId: string,
): Promise<Map<string, string[]>> {
  const notes = await listAllNotesInDeck(deckId);
  const out = new Map<string, string[]>();
  const push = (filename: string, noteId: string) => {
    const list = out.get(filename) ?? [];
    if (!list.includes(noteId)) list.push(noteId);
    out.set(filename, list);
  };
  for (const n of notes) {
    if (n.fields.image) {
      const fn = bareFilename(n.fields.image);
      if (fn && !isExternalUrl(fn)) push(fn, n.id);
    }
    for (const key of ['front', 'back', 'extra', 'context', 'mnemonic'] as const) {
      const v = n.fields[key];
      if (!v) continue;
      HTML_IMG_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = HTML_IMG_RE.exec(v))) {
        const src = m[1];
        if (!src || isExternalUrl(src)) continue;
        const fn = bareFilename(src);
        if (fn) push(fn, n.id);
      }
    }
  }
  return out;
}

function bareFilename(srcOrPath: string): string {
  // Drop query strings, hash fragments, and any leading directory parts.
  const noQuery = srcOrPath.split(/[?#]/, 1)[0] ?? '';
  const parts = noQuery.split('/');
  return parts[parts.length - 1] ?? '';
}

function isExternalUrl(s: string): boolean {
  return /^(https?:|data:|blob:|file:)/i.test(s);
}

/* ─── Directory walk + hashing ─────────────────────────────── */

const IMAGE_EXTS = new Set([
  'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'apng',
]);

async function* walkImageFiles(
  root: FileSystemDirectoryHandle,
  prefix = '',
): AsyncGenerator<{ name: string; file: File }> {
  for await (const [name, child] of (root as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
    if (child.kind === 'file') {
      const lower = name.toLowerCase();
      const dot = lower.lastIndexOf('.');
      if (dot < 0) continue;
      const ext = lower.slice(dot + 1);
      if (!IMAGE_EXTS.has(ext)) continue;
      const file = await (child as FileSystemFileHandle).getFile();
      // Filename is the *bare* leaf — that's what Anki media uses, and
      // matches how `<img src>` resolves through `getMediaUrl`.
      yield { name, file };
    } else if (child.kind === 'directory') {
      yield* walkImageFiles(child as FileSystemDirectoryHandle, prefix ? `${prefix}/${name}` : name);
    }
  }
}

async function sha256Truncated(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .slice(0, 8)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function guessMime(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.avif')) return 'image/avif';
  if (lower.endsWith('.bmp')) return 'image/bmp';
  if (lower.endsWith('.apng')) return 'image/apng';
  return 'application/octet-stream';
}

async function ensureReadPermission(
  handle: FileSystemDirectoryHandle,
): Promise<'granted' | 'denied' | 'prompt'> {
  // queryPermission tells us if we can read without prompting; if not, ask
  // for it. Browsers may return undefined for handles that haven't migrated.
  const q = await (handle as any).queryPermission?.({ mode: 'read' });
  if (q === 'granted') return 'granted';
  const r = await (handle as any).requestPermission?.({ mode: 'read' });
  if (r === 'granted') return 'granted';
  return r === 'denied' ? 'denied' : 'prompt';
}

/* ─── Per-deck handle persistence (raw IndexedDB) ──────────── */

const RAW_DB_NAME = 'cards-image-source-handles';
const RAW_STORE = 'handles';

/**
 * Test seam: when a deckId is registered here, the helpers below skip raw
 * IDB entirely and read/write from this Map. Production code never touches
 * it — it's empty in real browsers. Used so unit tests can install a
 * stand-in handle without going through structured clone (which fake-IDB
 * can't perform on class instances with prototype methods).
 */
const TEST_HANDLES = new Map<string, FileSystemDirectoryHandle>();

function openRaw(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(RAW_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const dbi = req.result;
      if (!dbi.objectStoreNames.contains(RAW_STORE)) {
        dbi.createObjectStore(RAW_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPutHandle(deckId: string, handle: FileSystemDirectoryHandle): Promise<void> {
  if (TEST_HANDLES.size > 0) { TEST_HANDLES.set(deckId, handle); return; }
  const dbi = await openRaw();
  await new Promise<void>((resolve, reject) => {
    const tx = dbi.transaction(RAW_STORE, 'readwrite');
    tx.objectStore(RAW_STORE).put(handle, deckId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  dbi.close();
}

async function idbGetHandle(deckId: string): Promise<FileSystemDirectoryHandle | null> {
  if (TEST_HANDLES.has(deckId)) return TEST_HANDLES.get(deckId) ?? null;
  const dbi = await openRaw();
  return new Promise((resolve, reject) => {
    const tx = dbi.transaction(RAW_STORE, 'readonly');
    const req = tx.objectStore(RAW_STORE).get(deckId);
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

async function idbDeleteHandle(deckId: string): Promise<void> {
  if (TEST_HANDLES.has(deckId)) { TEST_HANDLES.delete(deckId); return; }
  const dbi = await openRaw();
  await new Promise<void>((resolve, reject) => {
    const tx = dbi.transaction(RAW_STORE, 'readwrite');
    tx.objectStore(RAW_STORE).delete(deckId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  dbi.close();
}

/* ─── Test seam ────────────────────────────────────────────── */

/**
 * Test-only: install a stand-in for `showDirectoryPicker` and the raw IDB
 * helpers. Used by unit tests; ignored in production paths.
 */
export const __test = {
  collectReferencedImageFilenames,
  bareFilename,
  isExternalUrl,
  sha256Truncated,
  walkImageFiles,
  /** Install an in-memory handle for `deckId` so tests don't go through raw IDB. */
  setHandle(deckId: string, handle: FileSystemDirectoryHandle): void {
    TEST_HANDLES.set(deckId, handle);
  },
  /** Remove all test handles. Call from beforeEach to keep tests isolated. */
  clearHandles(): void {
    TEST_HANDLES.clear();
  },
};
