import { describe, it, expect } from 'vitest';
import { expectedRecall, buildForecast } from '@/lib/fsrs/forecast';
import { emptyCard } from '@/lib/fsrs/scheduler';
import { id } from '@/lib/ulid';
import type { Card, Deck } from '@/lib/db/schema';

function makeCard(overrides: Partial<Card> = {}): Card {
  const t = Date.now();
  const empty = emptyCard(new Date(t));
  return {
    id: id(),
    noteId: id(),
    deckId: id(),
    ...empty,
    suspended: false,
    buried: false,
    createdAt: t,
    modifiedAt: t,
    ...overrides,
  };
}

describe('forecast.expectedRecall', () => {
  it('returns null when the card has no lastReview', () => {
    expect(expectedRecall(makeCard(), new Date())).toBeNull();
  });

  it('returns 1 when target date is before lastReview (no time elapsed)', () => {
    const reviewedAt = Date.now();
    const c = makeCard({ state: 'review', stability: 30, lastReview: reviewedAt });
    expect(expectedRecall(c, new Date(reviewedAt - 1000))).toBe(1);
  });

  it('returns ~0.9 when target is one stability-day past review', () => {
    // R(t=S) = 0.9 exactly per the FSRS-5 default-retention formula.
    const reviewedAt = Date.now();
    const c = makeCard({ state: 'review', stability: 10, lastReview: reviewedAt });
    const target = new Date(reviewedAt + 10 * 86_400_000);
    const r = expectedRecall(c, target)!;
    expect(r).toBeGreaterThan(0.88);
    expect(r).toBeLessThan(0.92);
  });

  it('decays monotonically with elapsed time', () => {
    const reviewedAt = Date.now();
    const c = makeCard({ state: 'review', stability: 10, lastReview: reviewedAt });
    const r1 = expectedRecall(c, new Date(reviewedAt + 1 * 86_400_000))!;
    const r2 = expectedRecall(c, new Date(reviewedAt + 30 * 86_400_000))!;
    const r3 = expectedRecall(c, new Date(reviewedAt + 365 * 86_400_000))!;
    expect(r1).toBeGreaterThan(r2);
    expect(r2).toBeGreaterThan(r3);
  });
});

describe('forecast.buildForecast', () => {
  const deck: Deck = { id: 'D', name: 'TestDeck', createdAt: 0, modifiedAt: 0 };

  it('skips new + learning cards', () => {
    const cards = [
      makeCard({ state: 'new', deckId: deck.id }),
      makeCard({ state: 'learning', deckId: deck.id }),
    ];
    const s = buildForecast(cards, [deck], new Date(), 0.6);
    expect(s.cardsConsidered).toBe(0);
    expect(s.cardsSkipped).toBe(2);
    expect(s.byDeck).toHaveLength(0);
  });

  it('aggregates review-state cards into the right deck bucket', () => {
    const now = Date.now();
    const cards = [
      makeCard({ state: 'review', stability: 100, lastReview: now, deckId: deck.id }),
      makeCard({ state: 'review', stability: 100, lastReview: now, deckId: deck.id }),
    ];
    const target = new Date(now + 5 * 86_400_000);
    const s = buildForecast(cards, [deck], target, 0.6);
    expect(s.byDeck).toHaveLength(1);
    expect(s.byDeck[0].cardCount).toBe(2);
    expect(s.byDeck[0].meanRecall).toBeGreaterThan(0.9);
  });

  it('flags below-threshold cards as at-risk', () => {
    const now = Date.now();
    const cards = [
      // Long-elapsed weak-stability card — should be far below threshold.
      makeCard({ state: 'review', stability: 1, lastReview: now - 365 * 86_400_000, deckId: deck.id }),
      // Just reviewed, big stability — way above threshold.
      makeCard({ state: 'review', stability: 365, lastReview: now, deckId: deck.id }),
    ];
    const s = buildForecast(cards, [deck], new Date(now), 0.6);
    expect(s.atRiskCardIds).toHaveLength(1);
    expect(s.atRiskCardIds[0]).toBe(cards[0].id);
  });

  it('sorts decks worst-recall-first so drill targets surface', () => {
    const now = Date.now();
    const strong: Deck = { id: 'S', name: 'Strong', createdAt: 0, modifiedAt: 0 };
    const weak: Deck = { id: 'W', name: 'Weak', createdAt: 0, modifiedAt: 0 };
    const cards = [
      makeCard({ state: 'review', stability: 365, lastReview: now, deckId: strong.id }),
      makeCard({ state: 'review', stability: 2, lastReview: now - 100 * 86_400_000, deckId: weak.id }),
    ];
    const s = buildForecast(cards, [strong, weak], new Date(now), 0.6);
    expect(s.byDeck[0].deckName).toBe('Weak');
    expect(s.byDeck[1].deckName).toBe('Strong');
  });
});
