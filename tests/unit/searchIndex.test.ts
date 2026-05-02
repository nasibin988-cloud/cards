import { describe, it, expect, beforeEach } from 'vitest';
import {
  createDeck,
  createNote,
  deleteNote,
  searchNotes,
  updateNote,
} from '@/lib/db/queries';
import { rebuildIndex } from '@/lib/db/searchIndex';
import { db } from '@/lib/db/dexie';

beforeEach(async () => {
  const dbi = db();
  await dbi.transaction(
    'rw',
    [dbi.notes, dbi.cards, dbi.decks, dbi.reviewLogs, dbi.searchTokens],
    async () => {
      await Promise.all([
        dbi.notes.clear(),
        dbi.cards.clear(),
        dbi.decks.clear(),
        dbi.reviewLogs.clear(),
        dbi.searchTokens.clear(),
      ]);
    },
  );
});

describe('inverted-index search', () => {
  it('createNote indexes the note and searchNotes finds it', async () => {
    const d = await createDeck({ name: 'D' });
    const { note } = await createNote({
      deckId: d.id,
      fields: { front: 'mitochondria are the powerhouse', back: 'powerhouse of the cell' },
      tags: ['bio'],
    });
    const hits = await searchNotes('mitochondria');
    expect(hits.length).toBe(1);
    expect(hits[0].noteId).toBe(note.id);
  });

  it('requires every token to match (token intersection)', async () => {
    const d = await createDeck({ name: 'D' });
    await createNote({ deckId: d.id, fields: { front: 'mitochondria', back: 'cell' }, tags: [] });
    await createNote({ deckId: d.id, fields: { front: 'ribosome', back: 'protein' }, tags: [] });

    expect((await searchNotes('mitochondria cell')).length).toBe(1);
    // No note has both "ribosome" and "cell" tokens.
    expect((await searchNotes('ribosome cell')).length).toBe(0);
  });

  it('weights front matches above back matches', async () => {
    const d = await createDeck({ name: 'D' });
    const { note: a } = await createNote({
      deckId: d.id,
      fields: { front: 'enzymes catalyze reactions', back: 'biology' },
    });
    const { note: b } = await createNote({
      deckId: d.id,
      fields: { front: 'biology', back: 'enzymes catalyze reactions' },
    });
    const hits = await searchNotes('enzymes');
    expect(hits[0].noteId).toBe(a.id);
    expect(hits[1].noteId).toBe(b.id);
  });

  it('updateNote refreshes the postings', async () => {
    const d = await createDeck({ name: 'D' });
    const { note } = await createNote({ deckId: d.id, fields: { front: 'apple', back: '' } });
    expect((await searchNotes('apple')).length).toBe(1);
    expect((await searchNotes('orange')).length).toBe(0);

    await updateNote(note.id, { fields: { front: 'orange', back: '' } });
    expect((await searchNotes('orange')).length).toBe(1);
    expect((await searchNotes('apple')).length).toBe(0);
  });

  it('deleteNote removes the postings', async () => {
    const d = await createDeck({ name: 'D' });
    const { note } = await createNote({ deckId: d.id, fields: { front: 'unique', back: '' } });
    expect((await searchNotes('unique')).length).toBe(1);
    await deleteNote(note.id);
    expect((await searchNotes('unique')).length).toBe(0);
  });

  it('rebuildIndex rebuilds postings from scratch', async () => {
    const d = await createDeck({ name: 'D' });
    await createNote({ deckId: d.id, fields: { front: 'paris france', back: 'capital' } });
    // Wipe the index then rebuild.
    await db().searchTokens.clear();
    expect((await db().searchTokens.count())).toBe(0);
    await rebuildIndex();
    const hits = await searchNotes('paris');
    expect(hits.length).toBe(1);
  });

  it('lazy build: searching before any explicit indexing still works', async () => {
    const d = await createDeck({ name: 'D' });
    // Create note via low-level path that bypasses indexing
    // (simulating a fresh install with v3 data and v4 schema).
    const { note } = await createNote({ deckId: d.id, fields: { front: 'lazyterm', back: '' } });
    // Wipe the index so the lazy-build path fires on the next query.
    await db().searchTokens.clear();
    const hits = await searchNotes('lazyterm');
    expect(hits.length).toBe(1);
    expect(hits[0].noteId).toBe(note.id);
  });
});
