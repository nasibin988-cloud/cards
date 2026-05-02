import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '@/lib/db/dexie';
import { id as ulid } from '@/lib/ulid';
import {
  createDeck,
  createNote,
  getDeck,
  getMediaUrl,
  invalidateMediaUrl,
  replaceMediaByFilename,
  updateDeck,
} from '@/lib/db/queries';
import {
  applyImagesSyncDiff,
  scanImagesSource,
  undoImagesSync,
  __test as imageSyncInternals,
} from '@/lib/watch/image-sync';

const { bareFilename, isExternalUrl, sha256Truncated, collectReferencedImageFilenames } = imageSyncInternals;

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
  // Drop the in-memory test seam between runs.
  imageSyncInternals.clearHandles();
});

/* ─── A minimal in-memory FileSystemDirectoryHandle stand-in. ─────
   Browsers expose `entries()`, `getFile`, `kind`, `name`, plus
   `queryPermission`/`requestPermission`. We implement just what
   image-sync.ts touches.
   ────────────────────────────────────────────────────────────── */

class FakeFile {
  constructor(
    public name: string,
    public bytes: Uint8Array,
    public lastModified: number = Date.now(),
    public type: string = 'image/svg+xml',
  ) {}
  get size() { return this.bytes.byteLength; }
  arrayBuffer() {
    // Slice into a fresh ArrayBuffer so callers can't mutate our copy.
    return Promise.resolve(this.bytes.slice().buffer);
  }
}

class FakeFileHandle {
  kind: 'file' = 'file' as const;
  constructor(public name: string, public file: FakeFile) {}
  getFile() { return Promise.resolve(this.file); }
}

class FakeDirHandle {
  kind: 'directory' = 'directory' as const;
  private children: Map<string, FakeFileHandle | FakeDirHandle> = new Map();
  constructor(public name: string) {}
  put(name: string, file: FakeFile) {
    this.children.set(name, new FakeFileHandle(name, file));
  }
  remove(name: string) {
    this.children.delete(name);
  }
  async *entries(): AsyncIterableIterator<[string, FakeFileHandle | FakeDirHandle]> {
    for (const [k, v] of this.children) yield [k, v];
  }
  queryPermission() { return Promise.resolve('granted'); }
  requestPermission() { return Promise.resolve('granted'); }
}

/** Install a FakeDirHandle via the module's test seam (no raw IDB). */
function installFakeHandle(deckId: string, handle: FakeDirHandle) {
  imageSyncInternals.setHandle(deckId, handle as unknown as FileSystemDirectoryHandle);
}

const utf8 = (s: string) => new TextEncoder().encode(s);

/* ─── Tests ──────────────────────────────────────────────────── */

