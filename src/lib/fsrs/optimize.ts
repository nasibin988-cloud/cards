/**
 * Per-deck FSRS-19 weight optimizer.
 *
 * Replays each card's review history through the FSRS scheduler with a
 * candidate 19-element weight vector W, accumulates log-loss against actual
 * outcomes, and steps W down the gradient. Pure TypeScript — no Rust dep.
 *
 * Implementation choices:
 *   - Numerical (central-difference) gradient. Slower than analytical
 *     autograd but trivially correct for any FSRS-5 algorithm change in
 *     `ts-fsrs`. The full eval cost dominates over the 2 × 19 finite-diff
 *     evals per epoch.
 *   - AdamW step with a low learning rate. Conservative because FSRS
 *     weights span several orders of magnitude; a single oversized step
 *     can degrade the schedule visibly.
 *   - Bounded epochs and an absolute time budget so the user sees a result
 *     in a few seconds even on big histories.
 *   - Returns both the new weights AND the loss before/after, so the UI
 *     can refuse to apply when the optimizer didn't actually improve.
 *
 * The single-knob `analyzeDeckRetention` helper still exists for
 * lightweight tuning when the user only wants to nudge `request_retention`.
 * This optimizer is the heavier "fit FSRS to my data" path.
 */

import {
  createEmptyCard,
  forgetting_curve,
  fsrs,
  FSRS5_DEFAULT_DECAY,
  generatorParameters,
  default_w,
  type Card as FsrsCard,
  type Grade,
} from 'ts-fsrs';
import { db } from '@/lib/db/dexie';
import type { ReviewLog } from '@/lib/db/schema';

const RATING_TO_GRADE: Record<1 | 2 | 3 | 4, Grade> = {
  1: 1 as Grade, // Again
  2: 2 as Grade, // Hard
  3: 3 as Grade, // Good
  4: 4 as Grade, // Easy
};

export interface OptimizeOptions {
  /** Maximum optimization epochs. Each epoch is one full forward + gradient. */
  maxEpochs?: number;
  /** Absolute time budget (ms). Stops early if exceeded between epochs. */
  timeBudgetMs?: number;
  /** Minimum review-state reviews required to attempt optimization. */
  minReviews?: number;
  /** Adam learning rate. */
  learningRate?: number;
  /** L2 weight decay (AdamW). */
  weightDecay?: number;
  /** Reports progress between epochs (UI hook). */
  onProgress?: (info: { epoch: number; loss: number }) => void;
}

export interface OptimizeResult {
  reviewsUsed: number;
  initialWeights: number[];
  optimizedWeights: number[];
  initialLoss: number;
  finalLoss: number;
  improvement: number; // initialLoss - finalLoss; positive = better.
  epochsRun: number;
  /** Why we stopped: hit budget, plateaued, or completed. */
  stop: 'completed' | 'time-budget' | 'plateau';
  /** Set when too-few-reviews — caller should not apply. */
  insufficientData?: { have: number; need: number };
}

/**
 * Heart of the optimizer: simulate FSRS through one card's review history
 * with the given weight vector and accumulate log-loss against actual
 * outcomes. Loss is binary cross-entropy of predicted retrievability vs. y =
 * (rating ≥ 2). Only counts review-state and relearning-state reviews —
 * learning-step reviews don't carry retention signal.
 */
function replayCardHistory(weights: number[], logs: ReviewLog[]): { loss: number; count: number } {
  const f = fsrs(generatorParameters({ w: weights, request_retention: 0.9 }));
  let card: FsrsCard = createEmptyCard();
  let loss = 0;
  let count = 0;
  const eps = 1e-7;
  for (const l of logs) {
    // Score this review's loss BEFORE we step the card forward — the
    // prediction we want to evaluate is FSRS's retrievability belief at the
    // moment the review fired.
    if (l.state === 'review' || l.state === 'relearning') {
      const elapsed = Math.max(0, l.lastElapsedDays);
      const stability = Math.max(1e-3, card.stability || l.stability || 1e-3);
      const r = forgetting_curve(FSRS5_DEFAULT_DECAY, elapsed, stability);
      const y = l.rating === 1 ? 0 : 1;
      const rClamped = Math.max(eps, Math.min(1 - eps, r));
      loss += -(y * Math.log(rClamped) + (1 - y) * Math.log(1 - rClamped));
      count++;
    }
    const reviewDate = new Date(l.review);
    const grade = RATING_TO_GRADE[l.rating];
    if (!grade) continue;
    const result = f.next(card, reviewDate, grade);
    card = result.card;
  }
  return { loss, count };
}

/** Total log-loss across every card's history. Returns total loss + count. */
function totalLoss(weights: number[], byCard: Map<string, ReviewLog[]>): { loss: number; count: number } {
  let loss = 0;
  let count = 0;
  for (const history of byCard.values()) {
    const { loss: l, count: c } = replayCardHistory(weights, history);
    loss += l;
    count += c;
  }
  return { loss, count };
}

/**
 * AdamW optimizer step. Tracks first/second moments per weight; standard
 * Adam decay. weightDecay is decoupled (added directly to the parameter
 * step, not the gradient) so it doesn't interact with the m/v moments.
 */
