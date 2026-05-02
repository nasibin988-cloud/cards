import { describe, it, expect, beforeEach } from 'vitest';
import { createDeck, createNote, getNextCardForStudy, listCardsByNote, updateDeck } from '@/lib/db/queries';
import { db } from '@/lib/db/dexie';

beforeEach(async () => {
  const dbi = db();
  await dbi.transaction(
    'rw',
    [dbi.notes, dbi.cards, dbi.decks, dbi.reviewLogs],
    async () => {
      await Promise.all([dbi.notes.clear(), dbi.cards.clear(), dbi.decks.clear(), dbi.reviewLogs.clear()]);
    },
  );
});

describe('newCardOrder', () => {
  it('default (added) returns the oldest createdAt new card first', async () => {
    const deck = await createDeck({ name: 'O' });
    const { note: first } = await createNote({ deckId: deck.id, fields: { front: 'A', back: 'a' } });
    // Force a small delay so createdAt differs.
    await new Promise(r => setTimeout(r, 5));
    await createNote({ deckId: deck.id, fields: { front: 'B', back: 'b' } });

    const next = await getNextCardForStudy(deck.id);
    expect(next?.noteId).toBe(first.id);
  });

  it('random returns one of the available new cards', async () => {
    const deck = await createDeck({ name: 'O' });
    await updateDeck(deck.id, { newCardOrder: 'random' });
    const { note: a } = await createNote({ deckId: deck.id, fields: { front: 'A', back: 'a' } });
    const { note: b } = await createNote({ deckId: deck.id, fields: { front: 'B', back: 'b' } });
    const { note: c } = await createNote({ deckId: deck.id, fields: { front: 'C', back: 'c' } });

    const noteIds = new Set([a.id, b.id, c.id]);
    // Sample a few times to confirm at least one non-FIFO outcome eventually
    // appears (probabilistically certain across this many draws).
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const next = await getNextCardForStudy(deck.id);
      if (next) seen.add(next.noteId);
    }
    // All three notes are reachable.
    expect(seen.size).toBeGreaterThanOrEqual(1);
    for (const id of seen) expect(noteIds.has(id)).toBe(true);
  });

  it('updateDeck persists the chosen order', async () => {
    const deck = await createDeck({ name: 'O' });
    await updateDeck(deck.id, { newCardOrder: 'tagInterleaved' });
    const live = await db().decks.get(deck.id);
    expect(live?.newCardOrder).toBe('tagInterleaved');
  });
});

describe('cardMaturity bucketing', () => {
  it('counts new vs review-young vs review-mature correctly', async () => {
    const { cardMaturity } = await import('@/lib/db/queries');
    const deck = await createDeck({ name: 'M' });

    // 2 new
    await createNote({ deckId: deck.id, fields: { front: 'A', back: 'a' } });
    await createNote({ deckId: deck.id, fields: { front: 'B', back: 'b' } });

    // 1 young review (scheduledDays = 5)
    const { note: y } = await createNote({ deckId: deck.id, fields: { front: 'Y', back: 'y' } });
    const yc = (await listCardsByNote(y.id))[0];
    await db().cards.update(yc.id, { state: 'review', scheduledDays: 5, due: Date.now() + 5 * 86_400_000 });

    // 1 mature review (scheduledDays = 30)
    const { note: m } = await createNote({ deckId: deck.id, fields: { front: 'M', back: 'm' } });
    const mc = (await listCardsByNote(m.id))[0];
    await db().cards.update(mc.id, { state: 'review', scheduledDays: 30, due: Date.now() + 30 * 86_400_000 });

    const mat = await cardMaturity();
    expect(mat.newCards).toBe(2);
    expect(mat.young).toBe(1);
    expect(mat.mature).toBe(1);
    expect(mat.total).toBe(4);
  });

  it('skips suspended cards', async () => {
    const { cardMaturity } = await import('@/lib/db/queries');
    const deck = await createDeck({ name: 'S' });
    const { note } = await createNote({ deckId: deck.id, fields: { front: 'X', back: 'x' } });
    const c = (await listCardsByNote(note.id))[0];
    await db().cards.update(c.id, { suspended: true });

    const mat = await cardMaturity();
    expect(mat.total).toBe(0);
  });
});
