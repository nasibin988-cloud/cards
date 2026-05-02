import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '@/lib/db/dexie';
import {
  createDeck,
  createNote,
  deleteDeck,
  deleteDecks,
  getDeck,
  listDescendantDeckIds,
  listDecksAtOrUnderPath,
  recordReview,
  getNextCardForStudy,
} from '@/lib/db/queries';

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

describe('deleteDeck — cascades over the full subtree', () => {
  it('deleting a name-prefix parent removes every name-child too', async () => {
    const root = await createDeck({ name: 'Biology' });
    const ch01 = await createDeck({ name: 'Biology::Ch01' });
    const ch02 = await createDeck({ name: 'Biology::Ch02' });
    const sub  = await createDeck({ name: 'Biology::Ch02::Subsection' });
    const unrelated = await createDeck({ name: 'Chemistry' });

    await createNote({ deckId: ch01.id, fields: { front: 'Q', back: 'A' }, tags: [] });
    await createNote({ deckId: ch02.id, fields: { front: 'Q', back: 'A' }, tags: [] });
    await createNote({ deckId: sub.id, fields: { front: 'Q', back: 'A' }, tags: [] });
    await createNote({ deckId: unrelated.id, fields: { front: 'Q', back: 'A' }, tags: [] });

    await deleteDeck(root.id);

    expect(await getDeck(root.id)).toBeUndefined();
    expect(await getDeck(ch01.id)).toBeUndefined();
    expect(await getDeck(ch02.id)).toBeUndefined();
    expect(await getDeck(sub.id)).toBeUndefined();
    // Unrelated deck still intact.
    expect((await getDeck(unrelated.id))?.id).toBe(unrelated.id);

    // No orphaned notes/cards from the deleted decks.
    const remainingNotes = await db().notes.toArray();
    expect(remainingNotes.map(n => n.deckId)).toEqual([unrelated.id]);
    const remainingCards = await db().cards.toArray();
    expect(remainingCards.every(c => c.deckId === unrelated.id)).toBe(true);
  });

  it('deleting a deck removes its reviewLogs (so retention math stays clean)', async () => {
    const deck = await createDeck({ name: 'Solo' });
    const { cards } = await createNote({
      deckId: deck.id,
      fields: { front: 'Q', back: 'A' },
      tags: [],
    });
    const card = cards[0];
    const r1 = await recordReview(card, 3, 100);
    await recordReview(r1.updatedCard, 3, 100);

    expect((await db().reviewLogs.where('cardId').equals(card.id).count())).toBe(2);
    await deleteDeck(deck.id);
    expect((await db().reviewLogs.where('cardId').equals(card.id).count())).toBe(0);
  });

  it('deleting a parent with explicit parentId children cascades', async () => {
    const root = await createDeck({ name: 'A' });
    const child = await createDeck({ name: 'B' });
    // Manually link child via parentId (programmatic relationship, no `::`).
    await db().decks.update(child.id, { parentId: root.id });
    await createNote({ deckId: child.id, fields: { front: 'Q', back: 'A' }, tags: [] });

    await deleteDeck(root.id);
    expect(await getDeck(root.id)).toBeUndefined();
    expect(await getDeck(child.id)).toBeUndefined();
  });

  it('listDescendantDeckIds returns explicit + name children, walks transitively', async () => {
    const root = await createDeck({ name: 'MCAT' });
    const a = await createDeck({ name: 'MCAT::Biology' });
    const b = await createDeck({ name: 'MCAT::Biology::Ch01' });
    const c = await createDeck({ name: 'MCAT::Biology::Ch02' });
    await createDeck({ name: 'Spanish' });

    const desc = await listDescendantDeckIds(root.id);
    expect(new Set(desc)).toEqual(new Set([a.id, b.id, c.id]));

    const incl = await listDescendantDeckIds(root.id, { includeSelf: true });
    expect(new Set(incl)).toEqual(new Set([root.id, a.id, b.id, c.id]));
  });

  it('listDecksAtOrUnderPath supports virtual-parent deletion', async () => {
    // No explicit "MCAT" deck row — only leaves with that name prefix.
    const a = await createDeck({ name: 'MCAT::Biology::Ch01' });
    const b = await createDeck({ name: 'MCAT::Biology::Ch02' });
    await createDeck({ name: 'Persian' });

    const ids = await listDecksAtOrUnderPath('MCAT');
    expect(new Set(ids)).toEqual(new Set([a.id, b.id]));

    // And a deeper virtual parent.
    const ids2 = await listDecksAtOrUnderPath('MCAT::Biology');
    expect(new Set(ids2)).toEqual(new Set([a.id, b.id]));
  });

  it('deleteDecks removes a virtual-parent subtree (no actual root row)', async () => {
    const a = await createDeck({ name: 'MCAT::Biology::Ch01' });
    const b = await createDeck({ name: 'MCAT::Biology::Ch02' });
    const survivor = await createDeck({ name: 'Spanish' });
    await createNote({ deckId: a.id, fields: { front: 'Q', back: 'A' }, tags: [] });
    await createNote({ deckId: b.id, fields: { front: 'Q', back: 'A' }, tags: [] });

    const ids = await listDecksAtOrUnderPath('MCAT');
    await deleteDecks(ids);

    expect(await getDeck(a.id)).toBeUndefined();
    expect(await getDeck(b.id)).toBeUndefined();
    expect((await getDeck(survivor.id))?.id).toBe(survivor.id);

    // Notes and cards from the deleted decks are gone.
    const noteCount = await db().notes.toArray().then(ns => ns.length);
    expect(noteCount).toBe(0);
    const cardCount = await db().cards.toArray().then(cs => cs.length);
    expect(cardCount).toBe(0);
  });

  it('does not leave orphaned cards in the study queue after parent delete', async () => {
    const root = await createDeck({ name: 'Big' });
    const child = await createDeck({ name: 'Big::Inner' });
    await createNote({ deckId: child.id, fields: { front: 'Q', back: 'A' }, tags: [] });

    // Confirm a card was scheduled at the child level before delete.
    // (`getNextCardForStudy` does not auto-roll-up, so caller must enumerate.)
    const before = await getNextCardForStudy(child.id);
    expect(before).toBeDefined();

    await deleteDeck(root.id);

    const after = await getNextCardForStudy(child.id);
    expect(after).toBeUndefined();
    // Cards table should be empty.
    expect(await db().cards.count()).toBe(0);
  });

  it('is a no-op for a missing deck id', async () => {
    await expect(deleteDeck('does-not-exist')).resolves.toBeUndefined();
  });
});
