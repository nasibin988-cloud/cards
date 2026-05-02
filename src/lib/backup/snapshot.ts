/**
 * Local backup: dump every Dexie table (decks/notes/cards/reviewLogs/media/
 * settings) into a single JSON-LD-style structure, plus base64-encoded media
 * blobs. Restore reverses it.
 *
 * Lightweight on purpose: a single file, no compression. The user can save it
 * to Drive or wherever. For media-heavy decks, ~1MB per 100 images; OK.
 */

import { db } from '@/lib/db/dexie';
import { releaseAllMediaUrls } from '@/lib/db/queries';
import { clearRenderCache } from '@/lib/cloze/parser';
import type { Card, Deck, Media, Note, ReviewLog, Setting } from '@/lib/db/schema';

export interface Snapshot {
  version: 1;
  exportedAt: number;
  decks: Deck[];
  notes: Note[];
  cards: Card[];
  reviewLogs: ReviewLog[];
  settings: Setting[];
  media: Array<{ id: string; filename: string; mimeType: string; base64: string }>;
}

export async function exportSnapshot(): Promise<Snapshot> {
  const dbi = db();
  const [decks, notes, cards, reviewLogs, settings, media] = await Promise.all([
    dbi.decks.toArray(),
    dbi.notes.toArray(),
    dbi.cards.toArray(),
    dbi.reviewLogs.toArray(),
    dbi.settings.toArray(),
    dbi.media.toArray(),
  ]);
  const mediaEncoded = await Promise.all(
    media.map(async m => ({
      id: m.id,
      filename: m.filename,
      mimeType: m.mimeType,
      base64: await blobToBase64(m.blob),
    })),
  );
  return {
    version: 1,
    exportedAt: Date.now(),
    decks, notes, cards, reviewLogs, settings,
    media: mediaEncoded,
  };
}

