import { describe, it, expect, beforeEach } from 'vitest';
import {
  createDeck,
  createNote,
  listCardsByNote,
  updateNote,
} from '@/lib/db/queries';
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

describe('sibling cards on basic notes', () => {
  it('creates one card per sibling on note creation', async () => {
    const deck = await createDeck({ name: 'S' });
    const { note } = await createNote({
      deckId: deck.id,
      fields: { front: 'word', back: 'def' },
      siblings: [
        { id: 'fwd', frontField: 'front', backField: 'back', label: 'word→def' },
        { id: 'rev', frontField: 'back', backField: 'front', label: 'def→word' },
      ],
    });
    const cards = await listCardsByNote(note.id);
    expect(cards).toHaveLength(2);
    expect(new Set(cards.map(c => c.siblingId))).toEqual(new Set(['fwd', 'rev']));
  });

  it('updateNote adds new siblings and drops removed ones', async () => {
    const deck = await createDeck({ name: 'S' });
    const { note } = await createNote({
      deckId: deck.id,
      fields: { front: 'word', back: 'def' },
      siblings: [
        { id: 'fwd', frontField: 'front', backField: 'back' },
      ],
    });
    expect((await listCardsByNote(note.id))).toHaveLength(1);

    await updateNote(note.id, {
      siblings: [
        { id: 'fwd', frontField: 'front', backField: 'back' },
        { id: 'rev', frontField: 'back', backField: 'front' },
      ],
    });
    const after = await listCardsByNote(note.id);
    expect(after).toHaveLength(2);
    expect(new Set(after.map(c => c.siblingId))).toEqual(new Set(['fwd', 'rev']));

    await updateNote(note.id, {
      siblings: [{ id: 'fwd', frontField: 'front', backField: 'back' }],
    });
    const final = await listCardsByNote(note.id);
    expect(final).toHaveLength(1);
    expect(final[0].siblingId).toBe('fwd');
  });

  it('passing siblings: [] collapses back to a single bare card', async () => {
    const deck = await createDeck({ name: 'S' });
    const { note } = await createNote({
      deckId: deck.id,
      fields: { front: 'word', back: 'def' },
      siblings: [
        { id: 'fwd', frontField: 'front', backField: 'back' },
        { id: 'rev', frontField: 'back', backField: 'front' },
      ],
    });

    await updateNote(note.id, { siblings: [] });
    const after = await listCardsByNote(note.id);
    expect(after).toHaveLength(1);
    expect(after[0].siblingId).toBeUndefined();
  });

  it('promoting a single-card note to siblings drops the lone bare card', async () => {
    const deck = await createDeck({ name: 'S' });
    const { note } = await createNote({
      deckId: deck.id,
      fields: { front: 'word', back: 'def' },
    });
    const before = await listCardsByNote(note.id);
    expect(before).toHaveLength(1);
    expect(before[0].siblingId).toBeUndefined();

    await updateNote(note.id, {
      siblings: [
        { id: 'fwd', frontField: 'front', backField: 'back' },
        { id: 'rev', frontField: 'back', backField: 'front' },
      ],
    });
    const after = await listCardsByNote(note.id);
    expect(after).toHaveLength(2);
    expect(after.every(c => c.siblingId !== undefined)).toBe(true);
  });
});
