/**
 * Media: blob storage + LRU object-URL cache.
 *
 * Cards store media (images, audio) as Blobs in the `media` Dexie table,
 * keyed by filename. Renderers resolve a filename → blob URL via
 * `getMediaUrl`. Each blob URL pins its underlying Blob in memory until
 * revoked, so an unbounded cache leaks bytes across long study sessions
 * with image-heavy decks. The LRU bounds memory continuously; a few major
 * lifecycle boundaries (snapshot restore, sign-out) call `releaseAllMediaUrls`
 * to wipe the cache cleanly.
 */

import { db } from './dexie';
import { id } from '@/lib/ulid';

/**
 * LRU object-URL cache. Map preserves insertion order, which we abuse by
 * delete-and-re-set on access to bubble recents to the back.
 *
 * Cap chosen empirically: 200 cards' worth of media is well past anything
 * the user will revisit in a session. On eviction we revoke so the GC can
 * reclaim the underlying Blob.
 */
const MEDIA_URL_CAP = 200;
const mediaUrlCache = new Map<string, string>();

function touch(filename: string, url: string) {
  mediaUrlCache.delete(filename);
  mediaUrlCache.set(filename, url);
  while (mediaUrlCache.size > MEDIA_URL_CAP) {
    const oldest = mediaUrlCache.keys().next();
    if (oldest.done) break;
    const oldKey = oldest.value;
    const oldUrl = mediaUrlCache.get(oldKey);
    if (oldUrl) URL.revokeObjectURL(oldUrl);
    mediaUrlCache.delete(oldKey);
  }
}

export async function getMediaUrl(filename: string): Promise<string | null> {
  const cached = mediaUrlCache.get(filename);
  if (cached) {
    touch(filename, cached);
    return cached;
  }
  const m = await db().media.where('filename').equals(filename).first();
  if (!m) return null;
  // Some imports stored Blobs without an inferred MIME (JSZip's `async('blob')`
  // can't guess from numeric zip-entry names like "0", "1", "2"). When the
  // blob has no type, `URL.createObjectURL` produces a URL the browser
  // refuses to render in `<img>`. Re-wrap with the row's `mimeType` so the
  // resulting URL serves the right Content-Type. Cheap; no copy needed.
  const blob = m.blob.type === m.mimeType ? m.blob : new Blob([m.blob], { type: m.mimeType });
  const url = URL.createObjectURL(blob);
  touch(filename, url);
  return url;
}

/**
 * Release every cached blob URL. Call from major lifecycle boundaries —
 * snapshot restore, deck delete, sign-out — so the next render starts from
 * a clean slate. Per-card eviction is handled automatically by the LRU.
 */
export function releaseAllMediaUrls() {
  for (const url of mediaUrlCache.values()) URL.revokeObjectURL(url);
  mediaUrlCache.clear();
}

/**
 * Drop the cached object-URL for a single filename. Caller must already have
 * (or be about to) update the underlying blob; existing `<img src>` references
 * to the revoked URL stay rendered until the consumer re-resolves it.
 *
 * Pair with `mediaChangedSignal()` so live `CardRenderer` / `OcclusionRenderer`
 * instances refresh their src.
 */
export function invalidateMediaUrl(filename: string): void {
  const cached = mediaUrlCache.get(filename);
  if (cached) {
    URL.revokeObjectURL(cached);
    mediaUrlCache.delete(filename);
  }
}

/** Test helper: read the current cache size without exposing it for writes. */
export function __mediaUrlCacheSize(): number {
  return mediaUrlCache.size;
}

/**
 * Broadcast a media-replacement so any rendered card with an `<img>` whose
 * filename appears in `filenames` re-resolves to the fresh blob URL. We use
 * a window CustomEvent rather than pulling Zustand into the queries module —
 * consumers that care subscribe directly.
 */
export function mediaChangedSignal(filenames: string[]): void {
  if (typeof window === 'undefined' || filenames.length === 0) return;
  window.dispatchEvent(new CustomEvent('cards:media-changed', {
    detail: { filenames },
  }));
}

/**
 * Replace the bytes of an existing media row identified by filename. If no
 * such row exists, create one. The cached object URL is revoked so the next
 * `getMediaUrl(filename)` returns a fresh URL pointing at the new bytes.
 *
 * Returns the previous Blob (if any) so callers can support undo.
 */
export async function replaceMediaByFilename(
  filename: string,
  blob: Blob,
  mimeType: string,
): Promise<{ previousBlob: Blob | null; previousMime: string | null }> {
  const dbi = db();
  const existing = await dbi.media.where('filename').equals(filename).first();
  if (existing) {
    const previousBlob = existing.blob;
    const previousMime = existing.mimeType;
    await dbi.media.update(existing.id, { blob, mimeType });
    invalidateMediaUrl(filename);
    return { previousBlob, previousMime };
  }
  await dbi.media.put({
    id: id(),
    filename,
    mimeType,
    blob,
  });
  invalidateMediaUrl(filename);
  return { previousBlob: null, previousMime: null };
}
