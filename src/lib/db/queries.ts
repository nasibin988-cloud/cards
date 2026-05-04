import { db } from './dexie';
import type {
  Card,
  CardState,
  Deck,
  Highlight,
  Media,
  NewCardOrder,
  Note,
  NoteFields,
  NoteFlag,
  Rating,
  ReviewLog,
  Source,
  Tier,
} from './schema';
import {
  indexNote,
  noteIdsMatchingQuery,
  rebuildIndex,
  searchByIndex,
  unindexNote,
} from './searchIndex';

/**
 * Re-index a set of notes after a bulk operation that changed indexable
 * content. Runs sequentially in the background; callers don't need to
 * await — search becomes consistent after a brief lag. Search-index
 * failures are non-fatal and never block the calling write path.
 */
async function reindexNotes(noteIds: string[]): Promise<void> {
  if (noteIds.length === 0) return;
  try {
    const fresh = await db().notes.where('id').anyOf(noteIds).toArray();
    for (const n of fresh) await indexNote(n).catch(() => {});
  } catch { /* non-fatal */ }
}

async function unindexNotes(noteIds: string[]): Promise<void> {
  try {
    for (const id of noteIds) await unindexNote(id).catch(() => {});
  } catch { /* non-fatal */ }
}

/**
 * Index a single note, swallowing failures. Used inline on the create/
 * update note path so a search-index issue (e.g. table not present on
 * an old DB version) cannot break note creation.
 */
async function indexNoteSafe(note: Note): Promise<void> {
  try { await indexNote(note); } catch { /* non-fatal */ }
}

async function unindexNoteSafe(noteId: string): Promise<void> {
  try { await unindexNote(noteId); } catch { /* non-fatal */ }
}
import { id } from '@/lib/ulid';
import {
  applyRating,
  emptyCard,
  type SchedulerOptions,
} from '@/lib/fsrs/scheduler';
import { clozeOrds, hasCloze } from '@/lib/cloze/parser';

const now = () => Date.now();

/* ─── Decks ──────────────────────────────────────────────────── */

export async function listDecks(): Promise<Deck[]> {
  return db().decks.orderBy('name').toArray();
}

export async function getDeck(deckId: string): Promise<Deck | undefined> {
  return db().decks.get(deckId);
}

export interface NewDeck {
  name: string;
  description?: string;
  parentId?: string;
  desiredRetention?: number;
  newCardsPerDay?: number;
}

/**
 * Find a deck by exact name, creating it if missing. Used by Quick Capture
 * (and other write-fast flows) so the user never has to pre-create the
 * Inbox or other named buckets.
 */
export async function getOrCreateDeckByName(name: string, description?: string): Promise<Deck> {
  const dbi = db();
  const existing = await dbi.decks.where('name').equals(name).first();
  if (existing) return existing;
  const t = now();
  const deck: Deck = {
    id: id(),
    name,
    description,
    createdAt: t,
    modifiedAt: t,
  };
  await dbi.decks.put(deck);
  return deck;
}

export async function createDeck(input: NewDeck): Promise<Deck> {
  const t = now();
  const deck: Deck = {
    id: id(),
    name: input.name,
    description: input.description,
    parentId: input.parentId,
    desiredRetention: input.desiredRetention,
    newCardsPerDay: input.newCardsPerDay,
    createdAt: t,
    modifiedAt: t,
  };
  await db().decks.put(deck);
  return deck;
}

export async function updateDeck(deckId: string, patch: Partial<Deck>): Promise<void> {
  await db().decks.update(deckId, { ...patch, modifiedAt: now() });
}

/**
 * Collect every deck that should be considered a descendant of `deckId`.
 * The Cards model has two parent relationships:
 *   - explicit `parentId` set programmatically.
 *   - the Anki "::" name convention: a deck named `Biology::Ch01` is a child
 *     of a deck named `Biology`. We include name-prefix descendants so a
 *     `deleteDeck("Biology's id")` doesn't leave `Biology::Ch01` orphaned.
 *
 * Pass `includeSelf=true` to get `[deckId, ...descendants]` in one call.
 */
export async function listDescendantDeckIds(
  deckId: string,
  opts: { includeSelf?: boolean } = {},
): Promise<string[]> {
  const dbi = db();
  const root = await dbi.decks.get(deckId);
  if (!root) return [];
  const all = await dbi.decks.toArray();
  const queue: Deck[] = [root];
  const visited = new Set<string>([root.id]);
  const descendants: string[] = [];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const namePrefix = cur.name + '::';
    for (const d of all) {
      if (visited.has(d.id)) continue;
      const explicitChild = d.parentId === cur.id;
      const nameChild = d.name.startsWith(namePrefix);
      if (explicitChild || nameChild) {
        visited.add(d.id);
        descendants.push(d.id);
        queue.push(d);
      }
    }
  }
  return opts.includeSelf ? [root.id, ...descendants] : descendants;
}

/**
 * Find every deck whose name === `path` OR starts with `path + "::"`. Used
 * for deleting a virtual parent (e.g. the "MCAT" stub row in `DeckTree`
 * when only `MCAT::Biology::Ch01_*` decks actually exist).
 */
export async function listDecksAtOrUnderPath(path: string): Promise<string[]> {
  const all = await db().decks.toArray();
  const trimmed = path.trim();
  if (!trimmed) return [];
  const prefix = trimmed + '::';
  return all
    .filter(d => d.name === trimmed || d.name.startsWith(prefix))
    .map(d => d.id);
}

/**
 * Cascading delete. Removes the deck, every descendant deck (by parentId or
 * name-prefix), every note belonging to any of them, and every card +
 * reviewLog those cards produced. Media rows are NOT garbage-collected here
 * — they're shared across decks and we don't reference-count them yet.
 */
export async function deleteDeck(deckId: string): Promise<void> {
  const ids = await listDescendantDeckIds(deckId, { includeSelf: true });
  if (ids.length === 0) return;
  await deleteDecks(ids);
}

export interface ResetSummary {
  cardsReset: number;
  /** True when notes carry ankiNoteId, so we restamped createdAt in Anki order. */
  reorderedByAnki: boolean;
}

/**
 * Wipe FSRS state on every card in `deckId` and all its `::` descendants.
 * Suspended stays suspended (user intent). Buried clears (mid-flight). Review
 * logs are kept for stats history.
 *
 * Reordering is conservative: createdAt is rewritten ONLY if every note in
 * scope has an `ankiNoteId` (i.e. they came from a .apkg import made by the
 * current importer). In that case we sort by ankiNoteId and re-stamp
 * createdAt so the picker walks Anki's authoring order exactly.
 *
 * If even one note lacks ankiNoteId we leave all createdAt alone — falling
 * back to a ULID-based guess used to corrupt working orderings on imports
 * that already had good sequential createdAt. To restore order on legacy
 * data, re-import the .apkg (the new importer stamps ankiNoteId) and run
 * reset again.
 */
export async function resetDeckProgress(deckId: string): Promise<ResetSummary> {
  const dbi = db();
  const t = now();
  const deckIds = await listDescendantDeckIds(deckId, { includeSelf: true });
  if (deckIds.length === 0) return { cardsReset: 0, reorderedByAnki: false };

  const cards = await dbi.cards.where('deckId').anyOf(deckIds).toArray();
  if (cards.length === 0) return { cardsReset: 0, reorderedByAnki: false };

  const noteIds = [...new Set(cards.map(c => c.noteId))];
  const notes = await dbi.notes.where('id').anyOf(noteIds).toArray();
  const allHaveAnkiId = notes.length > 0 && notes.every(n => n.ankiNoteId !== undefined);

  const empty = emptyCard();

  if (!allHaveAnkiId) {
    // Just wipe FSRS state. Don't touch createdAt — whatever the importer
    // set is the best signal we have for order.
    await dbi.transaction('rw', dbi.cards, async () => {
      await dbi.cards.bulkPut(cards.map(c => ({
        ...c,
        ...empty,
        suspended: c.suspended,
        buried: false,
        buriedUntil: undefined,
        modifiedAt: t,
      })));
    });
    return { cardsReset: cards.length, reorderedByAnki: false };
  }

  // Reorder by Anki authoring order. ankiNoteId is a numeric string that
  // overflows JS Number — compare as BigInt.
  notes.sort((a, b) => {
    const av = BigInt(a.ankiNoteId!), bv = BigInt(b.ankiNoteId!);
    return av < bv ? -1 : av > bv ? 1 : 0;
  });

  const SLOT = 1000;
  const noteIdxById = new Map<string, number>();
  notes.forEach((n, idx) => noteIdxById.set(n.id, idx));

  await dbi.transaction('rw', dbi.notes, dbi.cards, async () => {
    await dbi.notes.bulkPut(notes.map((n, idx) => ({
      ...n,
      createdAt: t + idx * SLOT,
      modifiedAt: t,
    })));
    await dbi.cards.bulkPut(cards.map(c => {
      const idx = noteIdxById.get(c.noteId) ?? 0;
      const ord = (c.clozeOrd ?? 1) - 1;
      return {
        ...c,
        ...empty,
        suspended: c.suspended,
        buried: false,
        buriedUntil: undefined,
        createdAt: t + idx * SLOT + ord,
        modifiedAt: t,
      };
    }));
  });

  return { cardsReset: cards.length, reorderedByAnki: true };
}

/** Delete the given decks and all their notes/cards/reviewLogs atomically. */
export async function deleteDecks(deckIds: string[]): Promise<void> {
  if (deckIds.length === 0) return;
  const dbi = db();
  await dbi.transaction('rw', dbi.decks, dbi.notes, dbi.cards, dbi.reviewLogs, async () => {
    const noteIds = (await dbi.notes.where('deckId').anyOf(deckIds).primaryKeys()) as string[];
    const cardIds = (await dbi.cards.where('deckId').anyOf(deckIds).primaryKeys()) as string[];
    if (cardIds.length > 0) {
      await dbi.reviewLogs.where('cardId').anyOf(cardIds).delete();
    }
    await dbi.cards.where('deckId').anyOf(deckIds).delete();
    if (noteIds.length > 0) {
      await dbi.notes.bulkDelete(noteIds);
    }
    await dbi.decks.bulkDelete(deckIds);
  });
}

/* ─── Settings inheritance (re-exported from ./effective-settings) ── */

import {
  getEffectiveDeckSettings,
  getDeckAncestors,
  DEFAULT_RETENTION,
  DEFAULT_NEW_PER_DAY,
  DEFAULT_REVIEWS_PER_DAY,
  DEFAULT_MAX_INTERVAL,
  type EffectiveDeckSetting,
  type EffectiveDeckSettings,
} from './effective-settings';
export {
  getEffectiveDeckSettings,
  getDeckAncestors,
  DEFAULT_RETENTION,
  DEFAULT_NEW_PER_DAY,
  DEFAULT_REVIEWS_PER_DAY,
  DEFAULT_MAX_INTERVAL,
  type EffectiveDeckSetting,
  type EffectiveDeckSettings,
};

/* ─── Daily caps (new + review) ─────────────────────────────── */

