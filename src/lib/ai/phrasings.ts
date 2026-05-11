/**
 * Generate 2 alternate phrasings of a card's front. Same fact, different
 * wording — so by the time a card hits 30-day intervals you've answered
 * it phrased 3+ different ways and you've learned the concept, not the
 * sentence. The Reviewer rotates through (original, ...phrasings) based
 * on the card's reps + lapses count.
 *
 * Cloze invariant: each phrasing must carry the same {{cN::...}} ord set
 * as the original front, with the same inner answer per ord. We validate
 * client-side and drop any phrasing that mutated the structure.
 */

import { makeAnthropicClient } from './client';
import { getSetting } from '@/lib/db/queries';
import type { Note } from '@/lib/db/schema';

const MODEL = 'claude-opus-4-7';

const SYSTEM_PROMPT = `You write alternate phrasings of a flashcard's front for an anti-rote learning system.

Goal: same fact, different sentence. By rotating phrasings on each review, the user learns the concept instead of memorising one specific wording.

Rules:
- Generate exactly 2 alternate phrasings. Each one tests the same fact as the original. No new information, no broader scope, no narrower scope.
- For CLOZE cards: every {{cN::ANSWER}} ord in the original MUST appear in every phrasing, with the SAME inner ANSWER. You may move them around in the sentence, restructure the surrounding text, change voice (active ↔ passive), reorder clauses, but the cloze answers themselves stay verbatim.
- Vary structure: don't just swap one synonym. Restructure. Active to passive. Lead with a different fact. Use a definition stem instead of a question stem (or vice versa). Make the two phrasings feel like they came from different textbook authors.
- No meta words ("recall that", "note that"). No em dashes. No first names. No years unless load-bearing. No greetings, no preamble, no markdown wrappers.

Output JSON only:
{ "phrasings": ["<alt 1>", "<alt 2>"] }`;

/**
 * Count the (sorted) cloze-ord index set in a string. Used to verify
 * that Opus didn't drop or add a {{cN::}} marker.
 */
function clozeOrds(s: string): number[] {
  const ords = new Set<number>();
  const re = /\{\{c(\d+)::/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) ords.add(parseInt(m[1], 10));
  return [...ords].sort((a, b) => a - b);
}

/**
 * Extract the inner answer text for each cloze ord. Returns a map of
 * ord number → answer text. Stops at the matching closing braces and
 * strips any `::hint` annotation since we only care about the literal
 * answer for invariant-checking.
 */
function clozeAnswers(s: string): Map<number, string> {
  const out = new Map<number, string>();
  const re = /\{\{c(\d+)::([^}:]+?)(?::[^}]*)?\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const ord = parseInt(m[1], 10);
    // First occurrence wins — duplicated ords would be a separate bug.
    if (!out.has(ord)) out.set(ord, m[2].trim());
  }
  return out;
}

export async function generatePhrasings(note: Note): Promise<string[]> {
  const apiKey = await getSetting('claude_api_key');
  if (!apiKey) throw new Error('Claude API key not configured. Add it in Settings.');
  const client = await makeAnthropicClient(apiKey);

  const isCloze = note.modelId === 'cloze';
  const origOrds = isCloze ? clozeOrds(note.fields.front) : [];
  const origAnswers = isCloze ? clozeAnswers(note.fields.front) : new Map<number, string>();

  const userContent = `Card type: ${isCloze ? 'cloze' : 'basic'}
${isCloze
  ? `Cloze ords that MUST appear in each phrasing with the SAME inner answer: ${[...origAnswers.entries()].map(([ord, ans]) => `{{c${ord}::${ans}}}`).join(', ')}\n`
  : ''}
ORIGINAL FRONT:
${note.fields.front}

BACK (for context only; do not paraphrase):
${note.fields.back ?? ''}

Generate exactly 2 alternate phrasings of the FRONT. JSON only.`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1200,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userContent }],
  });

  const text = response.content
    .map(b => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();
  const json = (() => {
    const fenced = text.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
    if (fenced) return fenced[1].trim();
    const start = text.indexOf('{');
    return start >= 0 ? text.slice(start) : text;
  })();

  let parsed: { phrasings?: unknown };
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Could not parse model response as JSON.');
  }
  const raw = Array.isArray(parsed.phrasings) ? parsed.phrasings : [];
  const candidates = raw
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    .map(p => p.trim());

  // Drop phrasings that mutated the cloze structure. Better to ship
  // fewer phrasings than to silently degrade recall.
  const accepted: string[] = [];
  for (const p of candidates) {
    if (!isCloze) {
      // Basic notes: any non-empty paraphrase is acceptable. Don't
      // emit identical-to-original ones though.
      if (p !== note.fields.front) accepted.push(p);
      continue;
    }
    const pOrds = clozeOrds(p);
    if (pOrds.length !== origOrds.length || !pOrds.every((o, i) => o === origOrds[i])) continue;
    const pAns = clozeAnswers(p);
    let ok = true;
    for (const [ord, ans] of origAnswers) {
      if (pAns.get(ord) !== ans) { ok = false; break; }
    }
    if (!ok) continue;
    if (p === note.fields.front) continue;
    accepted.push(p);
  }

  return accepted;
}
