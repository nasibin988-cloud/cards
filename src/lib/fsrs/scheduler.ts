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
  /**
   * Hour of the local day (0–23) at which the calendar day "rolls over"
   * for scheduling purposes. When set, multi-day intervals are anchored
   * to this cutoff: a card rated Friday with a 1-day interval becomes
   * due at Saturday's cutoff (e.g. 12:01 AM) rather than 24h after the
   * exact rate-time. Sub-day intervals (learning steps) are unaffected.
   * Default behaviour (when undefined) is the legacy 24h-from-rate.
   */
  dayStartHour?: number;
}

/**
 * Compute the "day-cutoff" due timestamp for a card scheduled `scheduledDays`
 * full days from `lastReview`, anchored to a local-time cutoff. The result
 * is the cutoff moment that starts the day on which the card is meant to
 * be reviewable.
 *
 * Examples (dayStartHour=0):
 *   lastReview = Fri 8 PM, scheduledDays = 1 → Sat 12:00 AM
 *   lastReview = Fri 1 AM, scheduledDays = 1 → Sat 12:00 AM
 *   lastReview = Fri 8 PM, scheduledDays = 5 → Wed 12:00 AM
 *
 * With dayStartHour=4 (Anki-style "the day starts at 4 AM"), a 2 AM Friday
 * rate is still considered Thursday's day, so a 1d interval lands at
 * Friday 4 AM rather than Saturday.
 */
export function dayCutoffDue(
  lastReview: number,
  scheduledDays: number,
  dayStartHour: number,
): number {
  const dt = new Date(lastReview);
  // If we rated before today's cutoff we're still inside yesterday's
  // "day"; back up one calendar day so the cutoff anchor is correct.
  if (dt.getHours() < dayStartHour) {
    dt.setDate(dt.getDate() - 1);
  }
  dt.setHours(dayStartHour, 0, 0, 0);
  dt.setDate(dt.getDate() + scheduledDays);
  return dt.getTime();
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
    const scheduledDays = card.scheduled_days;
    // Apply the day-cutoff override so the rating-button label matches
    // what the actual recordReview would store. Sub-day intervals
    // (learning steps) bypass — they're meant to be wall-clock.
    const dueMs = (opts.dayStartHour !== undefined && scheduledDays >= 1)
      ? dayCutoffDue(now.getTime(), scheduledDays, opts.dayStartHour)
      : card.due.getTime();
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

  // Calendar-day override: any multi-day interval becomes due at the
  // configured day-cutoff rather than 24h-times-N from rate-time. So a
  // 1d card rated Friday at 8 PM is reviewable from Saturday's cutoff
  // (e.g. 12:01 AM) instead of Saturday 8 PM. Sub-day intervals are
  // unaffected so learning steps (10 min, 1 hr) still mean wall-clock.
  if (
    opts.dayStartHour !== undefined
    && partial.scheduledDays !== undefined
    && partial.scheduledDays >= 1
  ) {
    partial.due = dayCutoffDue(now.getTime(), partial.scheduledDays, opts.dayStartHour);
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