describe('image-sync internals', () => {
  it('bareFilename strips paths, query strings, hash fragments', () => {
    expect(bareFilename('foo/bar/baz.svg')).toBe('baz.svg');
    expect(bareFilename('baz.svg?v=2')).toBe('baz.svg');
    expect(bareFilename('baz.svg#frag')).toBe('baz.svg');
    expect(bareFilename('baz.svg')).toBe('baz.svg');
  });

  it('isExternalUrl recognizes the right schemes', () => {
    expect(isExternalUrl('https://x.com/a.png')).toBe(true);
    expect(isExternalUrl('http://x/a')).toBe(true);
    expect(isExternalUrl('data:image/png;base64,xxxx')).toBe(true);
    expect(isExternalUrl('blob:foo')).toBe(true);
    expect(isExternalUrl('a.svg')).toBe(false);
    expect(isExternalUrl('/media/a.svg')).toBe(false);
  });

  it('sha256Truncated is stable and content-addressed', async () => {
    const a = await sha256Truncated(utf8('hello').buffer);
    const b = await sha256Truncated(utf8('hello').buffer);
    const c = await sha256Truncated(utf8('hello!').buffer);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('collectReferencedImageFilenames', () => {
  it('finds note.fields.image and <img src> across fields, ignoring external URLs', async () => {
    const { id: deckId } = await createDeck({ name: 'D' });
    await createNote({
      deckId,
      fields: {
        front: 'see <img src="diagram.svg"> and <img src="/media/local.png">',
        back: '<img src="https://x/skip.png"> still here <img src="data:foo">',
        image: 'cover.jpg',
      },
      tags: [],
    });
    await createNote({
      deckId,
      fields: {
        front: '<img src="diagram.svg"> shared',
        back: '',
        extra: '<img src="extra-only.webp">',
      },
      tags: [],
    });
    const map = await collectReferencedImageFilenames(deckId);
    expect(new Set(map.keys())).toEqual(new Set([
      'cover.jpg', 'diagram.svg', 'local.png', 'extra-only.webp',
    ]));
    expect(map.get('diagram.svg')!.length).toBe(2);
    expect(map.get('cover.jpg')!.length).toBe(1);
  });
});

describe('scan + apply + undo', () => {
  it('reports changed/added/missing correctly and excludes unchanged', async () => {
    const { id: deckId } = await createDeck({ name: 'MCAT' });
    // Three notes: two reference distinct images; one references a third.
    await createNote({
      deckId,
      fields: { front: '<img src="ch01.svg">', back: '' },
      tags: [],
    });
    await createNote({
      deckId,
      fields: { front: '<img src="ch02.png">', back: '' },
      tags: [],
    });
    await createNote({
      deckId,
      fields: { front: '<img src="ch03.svg">', back: '' },
      tags: [],
    });

    // Seed media with prior bytes for ch01 (we'll claim it's "changed"),
    // ch02 (we'll claim it's "unchanged"), and leave ch03 absent.
    const oldCh01 = utf8('<svg>old ch01</svg>');
    const oldCh02 = utf8('PNG-old-ch02');
    await db().media.put({ id: ulid(), filename: 'ch01.svg', mimeType: 'image/svg+xml', blob: new Blob([oldCh01]) });
    await db().media.put({ id: ulid(), filename: 'ch02.png', mimeType: 'image/png', blob: new Blob([oldCh02]) });

    // Bootstrap a manifest matching those bytes so ch02 reads as unchanged
    // when the disk file matches.
    const oldHash01 = await sha256Truncated(oldCh01.buffer);
    const oldHash02 = await sha256Truncated(oldCh02.buffer);
    await updateDeck(deckId, {
      imagesSource: {
        rootName: 'images',
        manifest: {
          'ch01.svg': { hash: oldHash01, sizeBytes: oldCh01.byteLength, mtime: 0 },
          'ch02.png': { hash: oldHash02, sizeBytes: oldCh02.byteLength, mtime: 0 },
        },
        lastSyncedAt: 0,
        fileCount: 2,
      },
    });

    const root = new FakeDirHandle('images');
    // ch01: changed bytes
    root.put('ch01.svg', new FakeFile('ch01.svg', utf8('<svg>NEW ch01</svg>'), 1000, 'image/svg+xml'));
    // ch02: same bytes — unchanged
    root.put('ch02.png', new FakeFile('ch02.png', oldCh02, 2000, 'image/png'));
    // ch03: present on disk, no media row yet — added
    root.put('ch03.svg', new FakeFile('ch03.svg', utf8('<svg>fresh ch03</svg>'), 3000, 'image/svg+xml'));
    // Stray non-image file should be skipped entirely
    root.put('readme.md', new FakeFile('readme.md', utf8('hi'), 0, 'text/markdown'));

    await installFakeHandle(deckId, root);

    const report = await scanImagesSource(deckId);
    expect(report.unchanged).toBe(1);
    expect(report.referenced).toBe(3);
    expect(report.permission).toBe('granted');

    const kinds = report.items.reduce<Record<string, string[]>>((acc, it) => {
      (acc[it.kind] ??= []).push(it.filename);
      return acc;
    }, {});
    expect(kinds.changed).toEqual(['ch01.svg']);
    expect(kinds.added).toEqual(['ch03.svg']);
    expect(kinds.missing ?? []).toEqual([]);
  });

  it('apply rewrites blobs and updates manifest atomically; undo restores', async () => {
    const { id: deckId } = await createDeck({ name: 'D' });
    await createNote({ deckId, fields: { front: '<img src="img.svg">', back: '' }, tags: [] });

    const oldBytes = utf8('OLD');
    await db().media.put({ id: ulid(), filename: 'img.svg', mimeType: 'image/svg+xml', blob: new Blob([oldBytes]) });
    const oldHash = await sha256Truncated(oldBytes.buffer);
    await updateDeck(deckId, {
      imagesSource: {
        rootName: 'images',
        manifest: { 'img.svg': { hash: oldHash, sizeBytes: oldBytes.byteLength, mtime: 0 } },
        lastSyncedAt: 1,
        fileCount: 1,
      },
    });

    const newBytes = utf8('NEW-and-larger');
    const root = new FakeDirHandle('images');
    root.put('img.svg', new FakeFile('img.svg', newBytes, 1234, 'image/svg+xml'));
    await installFakeHandle(deckId, root);

    const report = await scanImagesSource(deckId);
    expect(report.items.length).toBe(1);
    const newHash = await sha256Truncated(newBytes.buffer);
    const snap = await applyImagesSyncDiff(deckId, report);

    // After apply: media row exists, manifest hash matches the new bytes.
    const after = await db().media.where('filename').equals('img.svg').first();
    expect(after).toBeTruthy();
    const deckAfter = await getDeck(deckId);
    expect(deckAfter?.imagesSource?.manifest['img.svg'].hash).toBe(newHash);
    expect(deckAfter?.imagesSource?.manifest['img.svg'].sizeBytes).toBe(newBytes.byteLength);
    expect(deckAfter?.imagesSource?.fileCount).toBe(1);
    expect(deckAfter?.imagesSource?.lastSyncedAt).toBe(report.scannedAt);

    // After undo: manifest restored to the prior hash + lastSyncedAt.
    await undoImagesSync(snap);
    const deckRestored = await getDeck(deckId);
    expect(deckRestored?.imagesSource?.manifest['img.svg'].hash).toBe(oldHash);
    expect(deckRestored?.imagesSource?.lastSyncedAt).toBe(1);
    // And the snapshot recorded the prior blob (so undo had something to put back).
    expect(snap.rewrites.length).toBe(1);
    expect(snap.rewrites[0].previousBlob).not.toBeNull();
    expect(snap.rewrites[0].appliedHash).toBe(newHash);
  });

  it('apply respects the user selection — unselected items are not written', async () => {
    const { id: deckId } = await createDeck({ name: 'D' });
    await createNote({ deckId, fields: { front: '<img src="a.svg"><img src="b.svg">', back: '' }, tags: [] });

    const aOld = utf8('Aold'), bOld = utf8('Bold');
    await db().media.put({ id: ulid(), filename: 'a.svg', mimeType: 'image/svg+xml', blob: new Blob([aOld]) });
    await db().media.put({ id: ulid(), filename: 'b.svg', mimeType: 'image/svg+xml', blob: new Blob([bOld]) });
    await updateDeck(deckId, {
      imagesSource: {
        rootName: 'images',
        manifest: {
          'a.svg': { hash: await sha256Truncated(aOld.buffer), sizeBytes: aOld.byteLength, mtime: 0 },
          'b.svg': { hash: await sha256Truncated(bOld.buffer), sizeBytes: bOld.byteLength, mtime: 0 },
        },
        lastSyncedAt: 0,
        fileCount: 2,
      },
    });

    const root = new FakeDirHandle('images');
    root.put('a.svg', new FakeFile('a.svg', utf8('Anew'), 1, 'image/svg+xml'));
    root.put('b.svg', new FakeFile('b.svg', utf8('Bnew'), 1, 'image/svg+xml'));
    await installFakeHandle(deckId, root);

    const report = await scanImagesSource(deckId);
    // Only apply the change for 'a.svg'.
    await applyImagesSyncDiff(deckId, report, ['a.svg']);

    const aNewHash = await sha256Truncated(utf8('Anew').buffer);
    const bOldHash = await sha256Truncated(bOld.buffer);
    const deckAfter = await getDeck(deckId);
    expect(deckAfter?.imagesSource?.manifest['a.svg'].hash).toBe(aNewHash);
    // b's manifest entry stays at the old hash because the user didn't select it.
    expect(deckAfter?.imagesSource?.manifest['b.svg'].hash).toBe(bOldHash);
  });

  it('reports a manifest entry as missing when the file disappears from disk', async () => {
    const { id: deckId } = await createDeck({ name: 'D' });
    await createNote({ deckId, fields: { front: '<img src="gone.svg">', back: '' }, tags: [] });
    const oldBytes = utf8('OLD');
    await db().media.put({ id: ulid(), filename: 'gone.svg', mimeType: 'image/svg+xml', blob: new Blob([oldBytes]) });
    await updateDeck(deckId, {
      imagesSource: {
        rootName: 'images',
        manifest: { 'gone.svg': { hash: await sha256Truncated(oldBytes.buffer), sizeBytes: oldBytes.byteLength, mtime: 0 } },
        lastSyncedAt: 0,
        fileCount: 1,
      },
    });

    const root = new FakeDirHandle('images');  // empty directory
    await installFakeHandle(deckId, root);

    const report = await scanImagesSource(deckId);
    const missing = report.items.find(i => i.kind === 'missing');
    expect(missing).toBeTruthy();
    expect((missing as any).filename).toBe('gone.svg');
    expect((missing as any).referencingNoteIds.length).toBe(1);
  });
});

describe('media URL cache invalidation on replace', () => {
  it('replaceMediaByFilename revokes the cached blob URL for that filename', async () => {
    const seedBytes = utf8('SEED');
    await db().media.put({ id: ulid(), filename: 'x.svg', mimeType: 'image/svg+xml', blob: new Blob([seedBytes]) });

    const url1 = await getMediaUrl('x.svg');
    expect(url1).toMatch(/^blob:/);
    const url1b = await getMediaUrl('x.svg');
    expect(url1b).toBe(url1); // cached

    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
    await replaceMediaByFilename('x.svg', new Blob([utf8('NEW')]), 'image/svg+xml');
    expect(revokeSpy).toHaveBeenCalledWith(url1);

    const url2 = await getMediaUrl('x.svg');
    expect(url2).not.toBe(url1);
    revokeSpy.mockRestore();
  });

  it('invalidateMediaUrl is a no-op when no URL was cached', () => {
    expect(() => invalidateMediaUrl('never-resolved.svg')).not.toThrow();
  });
});
