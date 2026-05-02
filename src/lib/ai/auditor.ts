/**
 * Card-quality auditor: surface cards that are likely poorly written, then
 * use Claude to propose a rewrite the user can accept with one click.
 *
 * Two phases:
 *  1. **Heuristic surfacing.** Cheap, no AI: lapsing-too-often, overlong,
 *     underspecified, or cloze syntax mishaps. Returns a ranked list of
 *     candidate notes.
 *  2. **Per-note rewrite.** AI: given a candidate, Claude returns a
 *     rewritten draft of the same fields preserving meaning + tags + tier.
 *     The UI shows side-by-side diff and a single Accept button.
 */

import { db } from '@/lib/db/dexie';
import { getSetting, validateNoteXlinks } from '@/lib/db/queries';
import { makeAnthropicClient } from './client';
import type { Card, Note, NoteFields } from '@/lib/db/schema';
import { hasCloze, renderPlain } from '@/lib/cloze/parser';
import { DEFAULT_MODEL } from './claude';

export type AuditReason =
  | 'lapsing'
  | 'overlong'
  | 'underspecified'
  | 'malformed'
  | 'broken-xlink';

export interface AuditCandidate {
  note: Note;
  cards: Card[];
  reasons: AuditReason[];
  /** Higher = more in need of attention. Sortable. */
  score: number;
  /** Short human-readable summary of why this card was flagged. */
  summary: string;
}

const REASON_LABELS: Record<AuditReason, string> = {
  lapsing: 'High lapse rate',
  overlong: 'Overlong front',
  underspecified: 'Sparse content',
  malformed: 'Cloze syntax issue',
  'broken-xlink': 'Broken cross-card link',
};

export interface AuditOptions {
  /** Limit cards in the audit pool. Default 5000 — full deck is fine for most. */
  scanLimit?: number;
  /** Min lapses to count as "lapsing." Default 3. */
  minLapses?: number;
  /** Max characters in front before counting as overlong. Default 360. */
  overlongAt?: number;
  /** How many candidates to surface. Default 30. */
  topK?: number;
}

