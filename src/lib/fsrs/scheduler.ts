import {
  fsrs,
  generatorParameters,
  createEmptyCard,
  Rating as FsrsRating,
  State as FsrsState,
  type Card as FsrsCard,
  type Grade,
  type RecordLogItem,
} from 'ts-fsrs';
import type { Card, CardState, Rating, ReviewLog } from '@/lib/db/schema';
import {
  DEFAULT_RETENTION,
  DEFAULT_MAX_INTERVAL,
  DEFAULT_W,
} from './defaults';
import { id } from '@/lib/ulid';
import { formatInterval } from '@/lib/utils';

function ratingToGrade(r: Rating): Grade {
  switch (r) {
    case 1: return FsrsRating.Again as Grade;
    case 2: return FsrsRating.Hard as Grade;
    case 3: return FsrsRating.Good as Grade;
    case 4: return FsrsRating.Easy as Grade;
  }
}

function fsrsStateToCardState(s: FsrsState): CardState {
  switch (s) {
    case FsrsState.New: return 'new';
    case FsrsState.Learning: return 'learning';
    case FsrsState.Review: return 'review';
    case FsrsState.Relearning: return 'relearning';
  }
}

function cardStateToFsrs(s: CardState): FsrsState {
  switch (s) {
    case 'new': return FsrsState.New;
    case 'learning': return FsrsState.Learning;
    case 'review': return FsrsState.Review;
    case 'relearning': return FsrsState.Relearning;
  }
}

export function cardToFsrsCard(c: Card): FsrsCard {
  return {
    due: new Date(c.due),
    stability: c.stability,
    difficulty: c.difficulty,
    elapsed_days: c.elapsedDays,
    scheduled_days: c.scheduledDays,
    learning_steps: c.learningSteps,
    reps: c.reps,
    lapses: c.lapses,
    state: cardStateToFsrs(c.state),
    last_review: c.lastReview ? new Date(c.lastReview) : undefined,
  };
}

export function fsrsCardToPartialCard(f: FsrsCard): Pick<
  Card,
  | 'due' | 'stability' | 'difficulty' | 'elapsedDays' | 'scheduledDays'
  | 'learningSteps' | 'reps' | 'lapses' | 'state' | 'lastReview'
> {
  return {
    due: f.due.getTime(),
    stability: f.stability,
    difficulty: f.difficulty,
    elapsedDays: f.elapsed_days,
    scheduledDays: f.scheduled_days,
    learningSteps: f.learning_steps,
    reps: f.reps,
    lapses: f.lapses,
    state: fsrsStateToCardState(f.state),
    lastReview: f.last_review ? f.last_review.getTime() : undefined,
  };
}

export function emptyCard(now: Date = new Date()): Pick<
  Card,
  | 'due' | 'stability' | 'difficulty' | 'elapsedDays' | 'scheduledDays'
  | 'learningSteps' | 'reps' | 'lapses' | 'state' | 'lastReview'
> {
  return fsrsCardToPartialCard(createEmptyCard(now));
}

export interface SchedulerOptions {
  w?: readonly number[];
  retention?: number;
  maxInterval?: number;
  /**
   * Multiplier applied to the FSRS-computed `scheduledDays`. Used by
   * Feynman mode to extend intervals when the user demonstrated deep
   * understanding (high completeness on Good/Easy). 1.0 = no change.
   * Hard cap by `maxInterval` is preserved.
   */
  intervalMultiplier?: number;
}

function makeFsrs(opts: SchedulerOptions = {}) {
  const params = generatorParameters({
    w: (opts.w ?? DEFAULT_W) as number[],
    request_retention: opts.retention ?? DEFAULT_RETENTION,
    maximum_interval: opts.maxInterval ?? DEFAULT_MAX_INTERVAL,
  });
  return fsrs(params);
}

export interface ScheduledRating {
  rating: Rating;
  scheduledDays: number;
  intervalLabel: string;
  due: number;
}

/** Preview the next state for all 4 ratings (used to label rating buttons). */
export function previewIntervals(
  card: Card,
  opts: SchedulerOptions = {},
  now: Date = new Date(),
): ScheduledRating[] {
  const f = makeFsrs(opts);
  const preview = f.repeat(cardToFsrsCard(card), now);
  const result: ScheduledRating[] = [];
  for (const rating of [1, 2, 3, 4] as const) {
    const item = preview[ratingToGrade(rating)];
    if (!item) continue;
    const card = item.card;
    const dueMs = card.due.getTime();
    const scheduledDays = card.scheduled_days;
    const days = (dueMs - now.getTime()) / 86_400_000;
    result.push({
      rating,
      scheduledDays,
      intervalLabel: formatInterval(days),
      due: dueMs,
    });
  }
  return result;
}

/** Apply a rating; returns updated card fields + a review log to persist. */
export function applyRating(
  card: Card,
  rating: Rating,
  durationMs: number,
  opts: SchedulerOptions = {},
  now: Date = new Date(),
): { cardPatch: Partial<Card>; log: ReviewLog } {
  const f = makeFsrs(opts);
  const result: RecordLogItem = f.next(cardToFsrsCard(card), now, ratingToGrade(rating));
  const partial = fsrsCardToPartialCard(result.card);

  // Optional Feynman bonus: widen the interval when the user demonstrated
  // deep understanding. We apply it AFTER FSRS so the model's relative
  // ordering (Hard < Good < Easy) is preserved; the multiplier just
  // stretches the result. Caps at maxInterval to honor that ceiling.
  const mult = opts.intervalMultiplier;
  if (mult && mult !== 1 && partial.scheduledDays !== undefined && partial.scheduledDays > 0) {
    const cap = opts.maxInterval ?? DEFAULT_MAX_INTERVAL;
    const widened = Math.min(cap, Math.round(partial.scheduledDays * mult));
    partial.scheduledDays = widened;
    partial.due = now.getTime() + widened * 86_400_000;
  }

  return {
    cardPatch: { ...partial, modifiedAt: now.getTime() },
    log: {
      id: id(),
      cardId: card.id,
      deckId: card.deckId,
      rating,
      state: fsrsStateToCardState(result.log.state),
      // Reflect the bonus in the log too so retention/optimizer math sees
      // the actual scheduled interval, not the un-bonused FSRS prediction.
      due: partial.due ?? result.log.due.getTime(),
      stability: result.log.stability,
      difficulty: result.log.difficulty,
      elapsedDays: result.log.elapsed_days,
      lastElapsedDays: result.log.last_elapsed_days,
      scheduledDays: partial.scheduledDays ?? result.log.scheduled_days,
      review: result.log.review.getTime(),
      durationMs,
    },
  };
}
