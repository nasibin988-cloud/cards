/**
 * Exam-day retention forecast.
 *
 * Given a target date (the test you're studying for), simulate every
 * card's expected retrievability on that date using its existing FSRS
 * stability + last-review timestamp. Output is a per-deck breakdown
 * plus a list of cards predicted to fall below a user-set threshold
 * (the "at-risk" set you should drill).
 *
 * Math: FSRS-5 retrievability as a function of days-elapsed and
 * stability, with the standard `factor = 19/81 * (1/retention^(1/decay) - 1)`
 * shape from the upstream model:
 *
 *   R(t, S) = (1 + factor * t / S) ^ -decay
 *
 * For the default retention (0.9) and FSRS-5 decay (0.5), this matches
 * the curves the scheduler uses internally. We only forecast cards that
 * have actually been reviewed — `state in {review, relearning}` and
 * `lastReview != null`. New + learning cards have no meaningful R yet
 * and would noise up the average.
 */

import type { Card, Deck } from '@/lib/db/schema';

/** FSRS-5 decay parameter. Hard-coded to match upstream. */
const DECAY = -0.5;
/** Pre-computed factor for retention=0.9. R(t,S) at t=S = 0.9. */
const FACTOR = 19 / 81;

/**
 * Probability the user recalls this card on `targetDate`. 0..1.
 * Returns null when the card has never been reviewed — no signal to
 * forecast from. Caller should skip those cards (or treat as 0).
 */
export function expectedRecall(card: Card, targetDate: Date): number | null {
  if (!card.lastReview) return null;
  if (card.stability <= 0) return null;
  const tDays = (targetDate.getTime() - card.lastReview) / 86_400_000;
  // Days in the past are clamped to 0 — you can't have negative elapsed.
  // If the exam is BEFORE lastReview the card was just reviewed; R = 1.
  if (tDays <= 0) return 1;
  return Math.pow(1 + FACTOR * tDays / card.stability, DECAY);
}

export interface DeckForecast {
  deckId: string;
  deckName: string;
  /** Cards counted in the average (state in {review, relearning}, with lastReview). */
  cardCount: number;
  /** Mean expected recall on target date, 0..1. */
  meanRecall: number;
  /** How many cards fall below the threshold on target date. */
  atRisk: number;
}

export interface ForecastSummary {
  targetDate: number;          // ms timestamp
  threshold: number;           // 0..1, e.g. 0.6
  cardsConsidered: number;     // total cards that had a forecast (i.e. lastReview was set)
  cardsSkipped: number;        // cards with no lastReview, or 'new'/'learning'
  overallMeanRecall: number;   // mean across cardsConsidered
  byDeck: DeckForecast[];      // sorted by meanRecall asc (worst first)
  atRiskCardIds: string[];     // every card under threshold, deck-sorted then recall-sorted
}

/**
 * Build a full forecast over the supplied cards. `decks` lets us label
 * each bucket with a name; cards whose deck isn't in the map fall into
 * an "Unknown" bucket so they're still counted.
 */
export function buildForecast(
  allCards: Card[],
  decks: Deck[],
  targetDate: Date,
  threshold: number,
): ForecastSummary {
  const deckById = new Map<string, Deck>();
  for (const d of decks) deckById.set(d.id, d);

  // Per-deck accumulator.
  interface Bucket {
    deckId: string;
    deckName: string;
    sum: number;
    count: number;
    atRisk: Array<{ cardId: string; recall: number }>;
  }
  const buckets = new Map<string, Bucket>();
  let totalSum = 0;
  let totalCount = 0;
  let totalSkipped = 0;

  for (const card of allCards) {
    if (card.suspended) { totalSkipped++; continue; }
    if (card.state !== 'review' && card.state !== 'relearning') { totalSkipped++; continue; }
    const r = expectedRecall(card, targetDate);
    if (r === null) { totalSkipped++; continue; }
    totalSum += r;
    totalCount++;
    let b = buckets.get(card.deckId);
    if (!b) {
      b = {
        deckId: card.deckId,
        deckName: deckById.get(card.deckId)?.name ?? '(unknown)',
        sum: 0,
        count: 0,
        atRisk: [],
      };
      buckets.set(card.deckId, b);
    }
    b.sum += r;
    b.count++;
    if (r < threshold) b.atRisk.push({ cardId: card.id, recall: r });
  }

  // Materialise + sort.
  const byDeck: DeckForecast[] = [];
  const atRiskCardIds: string[] = [];
  for (const b of buckets.values()) {
    byDeck.push({
      deckId: b.deckId,
      deckName: b.deckName,
      cardCount: b.count,
      meanRecall: b.count > 0 ? b.sum / b.count : 0,
      atRisk: b.atRisk.length,
    });
    // Worst-recall-first within each deck so a "drill these first"
    // pass reads top-down.
    b.atRisk.sort((a, b) => a.recall - b.recall);
    for (const a of b.atRisk) atRiskCardIds.push(a.cardId);
  }
  byDeck.sort((a, b) => a.meanRecall - b.meanRecall);

  return {
    targetDate: targetDate.getTime(),
    threshold,
    cardsConsidered: totalCount,
    cardsSkipped: totalSkipped,
    overallMeanRecall: totalCount > 0 ? totalSum / totalCount : 0,
    byDeck,
    atRiskCardIds,
  };
}
