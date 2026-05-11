/**
 * One-shot AI-driven card refinement.
 *
 * Goal: the user hits a shortcut on a card they think is low-quality.
 * Opus reads the card + a digest of other notes in the deck, diagnoses
 * one or more of:
 *   - LEAKAGE: text outside a cloze gives away the answer
 *       (paren leaks, forward-references, abbrev expanded-outside)
 *   - WEAK_CLOZE: cloze content is too long / not the salient fact
 *   - DUPLICATION: this card tests effectively the same fact as another
 * and returns a rewritten version of the card.
 *
 * Hard constraints baked into the prompt:
 *   - Preserve the exact set of {{cN::...}} indices. A 3-cloze card
 *     stays a 3-cloze card with c1/c2/c3.
 *   - Mechanism over narrative; no meta words ("classic", "textbook"),
 *     no years unless load-bearing, no first names, no em dashes —
 *     mirrors the user's MCAT V5 authoring discipline.
 *   - DUPLICATION rewrite produces a card on a DIFFERENT (deeper or
 *     adjacent) fact that fits the deck — not minutiae. Same cloze
 *     count.
 *
 * Output is validated client-side: if the new card has a different
 * cloze-ord count, we drop the rewrite (no silent regressions).
 */

import { makeAnthropicClient } from './client';
import { getSetting } from '@/lib/db/queries';
import { db } from '@/lib/db/dexie';
import type { Note } from '@/lib/db/schema';
import { renderPlain } from '@/lib/cloze/parser';

/** Always Opus for authorship. Haiku is reserved for bulk-triage v2. */
const IMPROVER_MODEL = 'claude-opus-4-7';

export type Diagnosis = 'LEAKAGE' | 'WEAK_CLOZE' | 'DUPLICATION' | 'OK';

export interface ImproveResult {
  /** What the model thinks is wrong (may be ['OK']). */
  diagnoses: Diagnosis[];
  /** True if the model produced a meaningfully different rewrite. */
  isImprovement: boolean;
  /** New front (cloze-bearing for cloze notes, plain for basic). */
  newFront: string;
  /** New back. */
  newBack: string;
  /** Optional new extra text. */
  newExtra?: string;
  /** When DUPLICATION is the primary issue, a short hint at which other
   *  card this duplicates (front-snippet). For the user's awareness. */
  duplicateOfHint: string | null;
  /** One-sentence explanation. */
  rationale: string;
}

interface RawResponse {
  diagnoses?: string[];
  isImprovement?: boolean;
  newFront?: string;
  newBack?: string;
  newExtra?: string;
  duplicateOfHint?: string | null;
  rationale?: string;
}

const SYSTEM_PROMPT = `You refine flashcards for spaced-repetition study. Diagnose three failure modes and rewrite when you find one:

1. LEAKAGE — text outside the cloze gives away the answer.
   - Parenthetical leak: text in (parens) inside or right after a cloze restates the answer.
   - Forward-reference leak: a later phrase references the cloze answer in a way that makes guessing trivial.
   - Abbreviation leak: an abbreviation is expanded outside the cloze when the cloze IS the expansion (or vice versa).

2. WEAK_CLOZE — what's clozed is too long, includes filler, or is not the salient testable fact.
   - A good cloze is the one or two words you're testing recall on, not a multi-clause sentence.
   - If the cloze contains a whole clause, narrow it to the precise fact.

3. DUPLICATION — this card tests effectively the same fact as another card listed in the deck digest.
   - When duplication is the primary problem, you produce a REPLACEMENT card on a different but adjacent fact that's NOT yet covered. Same cloze count. Go deeper into the mechanism or sideways into a related concept that fits the deck. NOT minutiae like names, dates, or trivia.

Hard constraints when rewriting:
- Preserve the exact set of {{cN::...}} ord numbers. A 3-cloze card stays 3-cloze with c1, c2, c3. No adding or removing clozes.
- Voice is clear, mechanism-over-narrative. No meta words ("classic", "textbook"). No years unless load-bearing. No first names. No em dashes anywhere.
- Don't paraphrase content that's already correct just to look different. If you don't see a real problem, return diagnoses: ["OK"] and isImprovement: false.

Output JSON ONLY (no prose before or after, no markdown fence):
{
  "diagnoses": ["LEAKAGE" | "WEAK_CLOZE" | "DUPLICATION" | "OK", ...],
  "isImprovement": boolean,
  "newFront": "<new front, cloze-bearing if cloze>",
  "newBack": "<new back>",
  "newExtra": "<optional, only when needed>",
  "duplicateOfHint": "<short snippet of the duplicate's front, or null>",
  "rationale": "<one sentence>"
}`;

/**
 * Count {{cN::...}} ord indices in a string. Used to enforce the
 * preserve-cloze-count invariant on Opus's output.
 */