export async function findCandidates(opts: AuditOptions = {}): Promise<AuditCandidate[]> {
  const { scanLimit = 5000, minLapses = 3, overlongAt = 360, topK = 30 } = opts;
  const dbi = db();
  const cards = await dbi.cards.limit(scanLimit).toArray();
  const noteIds = [...new Set(cards.map(c => c.noteId))];
  const notes = await dbi.notes.where('id').anyOf(noteIds).toArray();
  const noteById = new Map(notes.map(n => [n.id, n]));

  // Aggregate per-note signal.
  const cardsByNote = new Map<string, Card[]>();
  for (const c of cards) {
    const list = cardsByNote.get(c.noteId) ?? [];
    list.push(c);
    cardsByNote.set(c.noteId, list);
  }

  const candidates: AuditCandidate[] = [];
  for (const [noteId, group] of cardsByNote) {
    const note = noteById.get(noteId);
    if (!note) continue;
    const reasons: AuditReason[] = [];
    let score = 0;

    const totalLapses = group.reduce((sum, c) => sum + c.lapses, 0);
    if (totalLapses >= minLapses) {
      reasons.push('lapsing');
      score += totalLapses * 5;
    }

    const front = note.fields.front ?? '';
    const frontPlain = renderPlain(front);
    if (frontPlain.length >= overlongAt) {
      reasons.push('overlong');
      score += Math.min(20, Math.floor((frontPlain.length - overlongAt) / 40));
    }

    if (note.modelId === 'cloze' && !hasCloze(front)) {
      reasons.push('malformed');
      score += 50;
    }

    const isThin = frontPlain.trim().length < 12 && (note.fields.back ?? '').trim().length < 12;
    if (isThin) {
      reasons.push('underspecified');
      score += 10;
    }

    // Broken xlinks: a single broken link is a real problem (deleted target
    // or stale anchor). Validates fields by walking actual DB references —
    // not free, so only checked when the note has any `[[...]]` syntax.
    const hasAnyXlink = (
      ['front', 'back', 'extra', 'context', 'mnemonic', 'source'] as const
    ).some(k => (note.fields[k] ?? '').includes('[['));
    if (hasAnyXlink) {
      const xreport = await validateNoteXlinks(note.id);
      if (xreport && xreport.broken > 0) {
        reasons.push('broken-xlink');
        score += xreport.broken * 30;
      }
    }

    if (reasons.length === 0) continue;
    candidates.push({
      note,
      cards: group,
      reasons,
      score,
      summary: summarize(reasons, totalLapses, frontPlain.length),
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, topK);
}

function summarize(reasons: AuditReason[], lapses: number, frontLen: number): string {
  const parts: string[] = [];
  if (reasons.includes('lapsing')) parts.push(`${lapses} lapse${lapses === 1 ? '' : 's'}`);
  if (reasons.includes('overlong')) parts.push(`${frontLen} chars on front`);
  if (reasons.includes('malformed')) parts.push('cloze syntax issue');
  if (reasons.includes('underspecified')) parts.push('thin');
  if (reasons.includes('broken-xlink')) parts.push('broken xlink');
  return parts.join(' · ');
}

export const REASON_DESCRIPTIONS = REASON_LABELS;

/* ─── Per-note rewrite ────────────────────────────────────────── */

export interface RewriteResult {
  fields: NoteFields;
  rationale: string;
}

export async function rewriteCard(note: Note, hint?: string): Promise<RewriteResult> {
  const apiKey = await getSetting('claude_api_key');
  if (!apiKey) throw new Error('Add your Claude API key in Settings.');
  const model = (await getSetting('claude_model')) || DEFAULT_MODEL;

  const isCloze = note.modelId === 'cloze';

  const system = `You are a careful flashcard editor. The user will give you a card that is failing in some way (often lapsing, sometimes overlong or malformed). Rewrite it to maximize retrieval.

Constraints:
- Preserve the underlying fact / topic.
- If the card is cloze type (modelId='cloze'), keep cloze syntax in the front: {{c1::answer}}, {{c2::...}}, etc. Multi-cloze is allowed when each is an independent retrieval point.
- If basic, write a focused front (the question) and a concise back (the answer).
- Keep total card length tight: front under ~150 chars, back under ~200 chars when possible.
- Do not introduce new factual claims you can't justify from the original text.
- Use no em dashes. Periods, commas, parentheses only.

Return STRICT JSON, nothing else:
{
  "fields": {
    "front": string,
    "back": string,
    "extra"?: string,
    "mnemonic"?: string,
    "context"?: string,
    "source"?: string
  },
  "rationale": string
}`;

  const fieldDump = JSON.stringify(note.fields, null, 2);
  const user = [
    `Note type: ${isCloze ? 'cloze' : 'basic'}`,
    note.tags.length ? `Tags: ${note.tags.join(', ')}` : '',
    note.tier ? `Tier: ${note.tier}` : '',
    hint ? `Editor hint: ${hint}` : '',
    '',
    'Original fields:',
    fieldDump,
    '',
    'Return JSON now.',
  ].filter(Boolean).join('\n');

  const client = await makeAnthropicClient(apiKey);
  const r = await client.messages.create({
    model,
    max_tokens: 1024,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: user }],
  });

  const text = r.content.map(c => (c.type === 'text' ? c.text : '')).join('').trim();
  let cleaned = text;
  if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('Could not parse rewriter output.');
    parsed = JSON.parse(m[0]);
  }

  const obj = parsed as { fields?: Partial<NoteFields>; rationale?: string };
  if (!obj.fields || typeof obj.fields.front !== 'string') {
    throw new Error('Rewriter returned no front field.');
  }
  return {
    fields: {
      front: obj.fields.front,
      back: typeof obj.fields.back === 'string' ? obj.fields.back : (note.fields.back ?? ''),
      extra: typeof obj.fields.extra === 'string' ? obj.fields.extra : note.fields.extra,
      mnemonic: typeof obj.fields.mnemonic === 'string' ? obj.fields.mnemonic : note.fields.mnemonic,
      context: typeof obj.fields.context === 'string' ? obj.fields.context : note.fields.context,
      source: typeof obj.fields.source === 'string' ? obj.fields.source : note.fields.source,
      image: note.fields.image,
    },
    rationale: typeof obj.rationale === 'string' ? obj.rationale : '',
  };
}
