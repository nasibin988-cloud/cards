/**
 * AI grader: given a typed answer and the card's expected answer (back +
 * extra + the revealed cloze content for cloze cards), Claude returns a
 * suggested rating 1-4 and a short critique.
 *
 * Uses the same client and key as askClaude. Streams nothing; this is a
 * single round-trip with structured JSON output.
 */

import type { Card, Note, Rating } from '@/lib/db/schema';
import { getSetting } from '@/lib/db/queries';
import { makeAnthropicClient } from './client';
import { renderPlain } from '@/lib/cloze/parser';
import { DEFAULT_MODEL } from './claude';

export interface GraderResult {
  rating: Rating;
  critique: string;
  matched: boolean;       // true if answer was substantively correct
}

const SYSTEM_PROMPT = `You are an exacting study grader.

The user reviewed a flashcard and typed an answer. Compare it to the expected answer below. Output exactly one JSON object with these keys:
  "rating": integer 1-4
  "critique": one short sentence, terse, no hedging
  "matched": boolean

Rating rubric (FSRS):
  1 (Again)  — wrong, missed entirely, or fundamentally confused
  2 (Hard)   — partially correct but missed key components or precision
  3 (Good)   — correct in substance; minor wording differences are fine
  4 (Easy)   — correct AND complete with no hesitation

Be strict on "Good": if the answer omits a load-bearing fact from the back, it is at most a 2.

Output ONLY the JSON. No markdown, no commentary.`;

function buildUserPrompt(note: Note, card: Card, typedAnswer: string): string {
  const expected = note.modelId === 'cloze'
    ? `Cloze content: ${renderPlain(note.fields.front)}\nBack annotation: ${note.fields.back || '(none)'}`
    : `Back: ${note.fields.back || '(none)'}`;
  const extras = [
    note.fields.extra && `Extra: ${note.fields.extra}`,
    note.fields.mnemonic && `Mnemonic: ${note.fields.mnemonic}`,
    note.fields.context && `Context: ${note.fields.context}`,
  ].filter(Boolean).join('\n');

  return [
    `Question:\n${renderPlain(note.fields.front)}`,
    '',
    `Expected answer:\n${expected}`,
    extras,
    '',
    `Student typed:\n${typedAnswer || '(blank)'}`,
  ].filter(Boolean).join('\n');
}

export async function gradeAnswer(
  note: Note, card: Card, typedAnswer: string,
): Promise<GraderResult> {
  const apiKey = await getSetting('claude_api_key');
  if (!apiKey) throw new Error('Add your Claude API key in Settings to use grading.');
  const model = (await getSetting('claude_model')) || DEFAULT_MODEL;
  const client = await makeAnthropicClient(apiKey);

  const res = await client.messages.create({
    model,
    max_tokens: 256,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserPrompt(note, card, typedAnswer) }],
  });

  const text = res.content
    .filter(b => b.type === 'text')
    .map(b => 'text' in b ? b.text : '')
    .join('')
    .trim();

  const parsed = parseGraderJson(text);
  if (!parsed) throw new Error(`Grader returned non-JSON: ${text.slice(0, 200)}`);
  return parsed;
}

function parseGraderJson(text: string): GraderResult | null {
  // Tolerant parse: strip code fences if present.
  const cleaned = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
  try {
    const obj = JSON.parse(cleaned);
    const rating = obj.rating;
    if (![1, 2, 3, 4].includes(rating)) return null;
    return {
      rating: rating as Rating,
      critique: typeof obj.critique === 'string' ? obj.critique : '',
      matched: !!obj.matched,
    };
  } catch {
    return null;
  }
}
