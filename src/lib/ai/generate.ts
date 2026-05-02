/**
 * Card generator: given a passage of source text and authoring style,
 * Claude streams a list of draft notes. The user reviews each and chooses
 * to accept or reject individually.
 *
 * Output is a structured JSON array streamed inside a fenced block; we
 * accumulate the stream and parse at the end. Streaming is purely for
 * progress UX; we don't try to render partial JSON.
 */

import { getSetting } from '@/lib/db/queries';
import { makeAnthropicClient } from './client';
import type { NoteFields, Tier } from '@/lib/db/schema';
import { DEFAULT_MODEL } from './claude';

export interface DraftNote {
  fields: NoteFields;
  tags: string[];
  tier?: Tier;
  modelId: 'basic' | 'cloze';
}

export type GenerateStyle =
  | 'mcat-mechanism'   // multi-cloze, mechanism-over-narrative, MCAT house style
  | 'persian-vocab'   // Persian word + English gloss + Farsi script + transliteration
  | 'general-cloze'  // multi-cloze on any factual passage
  | 'qa-basic';      // basic question/answer pairs

interface GenerateOpts {
  text: string;
  style: GenerateStyle;
  count?: number;
  tagPrefix?: string;
  onChunk?: (delta: string) => void;
}

const STYLE_GUIDE: Record<GenerateStyle, string> = {
  'mcat-mechanism': `Authoring style: MCAT cloze cards.

  - Use multi-cloze {{c1::...}} aggressively when the clozes are independent retrieval points; never force a cloze to hit a target rate.
  - Mechanism over narrative. Explain WHY, not just WHAT.
  - Define unfamiliar terms inline; never forward-reference a term that isn't already on the card.
  - No "MCAT" / "Anki" / "high-yield" meta. No "classic", "textbook". No years unless load-bearing.
  - Use Front for cloze sentence, Back for follow-up annotation, Extra for the deeper mechanism explanation, Context for the sub-topic, Source for citation if any.
  - Use no em dashes. Periods, commas, parentheses only.`,

  'persian-vocab': `Authoring style: Persian vocabulary.

  - Front: Farsi word in script.
  - Back: English gloss (1-3 words).
  - Extra: literal etymology / breakdown if illuminating.
  - Context: typical phrase or sentence using the word.
  - Source: book or chapter if the user mentioned one.
  - Tag: "persian::vocab" plus any topic tag.`,

  'general-cloze': `Authoring style: general factual cloze.

  - Use multi-cloze where each cloze is an independent retrieval point.
  - Front carries the cloze sentence. Back is empty unless additional context is essential.
  - Extra holds the deeper "why" if the passage gave one.`,

  'qa-basic': `Authoring style: basic Q/A.

  - One question per card. Front is the question, Back is the answer.
  - Extra holds reasoning or a one-line proof.`,
};

const OUTPUT_FORMAT = `Output ONLY a JSON array of draft notes, no preamble or commentary, no code fences.

Each draft is an object:
{
  "modelId": "basic" | "cloze",
  "fields": {
    "front": string,
    "back": string,
    "extra"?: string,
    "mnemonic"?: string,
    "context"?: string,
    "source"?: string
  },
  "tags": string[],
  "tier"?: "core" | "clinical" | "advanced" | "bridge" | "standard" | "extended" | "scholarly"
}

If the passage doesn't yield enough material for the requested count, produce fewer rather than padding with low-quality cards. Quality > count.`;

export async function generateNotes(opts: GenerateOpts): Promise<DraftNote[]> {
  const { text, style, count = 8, tagPrefix, onChunk } = opts;
  const apiKey = await getSetting('claude_api_key');
  if (!apiKey) throw new Error('Add your Claude API key in Settings to generate cards.');
  const model = (await getSetting('claude_model')) || DEFAULT_MODEL;
  const client = await makeAnthropicClient(apiKey);

  const userPrompt = [
    `Authoring style:\n${STYLE_GUIDE[style]}`,
    '',
    `Target count: produce up to ${count} cards. Quality first.`,
    tagPrefix ? `Tag prefix: every card's tags array must start with "${tagPrefix}".` : '',
    '',
    `Source passage:`,
    '<<<',
    text,
    '>>>',
    '',
    OUTPUT_FORMAT,
  ].filter(Boolean).join('\n');

  let acc = '';
  const stream = client.messages.stream({
    model,
    max_tokens: 4096,
    system: 'You are a careful flashcard author. Follow the instructions exactly.',
    messages: [{ role: 'user', content: userPrompt }],
  });
  stream.on('text', delta => {
    acc += delta;
    onChunk?.(delta);
  });
  await stream.finalMessage();

  return parseDrafts(acc);
}

function parseDrafts(text: string): DraftNote[] {
  // Strip code fences if the model decided to use them despite instructions.
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  }
  try {
    const arr = JSON.parse(cleaned);
    if (!Array.isArray(arr)) throw new Error('expected array');
    return arr.filter(isDraft);
  } catch {
    // Fall back: try to find a JSON array in the text.
    const m = cleaned.match(/\[[\s\S]*\]/);
    if (!m) throw new Error(`Could not parse generator output:\n${cleaned.slice(0, 400)}`);
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) throw new Error('expected array');
    return arr.filter(isDraft);
  }
}

function isDraft(x: unknown): x is DraftNote {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  if (o.modelId !== 'basic' && o.modelId !== 'cloze') return false;
  if (typeof o.fields !== 'object' || o.fields === null) return false;
  const f = o.fields as Record<string, unknown>;
  if (typeof f.front !== 'string' || !f.front) return false;
  if (typeof f.back !== 'string') return false;
  return true;
}
