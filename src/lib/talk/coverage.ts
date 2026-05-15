/**
 * Cheap coverage tracker for talk sessions.
 *
 * After each assistant turn, we look at the freshly-generated text and
 * compute a Jaccard-style overlap between its tokens and each card's
 * plain content. Cards that exceed a threshold get bumped up in the
 * coverage map; once a card crosses 0.5 cumulative score it counts
 * as "introduced" in the UI tally.
 *
 * This is not precise — a paraphrase that doesn't share surface tokens
 * with the card text won't register — but it's free, runs locally,
 * and is enough to give the user a sense of curriculum progress.
 */

import { renderPlain } from '@/lib/cloze/parser';
import type { Note } from '@/lib/db/schema';

interface CardContext {
  cardId: string;
  note: Note;
  /** Pre-tokenized lowercase set for fast intersection. */
  tokens: Set<string>;
}

const STOPWORDS = new Set([
  'the','a','an','and','or','but','of','in','on','at','to','for','from','by','with','as',
  'is','are','was','were','be','been','being','it','its','this','that','these','those',
  'i','you','we','they','he','she','them','us','our','your','their','his','her',
  'do','does','did','have','has','had','can','could','will','would','should','may',
  'not','no','so','if','then','than','about','into','over','under','out','up','down',
]);

function tokenize(s: string): Set<string> {
  return new Set(
    s.toLowerCase()
      .replace(/[^a-z0-9؀-ۿ\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 4 && !STOPWORDS.has(t)),
  );
}

export function buildCardContexts(cards: Array<{ id: string; note: Note }>): CardContext[] {
  return cards.map(c => {
    const text = [
      renderPlain(c.note.fields.front),
      renderPlain(c.note.fields.back ?? ''),
      renderPlain(c.note.fields.extra ?? ''),
    ].filter(Boolean).join(' ');
    return { cardId: c.id, note: c.note, tokens: tokenize(text) };
  });
}

/**
 * Walk every card context, compute overlap with the response, and
 * update the coverage map in place. Returns the cards that crossed
 * the "introduced" threshold in this update so the UI can flash them.
 */
export function updateCoverage(
  coverage: Record<string, number>,
  responseText: string,
  contexts: CardContext[],
): { newlyIntroduced: string[] } {
  const respTokens = tokenize(responseText);
  if (respTokens.size === 0) return { newlyIntroduced: [] };
  const newlyIntroduced: string[] = [];
  for (const ctx of contexts) {
    if (ctx.tokens.size === 0) continue;
    let shared = 0;
    for (const t of ctx.tokens) if (respTokens.has(t)) shared++;
    const overlap = shared / Math.min(ctx.tokens.size, respTokens.size);
    if (overlap <= 0.05) continue;
    const prev = coverage[ctx.cardId] ?? 0;
    const bump = Math.min(0.4, overlap);
    const next = Math.min(1, prev + bump);
    coverage[ctx.cardId] = next;
    if (prev < 0.5 && next >= 0.5) newlyIntroduced.push(ctx.cardId);
  }
  return { newlyIntroduced };
}

export function introducedCount(coverage: Record<string, number>): number {
  let n = 0;
  for (const v of Object.values(coverage)) if (v >= 0.5) n++;
  return n;
}