class AdamW {
  m: number[];
  v: number[];
  step = 0;
  constructor(
    public dim: number,
    public lr: number,
    public beta1 = 0.9,
    public beta2 = 0.999,
    public eps = 1e-8,
    public weightDecay = 0,
  ) {
    this.m = new Array(dim).fill(0);
    this.v = new Array(dim).fill(0);
  }
  apply(weights: number[], grads: number[]): number[] {
    this.step++;
    const out = weights.slice();
    const t = this.step;
    const b1c = 1 - Math.pow(this.beta1, t);
    const b2c = 1 - Math.pow(this.beta2, t);
    for (let i = 0; i < this.dim; i++) {
      this.m[i] = this.beta1 * this.m[i] + (1 - this.beta1) * grads[i];
      this.v[i] = this.beta2 * this.v[i] + (1 - this.beta2) * grads[i] * grads[i];
      const mHat = this.m[i] / b1c;
      const vHat = this.v[i] / b2c;
      out[i] -= this.lr * (mHat / (Math.sqrt(vHat) + this.eps) + this.weightDecay * weights[i]);
    }
    return out;
  }
}

/**
 * Run the optimizer for one deck. Reads the deck's reviewLogs, groups by
 * card, replays each card's history with W₀ to get baseline loss, then
 * iterates AdamW steps until budget/plateau/completion.
 */
export async function optimizeFsrsWeights(
  deckId: string,
  opts: OptimizeOptions = {},
): Promise<OptimizeResult> {
  const {
    maxEpochs = 12,
    timeBudgetMs = 8000,
    minReviews = 200,
    learningRate = 4e-2,
    weightDecay = 1e-5,
    onProgress,
  } = opts;

  const dbi = db();
  const logs = await dbi.reviewLogs.where('deckId').equals(deckId).toArray();
  // Sort each card's history by review time so replay is causal.
  const byCard = new Map<string, ReviewLog[]>();
  for (const l of logs) {
    const list = byCard.get(l.cardId) ?? [];
    list.push(l);
    byCard.set(l.cardId, list);
  }
  for (const list of byCard.values()) list.sort((a, b) => a.review - b.review);

  // Count review-state samples — those carry retention signal. Learning
  // steps are FSRS-internal staircase moves; not training material.
  let reviewSampleCount = 0;
  for (const list of byCard.values()) {
    for (const l of list) if (l.state === 'review' || l.state === 'relearning') reviewSampleCount++;
  }
  const initialWeights = (default_w as readonly number[]).slice() as number[];
  const baseline = totalLoss(initialWeights, byCard);

  if (reviewSampleCount < minReviews) {
    return {
      reviewsUsed: reviewSampleCount,
      initialWeights,
      optimizedWeights: initialWeights,
      initialLoss: baseline.count > 0 ? baseline.loss / baseline.count : 0,
      finalLoss: baseline.count > 0 ? baseline.loss / baseline.count : 0,
      improvement: 0,
      epochsRun: 0,
      stop: 'completed',
      insufficientData: { have: reviewSampleCount, need: minReviews },
    };
  }

  const dim = initialWeights.length;
  const adam = new AdamW(dim, learningRate, 0.9, 0.999, 1e-8, weightDecay);

  let weights = initialWeights.slice();
  let lastLoss = baseline.loss / baseline.count;
  const initialLoss = lastLoss;

  const startedAt = Date.now();
  let epochsRun = 0;
  let stop: OptimizeResult['stop'] = 'completed';

  for (let epoch = 0; epoch < maxEpochs; epoch++) {
    if (Date.now() - startedAt > timeBudgetMs) { stop = 'time-budget'; break; }

    // Numerical gradient via central difference. Step size = max(1e-4, |w| * 1e-3)
    // so heavily-scaled weights still see a meaningful perturbation.
    const grads: number[] = new Array(dim).fill(0);
    for (let i = 0; i < dim; i++) {
      const h = Math.max(1e-4, Math.abs(weights[i]) * 1e-3);
      const wPlus = weights.slice(); wPlus[i] += h;
      const wMinus = weights.slice(); wMinus[i] -= h;
      const lp = totalLoss(wPlus, byCard).loss;
      const lm = totalLoss(wMinus, byCard).loss;
      grads[i] = (lp - lm) / (2 * h);
    }

    weights = adam.apply(weights, grads);
    const t = totalLoss(weights, byCard);
    const meanLoss = t.loss / Math.max(1, t.count);
    epochsRun = epoch + 1;
    onProgress?.({ epoch: epochsRun, loss: meanLoss });

    // Early stop on plateau: <0.05% relative improvement across an epoch.
    if (lastLoss > 0 && (lastLoss - meanLoss) / lastLoss < 5e-4 && epoch >= 3) {
      stop = 'plateau';
      lastLoss = meanLoss;
      break;
    }
    lastLoss = meanLoss;
  }

  return {
    reviewsUsed: reviewSampleCount,
    initialWeights,
    optimizedWeights: weights,
    initialLoss,
    finalLoss: lastLoss,
    improvement: initialLoss - lastLoss,
    epochsRun,
    stop,
  };
}
