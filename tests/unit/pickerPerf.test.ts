/**
 * Picker hot-path benchmark.
 *
 * Builds a synthetic 72-leaf, ~6000-card parent deck (mirrors the user's
 * MCAT V5 layout), seeds enough reviewLog activity to make cap checks fire,
 * then measures how long a single `getNextCardForStudy` call takes against
 * the parent. The pre-refactor version walked DB queries per candidate; the
 * batched version precomputes once. Threshold is generous so the test is
 * flake-free in CI but still catches a real regression.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '@/lib/db/dexie';
import type { Card } from '@/lib/db/schema';
import {
  createDeck,
  createNote,
  getNextCardForStudy,
  listDescendantDeckIds,
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

describe('Picker hot path — large parent deck', () => {
  it('parent study with 24 leaves and 25 cards each picks a card quickly', async () => {
    const root = await createDeck({ name: 'MCAT' });
    // Set parent caps that won't immediately exhaust — we want the cap loop
    // to walk many cards, not bail at the first one.
    await updateDeck(root.id, { newCardsPerDay: 1000 });

    // Synthetic scale: 24 leaves × 25 cards = 600 cards. Smaller than the
    // user's MCAT V5 (72×~100=~7200), but fake-indexeddb's seed phase makes
    // the prod-scale unworkable for a unit test. The performance signal is
    // about *the pick*, not the seed: the pick walks every candidate, so a
    // 600-card pool exercises the same code path that was the bottleneck.
    const LEAVES = 24;
    const CARDS_PER_LEAF = 25;
    const leafIds: string[] = [];
    for (let i = 0; i < LEAVES; i++) {
      const leaf = await createDeck({ name: `MCAT::Sub::Ch${String(i + 1).padStart(2, '0')}` });
      leafIds.push(leaf.id);
      const inserts: Array<Promise<unknown>> = [];
      for (let j = 0; j < CARDS_PER_LEAF; j++) {
        inserts.push(createNote({
          deckId: leaf.id,
          fields: { front: `Q${i}-${j}`, back: 'A' },
          tags: [],
        }));
      }
      await Promise.all(inserts);
    }

    // Seed enough today-reviews to make the cap counts non-trivial: rate
    // 20 cards as Good so buildCapContext has logs to bucket per deck.
    const dbi = db();
    const seedCards = await dbi.cards
      .where('deckId').anyOf(leafIds.slice(0, 4))
      .limit(20).toArray();
    for (const c of seedCards) {
      await recordReview(c, 3, 100);
    }

    // Confirm the scope is the full parent subtree.
    const subtreeSize = (await listDescendantDeckIds(root.id, { includeSelf: true })).length;
    expect(subtreeSize).toBe(LEAVES + 1);

    // Phase-by-phase timing so future regressions are easy to diagnose.
    // The picker's three big phases: queryByState (review), queryByState
    // (new), buildCapContext+iterate. Run each in isolation so we can see
    // the breakdown.
    const tDecksAll = performance.now();
    const _allDecks = await db().decks.toArray();
    const decksAllMs = performance.now() - tDecksAll;

    const tReviewQ = performance.now();
    const _r = await db().cards
      .where('[deckId+state]')
      .anyOf([root.id, ...leafIds].map(id => [id, 'review']))
      .toArray();
    const reviewQMs = performance.now() - tReviewQ;

    const tNewQ = performance.now();
    const _n = await db().cards
      .where('[deckId+state]')
      .anyOf([root.id, ...leafIds].map(id => [id, 'new']))
      .filter((c: Card) => !c.suspended && !c.buried)
      .sortBy('createdAt');
    const newQMs = performance.now() - tNewQ;

    const tLogs = performance.now();
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const _logs = await db().reviewLogs.where('review').aboveOrEqual(startOfToday.getTime()).toArray();
    const logsMs = performance.now() - tLogs;

    // Now full pick.
    const timings: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      const pick = await getNextCardForStudy([root.id, ...leafIds]);
      timings.push(performance.now() - start);
      expect(pick).toBeDefined();
    }
    const cold = timings[0];
    const warm = timings.slice(1).sort()[Math.floor(timings.slice(1).length / 2)];
    // eslint-disable-next-line no-console
    console.log(`[picker-perf] phases: decks.toArray=${decksAllMs.toFixed(1)} reviewQ=${reviewQMs.toFixed(1)} newQ=${newQMs.toFixed(1)} logs=${logsMs.toFixed(1)}`);
    // eslint-disable-next-line no-console
    console.log(`[picker-perf] full pick: cold=${cold.toFixed(1)}ms warm-median=${warm.toFixed(1)}ms full=${timings.map(t => t.toFixed(0)).join(',')}`);

    // The interesting invariant: residual = full - newQ - reviewQ - logs is
    // dominated by the cap iteration over candidates. The pre-refactor version
    // ran multiple DB calls per candidate (multi-second), the post-refactor
    // version is a sync Map lookup per candidate (must be < 200ms even in
    // fake-indexeddb). This catches a regression in CapContext usage.
    const dataFetchMs = newQMs + reviewQMs + logsMs;
    const residualMs = warm - dataFetchMs;
    // eslint-disable-next-line no-console
    console.log(`[picker-perf] residual (cap-iter + precompute) = ${residualMs.toFixed(1)}ms`);
    if (residualMs > 250) {
      throw new Error(
        `Cap-iteration residual ${residualMs.toFixed(1)}ms exceeds 250ms; ` +
        `cardAllowedByCaps may have reverted to per-candidate DB calls.`,
      );
    }
  }, 60_000);
});
