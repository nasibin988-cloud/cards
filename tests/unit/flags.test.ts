import { describe, it, expect, beforeEach } from 'vitest';
import {
  browseNotes,
  createDeck,
  createNote,
  cycleNoteFlag,
  setNoteFlag,
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

describe('note flags', () => {
  it('setNoteFlag persists and clears via undefined', async () => {
    const deck = await createDeck({ name: 'F' });
    const { note } = await createNote({ deckId: deck.id, fields: { front: 'q', back: 'a' } });

    await setNoteFlag(note.id, 'broken');
    let live = await db().notes.get(note.id);
    expect(live!.flag).toBe('broken');

    await setNoteFlag(note.id, undefined);
    live = await db().notes.get(note.id);
    expect(live!.flag).toBeUndefined();
  });

  it('cycleNoteFlag rotates through the canonical sequence', async () => {
    const deck = await createDeck({ name: 'F' });
    const { note } = await createNote({ deckId: deck.id, fields: { front: 'q', back: 'a' } });

    expect(await cycleNoteFlag(note.id)).toBe('revisit');
    expect(await cycleNoteFlag(note.id)).toBe('broken');
    expect(await cycleNoteFlag(note.id)).toBe('exemplar');
    expect(await cycleNoteFlag(note.id)).toBe('errata');
    expect(await cycleNoteFlag(note.id)).toBeUndefined();
    expect(await cycleNoteFlag(note.id)).toBe('revisit');
  });

  it('browseNotes filters by flags', async () => {
    const deck = await createDeck({ name: 'F' });
    const { note: a } = await createNote({ deckId: deck.id, fields: { front: 'A', back: 'a' } });
    const { note: b } = await createNote({ deckId: deck.id, fields: { front: 'B', back: 'b' } });
    const { note: c } = await createNote({ deckId: deck.id, fields: { front: 'C', back: 'c' } });

    await setNoteFlag(a.id, 'broken');
    await setNoteFlag(b.id, 'exemplar');
    // c stays unflagged

    const broken = await browseNotes(deck.id, { flags: ['broken'] });
    expect(broken.map(n => n.id)).toEqual([a.id]);

    const both = await browseNotes(deck.id, { flags: ['broken', 'exemplar'] });
    expect(both.map(n => n.id).sort()).toEqual([a.id, b.id].sort());

    // Unflagged is excluded when flags filter is set.
    expect(broken.map(n => n.id)).not.toContain(c.id);
  });
});
