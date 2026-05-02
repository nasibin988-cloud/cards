import { db } from './dexie';
import type { Note, NoteFields } from './schema';
import { indexNote } from './searchIndex';

export type SearchableField = keyof NoteFields;

export const SEARCH_FIELDS: ReadonlyArray<SearchableField> = [
  'front', 'back', 'extra', 'mnemonic', 'context', 'source',
];

export interface FindMatch {
  noteId: string;
  field: SearchableField;
  /** Excerpt centered on the first match in this field. */
  excerpt: string;
  /** Number of matches in this field. */
  count: number;
}

export interface FindReplaceOptions {
  /** Restrict to a single deck; omit for global search. */
  deckId?: string;
  regex?: boolean;
  caseSensitive?: boolean;
}

export interface ReplaceResult {
  notesTouched: number;
  matchesReplaced: number;
}

const EXCERPT_RADIUS = 40;

function buildPattern(find: string, opts: FindReplaceOptions): RegExp {
  const flags = opts.caseSensitive ? 'g' : 'gi';
  if (opts.regex) {
    return new RegExp(find, flags);
  }
  const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped, flags);
}

/** Run a find across the given scope. Returns up to `limit` matches. */
export async function findInNotes(
  find: string,
  opts: FindReplaceOptions = {},
  limit = 200,
): Promise<{ matches: FindMatch[]; truncated: boolean }> {
  if (!find) return { matches: [], truncated: false };
  const pattern = buildPattern(find, opts);
  const dbi = db();
  const notes = opts.deckId
    ? await dbi.notes.where('deckId').equals(opts.deckId).toArray()
    : await dbi.notes.toArray();

  const matches: FindMatch[] = [];
  let truncated = false;
  outer: for (const n of notes) {
    for (const f of SEARCH_FIELDS) {
      const v = n.fields[f];
      if (!v) continue;
      const fieldMatches = [...v.matchAll(pattern)];
      if (fieldMatches.length === 0) continue;
      const first = fieldMatches[0];
      matches.push({
        noteId: n.id,
        field: f,
        excerpt: makeExcerpt(v, first.index ?? 0, first[0].length),
        count: fieldMatches.length,
      });
      if (matches.length >= limit) {
        truncated = true;
        break outer;
      }
    }
  }
  return { matches, truncated };
}

function makeExcerpt(s: string, idx: number, len: number): string {
  const start = Math.max(0, idx - EXCERPT_RADIUS);
  const end = Math.min(s.length, idx + len + EXCERPT_RADIUS);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < s.length ? '…' : '';
  return prefix + s.slice(start, end) + suffix;
}

/**
 * Replace all matches in scope. Atomic. Returns how many notes were touched
 * and total replacements made.
 */
export async function replaceInNotes(
  find: string,
  replacement: string,
  opts: FindReplaceOptions = {},
): Promise<ReplaceResult> {
  if (!find) return { notesTouched: 0, matchesReplaced: 0 };
  const pattern = buildPattern(find, opts);
  const dbi = db();

  let touched = 0;
  let replaced = 0;
  let dirtyForIndex: Note[] = [];
  await dbi.transaction('rw', dbi.notes, async () => {
    const notes = opts.deckId
      ? await dbi.notes.where('deckId').equals(opts.deckId).toArray()
      : await dbi.notes.toArray();

    const dirty: Note[] = [];
    for (const n of notes) {
      let changed = false;
      const newFields: NoteFields = { ...n.fields };
      for (const f of SEARCH_FIELDS) {
        const v = newFields[f];
        if (!v) continue;
        const before = v;
        // Use a fresh regex per field; global flag preserves matchAll behaviour.
        const localPattern = new RegExp(pattern.source, pattern.flags);
        const after = before.replace(localPattern, replacement);
        if (after !== before) {
          // Count matches by rerunning matchAll on the original.
          const matches = [...before.matchAll(new RegExp(pattern.source, pattern.flags))];
          replaced += matches.length;
          (newFields as unknown as Record<string, unknown>)[f] = after;
          changed = true;
        }
      }
      if (changed) {
        dirty.push({ ...n, fields: newFields, modifiedAt: Date.now() });
        touched++;
      }
    }
    if (dirty.length) await dbi.notes.bulkPut(dirty);
    dirtyForIndex = dirty;
  });
  // Re-index outside the txn so we don't widen the write window.
  void (async () => { for (const n of dirtyForIndex) await indexNote(n); })();
  return { notesTouched: touched, matchesReplaced: replaced };
}

/**
 * Snapshot the original notes within a scope so a replacement can be undone.
 * Returns the full Note[] before the change. Caller should keep this around
 * for the toast lifetime.
 */
export async function snapshotScope(
  opts: FindReplaceOptions = {},
): Promise<Note[]> {
  const dbi = db();
  if (opts.deckId) return dbi.notes.where('deckId').equals(opts.deckId).toArray();
  return dbi.notes.toArray();
}

/** Restore notes captured by `snapshotScope`. */
export async function restoreSnapshot(snapshot: Note[]): Promise<void> {
  if (snapshot.length === 0) return;
  await db().notes.bulkPut(snapshot);
  // Replays the original token postings.
  for (const n of snapshot) await indexNote(n);
}
