/**
 * Background "auto-rephrase" trigger. Fires after a rate IFF:
 *   - the user has opted in via the setting (default OFF)
 *   - the card's stability >= a configurable floor (default 7 days)
 *   - the card has fewer than the max-phrasings cap (default 4) so we
 *     don't keep generating forever
 *   - the rating was Good (3) or Easy (4) — never on Again/Hard, since
 *     mid-confusion is the wrong moment to swap wording
 *
 * Fire-and-forget on the rate path: never await this, never block the
 * user. Generates one new phrasing, appends to the live rotation pool,
 * archives any retired wording to phrasingHistory. Same Opus call shape
 * as the manual `V` path.
 */

import { generatePhrasings } from './phrasings';
import { getJsonSetting, updateNote } from '@/lib/db/queries';
import type { Card, Note, Rating } from '@/lib/db/schema';

export interface AutoRephraseConfig {
  enabled: boolean;
  minStabilityDays: number;
  maxPhrasings: number;
  onlyGoodOrEasy: boolean;
}

const DEFAULTS: AutoRephraseConfig = {
  enabled: false,
  minStabilityDays: 7,
  maxPhrasings: 4,
  onlyGoodOrEasy: true,
};

export async function loadAutoRephraseConfig(): Promise<AutoRephraseConfig> {
  const [enabled, minStability, maxPhr, gateRating] = await Promise.all([
    getJsonSetting<boolean>('auto_rephrase_enabled', DEFAULTS.enabled),
    getJsonSetting<number>('auto_rephrase_min_stability_days', DEFAULTS.minStabilityDays),
    getJsonSetting<number>('auto_rephrase_max_phrasings', DEFAULTS.maxPhrasings),
    getJsonSetting<boolean>('auto_rephrase_only_good_or_easy', DEFAULTS.onlyGoodOrEasy),
  ]);
  return {
    enabled,
    minStabilityDays: Number.isFinite(minStability) && minStability >= 0 ? minStability : DEFAULTS.minStabilityDays,
    maxPhrasings: Number.isFinite(maxPhr) && maxPhr >= 0 ? maxPhr : DEFAULTS.maxPhrasings,
    onlyGoodOrEasy: gateRating,
  };
}

export function shouldAutoRephrase(
  note: Note,
  card: Card,
  rating: Rating,
  cfg: AutoRephraseConfig,
): boolean {
  if (!cfg.enabled) return false;
  if (cfg.onlyGoodOrEasy && rating < 3) return false;
  if (card.stability < cfg.minStabilityDays) return false;
  const have = note.phrasings?.length ?? 0;
  if (have >= cfg.maxPhrasings) return false;
  return true;
}

/**
 * Generate one fresh phrasing and append it to the live pool. Archives
 * old phrasings + the canonical front to phrasingHistory.
 *
 * Caller should NOT await — this runs in the background and surfaces
 * results on the next render via React's normal subscription path.
 * Throws are swallowed; auto-rephrase is best-effort and never
 * interferes with the review flow.
 */
export async function runAutoRephrase(note: Note): Promise<{
  added: number;
  phrasings: string[];
  phrasingHistory: string[];
} | null> {
  try {
    const fresh = await generatePhrasings(note);
    if (fresh.length === 0) return null;
    // generatePhrasings returns 2; we only want to add 1 per cycle so
    // the rotation doesn't explode after a few reviews.
    const pick = fresh.find(p =>
      !(note.phrasings ?? []).includes(p)
      && !(note.phrasingHistory ?? []).includes(p)
      && p !== note.fields.front,
    ) ?? fresh[0];
    const newPhrasings = [...(note.phrasings ?? []), pick];
    const accumulated = new Set<string>([
      ...(note.phrasingHistory ?? []),
      ...newPhrasings,
      note.fields.front,
    ]);
    const newHistory = [...accumulated];
    await updateNote(note.id, { phrasings: newPhrasings, phrasingHistory: newHistory });
    return { added: 1, phrasings: newPhrasings, phrasingHistory: newHistory };
  } catch {
    return null;
  }
}
