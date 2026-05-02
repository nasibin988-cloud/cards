/**
 * Feynman-mode evaluator. Given a card and the user's plain-language
 * explanation, asks Claude to produce a structured grade against the card's
 * back + extra ("why") + context fields.
 *
 * Output is a JSON object so the UI can render covered/missed/vague as
 * separate columns. Completeness drives the schedule bonus on the next
 * rate (a thorough explanation widens the FSRS interval).
 */

import { db } from '@/lib/db/dexie';
import { getSetting } from '@/lib/db/queries';
import { renderPlain } from '@/lib/cloze/parser';
import type { FeynmanGrade } from '@/lib/db/schema';
import { DEFAULT_MODEL } from './claude';
import { makeAnthropicClient } from './client';

const SYSTEM = `You are evaluating a student's plain-language explanation of a flashcard concept.

The student is using the Feynman technique: explain a concept simply, identify gaps in understanding, refine. Your job is to grade their explanation against the card's reference answer and surface what's missing.

Return STRICTLY a JSON object (no surrounding prose, no markdown fences) with this shape:

{
  "covered": ["bullet 1", "bullet 2", ...],
  "missed":  ["bullet 1", "bullet 2", ...],
  "vague":   ["bullet 1", "bullet 2", ...],
  "completeness": 0.0-1.0,
  "rationale": "1-2 sentence overall summary"
}

Rules:
- "covered" lists what the student got right (3-6 short bullets max).
- "missed" lists important reference points the student didn't mention (3-6 short bullets max).
- "vague" lists terms the student used without explaining, contradictions, or hand-waved logic (0-4 bullets).
- "completeness" is the fraction (0..1) of the reference content the student covered. Be generous about phrasing — paraphrase counts. Be strict about substance — naming a term is not the same as explaining it.
- "rationale" is for the user's eyes; keep it warm but honest.
- Never say "the card says X" — speak to the student directly ("you covered..." / "you missed...").
- Never invent content not in the reference. If the reference is sparse, "missed" can be empty.
- Output VALID JSON. No trailing commas. Strings only.`;

function buildUserPrompt(card: {
  topic: string;
  reference: string;
  explanation: string;
}): string {
  return `# CARD TOPIC
${card.topic}

# REFERENCE CONTENT (back + extra + context — what the user is trying to teach back)
${card.reference || '(no reference content available)'}

# STUDENT'S EXPLANATION
${card.explanation}`;
}

/**
 * Evaluate a Feynman attempt. Reads the note + card by id, builds a topic
 * + reference blob, asks Claude for a JSON grade, parses it. Throws on
 * unrecoverable errors so the UI can show a real message.
 */
export async function evaluateFeynmanExplanation(
  noteId: string,
  cardId: string,
  explanation: string,
): Promise<FeynmanGrade> {
  const trimmed = explanation.trim();
  if (trimmed.length < 5) {
    throw new Error('Explanation is too short to evaluate.');
  }

  const note = await db().notes.get(noteId);
  if (!note) throw new Error(`Note ${noteId} not found.`);
  const card = await db().cards.get(cardId);
  if (!card) throw new Error(`Card ${cardId} not found.`);

  // Topic = the card's front, with cloze blanks filled in plain text so
  // Claude has the full statement (not "X is the {{c1::Y}}").
  const topic = renderPlain(note.fields.front ?? '');

  // Reference = back + extra + context. Strip any cloze syntax so the
  // grader sees prose, not Anki markers.
  const reference = [
    note.fields.back && `BACK:\n${renderPlain(note.fields.back)}`,
    note.fields.extra && `WHY:\n${renderPlain(note.fields.extra)}`,
    note.fields.context && `CONTEXT:\n${renderPlain(note.fields.context)}`,
    note.fields.mnemonic && `MNEMONIC:\n${renderPlain(note.fields.mnemonic)}`,
  ].filter(Boolean).join('\n\n');

  const apiKey = await getSetting('claude_api_key');
  if (!apiKey) throw new Error('Add your Claude API key in Settings.');
  const model = (await getSetting('claude_model')) || DEFAULT_MODEL;
  const client = await makeAnthropicClient(apiKey);

  const result = await client.messages.create({
    model,
    max_tokens: 1024,
    // Cache the system prompt — same one every Feynman call. Saves cost
    // when the user does multiple cards in a session.
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: buildUserPrompt({ topic, reference, explanation: trimmed }) }],
  });
  const raw = result.content
    .map(c => (c.type === 'text' ? c.text : ''))
    .join('').trim();
  return parseGrade(raw);
}

/**
 * Tolerant JSON extraction. Claude usually returns clean JSON but can
 * wrap in ```json``` fences, prepend a sentence, or add trailing commas.
 * We try the obvious parse first, then fall back to the largest brace-
 * matched substring.
 */
function parseGrade(raw: string): FeynmanGrade {
  const candidate = stripFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    const m = candidate.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('Grader returned non-JSON output.');
    parsed = JSON.parse(m[0]);
  }
  return normalizeGrade(parsed);
}

function stripFences(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

function normalizeGrade(p: unknown): FeynmanGrade {
  const obj = (p && typeof p === 'object') ? (p as Record<string, unknown>) : {};
  const arr = (k: string): string[] => {
    const v = obj[k];
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === 'string').map(s => s.trim()).filter(Boolean);
  };
  const num = (k: string): number => {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.min(1, v));
    if (typeof v === 'string') {
      const n = parseFloat(v);
      if (Number.isFinite(n)) return Math.max(0, Math.min(1, n));
    }
    return 0;
  };
  const str = (k: string): string => (typeof obj[k] === 'string' ? (obj[k] as string).trim() : '');
  return {
    covered: arr('covered'),
    missed: arr('missed'),
    vague: arr('vague'),
    completeness: num('completeness'),
    rationale: str('rationale'),
  };
}

/**
 * Convert a Feynman grade + the user's chosen rating into an FSRS
 * interval multiplier. The bonus only applies on Good/Easy with high
 * completeness — we don't widen intervals for cards the user couldn't
 * actually explain.
 *
 * Curve:
 *   - completeness < 0.6 OR rating ∈ {Again, Hard}: 1.0× (no bonus).
 *   - completeness ≥ 0.6 AND rating ∈ {Good, Easy}: linear from 1.0× → 1.5×.
 */
export function feynmanScheduleMultiplier(
  rating: 1 | 2 | 3 | 4,
  completeness: number,
): number {
  if (rating === 1 || rating === 2) return 1.0;
  if (completeness < 0.6) return 1.0;
  // Map completeness 0.6..1.0 → 1.0..1.5
  const span = (completeness - 0.6) / 0.4;
  return 1.0 + span * 0.5;
}

/* ─── Test seam ─────────────────────────────────────────────── */

export const __test = {
  parseGrade,
  normalizeGrade,
};
