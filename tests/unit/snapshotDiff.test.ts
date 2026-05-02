import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '@/lib/db/dexie';
import {
  createDeck,
  createNote,
} from '@/lib/db/queries';
import { diffSnapshot, exportSnapshot } from '@/lib/backup/snapshot';

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
});

describe('diffSnapshot', () => {
  it('returns all-zero deltas when current === snapshot', async () => {
    const d = await createDeck({ name: 'D' });
    await createNote({ deckId: d.id, fields: { front: 'q', back: 'a' }, tags: [] });
    const snap = await exportSnapshot();
    const diff = await diffSnapshot(snap);
    expect(diff.decks.added).toBe(0);
    expect(diff.decks.removed).toBe(0);
    expect(diff.notes.added).toBe(0);
    expect(diff.notes.removed).toBe(0);
    expect(diff.cards.added).toBe(0);
  });

  it('counts removed when current has rows snapshot lacks', async () => {
    const d = await createDeck({ name: 'D' });
    await createNote({ deckId: d.id, fields: { front: 'before', back: 'a' }, tags: [] });
    const snap = await exportSnapshot();

    // Add MORE notes after snapshot — restoring would lose them.
    await createNote({ deckId: d.id, fields: { front: 'after-1', back: 'a' }, tags: [] });
    await createNote({ deckId: d.id, fields: { front: 'after-2', back: 'a' }, tags: [] });

    const diff = await diffSnapshot(snap);
    expect(diff.notes.removed).toBe(2);
    expect(diff.notes.added).toBe(0);
    expect(diff.notes.current).toBe(3);
    expect(diff.notes.snapshot).toBe(1);
  });

  it('counts added when snapshot has rows current lacks', async () => {
    const d = await createDeck({ name: 'D' });
    await createNote({ deckId: d.id, fields: { front: 'kept', back: 'a' }, tags: [] });
    await createNote({ deckId: d.id, fields: { front: 'will-be-restored', back: 'a' }, tags: [] });
    const snap = await exportSnapshot();

    // Delete a note after snapshot — restoring would re-add it.
    const notes = await db().notes.toArray();
    const target = notes.find(n => n.fields.front === 'will-be-restored')!;
    await db().notes.delete(target.id);

    const diff = await diffSnapshot(snap);
    expect(diff.notes.added).toBe(1);
    expect(diff.notes.removed).toBe(0);
  });

  it('lists deck names lost and gained (capped at 5)', async () => {
    // Build 7 decks, snapshot, then delete 2 → snapshot has 7, current has 5.
    const decks = [];
    for (let i = 0; i < 7; i++) {
      decks.push(await createDeck({ name: `D${i}` }));
    }
    const snap = await exportSnapshot();
    await db().decks.delete(decks[0].id);
    await db().decks.delete(decks[1].id);

    const diff = await diffSnapshot(snap);
    expect(diff.decks.added).toBe(2);
    expect(diff.deckNamesGained.length).toBeLessThanOrEqual(5);
    expect(diff.deckNamesGained.length).toBeGreaterThanOrEqual(2);
    // Names lost is empty here (we deleted, didn't add new).
    expect(diff.deckNamesLost).toEqual([]);
  });
});
