/**
 * Pull the raw note/card/review-log data for a report.
 *
 * Two entry points:
 *   - gatherDailyActivity(): filtered by today's day window (honoring the
 *     user's day_start_hour setting). Splits cards into LEARNED / REVIEWED /
 *     TROUBLE buckets based on the day's review-log signals.
 *   - gatherDecksForOverview(deckIds): walks the supplied decks' notes
 *     wholesale; no review-log filter.
 *
 * Both produce the same shape (ReportData) so a single writer pipeline
 * can consume either.
 */

import { db } from '@/lib/db/dexie';
import { getJsonSetting, listDescendantDeckIds } from '@/lib/db/queries';
import { renderPlain } from '@/lib/cloze/parser';
import type { Card, Deck, Note, ReviewLog } from '@/lib/db/schema';

export interface ReportCard {
  noteId: string;
  cardId: string;
  deckId: string;
  deckName: string;
  front: string;          // plain text, cloze parens stripped, trimmed
  back: string;
  extra?: string;
  /** Lapses for that card today (TROUBLE bucket only). */
  todayLapses?: number;
}

export interface ReportData {
  /** What kind of report this is — drives section selection in the writer. */
  kind: 'daily' | 'deck-overview';
  /** Human label for the title page. */
  title: string;
  /** ISO date for the report's "subject" — today's date, or the day a
   *  deck overview was generated. */
  generatedAt: number;
  /** Day window the daily report covers. Undefined for deck-overview. */
  dayStartMs?: number;
  dayEndMs?: number;
  /** Sections. Each bucket may be empty. */
  learnedToday: ReportCard[];
  reviewedToday: ReportCard[];
  trouble: ReportCard[];
  /** Used by the deck-overview path: all in-scope notes flattened.
   *  For daily reports this is empty (the three buckets above cover it). */
  fullDeckScope: ReportCard[];
  /** Deck headers for the title page. */
  decks: Array<{ id: string; name: string }>;
}

/** Local-time day cutoff: the start ms of today's "study day" using the
 *  same day_start_hour the scheduler uses. */
async function dayWindow(now: Date = new Date()): Promise<{ start: number; end: number }> {
  const dsh = await getJsonSetting<number | null>('day_start_hour', null);
  const hour = (typeof dsh === 'number' && dsh >= 0 && dsh <= 23) ? dsh : 0;
  const start = new Date(now);
  // If we're before today's cutoff we're still inside yesterday's day.
  if (start.getHours() < hour) start.setDate(start.getDate() - 1);
  start.setHours(hour, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start: start.getTime(), end: end.getTime() };
}

function toReportCard(note: Note, card: Card, deck: Deck): ReportCard {
  return {
    noteId: note.id,
    cardId: card.id,
    deckId: deck.id,
    deckName: deck.name,
    front: renderPlain(note.fields.front).replace(/\s+/g, ' ').trim(),
    back: renderPlain(note.fields.back ?? '').replace(/\s+/g, ' ').trim(),
    extra: note.fields.extra
      ? renderPlain(note.fields.extra).replace(/\s+/g, ' ').trim()
      : undefined,
  };
}

