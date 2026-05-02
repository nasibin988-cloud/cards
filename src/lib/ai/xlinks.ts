/**
 * AI-suggested cross-card link proposals.
 *
 * Pipeline:
 *  1. Use the existing `searchNotes` (token-overlap with field weighting) to
 *     pull the top-N most-similar notes to this one. No embeddings — that
 *     would require server-side state we don't have. Token overlap is good
 *     enough for a candidate pool.
 *  2. Hand the candidate notes + this note's content to Claude. Ask it to
 *     return a JSON list of `[[query|display]]` insertions, anchored to a
 *     specific span of source text.
 *  3. Caller previews each suggestion with accept/reject buttons before
 *     committing the rewrite.
 */

import { getSetting, searchNotes } from '@/lib/db/queries';
import type { Note } from '@/lib/db/schema';
import { makeAnthropicClient } from './client';
import { renderPlain } from '@/lib/cloze/parser';
import { DEFAULT_MODEL } from './claude';

export interface XlinkSuggestion {
  /** Plain text span in the note's Front field that should be wrapped. */
  anchor: string;
  /** Display text inside the [[…]] (defaults to anchor). */
  display?: string;
  /** The other note's id, the link target. */
  targetNoteId: string;
  /** Short snippet of the target's front for preview. */
  targetSnippet: string;
  /** Why this link is appropriate. */
  rationale: string;
}

interface ProposeOpts {
  note: Note;
  /** How many candidate similar notes to feed Claude. Default 8. */
  candidateK?: number;
}

export async function proposeXlinks(opts: ProposeOpts): Promise<XlinkSuggestion[]> {
  const { note, candidateK = 8 } = opts;
  const apiKey = await getSetting('claude_api_key');
  if (!apiKey) throw new Error('Add your Claude API key in Settings.');
  const model = (await getSetting('claude_model')) || DEFAULT_MODEL;

  const seed = `${renderPlain(note.fields.front)} ${renderPlain(note.fields.back)}`;
  const hits = await searchNotes(seed, candidateK);
  const candidates = hits.filter(h => h.noteId !== note.id);
  if (candidates.length === 0) return [];

  const candidateBlocks = candidates.map((h, i) =>
    `${i + 1}. id=${h.noteId} deck="${h.deckName}"\n   front: ${truncate(renderPlain(h.snippet), 220)}`
  ).join('\n');

  const system = `You suggest cross-card links between flashcards.

Given the source note and a list of candidate target notes, return a JSON array of at most 5 high-value link suggestions. Each suggestion has:
  { "anchor": string, "targetNoteId": string, "rationale": string, "display"?: string }

Rules:
- "anchor" MUST be a verbatim substring of the source note's Front field. No paraphrasing.
- Pick anchors that are real concepts, not generic words.
- Skip suggestions where the target note isn't genuinely about the anchor concept.
- Prefer at most 1 suggestion per source-anchor span.
- If no suggestions are warranted, return [].

Output ONLY the JSON array. No commentary.`;

  const sourceFront = renderPlain(note.fields.front);
  const user = `SOURCE NOTE (front field):\n${sourceFront}\n\nCANDIDATE TARGETS:\n${candidateBlocks}\n\nReturn JSON array now.`;

  const client = await makeAnthropicClient(apiKey);
  const r = await client.messages.create({
    model,
    max_tokens: 1024,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: user }],
  });
  const text = r.content.map(c => (c.type === 'text' ? c.text : '')).join('').trim();

  const arr = parseJsonArray(text);
  if (!Array.isArray(arr)) return [];

  const targetById = new Map(candidates.map(c => [c.noteId, c]));
  return arr
    .filter((x): x is { anchor: string; targetNoteId: string; rationale: string; display?: string } =>
      x && typeof x === 'object'
      && typeof x.anchor === 'string'
      && typeof x.targetNoteId === 'string'
      && typeof x.rationale === 'string',
    )
    .filter(x => sourceFront.includes(x.anchor))
    .filter(x => targetById.has(x.targetNoteId))
    .slice(0, 5)
    .map(x => ({
      anchor: x.anchor,
      display: x.display,
      targetNoteId: x.targetNoteId,
      rationale: x.rationale,
      targetSnippet: truncate(renderPlain(targetById.get(x.targetNoteId)!.snippet), 140),
    }));
}

/**
 * Apply a single suggestion to a Front field: replace the first occurrence
 * of the anchor with `[[noteId|display]]` (or `[[noteId|anchor]]`).
 */
export function applyXlinkSuggestion(front: string, suggestion: XlinkSuggestion): string {
  const display = suggestion.display ?? suggestion.anchor;
  const replacement = `[[${suggestion.targetNoteId}|${display}]]`;
  const idx = front.indexOf(suggestion.anchor);
  if (idx === -1) return front;
  return front.slice(0, idx) + replacement + front.slice(idx + suggestion.anchor.length);
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + '…';
}

function parseJsonArray(text: string): unknown {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  }
  try {
    return JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\[[\s\S]*\]/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch { return null; }
  }
}