/** Local-time midnight ms for `at` (default: now). */
function startOfTodayMs(at: Date = new Date()): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Today's new-card introductions in `deckIds`. A reviewLog with `state ===
 * 'new'` and a timestamp ≥ today's local midnight counts as one.
 *
 * Used to enforce `newCardsPerDay`. The reviewLog's `state` field stores
 * the *pre-review* state per ts-fsrs's `RecordLog.log.state`, so this is
 * exact even for cards that have since graduated.
 */
export async function countNewIntroductionsToday(
  deckIds: string[],
  at: Date = new Date(),
): Promise<number> {
  if (deckIds.length === 0) return 0;
  const since = startOfTodayMs(at);
  const set = new Set(deckIds);
  // Indexed range scan on `[deckId+review]` would be ideal, but Dexie's
  // anyOf+above composition is awkward; for typical deck sizes (≤ a few
  // thousand reviews/day) a filter is fine.
  return db().reviewLogs
    .where('review').aboveOrEqual(since)
    .filter(l => set.has(l.deckId) && l.state === 'new')
    .count();
}

/**
 * Today's review-card reviews in `deckIds`. Counts logs whose pre-state was
 * 'review' or 'relearning'. Learning steps don't count toward the daily
 * review cap (matches Anki). Snoozes are not logged at all, so they're
 * excluded automatically.
 */
export async function countReviewsToday(
  deckIds: string[],
  at: Date = new Date(),
): Promise<number> {
  if (deckIds.length === 0) return 0;
  const since = startOfTodayMs(at);
  const set = new Set(deckIds);
  return db().reviewLogs
    .where('review').aboveOrEqual(since)
    .filter(l => set.has(l.deckId) && (l.state === 'review' || l.state === 'relearning'))
    .count();
}

/**
 * Cap headroom for a single deck's effective cap, scoped to the deck's
 * own subtree (deck + descendants). Returns `{ allowed, used, cap, sourceName }`.
 *
 * `kind === 'new'` checks new-card introductions; `'review'` checks review
 * reviews. Used by `getScopeCapStatus` (which only needs scope-member
 * computations, not per-candidate); the picker hot path uses `CapContext`.
 */
async function capHeadroomFor(
  deckId: string,
  kind: 'new' | 'review',
  at: Date = new Date(),
): Promise<{ allowed: number; used: number; cap: number; sourceName: string | null }> {
  const eff = await getEffectiveDeckSettings(deckId);
  const cap = kind === 'new' ? eff.newCardsPerDay.value : eff.reviewsPerDay.value;
  const sourceName = kind === 'new' ? eff.newCardsPerDay.sourceName : eff.reviewsPerDay.sourceName;
  const subtree = await listDescendantDeckIds(deckId, { includeSelf: true });
  const used = kind === 'new'
    ? await countNewIntroductionsToday(subtree, at)
    : await countReviewsToday(subtree, at);
  return { allowed: Math.max(0, cap - used), used, cap, sourceName };
}

/**
 * Precomputed cap state for a study session. Built once per call to
 * `getNextCardForStudy` (or `peekNextCardForStudy`) so the per-candidate
 * admission check is a synchronous Map lookup instead of N DB queries.
 *
 * Without this, a 6000-card parent-study session triggers hundreds of
 * round-trips for every card pick: getEffectiveDeckSettings walks ancestors
 * twice (once for capHeadroomFor, once for deck-ancestors-in-scope),
 * listDescendantDeckIds scans the full decks table, and the count queries
 * stack up across rejected candidates.
 *
 * The precompute does the same work *once* and caches:
 *   - `headroomByDeck`: today's new + review headroom for every deck whose
 *     cap could apply (every scope member + every leaf reachable from one).
 *   - `inScopeAncestorsByLeaf`: for each leaf, the in-scope ancestors whose
 *     caps still bind that leaf's cards.
 */
/** Rich per-deck headroom: enough info for both the picker (allowed) and
 *  the Reviewer footer pill (cap/used/sourceName). The picker only cares
 *  about `newAllowed` / `reviewAllowed`; getScopeCapStatus reads the rest. */
export interface DeckHeadroom {
  newAllowed: number;
  newCap: number;
  newUsed: number;
  newSource: string | null;
  reviewAllowed: number;
  reviewCap: number;
  reviewUsed: number;
  reviewSource: string | null;
}

export interface CapContext {
  scope: ReadonlySet<string>;
  /** Per deck (scope members + descendants), today's headroom + provenance. */
  headroomByDeck: Map<string, DeckHeadroom>;
  /** Per leaf, the in-scope ancestors (closest first). Includes the leaf itself only if it's in scope. */
  inScopeAncestorsByLeaf: Map<string, string[]>;
  /** ms timestamp at build time, retained so callers can correlate. */
  at: number;
}

/**
 * Build a CapContext for the given study scope. Network of DB calls is:
 *  - `decks.toArray()` once.
 *  - `reviewLogs` indexed range-scan from today's local midnight, once.
 *  - `getEffectiveDeckSettings(id)` for each deck whose cap might apply.
 * All other computation runs in-memory.
 */
async function buildCapContext(scope: string[], at: Date = new Date()): Promise<CapContext> {
  const scopeSet = new Set(scope);
  const allDecks = await db().decks.toArray();

  // Build descendant adjacency once: for each deck, the set of decks where
  // it's a parent (by parentId or by `::` name-prefix). One linear pass.
  const childrenOf = new Map<string, string[]>();
  for (const d of allDecks) {
    if (d.parentId) {
      const list = childrenOf.get(d.parentId) ?? [];
      list.push(d.id);
      childrenOf.set(d.parentId, list);
    }
    // Name-prefix children: any deck whose name starts with d.name + '::'.
    // We add an edge from d to each shorter-suffixed sibling.
  }
  // Add name-prefix edges. O(decks^2) worst-case but trivial in practice.
  const byName = new Map<string, Deck[]>();
  for (const d of allDecks) {
    const list = byName.get(d.name) ?? [];
    list.push(d);
    byName.set(d.name, list);
  }
  for (const d of allDecks) {
    const segs = d.name.split('::').map(s => s.trim()).filter(Boolean);
    for (let i = 1; i < segs.length; i++) {
      const ancestorName = segs.slice(0, i).join('::');
      const ancestors = byName.get(ancestorName) ?? [];
      for (const a of ancestors) {
        const list = childrenOf.get(a.id) ?? [];
        if (!list.includes(d.id)) list.push(d.id);
        childrenOf.set(a.id, list);
      }
    }
  }

  // For each scope member, BFS its subtree.
  const subtreeByScopeMember = new Map<string, string[]>();
  for (const id of scopeSet) {
    const subtree: string[] = [];
    const visited = new Set<string>([id]);
    const queue: string[] = [id];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      subtree.push(cur);
      const kids = childrenOf.get(cur) ?? [];
      for (const k of kids) {
        if (!visited.has(k)) {
          visited.add(k);
          queue.push(k);
        }
      }
    }
    subtreeByScopeMember.set(id, subtree);
  }

  // Union all subtree members — these are every deck a card we'd pick can live in.
  const allRelevantDeckIds = new Set<string>();
  for (const ids of subtreeByScopeMember.values()) for (const id of ids) allRelevantDeckIds.add(id);

  // Invert: for each leaf, which scope members claim it as a descendant?
  const inScopeAncestorsByLeaf = new Map<string, string[]>();
  for (const leaf of allRelevantDeckIds) {
    const list: string[] = [];
    for (const [s, ids] of subtreeByScopeMember) {
      if (ids.includes(leaf)) list.push(s);
    }
    inScopeAncestorsByLeaf.set(leaf, list);
  }

  // Pre-aggregate today's review log activity in a single indexed range scan,
  // bucketed by deckId. Avoids N parallel filtered counts.
  const since = startOfTodayMs(at);
  const todayLogs = await db().reviewLogs.where('review').aboveOrEqual(since).toArray();
  const newByDeck = new Map<string, number>();
  const reviewByDeck = new Map<string, number>();
  for (const l of todayLogs) {
    if (l.state === 'new') {
      newByDeck.set(l.deckId, (newByDeck.get(l.deckId) ?? 0) + 1);
    } else if (l.state === 'review' || l.state === 'relearning') {
      reviewByDeck.set(l.deckId, (reviewByDeck.get(l.deckId) ?? 0) + 1);
    }
  }

  // Effective settings per deck — resolved against the cached deck list, NO
  // additional DB calls. `getEffectiveDeckSettings` makes 5+ queries per deck
  // (one per ancestor hop × one per field-pick); for 25 scope members that's
  // ~125 round-trips. Pure-JS resolution keeps the precompute under 50ms.
  const decksById = new Map<string, Deck>();
  for (const d of allDecks) decksById.set(d.id, d);
  const ancestorChainCache = new Map<string, Deck[]>();
  function chainFor(deckId: string): Deck[] {
    const cached = ancestorChainCache.get(deckId);
    if (cached) return cached;
    const own = decksById.get(deckId);
    if (!own) {
      ancestorChainCache.set(deckId, []);
      return [];
    }
    const chain: Deck[] = [own];
    const seen = new Set<string>([deckId]);
    let cur: Deck | undefined = own;
    for (let hop = 0; hop < 32 && cur; hop++) {
      let next: Deck | undefined;
      if (cur.parentId) next = decksById.get(cur.parentId);
      if (!next) {
        const segs: string[] = cur.name.split('::').map((s: string) => s.trim()).filter(Boolean);
        for (let len = segs.length - 1; len >= 1; len--) {
          const ancestorName: string = segs.slice(0, len).join('::');
          const cand: Deck | undefined = (byName.get(ancestorName) ?? [])[0];
          if (cand && !seen.has(cand.id)) { next = cand; break; }
        }
      }
      if (!next || seen.has(next.id)) break;
      seen.add(next.id);
      chain.push(next);
      cur = next;
    }
    ancestorChainCache.set(deckId, chain);
    return chain;
  }

  function effectiveCapWithSource(
    deckId: string,
    key: 'newCardsPerDay' | 'reviewsPerDay',
    fallback: number,
  ): { value: number; source: string | null } {
    for (const d of chainFor(deckId)) {
      const v = d[key];
      if (v !== undefined && v !== null) return { value: v, source: d.name };
    }
    return { value: fallback, source: null };
  }

  const headroomByDeck = new Map<string, DeckHeadroom>();
  for (const id of allRelevantDeckIds) {
    const subtree = bfsSubtree(id, childrenOf);
    let newUsed = 0, reviewUsed = 0;
    for (const sid of subtree) {
      newUsed += newByDeck.get(sid) ?? 0;
      reviewUsed += reviewByDeck.get(sid) ?? 0;
    }
    const newE = effectiveCapWithSource(id, 'newCardsPerDay', DEFAULT_NEW_PER_DAY);
    const reviewE = effectiveCapWithSource(id, 'reviewsPerDay', DEFAULT_REVIEWS_PER_DAY);
    headroomByDeck.set(id, {
      newAllowed: Math.max(0, newE.value - newUsed),
      newCap: newE.value,
      newUsed,
      newSource: newE.source,
      reviewAllowed: Math.max(0, reviewE.value - reviewUsed),
      reviewCap: reviewE.value,
      reviewUsed,
      reviewSource: reviewE.source,
    });
  }

  return {
    scope: scopeSet,
    headroomByDeck,
    inScopeAncestorsByLeaf,
    at: at.getTime(),
  };
}

function bfsSubtree(rootId: string, childrenOf: Map<string, string[]>): string[] {
  const out: string[] = [];
  const seen = new Set<string>([rootId]);
  const queue: string[] = [rootId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    out.push(cur);
    const kids = childrenOf.get(cur) ?? [];
    for (const k of kids) {
      if (!seen.has(k)) { seen.add(k); queue.push(k); }
    }
  }
  return out;
}

/**
 * Synchronous per-candidate cap check against a precomputed `CapContext`.
 * Replaces the old async `cardAllowedByCaps`. All policy is unchanged:
 *   - learning/relearning steps bypass caps.
 *   - card's own deck cap applies, plus any in-scope ancestor's cap.
 *   - more restrictive wins; zero headroom anywhere blocks the card.
 */
function cardAllowedByCapsSync(card: Card, ctx: CapContext): boolean {
  const isNew = card.state === 'new';
  const isReview = card.state === 'review' || card.state === 'relearning';
  if (!isNew && !isReview) return true;

  const ancestorsInScope = ctx.inScopeAncestorsByLeaf.get(card.deckId) ?? [];
  // The card's own deck's cap always applies; in-scope ancestors stack on top.
  // Use a Set since ancestorsInScope can contain the leaf itself.
  const relevant = new Set<string>(ancestorsInScope);
  relevant.add(card.deckId);

  for (const id of relevant) {
    const h = ctx.headroomByDeck.get(id);
    if (!h) continue; // unknown — be lenient (shouldn't happen in practice).
    if (isNew && h.newAllowed <= 0) return false;
    if (isReview && h.reviewAllowed <= 0) return false;
  }
  return true;
}

/**
 * Aggregate cap status for the active study scope. Used by the Reviewer
 * footer pill to display "3/20 new today" with the most restrictive
 * source. Returns the most-restrictive cap across `studyDeckIds`.
 */
export interface ScopeCapStatus {
  newUsed: number;
  newCap: number;
  newSource: string | null;  // Deck name where the binding cap originates.
  reviewUsed: number;
  reviewCap: number;
  reviewSource: string | null;
}

export async function getScopeCapStatus(
  studyDeckIds: string[],
  at: Date = new Date(),
): Promise<ScopeCapStatus> {
  if (studyDeckIds.length === 0) {
    return {
      newUsed: 0, newCap: Infinity, newSource: null,
      reviewUsed: 0, reviewCap: Infinity, reviewSource: null,
    };
  }
  // Use the same one-pass precompute as the picker hot path. Previously this
  // helper called capHeadroomFor per scope deck — N×(getEffectiveDeckSettings
  // + listDescendantDeckIds + count query) round-trips, which doubled the
  // work the Reviewer was already doing in buildCapContext on the same
  // scope. One precompute, then we read the binding constraint in O(N).
  const ctx = await buildCapContext(studyDeckIds, at);
  let bindingNew = { used: 0, cap: Infinity, sourceName: null as string | null, allowed: Infinity };
  let bindingReview = { used: 0, cap: Infinity, sourceName: null as string | null, allowed: Infinity };
  for (const id of studyDeckIds) {
    const h = ctx.headroomByDeck.get(id);
    if (!h) continue;
    if (h.newAllowed < bindingNew.allowed) {
      bindingNew = { used: h.newUsed, cap: h.newCap, sourceName: h.newSource, allowed: h.newAllowed };
    }
    if (h.reviewAllowed < bindingReview.allowed) {
      bindingReview = { used: h.reviewUsed, cap: h.reviewCap, sourceName: h.reviewSource, allowed: h.reviewAllowed };
    }
  }
  return {
    newUsed: bindingNew.used,
    newCap: bindingNew.cap,
    newSource: bindingNew.sourceName,
    reviewUsed: bindingReview.used,
    reviewCap: bindingReview.cap,
    reviewSource: bindingReview.sourceName,
  };
}

/* ─── Notes & Cards ──────────────────────────────────────────── */

export interface NewNoteInput {
  deckId: string;
  fields: NoteFields;
  tags?: string[];
  tier?: Tier;
  modelId?: 'basic' | 'cloze' | 'image-occlusion' | string;
  occlusions?: import('./schema').OcclusionRect[];
  siblings?: import('./schema').SiblingDef[];
}

/**
 * Create a Note + 1..N Cards. If `front` contains cloze syntax, one card per
 * distinct ord (and `modelId` defaults to 'cloze'); otherwise a single card
 * (modelId 'basic').
 */
export async function createNote(input: NewNoteInput): Promise<{ note: Note; cards: Card[] }> {
  const t = now();
  const isOcclusion = input.modelId === 'image-occlusion';
  const isCloze = !isOcclusion && (input.modelId === 'cloze' || hasCloze(input.fields.front));
  const modelId = input.modelId ?? (isCloze ? 'cloze' : 'basic');
  const siblings = !isOcclusion && !isCloze && input.siblings && input.siblings.length > 0
    ? input.siblings
    : undefined;
  const note: Note = {
    id: id(),
    deckId: input.deckId,
    modelId,
    fields: input.fields,
    tags: input.tags ?? [],
    tier: input.tier,
    occlusions: isOcclusion ? input.occlusions : undefined,
    siblings,
    createdAt: t,
    modifiedAt: t,
  };
  const empty = emptyCard(new Date(t));
  const cards: Card[] = [];
  if (isOcclusion) {
    const occlusions = input.occlusions ?? [];
    for (let i = 0; i < occlusions.length; i++) {
      cards.push({
        id: id(),
        noteId: note.id,
        deckId: input.deckId,
        clozeOrd: i + 1,
        ...empty,
        suspended: false,
        buried: false,
        createdAt: t,
        modifiedAt: t,
      });
    }
    if (cards.length === 0) {
      // No rectangles drawn — at least produce a single card so the note exists.
      cards.push({
        id: id(), noteId: note.id, deckId: input.deckId, clozeOrd: 1,
        ...empty, suspended: false, buried: false, createdAt: t, modifiedAt: t,
      });
    }
  } else if (isCloze) {
    const ords = clozeOrds(input.fields.front);
    if (ords.length === 0) ords.push(1);
    for (const ord of ords) {
      cards.push({
        id: id(),
        noteId: note.id,
        deckId: input.deckId,
        clozeOrd: ord,
        ...empty,
        suspended: false,
        buried: false,
        createdAt: t,
        modifiedAt: t,
      });
    }
  } else if (siblings) {
    for (const s of siblings) {
      cards.push({
        id: id(),
        noteId: note.id,
        deckId: input.deckId,
        siblingId: s.id,
        ...empty,
        suspended: false,
        buried: false,
        createdAt: t,
        modifiedAt: t,
      });
    }
  } else {
    cards.push({
      id: id(),
      noteId: note.id,
      deckId: input.deckId,
      ...empty,
      suspended: false,
      buried: false,
      createdAt: t,
      modifiedAt: t,
    });
  }
  await db().transaction('rw', db().notes, db().cards, async () => {
    await db().notes.put(note);
    await db().cards.bulkPut(cards);
  });
  // Search index update happens in a separate txn — keeps the hot create
  // path narrow and the index eventually consistent (sub-millisecond gap
  // in practice).
  await indexNoteSafe(note);
  return { note, cards };
}

/* ─── Xlinks (re-exported from ./xlinks) ─────────────────────── */

export {
  resolveXlink,
  extractXlinks,
  validateNoteXlinks,
  auditXlinks,
  type XlinkResolution,
  type NoteXlinkReport,
  type XlinkAuditSummary,
} from './xlinks';

export async function getNote(noteId: string): Promise<Note | undefined> {
  return db().notes.get(noteId);
}

export async function listNotes(deckId: string, limit = 200): Promise<Note[]> {
  return db().notes
    .where('deckId').equals(deckId)
    .reverse()
    .limit(limit)
    .toArray();
}

/**
 * Unlimited variant of `listNotes`. Used when callers need to enumerate every
 * note in a deck (e.g. image-source sync needs to find every `<img src>` in
 * every note). Order is unspecified — callers that care must sort.
 */
export async function listAllNotesInDeck(deckId: string): Promise<Note[]> {
  return db().notes.where('deckId').equals(deckId).toArray();
}

export interface UpdateNoteInput {
  fields?: Partial<NoteFields>;
  tags?: string[];
  tier?: Tier;
  /**
   * Sibling list for basic notes. Pass an empty array to clear siblings (and
   * collapse back to a single card). Omit to leave siblings unchanged.
   */
  siblings?: import('./schema').SiblingDef[];
}

/**
 * Update a note. If cloze ords change, we add/remove cards to match (preserving
 * scheduling state of unchanged ords).
 */
export async function updateNote(noteId: string, patch: UpdateNoteInput): Promise<void> {
  await db().transaction('rw', db().notes, db().cards, async () => {
    const note = await db().notes.get(noteId);
    if (!note) return;
    const newFields: NoteFields = { ...note.fields, ...patch.fields };
    const t = now();
    const newSiblings = patch.siblings !== undefined
      ? (patch.siblings.length ? patch.siblings : undefined)
      : note.siblings;
    const updated: Note = {
      ...note,
      fields: newFields,
      tags: patch.tags ?? note.tags,
      tier: patch.tier ?? note.tier,
      siblings: newSiblings,
      modifiedAt: t,
    };
    await db().notes.put(updated);

    // Sync sibling cards on basic notes whose sibling list changed.
    if (note.modelId !== 'cloze' && note.modelId !== 'image-occlusion' && patch.siblings !== undefined) {
      const desired = newSiblings ?? [];
      const wantedIds = new Set(desired.map(s => s.id));
      const existing = await db().cards.where('noteId').equals(noteId).toArray();
      const empty = emptyCard(new Date(t));

      // Single-card → multi-sibling: drop the lone card if it has no siblingId.
      const lone = existing.find(c => c.siblingId === undefined && c.clozeOrd === undefined);
      if (lone && desired.length > 0) {
        await db().cards.delete(lone.id);
      }

      // Add new siblings, drop ones that no longer exist.
      const haveSiblingIds = new Set(existing.map(c => c.siblingId).filter((x): x is string => !!x));
      const toAdd: Card[] = [];
      for (const s of desired) {
        if (!haveSiblingIds.has(s.id)) {
          toAdd.push({
            id: id(),
            noteId,
            deckId: note.deckId,
            siblingId: s.id,
            ...empty,
            suspended: false,
            buried: false,
            createdAt: t,
            modifiedAt: t,
          });
        }
      }
      const toDelete = existing
        .filter(c => c.siblingId !== undefined && !wantedIds.has(c.siblingId))
        .map(c => c.id);
      if (toDelete.length) await db().cards.bulkDelete(toDelete);
      if (toAdd.length) await db().cards.bulkPut(toAdd);

      // Multi-sibling → single: ensure exactly one bare card exists.
      if (desired.length === 0) {
        const remaining = await db().cards.where('noteId').equals(noteId).toArray();
        const bare = remaining.find(c => c.siblingId === undefined && c.clozeOrd === undefined);
        if (!bare) {
          await db().cards.bulkDelete(remaining.map(c => c.id));
          await db().cards.put({
            id: id(),
            noteId,
            deckId: note.deckId,
            ...empty,
            suspended: false,
            buried: false,
            createdAt: t,
            modifiedAt: t,
          });
        }
      }
    }

    if (note.modelId === 'cloze') {
      const newOrds = new Set(clozeOrds(newFields.front));
      if (newOrds.size === 0) newOrds.add(1);
      const existingCards = await db().cards.where('noteId').equals(noteId).toArray();
      const existingOrds = new Set(existingCards.map(c => c.clozeOrd!).filter(x => x !== undefined));
      const empty = emptyCard(new Date(t));
      const toAdd: Card[] = [];
      for (const ord of newOrds) {
        if (!existingOrds.has(ord)) {
          toAdd.push({
            id: id(),
            noteId,
            deckId: note.deckId,
            clozeOrd: ord,
            ...empty,
            suspended: false,
            buried: false,
            createdAt: t,
            modifiedAt: t,
          });
        }
      }
      const toDelete: string[] = [];
      for (const c of existingCards) {
        if (c.clozeOrd !== undefined && !newOrds.has(c.clozeOrd)) toDelete.push(c.id);
      }
      if (toDelete.length) await db().cards.bulkDelete(toDelete);
      if (toAdd.length) await db().cards.bulkPut(toAdd);
    }
  });
  // Re-index after the note write commits.
  const fresh = await db().notes.get(noteId);
  if (fresh) await indexNoteSafe(fresh);
}

export async function deleteNote(noteId: string): Promise<void> {
  await db().transaction('rw', db().notes, db().cards, db().reviewLogs, async () => {
    const cardIds = (await db().cards.where('noteId').equals(noteId).primaryKeys()) as string[];
    await db().reviewLogs.where('cardId').anyOf(cardIds).delete();
    await db().cards.where('noteId').equals(noteId).delete();
    await db().notes.delete(noteId);
  });
  await unindexNoteSafe(noteId);
}

/* ─── Cards / scheduling ─────────────────────────────────────── */

export async function getCard(cardId: string): Promise<Card | undefined> {
  return db().cards.get(cardId);
}

export interface DeckCounts {
  new: number;
  learning: number;
  review: number;
  total: number;
}

export async function getDeckCounts(deckId: string | string[], at: Date = new Date()): Promise<DeckCounts> {
  const nowMs = at.getTime();
  const ids = Array.isArray(deckId) ? deckId : [deckId];
  const cursor = ids.length === 1
    ? db().cards.where('deckId').equals(ids[0])
    : db().cards.where('deckId').anyOf(ids);
  const all = await cursor.toArray();
  const counts = { new: 0, learning: 0, review: 0, total: 0 };
  // Buried cards still count toward their state — burying is a transient
  // hide-from-picker, not a state transition. Excluding them made the
  // header counts shrink mid-session ("rate one cloze, watch 3 disappear
  // from NEW") instead of reflecting the actual deck composition.
  // Suspended cards are user-initiated parking and are excluded.
  for (const c of all) {
    if (c.suspended) continue;
    counts.total++;
    if (c.state === 'new') counts.new++;
    else if (c.state === 'learning' || c.state === 'relearning') counts.learning++;
    else if (c.state === 'review' && c.due <= nowMs) counts.review++;
  }
  return counts;
}

/**
 * Same as `getDeckCounts` but rolls up every descendant in the `::`
 * hierarchy. Use this on the deck detail page; the home tree's
 * sumCounts already aggregates differently (purely tree-walked).
 */
export async function getDeckCountsAggregate(deckId: string, at: Date = new Date()): Promise<DeckCounts> {
  const own = await getDeckCounts(deckId, at);
  const descendantIds = await listDescendantDeckIds(deckId);
  if (descendantIds.length === 0) return own;
  const childCounts = await Promise.all(descendantIds.map(id => getDeckCounts(id, at)));
  return childCounts.reduce(
    (acc, c) => ({
      new: acc.new + c.new,
      learning: acc.learning + c.learning,
      review: acc.review + c.review,
      total: acc.total + c.total,
    }),
    own,
  );
}

/** Sum counts across an arbitrary set of decks. Used by the path view. */
export async function getCountsForDecks(deckIds: string[], at: Date = new Date()): Promise<DeckCounts> {
  if (deckIds.length === 0) return { new: 0, learning: 0, review: 0, total: 0 };
  const partial = await Promise.all(deckIds.map(id => getDeckCounts(id, at)));
  return partial.reduce(
    (acc, c) => ({
      new: acc.new + c.new,
      learning: acc.learning + c.learning,
      review: acc.review + c.review,
      total: acc.total + c.total,
    }),
    { new: 0, learning: 0, review: 0, total: 0 },
  );
}

/**
 * Resolve a `::`-joined deck-name path into all matching deck IDs. Matches:
 *   - any deck whose name === path  (the explicit deck at that path, if any)
 *   - any deck whose name starts with `path + "::"`  (descendants)
 *
 * Used by /decks/path/[encoded] to support clicking a path-only intermediate
 * (where no explicit Deck row exists for that segment) — the page aggregates
 * across every deck under the prefix.
 */
export async function decksByPath(path: string): Promise<Deck[]> {
  const prefix = path + '::';
  const all = await db().decks.toArray();
  return all.filter(d => d.name === path || d.name.startsWith(prefix));
}

/**
 * Pick the next card to review for a deck.
 * Priority: learning/relearning (due) → review (due, oldest first) → new (oldest first).
 * Daily caps (newCardsPerDay, reviewsPerDay) are enforced *per candidate*:
 * a card is admitted only if every relevant deck (its own and any ancestor
 * also in scope) still has headroom under its effective cap.
 */
/**
 * Picker options. `force: true` is the "Continue ahead anyway" escape
 * hatch surfaced in the Reviewer's empty-state. Behavior:
 *   - Learning / relearning: drop the `due <= now` gate so cards mid-step
 *     come up immediately instead of waiting on the timer.
 *   - New cards: ignore the daily cap so capped pools open back up.
 *   - Reviews: STILL gated by `due <= now`. The user explicitly asked
 *     not to be served reviews that are due tomorrow when they're trying
 *     to grind through learning + new today.
 */
export interface PickerOptions {
  force?: boolean;
}

export async function getNextCardForStudy(
  deckId: string | string[],
  at: Date = new Date(),
  opts: PickerOptions = {},
): Promise<Card | undefined> {
  const nowMs = at.getTime();
  const force = opts.force === true;
  const ids = Array.isArray(deckId) ? deckId : [deckId];
  const queryByState = (state: 'learning' | 'relearning' | 'review' | 'new') =>
    ids.length === 1
      ? db().cards.where('[deckId+state]').equals([ids[0], state] as [string, string])
      : db().cards.where('[deckId+state]').anyOf(ids.map(d => [d, state] as [string, string]));

  // Learning/relearning steps bypass caps (Anki convention) — they're
  // mid-flight, not new introductions or full reviews. In force mode
  // we drop the `due <= now` gate too so the user can grind through
  // pending learning steps before they would naturally come up.
  const learning = force
    ? (await queryByState('learning')
        .filter(c => !c.suspended && !c.buried)
        .sortBy('due'))[0]
    : await queryByState('learning')
        .filter(c => !c.suspended && !c.buried && c.due <= nowMs)
        .first();
  if (learning) return learning;

  const relearning = force
    ? (await queryByState('relearning')
        .filter(c => !c.suspended && !c.buried)
        .sortBy('due'))[0]
    : await queryByState('relearning')
        .filter(c => !c.suspended && !c.buried && c.due <= nowMs)
        .first();
  if (relearning) return relearning;

  // Reviews: keep the due gate even in force mode. The user said
  // explicitly that they want learning + new to flow, not future
  // reviews dragged forward.
  const review = await queryByState('review')
    .filter(c => !c.suspended && !c.buried && c.due <= nowMs)
    .sortBy('due');

  const newCards = await queryByState('new')
    .filter(c => !c.suspended && !c.buried)
    .sortBy('createdAt');

  // Build the cap context exactly once for the whole pick. `cardAllowedByCapsSync`
  // then runs as a Map lookup — orders of magnitude faster than the
  // per-candidate version when the candidate pool is large. In force
  // mode we skip cap construction entirely; every card is allowed.
  const ctx = (!force && (review.length > 0 || newCards.length > 0))
    ? await buildCapContext(ids, at)
    : null;

  if (ctx) {
    for (const c of review) {
      if (cardAllowedByCapsSync(c, ctx)) return c;
    }
  } else if (force && review.length > 0) {
    // Force mode skipped cap-context, but reviews here are still
    // genuinely due (passed the due-gate above) so they're fair game.
    return review[0];
  }

  if (newCards.length > 0) {
    const deck = await db().decks.get(ids[0]);
    const order = deck?.newCardOrder ?? 'added';
    const ordered = order === 'tagInterleaved'
      ? await tagInterleaveOrder(newCards)
      : order === 'random'
        ? shuffle(newCards)
        : newCards; // 'added' = ASC by createdAt, already sorted.
    for (const c of ordered) {
      if (force || ctx === null || cardAllowedByCapsSync(c, ctx)) return c;
    }
  }

  return undefined;
}

function shuffle<T>(arr: T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Same priority logic as `getNextCardForStudy` but excludes a specific
 * card. Used by the Reviewer to prefetch the *next-next* card while the
 * current one is on screen, so the perceived latency between rate and
 * reveal of the next card is near zero.
 */
export async function peekNextCardForStudy(
  deckId: string | string[],
  excludeCardId: string,
  at: Date = new Date(),
  opts: PickerOptions = {},
): Promise<Card | undefined> {
  const nowMs = at.getTime();
  const force = opts.force === true;
  const ids = Array.isArray(deckId) ? deckId : [deckId];
  const queryByState = (state: 'learning' | 'relearning' | 'review' | 'new') =>
    ids.length === 1
      ? db().cards.where('[deckId+state]').equals([ids[0], state] as [string, string])
      : db().cards.where('[deckId+state]').anyOf(ids.map(d => [d, state] as [string, string]));

  const learning = force
    ? (await queryByState('learning')
        .filter(c => c.id !== excludeCardId && !c.suspended && !c.buried)
        .sortBy('due'))[0]
    : await queryByState('learning')
        .filter(c => c.id !== excludeCardId && !c.suspended && !c.buried && c.due <= nowMs)
        .first();
  if (learning) return learning;

  const relearning = force
    ? (await queryByState('relearning')
        .filter(c => c.id !== excludeCardId && !c.suspended && !c.buried)
        .sortBy('due'))[0]
    : await queryByState('relearning')
        .filter(c => c.id !== excludeCardId && !c.suspended && !c.buried && c.due <= nowMs)
        .first();
  if (relearning) return relearning;

  // Reviews: due-gated even in force mode (matches getNextCardForStudy).
  const review = await queryByState('review')
    .filter(c => c.id !== excludeCardId && !c.suspended && !c.buried && c.due <= nowMs)
    .sortBy('due');

  const newCards = await queryByState('new')
    .filter(c => c.id !== excludeCardId && !c.suspended && !c.buried)
    .sortBy('createdAt');

  const ctx = (!force && (review.length > 0 || newCards.length > 0))
    ? await buildCapContext(ids, at)
    : null;

  if (ctx) {
    for (const c of review) {
      if (cardAllowedByCapsSync(c, ctx)) return c;
    }
  } else if (force && review.length > 0) {
    return review[0];
  }

  if (newCards.length > 0) {
    const deck = await db().decks.get(ids[0]);
    const order = deck?.newCardOrder ?? 'added';
    const ordered = order === 'tagInterleaved'
      ? await tagInterleaveOrder(newCards)
      : order === 'random'
        ? shuffle(newCards)
        : newCards;
    for (const c of ordered) {
      if (force || ctx === null || cardAllowedByCapsSync(c, ctx)) return c;
    }
  }
  return undefined;
}

/**
 * Same priority order as `getNextCardForStudy` but scoped to a set of
 * noteIds (for practice queries / filtered review queues). Decks aren't
 * considered — cards from any deck are eligible if their noteId matches.
 */
export async function getNextCardFromNoteSet(
  noteIds: ReadonlySet<string>,
  at: Date = new Date(),
): Promise<Card | undefined> {
  if (noteIds.size === 0) return undefined;
  const nowMs = at.getTime();
  // Pull all candidate cards and sort/select in JS — avoids a Dexie cross-
  // index query on a large set, fine for practice queues up to ~10K notes.
  const cards = await db().cards.where('noteId').anyOf([...noteIds]).toArray();
  const eligible = cards.filter(c => !c.suspended && !c.buried);

  const learning = eligible.find(c => c.state === 'learning' && c.due <= nowMs);
  if (learning) return learning;
  const relearning = eligible.find(c => c.state === 'relearning' && c.due <= nowMs);
  if (relearning) return relearning;
  const reviews = eligible
    .filter(c => c.state === 'review' && c.due <= nowMs)
    .sort((a, b) => a.due - b.due);
  if (reviews.length) return reviews[0];
  const newOnes = eligible
    .filter(c => c.state === 'new')
    .sort((a, b) => a.createdAt - b.createdAt);
  if (newOnes.length) return newOnes[0];
  return undefined;
}

/**
 * Honor a deck's `newCardOrder`. Input is FIFO-sorted by createdAt.
 *  - 'added': return the head as-is.
 *  - 'random': return a random pick.
 *  - 'tagInterleaved': pick from the bucket whose tag has the fewest already-
 *    studied cards in this session — best-effort, computed by partitioning
 *    the pool by each note's first tag.
 */
function pickNewCard(cards: Card[], order: NewCardOrder): Card {
  if (cards.length === 1 || order === 'added') return cards[0];
  if (order === 'random') {
    return cards[Math.floor(Math.random() * cards.length)];
  }
  // tagInterleaved: round-robin by the cards' noteIds → first-tag bucket.
  // Without an in-memory tag map we fall back to FIFO; this branch is best-
  // effort and only runs when the user has explicitly opted in.
  return cards[0];
}

/**
 * Build a tag-interleaved sequence from a list of new cards using the loaded
 * notes so the round-robin actually has tag info to work with. Used by the
 * Reviewer when it pre-fetches a session's new-card queue.
 */
export async function tagInterleaveOrder(cards: Card[]): Promise<Card[]> {
  if (cards.length <= 1) return cards;
  const noteIds = [...new Set(cards.map(c => c.noteId))];
  const notes = await db().notes.where('id').anyOf(noteIds).toArray();
  const firstTagByNote = new Map<string, string>();
  for (const n of notes) {
    firstTagByNote.set(n.id, n.tags[0] ?? '');
  }
  const buckets = new Map<string, Card[]>();
  for (const c of cards) {
    const t = firstTagByNote.get(c.noteId) ?? '';
    const list = buckets.get(t) ?? [];
    list.push(c);
    buckets.set(t, list);
  }
  // Round-robin: pop from each bucket in turn until all empty.
  const order: Card[] = [];
  const lists = [...buckets.values()];
  let any = true;
  while (any) {
    any = false;
    for (const list of lists) {
      const next = list.shift();
      if (next) {
        order.push(next);
        any = true;
      }
    }
  }
  return order;
}

/**
 * Default sibling-bury duration when the user has not set
 * `sibling_bury_minutes`. Five minutes puts a handful of unrelated cards
 * between c1 and c2 at typical study pace, and is short enough that c2
 * still gets practiced in the same session.
 */
const DEFAULT_SIBLING_BURY_MS = 5 * 60 * 1000;

/**
 * Read the user-configured sibling-bury duration from settings. Returns 0
 * to disable the feature entirely (siblings stay in the queue right
 * after each other, like before the bury was introduced).
 */
async function getSiblingBuryMs(): Promise<number> {
  const stored = await getSetting('sibling_bury_minutes');
  if (stored === undefined) return DEFAULT_SIBLING_BURY_MS;
  const m = parseFloat(stored);
  if (!Number.isFinite(m) || m < 0) return DEFAULT_SIBLING_BURY_MS;
  return Math.round(m * 60 * 1000);
}

export async function recordReview(
  card: Card,
  rating: Rating,
  durationMs: number,
  opts: SchedulerOptions = {},
): Promise<{ updatedCard: Card; log: ReviewLog; siblingsBurried: number }> {
  const { cardPatch, log } = applyRating(card, rating, durationMs, opts);
  const updatedCard: Card = { ...card, ...cardPatch };
  const dbi = db();

  // Sibling-bury for cloze: hide the other cards of the same note for the rest
  // of today, so c1/c2/c3 don't appear back-to-back. Pre-collect siblings
  // before opening the write transaction.
  const tomorrow = new Date();
  tomorrow.setHours(0, 0, 0, 0);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowMs = tomorrow.getTime();

  const buryMs = await getSiblingBuryMs();

  const siblingIds = buryMs > 0
    ? (await dbi.cards
        .where('noteId').equals(card.noteId)
        .filter(c => c.id !== card.id && !c.suspended && !c.buried && c.due < tomorrowMs)
        .primaryKeys()) as string[]
    : [];

  await dbi.transaction('rw', [dbi.cards, dbi.reviewLogs, dbi.settings], async () => {
    await dbi.cards.put(updatedCard);
    await dbi.reviewLogs.put(log);
    // Save pre-review snapshot keyed by log id so undo can restore exactly.
    await dbi.settings.put({
      key: `__preReview:${log.id}`,
      value: JSON.stringify({
        due: card.due, stability: card.stability, difficulty: card.difficulty,
        elapsedDays: card.elapsedDays, scheduledDays: card.scheduledDays,
        learningSteps: card.learningSteps, reps: card.reps, lapses: card.lapses,
        state: card.state, lastReview: card.lastReview ?? null,
        siblingIds, // for undo of sibling burial
      }),
    });
    // Sibling-bury: defer same-note siblings by `buryMs` so c2 doesn't
    // immediately follow c1, but still gets practiced this session.
    if (siblingIds.length) {
      const siblings = await dbi.cards.where('id').anyOf(siblingIds).toArray();
      const t = now();
      const until = t + buryMs;
      await dbi.cards.bulkPut(
        siblings.map(s => ({ ...s, buried: true, buriedUntil: until, modifiedAt: t })),
      );
    }
  });

  // Leech detection — when lapses crosses the threshold, auto-flag the note
  // as `broken` so it surfaces in the Leeches lane. Don't overwrite a flag
  // the user has set deliberately. The threshold is configurable via the
  // `leech_threshold` setting (default 8).
  if (updatedCard.lapses >= 8 && card.lapses < updatedCard.lapses) {
    void (async () => {
      try {
        const stored = await getSetting('leech_threshold');
        const threshold = stored ? parseInt(stored, 10) : 8;
        if (!Number.isFinite(threshold) || updatedCard.lapses < threshold) return;
        const note = await dbi.notes.get(card.noteId);
        if (!note || note.flag) return;
        await dbi.notes.update(card.noteId, { flag: 'broken', modifiedAt: now() });
      } catch { /* leech-tagging is best-effort; never break a review */ }
    })();
  }

  return { updatedCard, log, siblingsBurried: siblingIds.length };
}

/** Restore the card to its pre-review state and delete the most recent log.
 *  Also un-buries any siblings that were buried as part of the review. */
export async function rollbackReview(cardId: string, logId: string): Promise<boolean> {
  const dbi = db();
  const snapKey = `__preReview:${logId}`;
  const snap = await dbi.settings.get(snapKey);
  if (!snap) return false;
  const restore = JSON.parse(snap.value);
  await dbi.transaction('rw', dbi.cards, dbi.reviewLogs, dbi.settings, async () => {
    const c = await dbi.cards.get(cardId);
    if (!c) return;
    await dbi.cards.put({
      ...c,
      due: restore.due,
      stability: restore.stability,
      difficulty: restore.difficulty,
      elapsedDays: restore.elapsedDays,
      scheduledDays: restore.scheduledDays,
      learningSteps: restore.learningSteps,
      reps: restore.reps,
      lapses: restore.lapses,
      state: restore.state,
      lastReview: restore.lastReview ?? undefined,
      modifiedAt: now(),
    });
    if (Array.isArray(restore.siblingIds) && restore.siblingIds.length) {
      const siblings = await dbi.cards.where('id').anyOf(restore.siblingIds).toArray();
      await dbi.cards.bulkPut(
        siblings.map(s => ({ ...s, buried: false, buriedUntil: undefined, modifiedAt: now() })),
      );
    }
    await dbi.reviewLogs.delete(logId);
    await dbi.settings.delete(snapKey);
  });
  return true;
}

/** Manual bury: hide the card until tomorrow's local day-start (Anki convention). */
export async function buryCard(cardId: string): Promise<void> {
  const tomorrow = new Date();
  tomorrow.setHours(0, 0, 0, 0);
  tomorrow.setDate(tomorrow.getDate() + 1);
  await db().cards.update(cardId, {
    buried: true,
    buriedUntil: tomorrow.getTime(),
    modifiedAt: now(),
  });
}

/** Suspend a card indefinitely (won't appear until manually unsuspended). */
export async function suspendCard(cardId: string): Promise<void> {
  await db().cards.update(cardId, { suspended: true, modifiedAt: now() });
}

/**
 * Release any cards whose bury window has expired. Called at the top of
 * every fetchNext, so within the same study session a sibling-buried c2
 * pops back into the queue once SIBLING_BURY_MS has elapsed since c1 was
 * rated.
 *
 * Legacy rows from before buriedUntil existed have `buried: true` with no
 * timestamp; we treat those as expired so upgrading users aren't stuck.
 */
export async function unburryStaleCards(deckId: string | string[]): Promise<void> {
  const t = Date.now();
  const ids = Array.isArray(deckId) ? deckId : [deckId];
  const cursor = ids.length === 1
    ? db().cards.where('deckId').equals(ids[0])
    : db().cards.where('deckId').anyOf(ids);
  const stale = await cursor
    .filter(c => c.buried && (c.buriedUntil === undefined || c.buriedUntil <= t))
    .toArray();
  if (stale.length === 0) return;
  await db().cards.bulkPut(
    stale.map(c => ({ ...c, buried: false, buriedUntil: undefined, modifiedAt: t })),
  );
}

export async function listCardsByDeck(deckId: string, limit = 500): Promise<Card[]> {
  return db().cards.where('deckId').equals(deckId).limit(limit).toArray();
}

export async function listCardsByNote(noteId: string): Promise<Card[]> {
  return db().cards.where('noteId').equals(noteId).toArray();
}

/** Reverse-chronological review log for a single card. */
export async function listReviewsForCard(cardId: string): Promise<ReviewLog[]> {
  const logs = await db().reviewLogs.where('cardId').equals(cardId).toArray();
  return logs.sort((a, b) => b.review - a.review);
}

/**
 * Fetch the most recent review logs across the given decks that still have
 * a pre-review snapshot in settings (i.e. are still rollback-able). Used
 * by the Reviewer's undo to walk back through history after a reload, when
 * the in-memory stack is empty. Returns up to `limit` logs newest-first.
 */
export async function listRecentUndoableReviews(
  deckIds: string[],
  limit = 50,
): Promise<ReviewLog[]> {
  if (deckIds.length === 0) return [];
  const dbi = db();
  const ids = new Set(deckIds);
  // Pull the newest logs in scope. Dexie's reverse() walks the index from
  // the back; combined with limit() this avoids loading the full table.
  const logs = await dbi.reviewLogs
    .orderBy('review')
    .reverse()
    .filter(l => ids.has(l.deckId))
    .limit(limit)
    .toArray();
  if (logs.length === 0) return logs;
  // Filter to logs that still have an undo snapshot (older reviews may
  // have had their snapshot rolled back already).
  const snapKeys = logs.map(l => `__preReview:${l.id}`);
  const snaps = await dbi.settings.where('key').anyOf(snapKeys).primaryKeys();
  const haveSnap = new Set(snaps as string[]);
  return logs.filter(l => haveSnap.has(`__preReview:${l.id}`));
}

const FLAG_CYCLE: ReadonlyArray<NoteFlag | undefined> = [
  undefined, 'revisit', 'broken', 'exemplar', 'errata',
];

/** Set or clear a flag on a note. Pass undefined to clear. */
export async function setNoteFlag(noteId: string, flag: NoteFlag | undefined): Promise<void> {
  await db().notes.update(noteId, {
    flag: flag,
    modifiedAt: now(),
  } as Partial<Note>);
}

/** Cycle a note's flag in the order defined by FLAG_CYCLE. Returns the new flag. */
export async function cycleNoteFlag(noteId: string): Promise<NoteFlag | undefined> {
  const note = await db().notes.get(noteId);
  if (!note) return undefined;
  const idx = FLAG_CYCLE.indexOf(note.flag);
  const next = FLAG_CYCLE[(idx + 1) % FLAG_CYCLE.length];
  await setNoteFlag(noteId, next);
  return next;
}

/** Lift suspension on a card. */
export async function unsuspendCard(cardId: string): Promise<void> {
  await db().cards.update(cardId, { suspended: false, modifiedAt: now() });
}

/** Lift the buried flag without resetting due date. */
export async function unburyCard(cardId: string): Promise<void> {
  await db().cards.update(cardId, { buried: false, buriedUntil: undefined, modifiedAt: now() });
}

/**
 * Re-anchor every multi-day-interval card's `due` to the next day-cutoff
 * after `lastReview + scheduledDays`. Idempotent: running it twice on
 * the same data yields the same result. Skips:
 *   - cards without a lastReview (never been graded)
 *   - cards whose scheduledDays < 1 (sub-day learning steps stay
 *     wall-clock — the whole point is to keep "see it in 10 minutes"
 *     meaning ten actual minutes)
 *   - suspended cards (no point rescheduling something the user
 *     deliberately parked)
 *
 * Returns how many rows were touched so the UI can confirm.
 */
export async function recomputeDueWithDayCutoff(dayStartHour: number): Promise<{ updated: number; total: number }> {
  if (!Number.isFinite(dayStartHour) || dayStartHour < 0 || dayStartHour > 23) {
    throw new Error('dayStartHour must be 0..23');
  }
  const dbi = db();
  const all = await dbi.cards.toArray();
  let total = 0;
  let updated = 0;
  const t = now();
  const patches: Card[] = [];
  for (const c of all) {
    if (c.suspended) continue;
    if (typeof c.lastReview !== 'number') continue;
    if (typeof c.scheduledDays !== 'number' || c.scheduledDays < 1) continue;
    total++;
    const nextDue = computeDayCutoffDue(c.lastReview, c.scheduledDays, dayStartHour);
    if (nextDue !== c.due) {
      patches.push({ ...c, due: nextDue, modifiedAt: t });
      updated++;
    }
  }
  if (patches.length > 0) {
    await dbi.cards.bulkPut(patches);
  }
  return { updated, total };
}

/**
 * Local computation of the day-cutoff due timestamp; mirror of
 * `dayCutoffDue` in lib/fsrs/scheduler.ts. Duplicated here so the
 * migration helper doesn't pull the FSRS module just to reach a 4-line
 * date-arithmetic function.
 */
function computeDayCutoffDue(lastReview: number, scheduledDays: number, dayStartHour: number): number {
  const dt = new Date(lastReview);
  if (dt.getHours() < dayStartHour) {
    dt.setDate(dt.getDate() - 1);
  }
  dt.setHours(dayStartHour, 0, 0, 0);
  dt.setDate(dt.getDate() + scheduledDays);
  return dt.getTime();
}

/** Send a card back to a 'new' state, wiping FSRS history. */
export async function resetCardProgress(cardId: string): Promise<void> {
  const card = await db().cards.get(cardId);
  if (!card) return;
  const empty = emptyCard();
  await db().cards.update(cardId, {
    ...empty,
    suspended: card.suspended,
    buried: false,
    modifiedAt: now(),
  });
}

/** Manually move a card's due date and force into 'review' state. */
export async function rescheduleCard(cardId: string, dueMs: number): Promise<void> {
  const card = await db().cards.get(cardId);
  if (!card) return;
  await db().cards.update(cardId, {
    due: dueMs,
    state: card.state === 'new' ? 'review' : card.state,
    modifiedAt: now(),
  });
}

/**
 * Push a card forward by `delayMs` without altering FSRS state. Returns the
 * previous due date so the caller can offer Undo. Snooze does NOT log a
 * review (FSRS would interpret it as a missed review and tank stability) —
 * it's purely a "not now" gesture.
 */
export async function snoozeCard(cardId: string, delayMs: number): Promise<{ previousDue: number } | null> {
  const card = await db().cards.get(cardId);
  if (!card) return null;
  const previousDue = card.due;
  await db().cards.update(cardId, {
    due: Date.now() + delayMs,
    modifiedAt: now(),
  });
  return { previousDue };
}

/** Restore a card's due to a previous value (used to undo a snooze). */
export async function restoreCardDue(cardId: string, dueMs: number): Promise<void> {
  await db().cards.update(cardId, { due: dueMs, modifiedAt: now() });
}

/* ─── Note-type conversion ────────────────────────────────────── */

export type ConvertTarget = 'basic' | 'cloze';

/**
 * Compute the field rewrite that a basic↔cloze conversion would produce,
 * without writing to the DB. Used to preview the change.
 */
export function previewConvertNoteType(
  note: Note,
  target: ConvertTarget,
): { fields: NoteFields; willDeleteHistory: boolean } {
  if (note.modelId === target) {
    return { fields: note.fields, willDeleteHistory: false };
  }

  if (target === 'cloze') {
    // basic → cloze: wrap the back into a cloze on a new line of the front,
    // so a single Card per cloze ord drives the whole note.
    const front = note.fields.front.trim();
    const back = (note.fields.back ?? '').trim();
    const newFront = back
      ? `${front}\n{{c1::${back}}}`
      : front;
    return {
      fields: { ...note.fields, front: newFront, back: '' },
      willDeleteHistory: true,
    };
  }

  // cloze → basic: extract first cloze's answer as the back, strip cloze
  // syntax from the front. Multi-cloze answers join with " / ".
  const re = /\{\{c\d+::([^}]+?)(?:::[^}]+)?\}\}/g;
  const answers: string[] = [];
  const naked = note.fields.front.replace(re, (_, body) => {
    answers.push(body);
    return body;
  });
  return {
    fields: {
      ...note.fields,
      front: naked,
      back: answers.length ? answers.join(' / ') : (note.fields.back ?? ''),
    },
    willDeleteHistory: true,
  };
}

/**
 * Apply a basic↔cloze conversion: rewrites fields, swaps modelId, and
 * regenerates cards from scratch. Existing scheduling history on the note's
 * cards is dropped.
 */
export async function convertNoteType(noteId: string, target: ConvertTarget): Promise<void> {
  const dbi = db();
  await dbi.transaction('rw', dbi.notes, dbi.cards, dbi.reviewLogs, async () => {
    const note = await dbi.notes.get(noteId);
    if (!note) return;
    if (note.modelId === target) return;
    if (note.modelId === 'image-occlusion') return; // out of scope

    const preview = previewConvertNoteType(note, target);
    const t = now();

    // Drop existing cards + their review logs.
    const existing = await dbi.cards.where('noteId').equals(noteId).toArray();
    const cardIds = existing.map(c => c.id);
    if (cardIds.length) {
      await dbi.reviewLogs.where('cardId').anyOf(cardIds).delete();
      await dbi.cards.bulkDelete(cardIds);
    }

    // Update note.
    const updated: Note = {
      ...note,
      modelId: target,
      fields: preview.fields,
      // Cloze can't have siblings; clear them on conversion to cloze.
      siblings: target === 'cloze' ? undefined : note.siblings,
      modifiedAt: t,
    };
    await dbi.notes.put(updated);

    // Recreate cards.
    const empty = emptyCard(new Date(t));
    const cards: Card[] = [];
    if (target === 'cloze') {
      const ords = clozeOrds(preview.fields.front);
      const ordList = ords.length ? ords : [1];
      for (const ord of ordList) {
        cards.push({
          id: id(),
          noteId,
          deckId: note.deckId,
          clozeOrd: ord,
          ...empty,
          suspended: false,
          buried: false,
          createdAt: t,
          modifiedAt: t,
        });
      }
    } else {
      // Basic: one card unless siblings are still defined.
      const siblingDefs = updated.siblings ?? [];
      if (siblingDefs.length) {
        for (const s of siblingDefs) {
          cards.push({
            id: id(),
            noteId,
            deckId: note.deckId,
            siblingId: s.id,
            ...empty,
            suspended: false,
            buried: false,
            createdAt: t,
            modifiedAt: t,
          });
        }
      } else {
        cards.push({
          id: id(),
          noteId,
          deckId: note.deckId,
          ...empty,
          suspended: false,
          buried: false,
          createdAt: t,
          modifiedAt: t,
        });
      }
    }
    await dbi.cards.bulkPut(cards);
  });
  // Note fields changed → re-index.
  const fresh = await db().notes.get(noteId);
  if (fresh) await indexNoteSafe(fresh);
}

/* ─── Bulk operations on selected notes ──────────────────────── */

export type BulkAction =
  | { kind: 'suspend' }
  | { kind: 'unsuspend' }
  | { kind: 'bury' }
  | { kind: 'unbury' }
  | { kind: 'reset' }
  | { kind: 'delete' }
  | { kind: 'move'; targetDeckId: string }
  | { kind: 'addTag'; tag: string }
  | { kind: 'removeTag'; tag: string };

/** Snapshot of pre-action state, sufficient to undo a bulk apply. */
export interface BulkUndo {
  action: BulkAction;
  notes: Array<{ id: string; tags: string[]; deckId: string }>;
  cards: Array<Pick<Card,
    | 'id' | 'deckId' | 'due' | 'stability' | 'difficulty'
    | 'elapsedDays' | 'scheduledDays' | 'learningSteps' | 'reps' | 'lapses'
    | 'state' | 'lastReview' | 'suspended' | 'buried' | 'buriedUntil'>>;
  /** For delete: full Note + Card rows so we can restore. */
  deletedNotes?: Note[];
  deletedCards?: Card[];
  deletedReviewLogs?: ReviewLog[];
}

/**
 * Apply an action to a set of notes (and all their cards), returning
 * a snapshot the caller can pass to `undoBulk` to restore prior state.
 */
export async function bulkApply(
  noteIds: string[],
  action: BulkAction,
): Promise<BulkUndo> {
  const dbi = db();
  const t = now();

  if (noteIds.length === 0) {
    return { action, notes: [], cards: [] };
  }

  if (action.kind === 'delete') {
    const notes = await dbi.notes.where('id').anyOf(noteIds).toArray();
    const cards = await dbi.cards.where('noteId').anyOf(noteIds).toArray();
    const cardIds = cards.map(c => c.id);
    const logs = cardIds.length
      ? await dbi.reviewLogs.where('cardId').anyOf(cardIds).toArray()
      : [];
    await dbi.transaction('rw', dbi.notes, dbi.cards, dbi.reviewLogs, async () => {
      if (cardIds.length) {
        await dbi.reviewLogs.where('cardId').anyOf(cardIds).delete();
        await dbi.cards.bulkDelete(cardIds);
      }
      await dbi.notes.bulkDelete(noteIds);
    });
    void unindexNotes(noteIds);
    return {
      action,
      notes: notes.map(n => ({ id: n.id, tags: n.tags, deckId: n.deckId })),
      cards: cards.map(snapshotCard),
      deletedNotes: notes,
      deletedCards: cards,
      deletedReviewLogs: logs,
    };
  }

  // For non-delete actions we capture a per-note tag/deck snapshot and per-card
  // FSRS snapshot, then mutate.
  const notes = await dbi.notes.where('id').anyOf(noteIds).toArray();
  const cards = await dbi.cards.where('noteId').anyOf(noteIds).toArray();
  const undo: BulkUndo = {
    action,
    notes: notes.map(n => ({ id: n.id, tags: [...n.tags], deckId: n.deckId })),
    cards: cards.map(snapshotCard),
  };

  await dbi.transaction('rw', dbi.notes, dbi.cards, async () => {
    switch (action.kind) {
      case 'suspend':
        await dbi.cards.bulkPut(cards.map(c => ({ ...c, suspended: true, modifiedAt: t })));
        break;
      case 'unsuspend':
        await dbi.cards.bulkPut(cards.map(c => ({ ...c, suspended: false, modifiedAt: t })));
        break;
      case 'bury': {
        const tomorrow = new Date();
        tomorrow.setHours(0, 0, 0, 0);
        tomorrow.setDate(tomorrow.getDate() + 1);
        const buriedUntil = tomorrow.getTime();
        await dbi.cards.bulkPut(cards.map(c => ({
          ...c,
          buried: true,
          buriedUntil,
          modifiedAt: t,
        })));
        break;
      }
      case 'unbury':
        await dbi.cards.bulkPut(cards.map(c => ({
          ...c, buried: false, buriedUntil: undefined, modifiedAt: t,
        })));
        break;
      case 'reset': {
        const empty = emptyCard();
        await dbi.cards.bulkPut(cards.map(c => ({
          ...c,
          ...empty,
          suspended: c.suspended,
          buried: false,
          buriedUntil: undefined,
          modifiedAt: t,
        })));
        break;
      }
      case 'move':
        await dbi.notes.bulkPut(notes.map(n => ({ ...n, deckId: action.targetDeckId, modifiedAt: t })));
        await dbi.cards.bulkPut(cards.map(c => ({ ...c, deckId: action.targetDeckId, modifiedAt: t })));
        break;
      case 'addTag':
        await dbi.notes.bulkPut(notes.map(n => {
          if (n.tags.includes(action.tag)) return n;
          return { ...n, tags: [...n.tags, action.tag], modifiedAt: t };
        }));
        break;
      case 'removeTag':
        await dbi.notes.bulkPut(notes.map(n => {
          if (!n.tags.includes(action.tag)) return n;
          return { ...n, tags: n.tags.filter(x => x !== action.tag), modifiedAt: t };
        }));
        break;
    }
  });

  // Re-index when the change touches indexable content. `move` is a deckId
  // swap and doesn't affect search results.
  if (action.kind === 'addTag' || action.kind === 'removeTag') {
    void reindexNotes(noteIds);
  }

  return undo;
}

/** Inverse of `bulkApply`. Re-indexes any restored or modified notes. */
export async function undoBulk(snap: BulkUndo): Promise<void> {
  const dbi = db();
  const t = now();

  if (snap.action.kind === 'delete') {
    if (!snap.deletedNotes || !snap.deletedCards) return;
    await dbi.transaction('rw', dbi.notes, dbi.cards, dbi.reviewLogs, async () => {
      await dbi.notes.bulkPut(snap.deletedNotes!);
      await dbi.cards.bulkPut(snap.deletedCards!);
      if (snap.deletedReviewLogs?.length) {
        await dbi.reviewLogs.bulkPut(snap.deletedReviewLogs);
      }
    });
    void reindexNotes(snap.deletedNotes.map(n => n.id));
    return;
  }

  await dbi.transaction('rw', dbi.notes, dbi.cards, async () => {
    // Restore note tags + deckId.
    const liveNotes = await dbi.notes.where('id').anyOf(snap.notes.map(n => n.id)).toArray();
    const noteById = new Map(liveNotes.map(n => [n.id, n]));
    const restoredNotes: Note[] = snap.notes
      .map(s => {
        const live = noteById.get(s.id);
        if (!live) return null;
        return { ...live, tags: s.tags, deckId: s.deckId, modifiedAt: t };
      })
      .filter((x): x is Note => x !== null);
    if (restoredNotes.length) await dbi.notes.bulkPut(restoredNotes);

    // Restore card FSRS state.
    const liveCards = await dbi.cards.where('id').anyOf(snap.cards.map(c => c.id)).toArray();
    const cardById = new Map(liveCards.map(c => [c.id, c]));
    const restoredCards: Card[] = snap.cards
      .map(s => {
        const live = cardById.get(s.id);
        if (!live) return null;
        return { ...live, ...s, modifiedAt: t };
      })
      .filter((x): x is Card => x !== null);
    if (restoredCards.length) await dbi.cards.bulkPut(restoredCards);
  });
  // Re-index whatever notes were touched (tag undo affects search content).
  void reindexNotes(snap.notes.map(n => n.id));
}

function snapshotCard(c: Card): BulkUndo['cards'][number] {
  return {
    id: c.id,
    deckId: c.deckId,
    due: c.due,
    stability: c.stability,
    difficulty: c.difficulty,
    elapsedDays: c.elapsedDays,
    scheduledDays: c.scheduledDays,
    learningSteps: c.learningSteps,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state,
    lastReview: c.lastReview,
    suspended: c.suspended,
    buried: c.buried,
    buriedUntil: c.buriedUntil,
  };
}

/* ─── Bulk import (used by .apkg) ────────────────────────────── */

export async function bulkImport(args: {
  decks: Deck[];
  notes: Note[];
  cards: Card[];
  media: Media[];
}): Promise<void> {
  const { decks, notes, cards, media } = args;
  const dbi = db();
  await dbi.transaction('rw', dbi.decks, dbi.notes, dbi.cards, dbi.media, async () => {
    if (decks.length) await dbi.decks.bulkPut(decks);
    if (notes.length) await dbi.notes.bulkPut(notes);
    if (cards.length) await dbi.cards.bulkPut(cards);
    if (media.length) await dbi.media.bulkPut(media);
  });
  // .apkg imports can hit ~10K notes; re-index in bulk.
  void rebuildIndex();
}

/* ─── Feynman attempts ───────────────────────────────────────── */

import type { FeynmanLog, FeynmanGrade } from './schema';

/**
 * Persist a Feynman attempt. Returns the saved record so the caller can
 * reference its id (e.g. to update a scheduleMultiplier after recordReview).
 */
export interface NewFeynmanAttempt {
  cardId: string;
  noteId: string;
  deckId: string;
  explanation: string;
  inputMode: 'text' | 'voice';
  durationMs: number;
  grade?: FeynmanGrade;
}

export async function recordFeynmanAttempt(input: NewFeynmanAttempt): Promise<FeynmanLog> {
  const log: FeynmanLog = {
    id: id(),
    cardId: input.cardId,
    noteId: input.noteId,
    deckId: input.deckId,
    explanation: input.explanation,
    inputMode: input.inputMode,
    durationMs: input.durationMs,
    grade: input.grade,
    createdAt: now(),
  };
  await db().feynmanLogs.put(log);
  return log;
}

/** Patch a previously-saved attempt with the rating + multiplier the user applied. */
export async function updateFeynmanAttempt(
  attemptId: string,
  patch: { rating?: 1 | 2 | 3 | 4; scheduleMultiplier?: number; grade?: FeynmanGrade },
): Promise<void> {
  await db().feynmanLogs.update(attemptId, patch);
}

/** All Feynman attempts on a card, newest first. Used for the per-note history view. */
export async function listFeynmanForCard(cardId: string): Promise<FeynmanLog[]> {
  return db().feynmanLogs
    .where('[cardId+createdAt]')
    .between([cardId, 0], [cardId, Infinity])
    .reverse()
    .toArray();
}

/* ─── Media (re-exported from ./media) ───────────────────────── */

export {
  getMediaUrl,
  releaseAllMediaUrls,
  invalidateMediaUrl,
  __mediaUrlCacheSize,
  mediaChangedSignal,
  replaceMediaByFilename,
} from './media';

/* ─── Incremental reading ─────────────────────────────────────── */

export async function listSources(): Promise<Source[]> {
  return db().sources.orderBy('lastReadAt').reverse().toArray();
}

export async function getSource(sourceId: string): Promise<Source | undefined> {
  return db().sources.get(sourceId);
}

export async function createSource(input: { title: string; kind: 'paste' | 'pdf'; body: string }): Promise<Source> {
  const t = now();
  const safeTitle = input.title.trim() || 'Untitled';
  const deck = await getOrCreateDeckByName(`Reading::${safeTitle}`, 'Auto-created deck for incremental reading.');
  const source: Source = {
    id: id(),
    title: safeTitle,
    kind: input.kind,
    body: input.body,
    addedAt: t,
    progress: 0,
    deckId: deck.id,
  };
  await db().sources.put(source);
  return source;
}

export async function deleteSource(sourceId: string): Promise<void> {
  const dbi = db();
  await dbi.transaction('rw', [dbi.sources, dbi.highlights], async () => {
    await dbi.highlights.where('sourceId').equals(sourceId).delete();
    await dbi.sources.delete(sourceId);
  });
}

export async function updateSourceProgress(sourceId: string, progress: number): Promise<void> {
  await db().sources.update(sourceId, {
    progress: Math.min(1, Math.max(0, progress)),
    lastReadAt: now(),
  });
}

export async function listHighlights(sourceId: string): Promise<Highlight[]> {
  return db().highlights
    .where('sourceId').equals(sourceId)
    .sortBy('start');
}

export async function addHighlight(input: { sourceId: string; start: number; end: number; text: string }): Promise<Highlight> {
  const h: Highlight = {
    id: id(),
    sourceId: input.sourceId,
    start: input.start,
    end: input.end,
    text: input.text,
    createdAt: now(),
  };
  await db().highlights.put(h);
  return h;
}

export async function removeHighlight(highlightId: string): Promise<void> {
  await db().highlights.delete(highlightId);
}

/**
 * Promote a highlight to a cloze card. The surrounding paragraph (split on
 * blank-line boundaries) becomes the front, with the highlight wrapped in
 * `{{c1::…}}`. Returns the new note's id and links the highlight to it.
 */
export async function promoteHighlightToNote(highlightId: string): Promise<string | null> {
  const dbi = db();
  const h = await dbi.highlights.get(highlightId);
  if (!h) return null;
  const source = await dbi.sources.get(h.sourceId);
  if (!source) return null;

  // Find the paragraph that contains the highlight. Body is segmented by
  // blank-line runs; we walk start→end accumulating offsets.
  const paragraphs = source.body.split(/\n\s*\n/);
  let cursor = 0;
  let para = '';
  let paraStart = 0;
  for (const p of paragraphs) {
    const next = cursor + p.length;
    if (h.start >= cursor && h.start < next) {
      para = p;
      paraStart = cursor;
      break;
    }
    cursor = next + 2; // for the blank-line separator
  }
  if (!para) {
    // Highlight is bare text — fall back to a one-sentence card.
    para = h.text;
    paraStart = h.start;
  }

  // Build the front by wrapping the highlight in cloze syntax.
  const localStart = h.start - paraStart;
  const localEnd = Math.min(para.length, h.end - paraStart);
  const before = para.slice(0, localStart);
  const middle = para.slice(localStart, localEnd);
  const after = para.slice(localEnd);
  const front = `${before}{{c1::${middle}}}${after}`.trim();

  const { note } = await createNote({
    deckId: source.deckId,
    modelId: 'cloze',
    fields: { front, back: '', source: source.title },
    tags: ['reading'],
  });
  await dbi.highlights.update(highlightId, { noteId: note.id });
  return note.id;
}

/* ─── Settings ───────────────────────────────────────────────── */

export async function getSetting(key: string): Promise<string | undefined> {
  const s = await db().settings.get(key);
  return s?.value;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await db().settings.put({ key, value });
}

export async function getJsonSetting<T>(key: string, fallback: T): Promise<T> {
  const v = await getSetting(key);
  if (!v) return fallback;
  try { return JSON.parse(v) as T; } catch { return fallback; }
}

export async function setJsonSetting<T>(key: string, value: T): Promise<void> {
  await setSetting(key, JSON.stringify(value));
}

/* ─── Stats ──────────────────────────────────────────────────── */

export async function reviewsByDay(start: Date, end: Date): Promise<Map<string, number>> {
  const logs = await db().reviewLogs
    .where('review')
    .between(start.getTime(), end.getTime(), true, true)
    .toArray();
  const map = new Map<string, number>();
  for (const l of logs) {
    const day = new Date(l.review).toISOString().split('T')[0];
    map.set(day, (map.get(day) ?? 0) + 1);
  }
  return map;
}

export async function retentionWindow(days = 30): Promise<{ total: number; correct: number; rate: number }> {
  const start = Date.now() - days * 86_400_000;
  const logs = await db().reviewLogs.where('review').above(start).toArray();
  const reviews = logs.filter(l => l.state === 'review' || l.state === 'relearning');
  const total = reviews.length;
  const correct = reviews.filter(l => l.rating !== 1).length;
  return { total, correct, rate: total > 0 ? correct / total : 0 };
}

/** Same as retentionWindow but scoped to one deck. */
/**
 * 7×24 grid of review counts by (day-of-week, hour). Day index 0 = Sunday.
 * Bucketed in local time so the diagonal across days reads naturally.
 */
export async function reviewsByHourOfWeek(days = 90): Promise<number[][]> {
  const grid: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const cutoff = Date.now() - days * 86_400_000;
  const logs = await db().reviewLogs.where('review').above(cutoff).toArray();
  for (const l of logs) {
    const d = new Date(l.review);
    grid[d.getDay()][d.getHours()]++;
  }
  return grid;
}

export async function deckRetentionWindow(deckId: string, days = 30): Promise<{ total: number; correct: number; rate: number }> {
  const start = Date.now() - days * 86_400_000;
  const logs = await db().reviewLogs
    .where('review').above(start)
    .filter(l => l.deckId === deckId)
    .toArray();
  const reviews = logs.filter(l => l.state === 'review' || l.state === 'relearning');
  const total = reviews.length;
  const correct = reviews.filter(l => l.rating !== 1).length;
  return { total, correct, rate: total > 0 ? correct / total : 0 };
}

export interface CardMaturity {
  /** state === 'new' */
  newCards: number;
  /** state === 'learning' or 'relearning' */
  learning: number;
  /** review-state cards with scheduledDays < 21 (FSRS-5 maturity threshold) */
  young: number;
  /** review-state cards with scheduledDays >= 21 */
  mature: number;
  total: number;
}

const MATURITY_DAYS = 21;

/** Bucket every non-suspended card by maturity. */
export async function cardMaturity(): Promise<CardMaturity> {
  // Stream cards via cursor instead of loading the full table into memory.
  // Lets a 50K-card deck bucket without a multi-MB Array allocation.
  let newCards = 0, learning = 0, young = 0, mature = 0;
  await db().cards.each(c => {
    if (c.suspended) return;
    if (c.state === 'new') newCards++;
    else if (c.state === 'learning' || c.state === 'relearning') learning++;
    else if (c.scheduledDays >= MATURITY_DAYS) mature++;
    else young++;
  });
  return { newCards, learning, young, mature, total: newCards + learning + young + mature };
}

/* ─── Lapses / trouble cards ─────────────────────────────────── */

export interface TroubleCard {
  card: Card;
  note: Note;
  deckName: string;
}

export async function listTroubleCards(minLapses: number = 3, limit: number = 50): Promise<TroubleCard[]> {
  const dbi = db();
  const cards = await dbi.cards
    .filter(c => c.lapses >= minLapses)
    .toArray();
  cards.sort((a, b) => b.lapses - a.lapses);
  const trimmed = cards.slice(0, limit);

  const noteIds = [...new Set(trimmed.map(c => c.noteId))];
  const deckIds = [...new Set(trimmed.map(c => c.deckId))];
  const [notes, decks] = await Promise.all([
    dbi.notes.where('id').anyOf(noteIds).toArray(),
    dbi.decks.where('id').anyOf(deckIds).toArray(),
  ]);
  const noteById = new Map(notes.map(n => [n.id, n]));
  const deckNameById = new Map(decks.map(d => [d.id, d.name]));

  const out: TroubleCard[] = [];
  for (const c of trimmed) {
    const n = noteById.get(c.noteId);
    if (!n) continue;
    out.push({ card: c, note: n, deckName: deckNameById.get(c.deckId) ?? '' });
  }
  return out;
}

/* ─── Search ─────────────────────────────────────────────────── */

export interface SearchHit {
  noteId: string;
  deckId: string;
  deckName: string;
  snippet: string;       // raw front text (caller can renderPlain for cloze)
  score: number;
}

/**
 * Token-overlap full-text search backed by the inverted index in
 * `searchTokens`. The index is built lazily on first query and kept
 * up-to-date by indexNote / unindexNote on the note write paths.
 *
 * For queries of one to four tokens, runtime is O(sum of postings) — it
 * doesn't scale with the deck size, only with how common the query
 * tokens are.
 */
export async function searchNotes(query: string, limit = 25): Promise<SearchHit[]> {
  const indexed = await searchByIndex(query, limit);
  if (indexed.length === 0) return [];

  const dbi = db();
  const [notes, decks] = await Promise.all([
    dbi.notes.where('id').anyOf(indexed.map(h => h.noteId)).toArray(),
    dbi.decks.toArray(),
  ]);
  const noteById = new Map(notes.map(n => [n.id, n]));
  const deckNameById = new Map(decks.map(d => [d.id, d.name]));

  const hits: SearchHit[] = [];
  for (const h of indexed) {
    const n = noteById.get(h.noteId);
    if (!n) continue;
    hits.push({
      noteId: n.id,
      deckId: n.deckId,
      deckName: deckNameById.get(n.deckId) ?? '',
      snippet: n.fields.front,
      score: h.score,
    });
  }
  return hits;
}

/* ─── Tags ───────────────────────────────────────────────────── */

export async function listAllTags(): Promise<string[]> {
  const dbi = db();
  const all = new Set<string>();
  await dbi.notes.each(n => { for (const t of n.tags) all.add(t); });
  return [...all].sort();
}

export interface TagUsage {
  tag: string;
  noteCount: number;
}

/** Tag → note count, alphabetical. Used by the tag management UI. */
export async function listTagUsage(): Promise<TagUsage[]> {
  const counts = new Map<string, number>();
  await db().notes.each(n => {
    for (const t of n.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  });
  return [...counts.entries()]
    .map(([tag, noteCount]) => ({ tag, noteCount }))
    .sort((a, b) => a.tag.localeCompare(b.tag));
}

/** Rename a tag across every note that has it. Returns notes touched. */
export async function renameTag(from: string, to: string): Promise<number> {
  if (!from || !to || from === to) return 0;
  const dbi = db();
  const t = now();
  let touched = 0;
  const touchedIds: string[] = [];
  await dbi.transaction('rw', dbi.notes, async () => {
    const notes = await dbi.notes.where('tags').equals(from).toArray();
    const updates: Note[] = [];
    for (const n of notes) {
      // Replace `from` with `to`; dedupe in case the note already had `to`.
      const next = Array.from(new Set(n.tags.map(x => (x === from ? to : x))));
      updates.push({ ...n, tags: next, modifiedAt: t });
      touchedIds.push(n.id);
    }
    if (updates.length) {
      await dbi.notes.bulkPut(updates);
      touched = updates.length;
    }
  });
  if (touchedIds.length) void reindexNotes(touchedIds);
  return touched;
}

/** Merge `sources` into `target` across every note. Returns notes touched. */
export async function mergeTags(sources: string[], target: string): Promise<number> {
  if (!target || sources.length === 0) return 0;
  const dbi = db();
  const t = now();
  const sourceSet = new Set(sources.filter(s => s && s !== target));
  if (sourceSet.size === 0) return 0;
  let touched = 0;
  let touchedIds: string[] = [];
  await dbi.transaction('rw', dbi.notes, async () => {
    // Union per-tag queries to dodge a multi-entry `anyOf` quirk in some
    // IndexedDB shims; each `.equals()` is fine.
    const noteById = new Map<string, Note>();
    for (const src of sourceSet) {
      const hits = await dbi.notes.where('tags').equals(src).toArray();
      for (const n of hits) {
        if (!noteById.has(n.id)) noteById.set(n.id, n);
      }
    }
    const updates: Note[] = [];
    for (const n of noteById.values()) {
      const next = Array.from(new Set(
        n.tags.map(x => (sourceSet.has(x) ? target : x)),
      ));
      updates.push({ ...n, tags: next, modifiedAt: t });
    }
    if (updates.length) {
      await dbi.notes.bulkPut(updates);
      touched = updates.length;
      touchedIds = updates.map(u => u.id);
    }
  });
  // Re-index AFTER the parent txn closes so the searchTokens write is in
  // its own transaction (Dexie sub-transactions can't reach a table that
  // wasn't declared in the parent).
  if (touchedIds.length) void reindexNotes(touchedIds);
  return touched;
}

/** Remove a tag from every note that has it. */
export async function deleteTagEverywhere(tag: string): Promise<number> {
  if (!tag) return 0;
  const dbi = db();
  const t = now();
  let touched = 0;
  const touchedIds: string[] = [];
  await dbi.transaction('rw', dbi.notes, async () => {
    const notes = await dbi.notes.where('tags').equals(tag).toArray();
    const updates: Note[] = [];
    for (const n of notes) {
      const next = n.tags.filter(x => x !== tag);
      updates.push({ ...n, tags: next, modifiedAt: t });
      touchedIds.push(n.id);
    }
    if (updates.length) {
      await dbi.notes.bulkPut(updates);
      touched = updates.length;
    }
  });
  if (touchedIds.length) void reindexNotes(touchedIds);
  return touched;
}

export async function listTagsInDeck(deckId: string, includeDescendants = false): Promise<string[]> {
  const dbi = db();
  const all = new Set<string>();
  let deckIds: string[] = [deckId];
  if (includeDescendants) {
    const descendants = await listDescendantDeckIds(deckId);
    if (descendants.length > 0) deckIds = [deckId, ...descendants];
  }
  const cursor = deckIds.length === 1
    ? dbi.notes.where('deckId').equals(deckIds[0])
    : dbi.notes.where('deckId').anyOf(deckIds);
  await cursor.each(n => {
    for (const t of n.tags) all.add(t);
  });
  return [...all].sort();
}

/* ─── Browse filters ─────────────────────────────────────────── */

export interface NoteBrowseFilters {
  states?: CardState[];
  tags?: string[];      // any-of
  tier?: string;
  query?: string;       // free-text; same matcher as searchNotes but deck-scoped
  hasLapses?: number;   // notes with at least one card whose lapses ≥ this
  lapsesAtMost?: number; // notes whose every card has lapses ≤ this
  suspended?: boolean;
  buried?: boolean;
  /** Restrict to notes created within the last N days. */
  addedWithinDays?: number;
  /** Restrict to notes whose modifiedAt is within the last N days. */
  editedWithinDays?: number;
  /** Restrict to notes with at least one card due now (state in review/learning/relearning, due ≤ now). */
  dueOnly?: boolean;
  /** Any-of flag filter. */
  flags?: NoteFlag[];
  /** Roll up notes from every descendant deck via the `::` hierarchy. */
  includeDescendants?: boolean;
  /**
   * Sort key applied to the result. `newest` (default) sorts by note.createdAt
   * desc; `oldest` flips it. The card-derived sorts (due, lapses, hardest)
   * pull cards once and aggregate per note — earliest due, max lapses, max
   * difficulty respectively.
   */
  sort?: 'newest' | 'oldest' | 'due' | 'lapses' | 'hardest';
}

export async function browseNotes(
  deckId: string,
  filters: NoteBrowseFilters = {},
  limit = 500,
): Promise<Note[]> {
  const dbi = db();

  // Resolve the set of decks to search. With includeDescendants we union the
  // deck's own notes with those of every `name`-prefix descendant — Anki
  // users expect a parent deck to surface its children's notes.
  let deckIds: string[] = [deckId];
  if (filters.includeDescendants) {
    const descendants = await listDescendantDeckIds(deckId);
    if (descendants.length > 0) deckIds = [deckId, ...descendants];
  }

  // Compose all note-level predicates so we can stream-filter via cursor and
  // bail out as soon as we've collected `limit` matches. Avoids materializing
  // the whole deck in memory when filters are tight.
  const tierFilter = filters.tier;
  const wantedTags = filters.tags?.length ? new Set(filters.tags) : null;
  const wantedFlags = filters.flags?.length ? new Set(filters.flags) : null;
  const addedCutoff = filters.addedWithinDays !== undefined
    ? Date.now() - filters.addedWithinDays * 86_400_000 : null;
  const editedCutoff = filters.editedWithinDays !== undefined
    ? Date.now() - filters.editedWithinDays * 86_400_000 : null;

  // Free-text filtering uses the inverted index instead of a per-note
  // substring scan. The index gives us a noteId set; we then run other
  // filters only against notes in that set. For a 6000-note deck the
  // search keystroke goes from O(notes × tokens) substring work to
  // O(token postings) — typically < 5ms.
  //
  // Returns null when the query has no usable tokens (e.g. all length-1) so
  // we can skip the index check entirely. Returns an empty Set when the
  // query has tokens but no notes match — short-circuits to no results.
  const queryNoteIds = filters.query
    ? await noteIdsMatchingQuery(filters.query)
    : null;
  if (queryNoteIds && queryNoteIds.size === 0) {
    return [];
  }

  const sort = filters.sort ?? 'newest';
  const sortNeedsCards = sort === 'due' || sort === 'lapses' || sort === 'hardest';
  const needsCardJoin =
    filters.states !== undefined ||
    filters.hasLapses !== undefined ||
    filters.lapsesAtMost !== undefined ||
    filters.suspended !== undefined ||
    filters.buried !== undefined ||
    !!filters.dueOnly ||
    sortNeedsCards;

  const matchesNoteLevel = (n: Note): boolean => {
    if (queryNoteIds && !queryNoteIds.has(n.id)) return false;
    if (tierFilter && n.tier !== tierFilter) return false;
    if (wantedTags && !n.tags.some(t => wantedTags.has(t))) return false;
    if (wantedFlags && (n.flag === undefined || !wantedFlags.has(n.flag))) return false;
    if (addedCutoff !== null && n.createdAt < addedCutoff) return false;
    if (editedCutoff !== null && n.modifiedAt < editedCutoff) return false;
    return true;
  };

  // Phase 1: stream notes from each in-scope deck and apply note-level
  // filters. Stop early when we've collected the limit (only safe when no
  // card-join filter needs a second pass).
  let notes: Note[] = [];
  const noteCursor = deckIds.length === 1
    ? dbi.notes.where('deckId').equals(deckIds[0])
    : dbi.notes.where('deckId').anyOf(deckIds);
  if (!needsCardJoin) {
    await noteCursor.until(() => notes.length >= limit, true).each(n => {
      if (matchesNoteLevel(n)) notes.push(n);
    });
    return applyNoteSort(notes, sort, undefined).slice(0, limit);
  }

  // With a card-join filter, we still need every note-level match because a
  // card filter could exclude a 100-note slice and require pulling more.
  await noteCursor.each(n => {
    if (matchesNoteLevel(n)) notes.push(n);
  });

  // Phase 2: pull cards for the candidate notes. Scope the cursor to the
  // same deck set so we don't sweep the whole cards table.
  const noteIdSet = new Set(notes.map(n => n.id));
  const byNote = new Map<string, Card[]>();
  const cardCursor = deckIds.length === 1
    ? dbi.cards.where('deckId').equals(deckIds[0])
    : dbi.cards.where('deckId').anyOf(deckIds);
  await cardCursor.each(c => {
    if (!noteIdSet.has(c.noteId)) return;
    const list = byNote.get(c.noteId) ?? [];
    list.push(c);
    byNote.set(c.noteId, list);
  });
  const nowMs = Date.now();
  notes = notes.filter(n => {
    const cs = byNote.get(n.id) ?? [];
    if (cs.length === 0) return false;
    if (filters.states && !cs.some(c => filters.states!.includes(c.state))) return false;
    if (filters.hasLapses !== undefined && !cs.some(c => c.lapses >= filters.hasLapses!)) return false;
    if (filters.lapsesAtMost !== undefined && !cs.every(c => c.lapses <= filters.lapsesAtMost!)) return false;
    if (filters.suspended !== undefined && !cs.some(c => c.suspended === filters.suspended)) return false;
    if (filters.buried !== undefined && !cs.some(c => c.buried === filters.buried)) return false;
    if (filters.dueOnly && !cs.some(c => !c.suspended && !c.buried && c.due <= nowMs)) return false;
    return true;
  });

  return applyNoteSort(notes, sort, byNote).slice(0, limit);
}

/**
 * Apply the requested sort. `byNote` may be undefined when sort doesn't
 * need card data; in that case card-derived sorts fall back to `newest`.
 */
function applyNoteSort(
  notes: Note[],
  sort: 'newest' | 'oldest' | 'due' | 'lapses' | 'hardest',
  byNote: Map<string, Card[]> | undefined,
): Note[] {
  if (sort === 'newest') {
    return [...notes].sort((a, b) => b.createdAt - a.createdAt);
  }
  if (sort === 'oldest') {
    return [...notes].sort((a, b) => a.createdAt - b.createdAt);
  }
  if (!byNote) return [...notes].sort((a, b) => b.createdAt - a.createdAt);

  const FAR_FUTURE = Number.MAX_SAFE_INTEGER;
  const score = (n: Note): number => {
    const cs = byNote.get(n.id) ?? [];
    if (cs.length === 0) return sort === 'due' ? FAR_FUTURE : -1;
    if (sort === 'due') {
      // earliest due across the note's cards
      let best = FAR_FUTURE;
      for (const c of cs) {
        if (c.suspended || c.buried) continue;
        if (c.due < best) best = c.due;
      }
      return best;
    }
    if (sort === 'lapses') {
      let max = 0;
      for (const c of cs) if (c.lapses > max) max = c.lapses;
      return max;
    }
    // hardest = max difficulty
    let max = 0;
    for (const c of cs) if (c.difficulty > max) max = c.difficulty;
    return max;
  };

  // due is asc; lapses & hardest are desc.
  const dir = sort === 'due' ? 1 : -1;
  return [...notes].sort((a, b) => dir * (score(a) - score(b)));
}

export async function totalReviewsToday(): Promise<number> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return db().reviewLogs.where('review').above(start.getTime()).count();
}

/**
 * Returns aggregate today-only metrics for the home/Reviewer panels. Pulls
 * every reviewLog since local midnight (cheap; the index is keyed on review
 * time) and sums durations + counts. Snoozes never write to reviewLogs, so
 * the numbers reflect actual graded reviews.
 */
export interface TodayStudyStats {
  count: number;
  totalMs: number;
  perMinute: number;
  secondsPerCard: number;
}

export async function getTodayStudyStats(): Promise<TodayStudyStats> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  // Optional epoch: when the user clicks "Reset today" we stash now() in
  // this setting so the visible count restarts from zero. Cap by midnight
  // so a stale epoch from yesterday doesn't suppress today's reviews.
  const epochRaw = await getSetting('today_stats_epoch_ms');
  const epoch = epochRaw ? parseInt(epochRaw, 10) : 0;
  const since = Math.max(start.getTime(), Number.isFinite(epoch) ? epoch : 0);
  const logs = await db().reviewLogs.where('review').above(since).toArray();
  let count = 0;
  let totalMs = 0;
  for (const l of logs) {
    count++;
    totalMs += Math.max(0, l.durationMs);
  }
  const minutes = totalMs / 60_000;
  const perMinute = minutes > 0 ? count / minutes : 0;
  const secondsPerCard = count > 0 ? totalMs / count / 1000 : 0;
  return { count, totalMs, perMinute, secondsPerCard };
}

/**
 * Reset the visible "today" counters without touching the underlying
 * review log. Sets a per-user epoch the stats query clamps to. Clears
 * itself implicitly at the next local midnight (the query takes
 * max(midnight, epoch)).
 */
export async function resetTodayStats(): Promise<void> {
  await setSetting('today_stats_epoch_ms', String(Date.now()));
}

/**
 * Compute the current consecutive-day streak of reviews. Returns the number
 * of days going back from today during which the user reviewed at least one
 * card. If there's a gap (a day with zero reviews), the streak ends.
 */
export async function currentStreak(): Promise<number> {
  const dbi = db();
  const start = new Date();
  start.setHours(0, 0, 0, 0);

  // Walk backwards 365 days at most.
  let streak = 0;
  for (let i = 0; i < 365; i++) {
    const dayStart = start.getTime() - i * 86_400_000;
    const dayEnd = dayStart + 86_400_000;
    const count = await dbi.reviewLogs
      .where('review').between(dayStart, dayEnd, true, false).count();
    if (count > 0) streak++;
    else if (i > 0) break;     // missed a day → streak ended
    // i === 0 with 0 reviews still continues; today's streak hasn't broken yet.
  }
  return streak;
}

/** Returns daily review-log entries, grouped by review log entry. */
export async function reviewsOnDay(day: Date): Promise<ReviewLog[]> {
  const dbi = db();
  const start = new Date(day);
  start.setHours(0, 0, 0, 0);
  const end = start.getTime() + 86_400_000;
  return dbi.reviewLogs.where('review').between(start.getTime(), end, true, false).toArray();
}

export interface TagRetention {
  tag: string;
  reviews: number;
  retention: number;
}

/**
 * Tag-level retention: for each tag in use, look up that tag's notes' cards'
 * review logs and compute correct/total. Min `minReviews` to surface a tag.
 */
export async function tagRetention(minReviews: number = 30): Promise<TagRetention[]> {
  const dbi = db();
  const [notes, cards, logs] = await Promise.all([
    dbi.notes.toArray(),
    dbi.cards.toArray(),
    dbi.reviewLogs.toArray(),
  ]);

  const tagsByCard = new Map<string, string[]>();
  const noteTagsById = new Map(notes.map(n => [n.id, n.tags]));
  for (const c of cards) {
    const tags = noteTagsById.get(c.noteId) ?? [];
    tagsByCard.set(c.id, tags);
  }

  const counts = new Map<string, { reviews: number; correct: number }>();
  for (const l of logs) {
    if (l.state !== 'review' && l.state !== 'relearning') continue;
    const tags = tagsByCard.get(l.cardId) ?? [];
    for (const t of tags) {
      const c = counts.get(t) ?? { reviews: 0, correct: 0 };
      c.reviews++;
      if (l.rating !== 1) c.correct++;
      counts.set(t, c);
    }
  }
  const out: TagRetention[] = [];
  for (const [tag, { reviews, correct }] of counts) {
    if (reviews < minReviews) continue;
    out.push({ tag, reviews, retention: correct / reviews });
  }
  out.sort((a, b) => a.retention - b.retention);
  return out;
}

/**
 * For a deck, return the count of review-state cards due in each of the next
 * `days` calendar days starting today (inclusive). due[0] = today's review-due
 * cards, due[1] = tomorrow's, etc. New and learning cards are excluded.
 */
export async function dueForecast(deckId: string, days: number = 7): Promise<number[]> {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const counts = new Array<number>(days).fill(0);
  const all = await db().cards.where('deckId').equals(deckId).toArray();
  for (const c of all) {
    if (c.suspended || c.state !== 'review') continue;
    const dayDelta = Math.floor((c.due - startOfToday.getTime()) / 86_400_000);
    if (dayDelta < 0) counts[0] += 1; // overdue → counted today
    else if (dayDelta < days) counts[dayDelta] += 1;
  }
  return counts;
}