function clozeOrds(s: string): number[] {
  const ords = new Set<number>();
  const re = /\{\{c(\d+)::/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) ords.add(parseInt(m[1], 10));
  return [...ords].sort((a, b) => a - b);
}

/**
 * Build a compact digest of other notes in the same deck so the model
 * can spot duplicates. We bias toward notes whose plain-text front
 * shares words with the current card — a cheap proxy for relevance.
 * Caps at ~120 entries to keep the prompt size reasonable.
 */
async function buildDeckDigest(currentNote: Note): Promise<string> {
  const peers = await db().notes
    .where('deckId').equals(currentNote.deckId)
    .toArray();
  const currentWords = new Set(
    renderPlain(currentNote.fields.front + ' ' + (currentNote.fields.back ?? ''))
      .toLowerCase()
      .split(/\W+/)
      .filter(w => w.length >= 4),
  );

  const scored: Array<{ note: Note; score: number }> = [];
  for (const n of peers) {
    if (n.id === currentNote.id) continue;
    const text = renderPlain((n.fields.front ?? '') + ' ' + (n.fields.back ?? '')).toLowerCase();
    let score = 0;
    for (const w of text.split(/\W+/)) {
      if (w.length >= 4 && currentWords.has(w)) score++;
    }
    if (score > 0) scored.push({ note: n, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 120).map(s => s.note);

  const lines: string[] = [];
  for (const n of top) {
    const front = renderPlain(n.fields.front).replace(/\s+/g, ' ').trim().slice(0, 100);
    if (front) lines.push(`- ${front}`);
  }
  return lines.join('\n') || '(no other notes in this deck)';
}

export interface ImproveOptions {
  /** Set true to skip the deck-digest fetch (faster, smaller prompt). */
  skipDuplicationCheck?: boolean;
  signal?: AbortSignal;
}

/**
 * Main entry point. Returns a rewrite that has been validated to
 * preserve the cloze-ord set. If validation fails or the model says
 * isImprovement=false, the rewrite is returned with isImprovement
 * unchanged so the caller can decide to drop it.
 */
export async function improveCardWithAI(
  note: Note,
  opts: ImproveOptions = {},
): Promise<ImproveResult> {
  const apiKey = await getSetting('claude_api_key');
  if (!apiKey) throw new Error('Claude API key not configured. Add it in Settings.');
  const client = await makeAnthropicClient(apiKey);

  const isCloze = note.modelId === 'cloze';
  const origOrds = isCloze ? clozeOrds(note.fields.front) : [];

  const digest = opts.skipDuplicationCheck
    ? '(skipped)'
    : await buildDeckDigest(note);

  const userContent = `Card type: ${isCloze ? 'cloze' : 'basic'}
Cloze ords present: ${isCloze ? `[${origOrds.join(', ')}]` : 'n/a'}

CURRENT FRONT:
${note.fields.front}

CURRENT BACK:
${note.fields.back ?? ''}

${note.fields.extra ? `CURRENT EXTRA:\n${note.fields.extra}\n\n` : ''}OTHER NOTES IN THIS DECK (front excerpts, sampled by word-overlap relevance):
${digest}

Diagnose and rewrite per the system rules. If nothing's wrong, return diagnoses: ["OK"], isImprovement: false, and echo the current fields unchanged.`;

  const response = await client.messages.create({
    model: IMPROVER_MODEL,
    max_tokens: 2048,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userContent }],
  });

  const text = response.content
    .map(block => (block.type === 'text' ? block.text : ''))
    .join('')
    .trim();

  // Strip optional JSON code-fences and any leading prose before the {.
  const jsonText = (() => {
    const fenced = text.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
    if (fenced) return fenced[1].trim();
    const braceStart = text.indexOf('{');
    return braceStart >= 0 ? text.slice(braceStart) : text;
  })();

  let parsed: RawResponse;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`Could not parse model response as JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  const diagnoses = (parsed.diagnoses ?? []).filter((d): d is Diagnosis =>
    d === 'LEAKAGE' || d === 'WEAK_CLOZE' || d === 'DUPLICATION' || d === 'OK',
  );
  const newFront = String(parsed.newFront ?? note.fields.front);
  const newBack = String(parsed.newBack ?? note.fields.back ?? '');

  // Hard validation: a cloze card must keep its ord set exactly. If
  // Opus dropped or added a cloze (rare but possible), refuse the
  // rewrite — we'd rather show no change than silently lose recall
  // structure.
  if (isCloze) {
    const newOrds = clozeOrds(newFront);
    const same =
      origOrds.length === newOrds.length
      && origOrds.every((o, i) => o === newOrds[i]);
    if (!same) {
      return {
        diagnoses,
        isImprovement: false,
        newFront: note.fields.front,
        newBack: note.fields.back ?? '',
        newExtra: note.fields.extra,
        duplicateOfHint: null,
        rationale: `Rewrite rejected: cloze ords changed from [${origOrds.join(',')}] to [${newOrds.join(',')}].`,
      };
    }
  }

  return {
    diagnoses: diagnoses.length ? diagnoses : ['OK'],
    isImprovement: Boolean(parsed.isImprovement),
    newFront,
    newBack,
    newExtra: parsed.newExtra,
    duplicateOfHint: parsed.duplicateOfHint ?? null,
    rationale: String(parsed.rationale ?? ''),
  };
}