export async function gatherDailyActivity(): Promise<ReportData> {
  const { start, end } = await dayWindow();
  const dbi = db();
  const [logs, notes, cards, decks] = await Promise.all([
    dbi.reviewLogs.where('review').between(start, end, true, false).toArray(),
    dbi.notes.toArray(),
    dbi.cards.toArray(),
    dbi.decks.toArray(),
  ]);

  const noteById = new Map(notes.map(n => [n.id, n]));
  const cardById = new Map(cards.map(c => [c.id, c]));
  const deckById = new Map(decks.map(d => [d.id, d]));

  // Per-card aggregation of today's logs so we can decide LEARNED vs
  // REVIEWED vs TROUBLE without double-counting cards that got rated
  // more than once.
  const perCard = new Map<string, { firstState: string; lastState: string; minRating: number; lapses: number; count: number }>();
  // Sort logs by review timestamp so firstState/lastState are correct.
  const sorted = [...logs].sort((a, b) => a.review - b.review);
  for (const l of sorted) {
    const existing = perCard.get(l.cardId);
    if (!existing) {
      perCard.set(l.cardId, {
        firstState: l.state,
        lastState: l.state,
        minRating: l.rating,
        lapses: l.rating === 1 ? 1 : 0,
        count: 1,
      });
    } else {
      existing.lastState = l.state;
      existing.minRating = Math.min(existing.minRating, l.rating);
      if (l.rating === 1) existing.lapses++;
      existing.count++;
    }
  }

  const learned: ReportCard[] = [];
  const reviewed: ReportCard[] = [];
  const trouble: ReportCard[] = [];

  for (const [cardId, agg] of perCard) {
    const card = cardById.get(cardId);
    if (!card) continue;
    const note = noteById.get(card.noteId);
    if (!note) continue;
    const deck = deckById.get(card.deckId);
    if (!deck) continue;
    const rc = toReportCard(note, card, deck);
    rc.todayLapses = agg.lapses;
    // TROUBLE: any lapse today, regardless of which bucket the card
    // ended up in. A lapsed card is still "trouble" even if you eventually
    // got it.
    if (agg.lapses > 0) trouble.push(rc);
    // LEARNED: card was 'new' at start of the first log today. Note that
    // a learning card that just stepped through doesn't fire as 'new' —
    // it's already past that. This catches genuine first-encounters.
    if (agg.firstState === 'new') {
      learned.push(rc);
    } else if (agg.firstState === 'review' || agg.firstState === 'relearning') {
      reviewed.push(rc);
    } else if (agg.firstState === 'learning') {
      // Learning-step continuations: count as "reviewed today" (they're
      // mid-flight, not first-encounters).
      reviewed.push(rc);
    }
  }

  return {
    kind: 'daily',
    title: new Date(start).toLocaleDateString(undefined, {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    }),
    generatedAt: Date.now(),
    dayStartMs: start,
    dayEndMs: end,
    learnedToday: learned,
    reviewedToday: reviewed,
    trouble,
    fullDeckScope: [],
    decks: decksFromCards([...learned, ...reviewed, ...trouble]),
  };
}

export async function gatherDecksForOverview(deckIds: string[]): Promise<ReportData> {
  // Expand each deck id to include `::` descendants so picking "MCAT"
  // pulls in MCAT::Bio::Ch01_*, etc.
  const allIds = new Set<string>();
  for (const id of deckIds) {
    const ds = await listDescendantDeckIds(id, { includeSelf: true });
    for (const d of ds) allIds.add(d);
  }

  const dbi = db();
  const [notes, cards, decks] = await Promise.all([
    dbi.notes.where('deckId').anyOf([...allIds]).toArray(),
    dbi.cards.where('deckId').anyOf([...allIds]).toArray(),
    dbi.decks.where('id').anyOf([...allIds]).toArray(),
  ]);

  const noteById = new Map(notes.map(n => [n.id, n]));
  const deckById = new Map(decks.map(d => [d.id, d]));

  // Use one representative card per note (the first cloze ord, or the
  // single bare card on a basic note). Avoids duplicating the same fact
  // N times when a cloze has N ords.
  const cardsByNote = new Map<string, Card[]>();
  for (const c of cards) {
    if (c.suspended) continue;
    let bucket = cardsByNote.get(c.noteId);
    if (!bucket) { bucket = []; cardsByNote.set(c.noteId, bucket); }
    bucket.push(c);
  }
  const flat: ReportCard[] = [];
  for (const [noteId, bucket] of cardsByNote) {
    const note = noteById.get(noteId);
    if (!note) continue;
    const card = bucket[0];
    const deck = deckById.get(card.deckId);
    if (!deck) continue;
    flat.push(toReportCard(note, card, deck));
  }

  // Title: list the directly-requested decks, not the expansion. Reads
  // cleaner ("MCAT" instead of "MCAT::Bio::Ch01_…, MCAT::Bio::Ch02_…").
  const titleDecks = deckIds
    .map(id => deckById.get(id)?.name)
    .filter((s): s is string => !!s);

  return {
    kind: 'deck-overview',
    title: titleDecks.length === 1 ? titleDecks[0] : `${titleDecks.length} decks`,
    generatedAt: Date.now(),
    learnedToday: [],
    reviewedToday: [],
    trouble: [],
    fullDeckScope: flat,
    decks: decksFromCards(flat),
  };
}

function decksFromCards(cards: ReportCard[]): Array<{ id: string; name: string }> {
  const seen = new Map<string, string>();
  for (const c of cards) {
    if (!seen.has(c.deckId)) seen.set(c.deckId, c.deckName);
  }
  return [...seen.entries()].map(([id, name]) => ({ id, name }));
}

/** Used only for the test suite — not exported via index.ts. */
export type { ReviewLog };
