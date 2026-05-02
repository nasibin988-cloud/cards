/**
 * Cross-card link ([[query]] / [[query|display]]) resolution and auditing.
 *
 * Two consumers:
 *   - `CardRenderer` pre-resolves every xlink at render time so broken
 *     links visibly indicate themselves before the user clicks.
 *   - The Audit page uses `auditXlinks` to surface broken-link counts as
 *     a candidate "reason" alongside lapsing/overlong/etc.
 */

import { db } from './dexie';

// `searchNotes` lives in the main queries module. We keep it imported via
// the barrel to avoid a circular module ref between xlinks/queries during
// the gradual split.
import { searchNotes } from './queries';

/**
 * Resolve a single xlink query to its kind + outcome.
 *
 * Resolution rules (mirror the click-time logic in CardRenderer):
 *   - 26-char Crockford-base32 query → look up by id.
 *       If found: 'resolved-direct'.
 *       If not:    'broken-deleted-id'.
 *   - Otherwise → searchNotes(q, 8):
 *       0 hits   → 'broken-no-match'
 *       1 hit    → 'resolved-search'
 *       N hits   → 'ambiguous'
 */
export type XlinkResolution =
  | { kind: 'resolved-direct'; noteId: string }
  | { kind: 'resolved-search'; noteId: string }
  | { kind: 'ambiguous'; matches: number }
  | { kind: 'broken-deleted-id'; queriedId: string }
  | { kind: 'broken-no-match' };

export async function resolveXlink(query: string): Promise<XlinkResolution> {
  const isUlid = /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(query);
  if (isUlid) {
    const n = await db().notes.get(query);
    if (n) return { kind: 'resolved-direct', noteId: n.id };
    return { kind: 'broken-deleted-id', queriedId: query };
  }
  const hits = await searchNotes(query, 8);
  if (hits.length === 0) return { kind: 'broken-no-match' };
  if (hits.length === 1) return { kind: 'resolved-search', noteId: hits[0].noteId };
  return { kind: 'ambiguous', matches: hits.length };
}

const XLINK_RE = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g;

/** Extract every `[[query]]` / `[[query|display]]` from a piece of text. */
export function extractXlinks(text: string): Array<{ query: string; display?: string }> {
  if (!text) return [];
  const out: Array<{ query: string; display?: string }> = [];
  XLINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = XLINK_RE.exec(text))) {
    out.push({ query: m[1].trim(), display: m[2]?.trim() });
  }
  return out;
}

/**
 * For an entire note: extract every xlink across its fields and resolve
 * each. Returns counts by kind plus the raw list.
 */
export interface NoteXlinkReport {
  noteId: string;
  total: number;
  broken: number;
  ambiguous: number;
  resolutions: Array<{ query: string; display?: string; resolution: XlinkResolution }>;
}

export async function validateNoteXlinks(noteId: string): Promise<NoteXlinkReport | null> {
  const n = await db().notes.get(noteId);
  if (!n) return null;
  const text = [
    n.fields.front, n.fields.back, n.fields.extra,
    n.fields.context, n.fields.mnemonic, n.fields.source,
  ].filter(Boolean).join('\n');
  const links = extractXlinks(text);
  if (links.length === 0) {
    return { noteId, total: 0, broken: 0, ambiguous: 0, resolutions: [] };
  }
  const resolutions = await Promise.all(
    links.map(async l => ({ ...l, resolution: await resolveXlink(l.query) })),
  );
  let broken = 0, ambiguous = 0;
  for (const r of resolutions) {
    if (r.resolution.kind === 'broken-deleted-id' || r.resolution.kind === 'broken-no-match') broken++;
    else if (r.resolution.kind === 'ambiguous') ambiguous++;
  }
  return { noteId, total: resolutions.length, broken, ambiguous, resolutions };
}

/**
 * Aggregate scan: walk every note in a deck (or all decks) and count
 * broken/ambiguous xlinks. Used by the audit page to render a summary.
 */
export interface XlinkAuditSummary {
  notesWithXlinks: number;
  totalXlinks: number;
  brokenXlinks: number;
  ambiguousXlinks: number;
  brokenByNoteId: Map<string, NoteXlinkReport>;
}

export async function auditXlinks(deckId?: string): Promise<XlinkAuditSummary> {
  const notes = deckId
    ? await db().notes.where('deckId').equals(deckId).toArray()
    : await db().notes.toArray();
  let notesWithXlinks = 0;
  let totalXlinks = 0;
  let brokenXlinks = 0;
  let ambiguousXlinks = 0;
  const brokenByNoteId = new Map<string, NoteXlinkReport>();
  for (const n of notes) {
    const report = await validateNoteXlinks(n.id);
    if (!report || report.total === 0) continue;
    notesWithXlinks++;
    totalXlinks += report.total;
    brokenXlinks += report.broken;
    ambiguousXlinks += report.ambiguous;
    if (report.broken > 0) brokenByNoteId.set(n.id, report);
  }
  return { notesWithXlinks, totalXlinks, brokenXlinks, ambiguousXlinks, brokenByNoteId };
}
