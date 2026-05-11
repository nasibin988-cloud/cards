/**
 * Look at the current note + the most-similar peer notes in its deck;
 * if a peer is confusable, append a "distinct from X because Y" line
 * to the BACK so future reviews start with the disambiguator already
 * baked in.
 *
 * Returns the appended snippet (without surrounding back text) plus
 * the new back. Caller is responsible for committing.
 */

import { makeAnthropicClient } from './client';
import { getSetting } from '@/lib/db/queries';
import { db } from '@/lib/db/dexie';
import type { Note } from '@/lib/db/schema';
import { renderPlain } from '@/lib/cloze/parser';

const MODEL = 'claude-opus-4-7';

const SYSTEM_PROMPT = `You catch confusable peer flashcards and write a disambiguating sentence.

Given the current card + a list of peers in the same deck, decide whether the user is at risk of confusing the current card with any peer (terminology overlap, similar mechanism, sibling concept). If so, write ONE sentence — under 25 words — that crisply distinguishes the current card from the most confusable peer. Format:

  Distinct from <peer concept, paraphrased>: <the one fact that separates them>.

Constraints:
- One sentence, one peer. Pick the most confusable.
- Mechanism over surface trivia. Don't say "X is uppercase, Y is lowercase". Say what's mechanistically different.
- No meta words ("note that…", "be careful…"). No em dashes. No first names. No years unless load-bearing.
- If nothing in the peer list is genuinely confusable, output "NONE".

Output JSON only:
{ "snippet": "<the sentence, or 'NONE'>" }`;

export interface DisambiguateResult {
  /** The new disambiguator snippet. Empty if Opus found nothing. */
  snippet: string;
  /** The new back: original + " " + snippet. Empty if no snippet. */
  newBack: string;
}

export async function disambiguateCard(note: Note): Promise<DisambiguateResult> {
  const apiKey = await getSetting('claude_api_key');
  if (!apiKey) throw new Error('Claude API key not configured. Add it in Settings.');
  const client = await makeAnthropicClient(apiKey);

  // Pull peer fronts from the same deck, ranked by word-overlap with
  // the current card. Same shape as refine's deck-digest, capped to
  // keep the prompt compact.
  const peers = await db().notes.where('deckId').equals(note.deckId).toArray();
  const myWords = new Set(
    renderPlain(note.fields.front + ' ' + (note.fields.back ?? ''))
      .toLowerCase()
      .split(/\W+/)
      .filter(w => w.length >= 4),
  );
  const scored: Array<{ note: Note; score: number }> = [];
  for (const p of peers) {
    if (p.id === note.id) continue;
    const text = renderPlain((p.fields.front ?? '') + ' ' + (p.fields.back ?? '')).toLowerCase();
    let score = 0;
    for (const w of text.split(/\W+/)) {
      if (w.length >= 4 && myWords.has(w)) score++;
    }
    if (score > 0) scored.push({ note: p, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 60).map(s => s.note);

  if (top.length === 0) {
    return { snippet: '', newBack: '' };
  }

  const peerLines = top
    .map((p, i) => {
      const front = renderPlain(p.fields.front).replace(/\s+/g, ' ').trim().slice(0, 90);
      const back = renderPlain(p.fields.back ?? '').replace(/\s+/g, ' ').trim().slice(0, 90);
      return `${i + 1}. FRONT: ${front}\n   BACK: ${back}`;
    })
    .join('\n');

  const userContent = `CURRENT CARD
FRONT: ${renderPlain(note.fields.front)}
BACK:  ${renderPlain(note.fields.back ?? '')}

PEERS IN THIS DECK (word-overlap-ranked, most-similar first):
${peerLines}

Write a disambiguator per the rules. JSON only.`;

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
  const parsed = JSON.parse(json) as { snippet?: string };
  const snippet = (parsed.snippet ?? '').trim();
  if (!snippet || snippet === 'NONE') return { snippet: '', newBack: '' };

  const existingBack = (note.fields.back ?? '').trim();
  const newBack = existingBack
    ? `${existingBack}\n\n${snippet}`
    : snippet;
  return { snippet, newBack };
}
