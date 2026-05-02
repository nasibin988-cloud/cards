import { describe, it, expect, beforeEach } from 'vitest';
import {
  createDeck,
  createNote,
  searchNotes,
  browseNotes,
  listAllTags,
  listTagsInDeck,
  recordReview,
} from '@/lib/db/queries';
import { db } from '@/lib/db/dexie';
import { buildDeckTree } from '@/lib/decks/tree';
import type { Deck } from '@/lib/db/schema';

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
        dbi.media.clear(),
        dbi.settings.clear(),
      ]);
    },
  );
});

describe('searchNotes', () => {
  it('finds notes by front text', async () => {
    const deck = await createDeck({ name: 'D' });
    await createNote({ deckId: deck.id, fields: { front: 'parietal lobe attention', back: '' } });
    await createNote({ deckId: deck.id, fields: { front: 'temporal lobe memory', back: '' } });
    const hits = await searchNotes('parietal');
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet).toContain('parietal');
  });

  it('finds notes by tag', async () => {
    const deck = await createDeck({ name: 'D' });
    await createNote({ deckId: deck.id, fields: { front: 'something', back: '' }, tags: ['biochem'] });
    const hits = await searchNotes('biochem');
    expect(hits).toHaveLength(1);
  });

  it('requires all tokens to match somewhere', async () => {
    const deck = await createDeck({ name: 'D' });
    await createNote({ deckId: deck.id, fields: { front: 'parietal lobe', back: 'spatial attention' } });
    expect(await searchNotes('parietal spatial')).toHaveLength(1);
    expect(await searchNotes('parietal occipital')).toHaveLength(0);
  });

  it('weights front matches higher than back matches', async () => {
    const deck = await createDeck({ name: 'D' });
    const a = await createNote({ deckId: deck.id, fields: { front: 'occipital', back: 'irrelevant' } });
    const b = await createNote({ deckId: deck.id, fields: { front: 'irrelevant', back: 'occipital' } });
    const hits = await searchNotes('occipital');
    expect(hits[0].noteId).toBe(a.note.id);
    expect(hits[1].noteId).toBe(b.note.id);
  });

  it('ignores 1-character tokens', async () => {
    const deck = await createDeck({ name: 'D' });
    await createNote({ deckId: deck.id, fields: { front: 'short', back: '' } });
    expect(await searchNotes('a')).toHaveLength(0);
  });
});

describe('browseNotes filters', () => {
  it('filters by tier', async () => {
    const deck = await createDeck({ name: 'D' });
    await createNote({ deckId: deck.id, fields: { front: 'core fact', back: '' }, tier: 'core' });
    await createNote({ deckId: deck.id, fields: { front: 'advanced fact', back: '' }, tier: 'advanced' });
    const out = await browseNotes(deck.id, { tier: 'core' });
    expect(out).toHaveLength(1);
    expect(out[0].fields.front).toBe('core fact');
  });

  it('filters by tag (any-of)', async () => {
    const deck = await createDeck({ name: 'D' });
    await createNote({ deckId: deck.id, fields: { front: 'a', back: '' }, tags: ['x', 'y'] });
    await createNote({ deckId: deck.id, fields: { front: 'b', back: '' }, tags: ['z'] });
    expect((await browseNotes(deck.id, { tags: ['x'] }))).toHaveLength(1);
    expect((await browseNotes(deck.id, { tags: ['x', 'z'] }))).toHaveLength(2);
  });

  it('filters by state via the joined cards table', async () => {
    const deck = await createDeck({ name: 'D' });
    const { cards } = await createNote({ deckId: deck.id, fields: { front: 'q', back: 'a' } });
    expect((await browseNotes(deck.id, { states: ['new'] }))).toHaveLength(1);
    expect((await browseNotes(deck.id, { states: ['review'] }))).toHaveLength(0);

    await db().cards.update(cards[0].id, { state: 'review' });
    expect((await browseNotes(deck.id, { states: ['review'] }))).toHaveLength(1);
  });

  it('filters by lapses ≥ N', async () => {
    const deck = await createDeck({ name: 'D' });
    const { cards: a } = await createNote({ deckId: deck.id, fields: { front: 'low', back: '' } });
    const { cards: b } = await createNote({ deckId: deck.id, fields: { front: 'high', back: '' } });
    await db().cards.update(a[0].id, { lapses: 1 });
    await db().cards.update(b[0].id, { lapses: 5 });

    expect((await browseNotes(deck.id, { hasLapses: 1 }))).toHaveLength(2);
    expect((await browseNotes(deck.id, { hasLapses: 3 }))).toHaveLength(1);
    expect((await browseNotes(deck.id, { hasLapses: 10 }))).toHaveLength(0);
  });

  it('filters by free-text query', async () => {
    const deck = await createDeck({ name: 'D' });
    await createNote({ deckId: deck.id, fields: { front: 'parietal cortex', back: '' } });
    await createNote({ deckId: deck.id, fields: { front: 'occipital cortex', back: '' } });
    expect((await browseNotes(deck.id, { query: 'parietal' }))).toHaveLength(1);
  });
});

describe('listAllTags / listTagsInDeck', () => {
  it('returns sorted unique tags', async () => {
    const a = await createDeck({ name: 'A' });
    const b = await createDeck({ name: 'B' });
    await createNote({ deckId: a.id, fields: { front: '1', back: '' }, tags: ['z', 'x'] });
    await createNote({ deckId: a.id, fields: { front: '2', back: '' }, tags: ['x', 'y'] });
    await createNote({ deckId: b.id, fields: { front: '3', back: '' }, tags: ['only-b'] });

    expect(await listAllTags()).toEqual(['only-b', 'x', 'y', 'z']);
    expect(await listTagsInDeck(a.id)).toEqual(['x', 'y', 'z']);
    expect(await listTagsInDeck(b.id)).toEqual(['only-b']);
  });
});

describe('buildDeckTree', () => {
  it('groups Anki "::" hierarchical names into a tree', () => {
    const decks: Deck[] = [
      makeDeck('1', 'MCAT::Bio::Ch01'),
      makeDeck('2', 'MCAT::Bio::Ch02'),
      makeDeck('3', 'MCAT::Chem::Ch01'),
      makeDeck('4', 'Persian::Verbs'),
    ];
    const tree = buildDeckTree(decks);
    expect(tree.map(n => n.displayName)).toEqual(['MCAT', 'Persian']);
    const mcat = tree[0];
    expect(mcat.children.map(n => n.displayName)).toEqual(['Bio', 'Chem']);
    expect(mcat.children[0].children.map(n => n.displayName)).toEqual(['Ch01', 'Ch02']);
    // Leaves carry the actual deck reference.
    expect(mcat.children[0].children[0].deck?.id).toBe('1');
  });

  it('flat decks become flat tree', () => {
    const tree = buildDeckTree([
      makeDeck('a', 'Apple'),
      makeDeck('b', 'Banana'),
    ]);
    expect(tree).toHaveLength(2);
    expect(tree.every(n => n.children.length === 0)).toBe(true);
    expect(tree[0].deck?.id).toBe('a');
  });

  it('synthesized parent nodes have deck=null but still aggregate children', () => {
    const tree = buildDeckTree([
      makeDeck('1', 'Outer::Inner'),
    ]);
    expect(tree[0].deck).toBe(null);   // "Outer" was never a real deck
    expect(tree[0].children[0].deck?.id).toBe('1');
  });
});

function makeDeck(id: string, name: string): Deck {
  const t = Date.now();
  return { id, name, createdAt: t, modifiedAt: t };
}
