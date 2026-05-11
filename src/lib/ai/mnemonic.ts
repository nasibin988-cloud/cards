/**
 * Generate a short, evocative mnemonic for the current note. Goes into
 * the existing `mnemonic` field — CardRenderer already shows a labeled
 * BackBlock for it on the reveal side.
 *
 * Style: 1–2 sentences max. Concrete imagery or a phonetic / alliterative
 * hook. NO em dashes, NO meta words, NO years unless load-bearing —
 * mirrors the user's MCAT V5 authoring discipline. If the card looks
 * resistant to mnemonic-ification (purely numeric, single-token answer
 * with no obvious associative hook), we return an empty string and the
 * caller leaves the field alone.
 */

import { makeAnthropicClient } from './client';
import { getSetting } from '@/lib/db/queries';
import type { Note } from '@/lib/db/schema';
import { renderPlain } from '@/lib/cloze/parser';

const MODEL = 'claude-opus-4-7';

const SYSTEM_PROMPT = `You write tight mnemonics for spaced-repetition flashcards.

Constraints:
- 1–2 sentences, max ~200 characters. A single vivid image or phonetic hook beats a paragraph.
- Concrete and sensory: a scene the user can picture, or a sound/word play that lodges the answer.
- No meta words ("classic", "remember that…", "think of…"). The mnemonic IS the thought; don't narrate it.
- No first names. No years unless load-bearing for the mnemonic. No em dashes.
- If the card has no plausible mnemonic hook (raw numbers without context, single-token trivia, etc.), output the literal string EMPTY.

Output JSON only:
{ "mnemonic": "<one or two sentences, or 'EMPTY'>" }`;

export async function generateMnemonic(note: Note): Promise<string> {
  const apiKey = await getSetting('claude_api_key');
  if (!apiKey) throw new Error('Claude API key not configured. Add it in Settings.');
  const client = await makeAnthropicClient(apiKey);

  const userContent = `FRONT:
${renderPlain(note.fields.front)}

BACK:
${renderPlain(note.fields.back ?? '')}

${note.fields.extra ? `EXTRA:\n${renderPlain(note.fields.extra)}\n\n` : ''}Write a mnemonic per the rules. JSON only.`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 400,
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
  const parsed = JSON.parse(json) as { mnemonic?: string };
  const out = (parsed.mnemonic ?? '').trim();
  if (!out || out === 'EMPTY') return '';
  return out;
}
