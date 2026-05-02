import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '@/lib/db/dexie';
import {
  countNewIntroductionsToday,
  countReviewsToday,
  createDeck,
  createNote,
  getNextCardForStudy,
  getScopeCapStatus,
  recordReview,
  updateDeck,
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

async function studyOnce(cardId: string) {
  const card = await db().cards.get(cardId);
  if (!card) throw new Error('card vanished');
  await recordReview(card, 3, 100);
}

describe('daily caps — counting', () => {
  it('counts a new-card introduction in today bucket', async () => {
    const d = await createDeck({ name: 'D' });
    const { cards } = await createNote({ deckId: d.id, fields: { front: 'Q', back: 'A' }, tags: [] });
    expect(await countNewIntroductionsToday([d.id])).toBe(0);
    await studyOnce(cards[0].id);
    expect(await countNewIntroductionsToday([d.id])).toBe(1);
  });

  it('does not count a learning-state review against either cap', async () => {
    const d = await createDeck({ name: 'D' });
    const { cards } = await createNote({ deckId: d.id, fields: { front: 'Q', back: 'A' }, tags: [] });
    // First review: pre-state is `new` → introduction.
    await studyOnce(cards[0].id);
    expect(await countNewIntroductionsToday([d.id])).toBe(1);
    expect(await countReviewsToday([d.id])).toBe(0);

    // Second review: pre-state is `learning` (since the card just left
    // `new`). Doesn't count toward either cap.
    await studyOnce(cards[0].id);
    expect(await countNewIntroductionsToday([d.id])).toBe(1);
    expect(await countReviewsToday([d.id])).toBe(0);
  });
});

describe('getNextCardForStudy — cap enforcement', () => {
  it('respects a leaf\'s newCardsPerDay cap and returns nothing once exhausted', async () => {
    const d = await createDeck({ name: 'D' });
    await updateDeck(d.id, { newCardsPerDay: 1 });
    const a = await createNote({ deckId: d.id, fields: { front: 'A1', back: '' }, tags: [] });
    await createNote({ deckId: d.id, fields: { front: 'B2', back: '' }, tags: [] });

    // Pick first new — should succeed.
    const first = await getNextCardForStudy(d.id);
    expect(first).toBeDefined();
    expect(first!.id).toBe(a.cards[0].id);

    // Burn the cap by reviewing it.
    await studyOnce(first!.id);
    // Now no new card should be admitted.
    const next = await getNextCardForStudy(d.id);
    expect(next).toBeUndefined();
  });

  it('parent cap binds across descendants when studying the parent', async () => {
    const parent = await createDeck({ name: 'P' });
    const child = await createDeck({ name: 'P::Child' });
    await updateDeck(parent.id, { newCardsPerDay: 1 });

    const a = await createNote({ deckId: child.id, fields: { front: 'A', back: '' }, tags: [] });
    await createNote({ deckId: child.id, fields: { front: 'B', back: '' }, tags: [] });

    // Studying the parent's full scope: the leaf's effective cap inherits 1
    // from parent. Pick one, burn it, expect no second.
    const first = await getNextCardForStudy([parent.id, child.id]);
    expect(first).toBeDefined();
    expect(first!.id).toBe(a.cards[0].id);
    await studyOnce(first!.id);

    const next = await getNextCardForStudy([parent.id, child.id]);
    expect(next).toBeUndefined();
  });

  it('leaf overrides parent cap when explicit', async () => {
    const parent = await createDeck({ name: 'P' });
    const child = await createDeck({ name: 'P::Child' });
    await updateDeck(parent.id, { newCardsPerDay: 1 });
    await updateDeck(child.id, { newCardsPerDay: 5 });

    await createNote({ deckId: child.id, fields: { front: 'A', back: '' }, tags: [] });
    await createNote({ deckId: child.id, fields: { front: 'B', back: '' }, tags: [] });

    // Studying the leaf alone: only the leaf's cap (5) applies.
    const a = await getNextCardForStudy(child.id);
    expect(a).toBeDefined();
    await studyOnce(a!.id);
    const b = await getNextCardForStudy(child.id);
    expect(b).toBeDefined(); // still allowed; cap is 5
  });

  it('more-restrictive-wins: leaf=5, parent=1, scoped to parent → parent wins', async () => {
    const parent = await createDeck({ name: 'P' });
    const child = await createDeck({ name: 'P::Child' });
    await updateDeck(parent.id, { newCardsPerDay: 1 });
    await updateDeck(child.id, { newCardsPerDay: 5 });

    await createNote({ deckId: child.id, fields: { front: 'A', back: '' }, tags: [] });
    await createNote({ deckId: child.id, fields: { front: 'B', back: '' }, tags: [] });

    const a = await getNextCardForStudy([parent.id, child.id]);
    expect(a).toBeDefined();
    await studyOnce(a!.id);
    // Now parent's cap (1) is exhausted even though leaf permits more.
    const b = await getNextCardForStudy([parent.id, child.id]);
    expect(b).toBeUndefined();
  });

  it('unrelated decks do not consume each other\'s caps', async () => {
    const p1 = await createDeck({ name: 'P1' });
    const p2 = await createDeck({ name: 'P2' });
    await updateDeck(p1.id, { newCardsPerDay: 1 });
    await updateDeck(p2.id, { newCardsPerDay: 1 });

    await createNote({ deckId: p1.id, fields: { front: '1', back: '' }, tags: [] });
    await createNote({ deckId: p2.id, fields: { front: '2', back: '' }, tags: [] });

    const a = await getNextCardForStudy(p1.id);
    expect(a).toBeDefined();
    await studyOnce(a!.id);
    expect(await getNextCardForStudy(p1.id)).toBeUndefined();
    // P2 still has headroom.
    expect(await getNextCardForStudy(p2.id)).toBeDefined();
  });
});

describe('getScopeCapStatus — binding constraint', () => {
  it('reports the most-restrictive headroom across the scope', async () => {
    const parent = await createDeck({ name: 'P' });
    const child = await createDeck({ name: 'P::C' });
    await updateDeck(parent.id, { newCardsPerDay: 50 });
    await updateDeck(child.id, { newCardsPerDay: 3 });

    const status = await getScopeCapStatus([parent.id, child.id]);
    // Most-restrictive headroom is the child's (3 - 0 = 3 vs parent's 50).
    expect(status.newCap).toBe(3);
    expect(status.newSource).toBe('P::C');
    expect(status.newUsed).toBe(0);
  });
});
