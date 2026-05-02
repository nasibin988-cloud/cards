/**
 * Per-deck effective settings: walk parent chain and resolve each tunable
 * with provenance.
 *
 * Resolution: leaf field wins; if unset, climb to the nearest ancestor that
 * has it set; if none, fall back to a module default (DEFAULT_*). Each
 * field reports the deck id where the value originated, so the UI can
 * render "Inherits 0.85 from MCAT" labels without re-deriving them.
 *
 * Ancestor chain prefers explicit `parentId`; if that's unset, falls back
 * to the `::` name convention by stripping the rightmost segment until a
 * deck with the resulting name exists. So `MCAT::Biology::Ch01` ascends to
 * `MCAT::Biology` (if it exists) → `MCAT` (if it exists) → defaults.
 */

import { db } from './dexie';
import type { Deck } from './schema';

export interface EffectiveDeckSetting<T> {
  value: T;
  /** Deck id this came from, or null when it's a global default. */
  sourceId: string | null;
  /** Deck name this came from, or null for default. */
  sourceName: string | null;
  /** True iff value came from the deck itself (not an ancestor). */
  isOwn: boolean;
  /** True iff value came from a fallback (no deck in the chain set it). */
  isDefault: boolean;
}

export interface EffectiveDeckSettings {
  deckId: string;
  desiredRetention: EffectiveDeckSetting<number>;
  newCardsPerDay: EffectiveDeckSetting<number>;
  reviewsPerDay: EffectiveDeckSetting<number>;
  maxInterval: EffectiveDeckSetting<number>;
  fsrsParams: EffectiveDeckSetting<number[]>;
  /** Convenience array of ancestor decks (closest first), excluding self. */
  ancestors: Deck[];
}

export const DEFAULT_RETENTION = 0.9;
export const DEFAULT_NEW_PER_DAY = 20;
export const DEFAULT_REVIEWS_PER_DAY = 200;
export const DEFAULT_MAX_INTERVAL = 36500;
// FSRS-5 default weight sourcing lives in the scheduler module — we never
// duplicate the 19-element vector here. Caller-side resolves at scheduler call.

/**
 * Walk the deck's ancestors (closest first), preferring `parentId` and
 * falling back to the `::` name convention.
 *
 * Defensive: if a parentId chain has a cycle (data corruption), bail at
 * 32 hops. Name-based ascent has no cycles (each step strips a segment).
 */
export async function getDeckAncestors(deckId: string): Promise<Deck[]> {
  const dbi = db();
  const seen = new Set<string>();
  const out: Deck[] = [];
  let cur = await dbi.decks.get(deckId);
  if (!cur) return out;
  for (let hop = 0; hop < 32; hop++) {
    seen.add(cur.id);
    let next: Deck | undefined;
    if (cur.parentId) {
      next = await dbi.decks.get(cur.parentId);
    }
    if (!next) {
      // Name-prefix ancestor: walk *every* shorter `::` prefix from longest
      // to shortest, taking the first one that resolves to a real deck. So a
      // leaf "MCAT::Biology::Ch01" can inherit directly from "MCAT" even
      // when there's no "MCAT::Biology" deck row in between — virtual
      // intermediate stubs don't break the chain.
      const segs: string[] = cur.name.split('::').map(s => s.trim()).filter(Boolean);
      for (let len = segs.length - 1; len >= 1; len--) {
        const ancestorName: string = segs.slice(0, len).join('::');
        const candidate = await dbi.decks.where('name').equals(ancestorName).first();
        if (candidate && !seen.has(candidate.id)) {
          next = candidate;
          break;
        }
      }
    }
    if (!next || seen.has(next.id)) break;
    out.push(next);
    cur = next;
  }
  return out;
}

/**
 * Resolve effective settings (with provenance) for a deck, walking ancestors
 * and falling back to module defaults. Use this everywhere we previously
 * read a single field off a Deck row to schedule cards or render dials.
 */
export async function getEffectiveDeckSettings(deckId: string): Promise<EffectiveDeckSettings> {
  const dbi = db();
  const own = await dbi.decks.get(deckId);
  if (!own) {
    return {
      deckId,
      desiredRetention: defaulted(DEFAULT_RETENTION),
      newCardsPerDay: defaulted(DEFAULT_NEW_PER_DAY),
      reviewsPerDay: defaulted(DEFAULT_REVIEWS_PER_DAY),
      maxInterval: defaulted(DEFAULT_MAX_INTERVAL),
      fsrsParams: defaulted<number[]>([] as number[]),
      ancestors: [],
    };
  }
  const ancestors = await getDeckAncestors(deckId);
  const chain = [own, ...ancestors];

  function pick<K extends keyof Deck>(key: K, fallback: Deck[K]): EffectiveDeckSetting<NonNullable<Deck[K]>> {
    for (const d of chain) {
      const v = d[key];
      if (v !== undefined && v !== null) {
        return {
          value: v as NonNullable<Deck[K]>,
          sourceId: d.id,
          sourceName: d.name,
          isOwn: d.id === own!.id,
          isDefault: false,
        };
      }
    }
    return defaulted(fallback as NonNullable<Deck[K]>);
  }

  return {
    deckId,
    desiredRetention: pick('desiredRetention', DEFAULT_RETENTION),
    newCardsPerDay: pick('newCardsPerDay', DEFAULT_NEW_PER_DAY),
    reviewsPerDay: pick('reviewsPerDay', DEFAULT_REVIEWS_PER_DAY),
    maxInterval: pick('maxInterval', DEFAULT_MAX_INTERVAL),
    fsrsParams: pick('fsrsParams', [] as number[]),
    ancestors,
  };
}

function defaulted<T>(value: T): EffectiveDeckSetting<T> {
  return { value, sourceId: null, sourceName: null, isOwn: false, isDefault: true };
}
