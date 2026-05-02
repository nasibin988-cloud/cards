import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '@/lib/db/dexie';
import { id as ulid } from '@/lib/ulid';
import {
  createDeck,
  createNote,
  recordReview,
} from '@/lib/db/queries';
import { optimizeFsrsWeights } from '@/lib/fsrs/optimize';

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

describe('optimizeFsrsWeights', () => {
  it('reports insufficientData when there are too few reviews', async () => {
    const d = await createDeck({ name: 'D' });
    const { cards } = await createNote({
      deckId: d.id,
      fields: { front: 'q', back: 'a' },
      tags: [],
    });
    // Only one review — well below the default 200 threshold.
    await recordReview(cards[0], 3, 100);
    const result = await optimizeFsrsWeights(d.id);
    expect(result.insufficientData).toBeDefined();
    expect(result.insufficientData!.need).toBeGreaterThan(0);
    expect(result.epochsRun).toBe(0);
  });

  it('returns finite loss values when the threshold is lowered', async () => {
    // Synthesize ~50 reviews across a few cards by repeatedly rating them.
    // We pass minReviews=10 to bypass the realistic threshold; we don't
    // need to demonstrate convergence on a synthetic dataset, only that
    // the optimizer terminates and produces a sensible loss number.
    const d = await createDeck({ name: 'D' });
    for (let i = 0; i < 5; i++) {
      const { cards } = await createNote({
        deckId: d.id,
        fields: { front: `q${i}`, back: 'a' },
        tags: [],
      });
      let card = cards[0];
      for (let j = 0; j < 10; j++) {
        const r = await recordReview(card, j % 4 === 0 ? 1 : 3, 100);
        card = r.updatedCard;
      }
    }

    const result = await optimizeFsrsWeights(d.id, {
      minReviews: 10,
      maxEpochs: 2,
      timeBudgetMs: 4000,
    });
    expect(result.insufficientData).toBeUndefined();
    expect(Number.isFinite(result.initialLoss)).toBe(true);
    expect(Number.isFinite(result.finalLoss)).toBe(true);
    expect(result.optimizedWeights.length).toBe(result.initialWeights.length);
    // Each weight is finite (no NaN/Infinity from the gradient steps).
    for (const w of result.optimizedWeights) {
      expect(Number.isFinite(w)).toBe(true);
    }
  }, 30_000);

  it('respects the time budget', async () => {
    // Build a non-trivial set so each epoch isn't free.
    const d = await createDeck({ name: 'D' });
    for (let i = 0; i < 3; i++) {
      const { cards } = await createNote({
        deckId: d.id,
        fields: { front: `q${i}`, back: 'a' },
        tags: [],
      });
      let card = cards[0];
      for (let j = 0; j < 8; j++) {
        const r = await recordReview(card, 3, 100);
        card = r.updatedCard;
      }
    }

    const start = Date.now();
    const result = await optimizeFsrsWeights(d.id, {
      minReviews: 5,
      maxEpochs: 100,
      timeBudgetMs: 200,  // intentionally tight
    });
    const elapsed = Date.now() - start;
    // The optimizer can overshoot by up to one epoch since it checks
    // budget between epochs, not within. 5x slack covers fake-IDB latency.
    expect(elapsed).toBeLessThan(2000);
    expect(['time-budget', 'plateau', 'completed']).toContain(result.stop);
  }, 30_000);
});
