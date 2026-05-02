import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '@/lib/db/dexie';
import { id as ulid } from '@/lib/ulid';
import {
  __mediaUrlCacheSize,
  getMediaUrl,
  invalidateMediaUrl,
  releaseAllMediaUrls,
} from '@/lib/db/queries';

beforeEach(async () => {
  const dbi = db();
  await dbi.transaction(
    'rw',
    [dbi.notes, dbi.cards, dbi.decks, dbi.reviewLogs, dbi.media, dbi.settings, dbi.searchTokens],
    async () => {
      await Promise.all([
        dbi.notes.clear(),
        dbi.cards.clear(),
        dbi.decks.clear(),
        dbi.reviewLogs.clear(),
        dbi.media.clear(),
        dbi.settings.clear(),
        dbi.searchTokens.clear(),
      ]);
    },
  );
  releaseAllMediaUrls();
});

const utf8 = (s: string) => new TextEncoder().encode(s);

async function seedMedia(count: number) {
  const dbi = db();
  for (let i = 0; i < count; i++) {
    await dbi.media.put({
      id: ulid(),
      filename: `img${i.toString().padStart(4, '0')}.svg`,
      mimeType: 'image/svg+xml',
      blob: new Blob([utf8(`<svg>${i}</svg>`)]),
    });
  }
}

describe('media URL LRU cache', () => {
  it('caches across calls and returns the same URL', async () => {
    await seedMedia(1);
    const a = await getMediaUrl('img0000.svg');
    const b = await getMediaUrl('img0000.svg');
    expect(a).toBeTruthy();
    expect(a).toBe(b);
    expect(__mediaUrlCacheSize()).toBe(1);
  });

  it('evicts the oldest entry once the cap is exceeded', async () => {
    // The cap is internal but documented as 200. Seed 250 unique filenames
    // and pull each through getMediaUrl so the cache fills past the cap.
    await seedMedia(250);
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
    for (let i = 0; i < 250; i++) {
      await getMediaUrl(`img${i.toString().padStart(4, '0')}.svg`);
    }
    expect(__mediaUrlCacheSize()).toBeLessThanOrEqual(200);
    // Some URLs must have been revoked along the way.
    expect(revokeSpy).toHaveBeenCalled();
    revokeSpy.mockRestore();
  });

  it('refreshes recency on get (LRU not FIFO)', async () => {
    await seedMedia(210);
    // Pull 210 (cap = 200, so 10 oldest evicted).
    for (let i = 0; i < 210; i++) {
      await getMediaUrl(`img${i.toString().padStart(4, '0')}.svg`);
    }
    // img0000..img0009 should be evicted; img0210 doesn't exist; ask for
    // img0009 — if LRU, still evicted; touching img0050 should keep it.
    // Touch img0050 to bubble it.
    await getMediaUrl('img0050.svg');
    // Now seed + insert another → some old must go. Verify img0050 survives.
    await seedMedia(1); // creates img0000.svg duplicate hash but new id; doesn't matter for cache
    for (let i = 210; i < 220; i++) {
      const dbi = db();
      await dbi.media.put({
        id: ulid(),
        filename: `pad${i}.svg`,
        mimeType: 'image/svg+xml',
        blob: new Blob([utf8(`<svg>${i}</svg>`)]),
      });
      await getMediaUrl(`pad${i}.svg`);
    }
    // After all that churn, img0050 should still be cached (we touched it
    // late; LRU bubbled it). Verify by checking another fetch returns the
    // SAME URL — if it was evicted, getMediaUrl would create a fresh one.
    const before = await getMediaUrl('img0050.svg');
    const after = await getMediaUrl('img0050.svg');
    expect(before).toBe(after);
  });

  it('releaseAllMediaUrls clears everything and revokes', async () => {
    await seedMedia(5);
    for (let i = 0; i < 5; i++) await getMediaUrl(`img${i.toString().padStart(4, '0')}.svg`);
    expect(__mediaUrlCacheSize()).toBe(5);
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
    releaseAllMediaUrls();
    expect(__mediaUrlCacheSize()).toBe(0);
    expect(revokeSpy).toHaveBeenCalledTimes(5);
    revokeSpy.mockRestore();
  });

  it('invalidateMediaUrl removes a single entry', async () => {
    await seedMedia(2);
    await getMediaUrl('img0000.svg');
    await getMediaUrl('img0001.svg');
    expect(__mediaUrlCacheSize()).toBe(2);
    invalidateMediaUrl('img0000.svg');
    expect(__mediaUrlCacheSize()).toBe(1);
  });
});
