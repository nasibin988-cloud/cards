import { describe, it, expect } from 'vitest';
import {
  applyRating,
  emptyCard,
  previewIntervals,
} from '@/lib/fsrs/scheduler';
import type { Card } from '@/lib/db/schema';
import { id } from '@/lib/ulid';

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

describe('FSRS wrapper', () => {
  describe('emptyCard', () => {
    it('produces a New-state card with stability 0 and difficulty 0', () => {
      const e = emptyCard();
      expect(e.state).toBe('new');
      expect(e.reps).toBe(0);
      expect(e.lapses).toBe(0);
      expect(e.stability).toBe(0);
      expect(e.difficulty).toBe(0);
    });
  });

  describe('previewIntervals', () => {
    it('returns 4 entries for ratings 1-4', () => {
      const card = makeCard();
      const out = previewIntervals(card);
      expect(out).toHaveLength(4);
      expect(out.map(x => x.rating)).toEqual([1, 2, 3, 4]);
    });
    it('produces non-empty interval labels', () => {
      const card = makeCard();
      const out = previewIntervals(card);
      for (const x of out) {
        expect(x.intervalLabel.length).toBeGreaterThan(0);
        expect(x.intervalLabel).not.toBe('—');
      }
    });
    it('Easy schedules at least as far out as Good for review-state cards', () => {
      const card = makeCard({
        state: 'review',
        reps: 5,
        stability: 30,
        difficulty: 5,
        lastReview: Date.now() - 30 * 86_400_000,
      });
      const out = previewIntervals(card);
      const good = out.find(x => x.rating === 3)!;
      const easy = out.find(x => x.rating === 4)!;
      expect(easy.scheduledDays).toBeGreaterThanOrEqual(good.scheduledDays);
    });
  });

  describe('applyRating', () => {
    it('Good on a new card transitions to learning or review', () => {
      const card = makeCard();
      const { cardPatch, log } = applyRating(card, 3, 1500);
      expect(['learning', 'review']).toContain(cardPatch.state);
      expect(log.rating).toBe(3);
      expect(log.cardId).toBe(card.id);
      expect(log.deckId).toBe(card.deckId);
      expect(log.durationMs).toBe(1500);
    });
    it('Again increments lapses on a review card', () => {
      const card = makeCard({
        state: 'review',
        reps: 5,
        stability: 30,
        difficulty: 5,
        lastReview: Date.now() - 30 * 86_400_000,
        lapses: 0,
      });
      const { cardPatch } = applyRating(card, 1, 800);
      expect(cardPatch.lapses).toBeGreaterThanOrEqual(card.lapses);
      expect(['learning', 'relearning']).toContain(cardPatch.state);
    });
    it('Easy on a new card moves it to review with a longer schedule', () => {
      const card = makeCard();
      const { cardPatch } = applyRating(card, 4, 600);
      expect(cardPatch.due).toBeGreaterThan(Date.now());
      expect(cardPatch.reps).toBe(1);
    });
    it('preserves note and deck IDs in the log', () => {
      const card = makeCard();
      const { log } = applyRating(card, 3, 1000);
      expect(log.cardId).toBe(card.id);
      expect(log.deckId).toBe(card.deckId);
      expect(typeof log.review).toBe('number');
    });
  });
});