export async function importSnapshot(snap: Snapshot, mode: 'merge' | 'replace' = 'replace'): Promise<void> {
  // Drop all cached blob URLs first — every URL points at the *old* Media
  // table's Blobs which we're about to replace. Existing <img src="blob:…">
  // references still render until the next re-resolve, but they'd
  // otherwise pin the old blobs in memory.
  releaseAllMediaUrls();
  // Drop rendered-card HTML cache; restored notes have different text so
  // existing entries are dead weight. (LRU would evict them eventually,
  // but a clean wipe avoids the next 100 renders cache-missing.)
  clearRenderCache();

  const dbi = db();
  await dbi.transaction(
    'rw',
    [dbi.decks, dbi.notes, dbi.cards, dbi.reviewLogs, dbi.settings, dbi.media],
    async () => {
      if (mode === 'replace') {
        await Promise.all([
          dbi.decks.clear(), dbi.notes.clear(), dbi.cards.clear(),
          dbi.reviewLogs.clear(), dbi.settings.clear(), dbi.media.clear(),
        ]);
      }
      if (snap.decks.length) await dbi.decks.bulkPut(snap.decks);
      if (snap.notes.length) await dbi.notes.bulkPut(snap.notes);
      if (snap.cards.length) await dbi.cards.bulkPut(snap.cards);
      if (snap.reviewLogs.length) await dbi.reviewLogs.bulkPut(snap.reviewLogs);
      if (snap.settings.length) await dbi.settings.bulkPut(snap.settings);
      if (snap.media.length) {
        const restored: Media[] = await Promise.all(
          snap.media.map(async m => ({
            id: m.id,
            filename: m.filename,
            mimeType: m.mimeType,
            blob: await base64ToBlob(m.base64, m.mimeType),
          })),
        );
        await dbi.media.bulkPut(restored);
      }
    },
  );
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = '';
  // Chunk to avoid call-stack issues on very large blobs.
  const CHUNK = 32768;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function base64ToBlob(b64: string, mime: string): Promise<Blob> {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

const LAST_AUTO_KEY = 'cards-last-auto-backup-ms';
const ONE_DAY_MS = 86_400_000;

/**
 * Run a daily auto-backup if the last one was > 24h ago. Saves to OPFS
 * (browser-local origin-private filesystem), where it survives across
 * service-worker reloads but doesn't get evicted on a normal cache flush.
 */
export async function maybeRunDailyBackup(): Promise<{ ran: boolean }> {
  const last = parseInt(localStorage.getItem(LAST_AUTO_KEY) ?? '0', 10);
  if (Date.now() - last < ONE_DAY_MS) return { ran: false };

  // OPFS may not be available (Safari < 17). Fall back silently.
  if (!('storage' in navigator) || !('getDirectory' in navigator.storage)) {
    return { ran: false };
  }
  try {
    const dir = await navigator.storage.getDirectory();
    const filename = `cards-backup-${new Date().toISOString().split('T')[0]}.json`;
    const handle = await dir.getFileHandle(filename, { create: true });
    const writable = await handle.createWritable();
    const snap = await exportSnapshot();
    await writable.write(JSON.stringify(snap));
    await writable.close();
    // Keep only the 7 most recent.
    const entries: Array<[string, FileSystemFileHandle]> = [];
    for await (const [name, h] of (dir as any).entries()) {
      if (typeof name === 'string' && name.startsWith('cards-backup-') && h.kind === 'file') {
        entries.push([name, h as FileSystemFileHandle]);
      }
    }
    entries.sort(([a], [b]) => b.localeCompare(a));
    for (const [name] of entries.slice(7)) {
      try { await dir.removeEntry(name); } catch { /* ignore */ }
    }
    localStorage.setItem(LAST_AUTO_KEY, String(Date.now()));
    return { ran: true };
  } catch {
    return { ran: false };
  }
}

/** List backups stored in OPFS (most-recent first). */
export async function listBackups(): Promise<Array<{ name: string; size: number; modified: number }>> {
  if (!('storage' in navigator) || !('getDirectory' in navigator.storage)) return [];
  const dir = await navigator.storage.getDirectory();
  const out: Array<{ name: string; size: number; modified: number }> = [];
  for await (const [name, handle] of (dir as any).entries()) {
    if (handle.kind !== 'file' || !name.startsWith('cards-backup-')) continue;
    const file = await (handle as FileSystemFileHandle).getFile();
    out.push({ name, size: file.size, modified: file.lastModified });
  }
  out.sort((a, b) => b.modified - a.modified);
  return out;
}

export async function readBackup(name: string): Promise<Snapshot> {
  const dir = await navigator.storage.getDirectory();
  const handle = await dir.getFileHandle(name);
  const file = await handle.getFile();
  return JSON.parse(await file.text()) as Snapshot;
}

/**
 * Diff a snapshot against the current Dexie state. Used by the restore UI
 * so the user can see exactly what they'd gain (rows in the snapshot but
 * not in current) and lose (rows in current but not in the snapshot).
 *
 * Identity is by `id` per table; we don't compare row contents — just
 * presence — because most "did I lose work" questions reduce to count
 * deltas. A field-level diff would help for rare cases but adds noise.
 */
export interface SnapshotDiff {
  decks: { added: number; removed: number; current: number; snapshot: number };
  notes: { added: number; removed: number; current: number; snapshot: number };
  cards: { added: number; removed: number; current: number; snapshot: number };
  reviewLogs: { added: number; removed: number; current: number; snapshot: number };
  media: { added: number; removed: number; current: number; snapshot: number };
  /** Names of decks that exist in current but not in the snapshot. Up to 5 — UI hint. */
  deckNamesLost: string[];
  /** Names of decks present in the snapshot but not in current — would be re-added. */
  deckNamesGained: string[];
}

export async function diffSnapshot(snap: Snapshot): Promise<SnapshotDiff> {
  const dbi = (await import('@/lib/db/dexie')).db();
  const [decks, notes, cards, reviewLogs, media] = await Promise.all([
    dbi.decks.toArray(),
    dbi.notes.toArray(),
    dbi.cards.toArray(),
    dbi.reviewLogs.toArray(),
    dbi.media.toArray(),
  ]);
  function tally<A extends { id: string }, B extends { id: string }>(curr: A[], snapRows: B[]) {
    const c = new Set(curr.map(x => x.id));
    const s = new Set(snapRows.map(x => x.id));
    let added = 0, removed = 0;
    for (const id of s) if (!c.has(id)) added++;
    for (const id of c) if (!s.has(id)) removed++;
    return { added, removed, current: c.size, snapshot: s.size };
  }
  const decksTally = tally(decks, snap.decks);
  // For decks, also surface the *names* on each side (limited) so the UI
  // can render "you'd lose Biology::Ch01, Ch02 …" without a separate query.
  const currentDeckIds = new Set(decks.map(d => d.id));
  const snapDeckIds = new Set(snap.decks.map(d => d.id));
  const deckNamesLost = decks
    .filter(d => !snapDeckIds.has(d.id))
    .slice(0, 5)
    .map(d => d.name);
  const deckNamesGained = snap.decks
    .filter(d => !currentDeckIds.has(d.id))
    .slice(0, 5)
    .map(d => d.name);

  return {
    decks: decksTally,
    notes: tally(notes, snap.notes),
    cards: tally(cards, snap.cards),
    reviewLogs: tally(reviewLogs, snap.reviewLogs),
    media: tally(media, snap.media),
    deckNamesLost,
    deckNamesGained,
  };
}
