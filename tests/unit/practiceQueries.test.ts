import { describe, it, expect, beforeEach } from 'vitest';
import { createDeck, createNote, setNoteFlag } from '@/lib/db/queries';
import {
  createPracticeQuery,
  deletePracticeQuery,
  listPracticeQueries,
  resolvePracticeQuery,
  updatePracticeQuery,
} from '@/lib/practice/queries';
import { db } from '@/lib/db/dexie';

beforeEach(async () => {
  const dbi = db();
  await dbi.transaction(
    'rw',
    [dbi.notes, dbi.cards, dbi.decks, dbi.reviewLogs, dbi.practiceQueries],
    async () => {
      await Promise.all([
        dbi.notes.clear(),
        dbi.cards.clear(),
        dbi.decks.clear(),
        dbi.reviewLogs.clear(),
        dbi.practiceQueries.clear(),
      ]);
    },
  );
});

describe('practice queries CRUD', () => {
  it('create + list returns the saved query', async () => {
    const q = await createPracticeQuery({ name: 'Lapsed bio', query: 'tag:bio lapses>=3' });
    const list = await listPracticeQueries();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(q.id);
    expect(list[0].name).toBe('Lapsed bio');
  });

  it('update changes name + query, bumps modifiedAt', async () => {
    const q = await createPracticeQuery({ name: 'A', query: 'tag:a' });
    await new Promise(r => setTimeout(r, 5));
    await updatePracticeQuery(q.id, { name: 'B', query: 'tag:b' });
    const live = (await listPracticeQueries())[0];
    expect(live.name).toBe('B');
    expect(live.query).toBe('tag:b');
    expect(live.modifiedAt).toBeGreaterThanOrEqual(q.modifiedAt);
  });

  it('delete removes the saved query', async () => {
    const q = await createPracticeQuery({ name: 'X', query: 'tag:x' });
    await deletePracticeQuery(q.id);
    expect(await listPracticeQueries()).toHaveLength(0);
  });
});

describe('resolvePracticeQuery', () => {
  it('returns matching note ids when scoped to a deck', async () => {
    const deck = await createDeck({ name: 'D' });
    const { note: a } = await createNote({ deckId: deck.id, fields: { front: 'A', back: 'a' }, tags: ['enzymes'] });
    const { note: b } = await createNote({ deckId: deck.id, fields: { front: 'B', back: 'b' }, tags: ['lipids'] });
    await createNote({ deckId: deck.id, fields: { front: 'C', back: 'c' }, tags: ['carbs'] });

    const q = await createPracticeQuery({ name: 'Enzymes', query: 'tag:enzymes', deckId: deck.id });
    const ids = await resolvePracticeQuery(q);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
    expect(ids).toHaveLength(1);
  });

  it('searches across all decks when no deckId is set', async () => {
    const a = await createDeck({ name: 'A' });
    const b = await createDeck({ name: 'B' });
    const { note: n1 } = await createNote({ deckId: a.id, fields: { front: 'X', back: 'x' }, tags: ['hot'] });
    const { note: n2 } = await createNote({ deckId: b.id, fields: { front: 'Y', back: 'y' }, tags: ['hot'] });

    const q = await createPracticeQuery({ name: 'Hot', query: 'tag:hot' });
    const ids = await resolvePracticeQuery(q);
    expect(new Set(ids)).toEqual(new Set([n1.id, n2.id]));
  });

  it('respects flag operator', async () => {
    const deck = await createDeck({ name: 'D' });
    const { note: a } = await createNote({ deckId: deck.id, fields: { front: 'A', back: 'a' } });
    await createNote({ deckId: deck.id, fields: { front: 'B', back: 'b' } });
    await setNoteFlag(a.id, 'broken');

    const q = await createPracticeQuery({ name: 'Broken', query: 'flag:broken', deckId: deck.id });
    const ids = await resolvePracticeQuery(q);
    expect(ids).toEqual([a.id]);
  });
});
