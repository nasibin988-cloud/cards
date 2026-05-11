/**
 * "Why did I miss this?" hint — generated when the user rates Again
 * on a card, displayed next time they review that same card.
 *
 * Model: Haiku, not Opus. Cost matters here because the hint can fire
 * on every lapse. Haiku writes a single-sentence diagnosis that's
 * good enough; it isn't authoring the card.
 *
 * Storage: localStorage keyed by cardId. No schema change. Hint is
 * stripped when the user finally gets the card right (rate >= 2 →
 * delete). Survives reloads, persists per browser. (Not synced —
 * lapse hints are ephemeral by design; they're meant to nudge you
 * on the next attempt, not become permanent card content.)
 */

import { makeAnthropicClient } from './client';
import { getSetting } from '@/lib/db/queries';
import type { Card, Note } from '@/lib/db/schema';
import { renderPlain } from '@/lib/cloze/parser';

const MODEL = 'claude-haiku-4-5-20251001';
const STORAGE_PREFIX = 'cards:lapse-hint:';

const SYSTEM_PROMPT = `You diagnose what an MCAT-style learner likely confused on a flashcard they just got wrong.

Write ONE sentence (≤25 words) naming the most likely confusion. Be specific to THIS card. Don't say "you might have forgotten X" — name the actual likely error.

No meta words ("perhaps", "maybe"). No em dashes. No first names. No years unless load-bearing. Direct, technical voice.

Output JSON only:
{ "hint": "<one sentence>" }`;

/**
 * Fire-and-forget. Generates a hint and writes it to localStorage.
 * Caller doesn't await — the cost is paid in the background while the
 * user moves to the next card.
 */
export async function generateAndStoreLapseHint(note: Note, card: Card): Promise<void> {
  if (typeof window === 'undefined') return;
  try {
    const apiKey = await getSetting('claude_api_key');
    if (!apiKey) return; // silently no-op when no key

    const client = await makeAnthropicClient(apiKey);
    const userContent = `FRONT: ${renderPlain(note.fields.front)}
BACK:  ${renderPlain(note.fields.back ?? '')}
${note.fields.extra ? `EXTRA: ${renderPlain(note.fields.extra)}\n` : ''}
LAPSES SO FAR: ${card.lapses}

Diagnose the likely confusion per the rules. JSON only.`;

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 300,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userContent }],
    });
    const text = response.content
      .map(b => (b.type === 'text' ? b.text : ''))
      .join('')
      .trim();
    const start = text.indexOf('{');
    const json = start >= 0 ? text.slice(start) : text;
    const parsed = JSON.parse(json) as { hint?: string };
    const hint = (parsed.hint ?? '').trim();
    if (!hint) return;
    localStorage.setItem(`${STORAGE_PREFIX}${card.id}`, JSON.stringify({
      hint,
      generatedAt: Date.now(),
    }));
  } catch { /* swallow — lapse hint is never blocking */ }
}

export function getLapseHint(cardId: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${cardId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { hint?: string };
    return parsed.hint ?? null;
  } catch {
    return null;
  }
}

export function clearLapseHint(cardId: string): void {
  if (typeof window === 'undefined') return;
  try { localStorage.removeItem(`${STORAGE_PREFIX}${cardId}`); } catch { /* ignore */ }
}
