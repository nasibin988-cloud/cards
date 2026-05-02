/**
 * Per-deck retention analysis. Given a deck's review log, compute:
 *   - observed retention (rate of non-Again ratings on review-state cards)
 *   - predicted retention (FSRS's belief about retrievability when we showed
 *     the card, averaged over the same review set)
 *   - delta (observed minus predicted)
 *   - a recommended request_retention adjustment.
 *
 * The fix is intentionally a single-knob tuning that the user can apply with
 * one click. A full FSRS-RS optimizer requires a Rust runtime; not in scope
 * for V1 in-browser. This recommendation is the best low-cost approximation:
 * if you're forgetting more than the model thinks, raise the target retention
 * (more reviews) and vice versa.
 */

import { db } from '@/lib/db/dexie';
import {
  forgetting_curve,
  FSRS5_DEFAULT_DECAY,
  default_request_retention,
} from 'ts-fsrs';

export interface DeckRetentionReport {
  totalReviews: number;
  observedRetention: number | null;   // null if too few reviews
  predictedRetention: number | null;
  delta: number | null;
  currentRetentionTarget: number;
  recommendedRetentionTarget: number | null;
  reasoning: string;
}

const MIN_REVIEWS = 50;

export async function analyzeDeckRetention(
  deckId: string,
  currentRetentionTarget: number = default_request_retention,
): Promise<DeckRetentionReport> {
  const dbi = db();
  const logs = await dbi.reviewLogs.where('deckId').equals(deckId).toArray();
  // Only review-state outcomes participate in the retention metric. Learning
  // and relearning state are short-term steps; FSRS evaluates retention on
  // long-term review-state cards.
  const reviewLogs = logs.filter(l => l.state === 'review' || l.state === 'relearning');

  if (reviewLogs.length < MIN_REVIEWS) {
    return {
      totalReviews: reviewLogs.length,
      observedRetention: null,
      predictedRetention: null,
      delta: null,
      currentRetentionTarget,
      recommendedRetentionTarget: null,
      reasoning: `Need at least ${MIN_REVIEWS} review-state reviews. You have ${reviewLogs.length}.`,
    };
  }

  let predictedSum = 0;
  let correct = 0;
  for (const l of reviewLogs) {
    // Predict retrievability at the moment of review using the stability and
    // elapsed_days that were active just before the review.
    const elapsed = Math.max(0, l.lastElapsedDays);
    const stability = Math.max(1e-3, l.stability);
    const r = forgetting_curve(FSRS5_DEFAULT_DECAY, elapsed, stability);
    predictedSum += r;
    if (l.rating !== 1) correct += 1;
  }
  const observed = correct / reviewLogs.length;
  const predicted = predictedSum / reviewLogs.length;
  const delta = observed - predicted;

  // Single-knob recommendation. Move target halfway toward observed, clipped.
  let recommended = currentRetentionTarget + delta * 0.5;
  recommended = Math.round(Math.min(0.97, Math.max(0.7, recommended)) * 100) / 100;

  let reasoning: string;
  if (Math.abs(delta) < 0.02) {
    reasoning = 'Schedules are well-calibrated. No change recommended.';
  } else if (delta < 0) {
    reasoning = `You're forgetting ${Math.abs(delta * 100).toFixed(1)}% more than FSRS expected. Raising the target makes the schedule more conservative (more reviews).`;
  } else {
    reasoning = `You're remembering ${(delta * 100).toFixed(1)}% better than FSRS expected. Lowering the target lets the schedule stretch out (fewer reviews).`;
  }

  return {
    totalReviews: reviewLogs.length,
    observedRetention: observed,
    predictedRetention: predicted,
    delta,
    currentRetentionTarget,
    recommendedRetentionTarget: recommended === currentRetentionTarget ? null : recommended,
    reasoning,
  };
}
