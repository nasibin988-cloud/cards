import { describe, it, expect, beforeEach } from 'vitest';
import { createDeck, createNote } from '@/lib/db/queries';
import {
  findInNotes,
  replaceInNotes,
  restoreSnapshot,
  snapshotScope,
} from '@/lib/db/find-replace';
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

async function seed() {
  const a = await createDeck({ name: 'A' });
  const b = await createDeck({ name: 'B' });
  const { note: n1 } = await createNote({ deckId: a.id, fields: { front: 'mitochondria', back: 'powerhouse of the cell' } });
  const { note: n2 } = await createNote({ deckId: a.id, fields: { front: 'cell wall', back: 'rigid layer of the cell' } });
  const { note: n3 } = await createNote({ deckId: b.id, fields: { front: 'plasma membrane', back: 'phospholipid bilayer' } });
  return { a, b, n1, n2, n3 };
}

describe('find / replace', () => {
  it('findInNotes finds case-insensitive matches by default', async () => {
    const { a } = await seed();
    const { matches } = await findInNotes('cell', { deckId: a.id });
    // Three (noteId, field) tuples contain "cell": n1 back, n2 front, n2 back.
    expect(matches.length).toBe(3);
    const fields = matches.map(m => m.field).sort();
    expect(fields).toEqual(['back', 'back', 'front']);
  });

  it('caseSensitive=true respects original casing', async () => {
    const { a } = await seed();
    const r1 = await findInNotes('Cell', { deckId: a.id, caseSensitive: true });
    expect(r1.matches.length).toBe(0);
    const r2 = await findInNotes('cell', { deckId: a.id, caseSensitive: true });
    expect(r2.matches.length).toBe(3);
  });

  it('regex flag enables pattern syntax', async () => {
    const { a } = await seed();
    const { matches } = await findInNotes('mit\\w+', { deckId: a.id, regex: true });
    expect(matches.length).toBe(1);
    expect(matches[0].field).toBe('front');
  });

  it('replaceInNotes mutates only the targeted scope', async () => {
    const { a, b } = await seed();
    const result = await replaceInNotes('cell', 'CELL', { deckId: a.id });
    expect(result.notesTouched).toBe(2);
    // Three "cell" occurrences across the two notes.
    expect(result.matchesReplaced).toBe(3);

    // Deck B unchanged.
    const dbi = db();
    const others = await dbi.notes.where('deckId').equals(b.id).toArray();
    expect(others.every(n => !n.fields.front.includes('CELL'))).toBe(true);
  });

  it('restoreSnapshot reverts a replace', async () => {
    const { a, n1 } = await seed();
    const snap = await snapshotScope({ deckId: a.id });
    await replaceInNotes('powerhouse', 'engine', { deckId: a.id });

    const dbi = db();
    let live = await dbi.notes.get(n1.id);
    expect(live!.fields.back).toContain('engine');

    await restoreSnapshot(snap);
    live = await dbi.notes.get(n1.id);
    expect(live!.fields.back).toContain('powerhouse');
  });

  it('searches all decks when no deckId is given', async () => {
    await seed();
    const { matches } = await findInNotes('membrane');
    expect(matches.length).toBe(1);
    expect(matches[0].field).toBe('front');
  });
});
