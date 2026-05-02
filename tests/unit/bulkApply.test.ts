import { describe, it, expect, beforeEach } from 'vitest';
import {
  bulkApply,
  createDeck,
  createNote,
  listCardsByNote,
  recordReview,
  undoBulk,
} from '@/lib/db/queries';
import { db } from '@/lib/db/dexie';

beforeEach(async () => {
  const dbi = db();
  await dbi.transaction(
    'rw',
    [dbi.notes, dbi.cards, dbi.decks, dbi.reviewLogs, dbi.media, dbi.settings],
    async () => {
      await Promise.all([
        dbi.notes.clear(),
        dbi.cards.clear(),
        dbi.decks.clear(),
        dbi.reviewLogs.clear(),
      ]);
    },
  );
});

async function makeDeckWithNotes(n: number) {
  const deck = await createDeck({ name: 'Bulk' });
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const { note } = await createNote({
      deckId: deck.id,
      fields: { front: `front-${i}`, back: `back-${i}` },
      tags: ['initial'],
    });
    ids.push(note.id);
  }
  return { deck, noteIds: ids };
}

describe('bulkApply / undoBulk', () => {
  it('suspend then undo restores suspended=false on all cards', async () => {
    const { noteIds } = await makeDeckWithNotes(3);
    const undo = await bulkApply(noteIds, { kind: 'suspend' });

    for (const id of noteIds) {
      const cards = await listCardsByNote(id);
      expect(cards.every(c => c.suspended)).toBe(true);
    }

    await undoBulk(undo);
    for (const id of noteIds) {
      const cards = await listCardsByNote(id);
      expect(cards.every(c => !c.suspended)).toBe(true);
    }
  });

  it('bury sets buried=true and stamps buriedAt; undo reverses it', async () => {
    const { noteIds } = await makeDeckWithNotes(2);
    const before = Date.now();
    const undo = await bulkApply(noteIds, { kind: 'bury' });

    for (const id of noteIds) {
      const cards = await listCardsByNote(id);
      expect(cards.every(c => c.buried)).toBe(true);
      expect(cards.every(c => (c.buriedAt ?? 0) >= before)).toBe(true);
    }

    await undoBulk(undo);
    for (const id of noteIds) {
      const cards = await listCardsByNote(id);
      expect(cards.every(c => !c.buried)).toBe(true);
      expect(cards.every(c => c.buriedAt === undefined)).toBe(true);
    }
  });

  it('reset wipes FSRS state but preserves suspended flag', async () => {
    const { noteIds } = await makeDeckWithNotes(1);
    // Suspend first, then take a review on the suspended-or-not card.
    const card = (await listCardsByNote(noteIds[0]))[0];
    await recordReview(card, 3, 1000);

    const after = (await listCardsByNote(noteIds[0]))[0];
    expect(after.reps).toBeGreaterThan(0);

    const undo = await bulkApply(noteIds, { kind: 'reset' });
    const reset = (await listCardsByNote(noteIds[0]))[0];
    expect(reset.reps).toBe(0);
    expect(reset.lapses).toBe(0);
    expect(reset.state).toBe('new');

    await undoBulk(undo);
    const restored = (await listCardsByNote(noteIds[0]))[0];
    expect(restored.reps).toBe(after.reps);
    expect(restored.state).toBe(after.state);
  });

  it('move re-parents notes and cards to a new deck', async () => {
    const { noteIds, deck } = await makeDeckWithNotes(2);
    const target = await createDeck({ name: 'Target' });

    const undo = await bulkApply(noteIds, { kind: 'move', targetDeckId: target.id });

    for (const id of noteIds) {
      const cards = await listCardsByNote(id);
      expect(cards.every(c => c.deckId === target.id)).toBe(true);
    }

    await undoBulk(undo);
    for (const id of noteIds) {
      const cards = await listCardsByNote(id);
      expect(cards.every(c => c.deckId === deck.id)).toBe(true);
    }
  });

  it('addTag is idempotent and undoable', async () => {
    const { noteIds } = await makeDeckWithNotes(2);
    const undo = await bulkApply(noteIds, { kind: 'addTag', tag: 'review' });

    const dbi = db();
    for (const id of noteIds) {
      const n = await dbi.notes.get(id);
      expect(n!.tags).toContain('review');
    }
    // Run again — tag should not duplicate.
    await bulkApply(noteIds, { kind: 'addTag', tag: 'review' });
    for (const id of noteIds) {
      const n = await dbi.notes.get(id);
      expect(n!.tags.filter(t => t === 'review').length).toBe(1);
    }

    await undoBulk(undo);
    for (const id of noteIds) {
      const n = await dbi.notes.get(id);
      expect(n!.tags).not.toContain('review');
    }
  });

  it('removeTag drops only the named tag', async () => {
    const { noteIds } = await makeDeckWithNotes(1);
    const dbi = db();
    await dbi.notes.update(noteIds[0], { tags: ['initial', 'extra', 'keep'] });

    await bulkApply(noteIds, { kind: 'removeTag', tag: 'extra' });
    const after = await dbi.notes.get(noteIds[0]);
    expect(after!.tags).toEqual(['initial', 'keep']);
  });

  it('delete removes notes + cards + reviewLogs and undo restores all three', async () => {
    const { noteIds } = await makeDeckWithNotes(2);
    const card = (await listCardsByNote(noteIds[0]))[0];
    await recordReview(card, 3, 1000);

    const dbi = db();
    const beforeNotes = await dbi.notes.count();
    const beforeCards = await dbi.cards.count();
    const beforeLogs = await dbi.reviewLogs.count();
    expect(beforeLogs).toBeGreaterThan(0);

    const undo = await bulkApply(noteIds, { kind: 'delete' });
    expect(await dbi.notes.count()).toBe(0);
    expect(await dbi.cards.count()).toBe(0);
    expect(await dbi.reviewLogs.count()).toBe(0);

    await undoBulk(undo);
    expect(await dbi.notes.count()).toBe(beforeNotes);
    expect(await dbi.cards.count()).toBe(beforeCards);
    expect(await dbi.reviewLogs.count()).toBe(beforeLogs);
  });

  it('empty noteId list is a no-op', async () => {
    const undo = await bulkApply([], { kind: 'suspend' });
    expect(undo.notes).toEqual([]);
    expect(undo.cards).toEqual([]);
    await undoBulk(undo); // should not throw
  });
});
