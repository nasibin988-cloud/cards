/**
 * Given a set of decks + a horizon, project the list of cards the
 * podcast should narrate.
 *
 * The projector is intentionally separate from `getNextCardForStudy`:
 *   - The picker is reactive (one card at a time, FSRS-correct, honors
 *     daily caps + bury/suspend mid-session) and depends on wall-clock.
 *   - The projector is batched (return the whole set, no caps, no
 *     state mutation) so the plan pass can see the full surface area
 *     and cluster it sensibly.
 *
 * Horizons:
 *   - today:    state in {learning, relearning} OR (state='review' AND due ≤ today-end)
 *               PLUS up to `newCardsPerDay` new cards per deck (the day's intake)
 *   - tomorrow: today's set PLUS (review cards due during tomorrow's local day)
 *               PLUS tomorrow's intake of new cards
 *   - week:     review cards due in the next 7 calendar days + 7d worth of new intake
 *   - new-only: every state='new' card (no caps, ignore newCardsPerDay)
 *   - all:      every non-suspended card across the decks (review + learning + new)
 *
 * `buried` is excluded only for `today` (bury means "hide for today");
 * other horizons include buried cards so the podcast still teaches the
 * material when the audio session itself is the substitute for sitting
 * with the app.
 */

import { db } from '@/lib/db/dexie';
import type { Card, Deck, Note, PodcastHorizon } from '@/lib/db/schema';

export interface ProjectedCard {
  card: Card;
  note: Note;
  deck: Deck;
  /**
   * Reason this card is in the projection. Used as one signal for
   * clustering (e.g. "lapses-heavy segment").
   */
  reason: 'learning' | 'relearning' | 'review-due' | 'new-intake' | 'review-week' | 'review-all' | 'new-all';
  /** Numeric difficulty signal for budget allocation.
   *  Higher = spend more words. Built from FSRS difficulty + lapses + state. */
  difficultySignal: number;
}

export interface Projection {
  horizon: PodcastHorizon;
  /** Start of "now" used for the projection (ms). */
  asOf: number;
  /** ms boundary of "end of today" for this projection. */
  todayEndMs: number;
  /** ms boundary of "end of tomorrow" for this projection (only for tomorrow/week). */
  horizonEndMs: number;
  cards: ProjectedCard[];
  /** Map deckId → name, snapshotted so segments can label themselves. */
  decksById: Map<string, Deck>;
}

function endOfDay(d: Date): number {
  const e = new Date(d);
  e.setHours(23, 59, 59, 999);
  return e.getTime();
}

function difficultyScore(c: Card): number {
  // FSRS difficulty is 1-10; lapses scaled at 0.5 each (so 4 lapses ≈ +2);
  // relearning gets a flat boost so they get more airtime.
  let s = c.difficulty || 5;
  s += (c.lapses || 0) * 0.5;
  if (c.state === 'relearning') s += 2;
  if (c.state === 'learning') s += 1;
  return s;
}

export async function projectQueue(
  deckIds: string[],
  horizon: PodcastHorizon,
  at: Date = new Date(),
): Promise<Projection> {
  const dbi = db();
  const decks = await dbi.decks.where('id').anyOf(deckIds).toArray();
  const decksById = new Map<string, Deck>();
  for (const d of decks) decksById.set(d.id, d);

  const todayEndMs = endOfDay(at);
  const tomorrow = new Date(at);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowEndMs = endOfDay(tomorrow);
  const weekEnd = new Date(at);
  weekEnd.setDate(weekEnd.getDate() + 7);
  const weekEndMs = endOfDay(weekEnd);

  // Pull all cards in scope once; filter in JS. For most decks this is
  // a single index scan and fits in memory comfortably.
  const allCards = await dbi.cards.where('deckId').anyOf(deckIds).toArray();

  // Pre-fetch every note used here in a single query to avoid N reads.
  const noteIds = Array.from(new Set(allCards.map(c => c.noteId)));
  const notes = await dbi.notes.bulkGet(noteIds);
  const notesById = new Map<string, Note>();
  for (const n of notes) if (n) notesById.set(n.id, n);

  const include = (
    c: Card,
    reason: ProjectedCard['reason'],
    out: ProjectedCard[],
  ) => {
    const note = notesById.get(c.noteId);
    const deck = decksById.get(c.deckId);
    if (!note || !deck) return;
    out.push({ card: c, note, deck, reason, difficultySignal: difficultyScore(c) });
  };

  const result: ProjectedCard[] = [];

  switch (horizon) {
    case 'all': {
      for (const c of allCards) {
        if (c.suspended) continue;
        const reason = c.state === 'new' ? 'new-all' : 'review-all';
        include(c, reason, result);
      }
      break;
    }
    case 'new-only': {
      for (const c of allCards) {
        if (c.suspended) continue;
        if (c.state !== 'new') continue;
        include(c, 'new-intake', result);
      }
      break;
    }
    case 'today':
    case 'tomorrow':
    case 'week': {
      const endMs =
        horizon === 'today' ? todayEndMs
        : horizon === 'tomorrow' ? tomorrowEndMs
        : weekEndMs;
      // Honor bury only for `today` — other horizons span past today.
      const honorBury = horizon === 'today';
      for (const c of allCards) {
        if (c.suspended) continue;
        if (honorBury && c.buried) continue;
        if (c.state === 'learning' && c.due <= endMs) {
          include(c, 'learning', result);
        } else if (c.state === 'relearning' && c.due <= endMs) {
          include(c, 'relearning', result);
        } else if (c.state === 'review' && c.due <= endMs) {
          include(c, horizon === 'week' ? 'review-week' : 'review-due', result);
        }
      }
      // New intake: per-deck cap × number-of-days in horizon.
      const days = horizon === 'today' ? 1 : horizon === 'tomorrow' ? 2 : 7;
      const newByDeck = new Map<string, Card[]>();
      for (const c of allCards) {
        if (c.suspended) continue;
        if (c.state !== 'new') continue;
        if (honorBury && c.buried) continue;
        const arr = newByDeck.get(c.deckId) ?? [];
        arr.push(c);
        newByDeck.set(c.deckId, arr);
      }
      for (const [deckId, cards] of newByDeck) {
        const deck = decksById.get(deckId);
        const perDay = Math.max(0, deck?.newCardsPerDay ?? 20);
        const cap = perDay * days;
        cards.sort((a, b) => a.createdAt - b.createdAt);
        for (const c of cards.slice(0, cap)) include(c, 'new-intake', result);
      }
      break;
    }
  }

  // Stable order: learning/relearning first, then review by due, then new
  // by createdAt. This is the order we'll narrate in absent a re-cluster.
  result.sort((a, b) => {
    const w = (r: ProjectedCard) => (
      r.reason === 'learning' ? 0
      : r.reason === 'relearning' ? 1
      : r.reason === 'review-due' ? 2
      : r.reason === 'review-week' ? 3
      : r.reason === 'review-all' ? 4
      : r.reason === 'new-intake' ? 5
      : 6
    );
    const wa = w(a), wb = w(b);
    if (wa !== wb) return wa - wb;
    return a.card.due - b.card.due;
  });

  return {
    horizon,
    asOf: at.getTime(),
    todayEndMs,
    horizonEndMs: horizon === 'today' ? todayEndMs : horizon === 'tomorrow' ? tomorrowEndMs : horizon === 'week' ? weekEndMs : Number.POSITIVE_INFINITY,
    cards: result,
    decksById,
  };
}
