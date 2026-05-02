import type { NoteBrowseFilters } from '@/lib/db/queries';
import type { CardState, NoteFlag, Tier } from '@/lib/db/schema';

const STATES: ReadonlySet<CardState> = new Set(['new', 'learning', 'review', 'relearning']);
const TIERS: ReadonlySet<Tier> = new Set([
  'core', 'clinical', 'advanced', 'bridge', 'standard', 'extended', 'scholarly',
]);
const FLAGS: ReadonlySet<NoteFlag> = new Set(['revisit', 'broken', 'exemplar', 'errata']);

export interface ParsedQuery {
  filters: NoteBrowseFilters;
  /** Free text not consumed by an operator. */
  text: string;
  /**
   * Comma-separated `deck:` operator values, intended for cross-deck search.
   * Resolution to deckIds happens in the consumer (we keep raw substrings here).
   */
  deckMatches?: string[];
}

/**
 * Parse a search-syntax string into deck-browse filters + free text.
 *
 * Supported operators (space-separated, all optional):
 *   tag:foo        — single tag (repeatable for any-of)
 *   tag:foo,bar    — any-of in one token
 *   state:new      — repeatable for any-of
 *   tier:core
 *   lapses>=3, lapses<=3, lapses=3
 *   added:7d       — last N days (also added:1m for months)
 *   edited:1d
 *   is:suspended | is:buried | is:due | is:new
 *
 * Anything that doesn't match becomes free-text query.
 */
export function parseQuery(input: string): ParsedQuery {
  const tokens = tokenize(input);
  const filters: NoteBrowseFilters = {};
  const free: string[] = [];
  const tagsAny = new Set<string>();
  const statesAny = new Set<CardState>();
  const flagsAny = new Set<NoteFlag>();
  const deckMatchesAny = new Set<string>();

  for (const tok of tokens) {
    const op = matchOperator(tok);
    if (!op) {
      free.push(tok);
      continue;
    }
    switch (op.kind) {
      case 'tag':
        for (const t of op.value.split(',').map(s => s.trim()).filter(Boolean)) tagsAny.add(t);
        break;
      case 'state':
        for (const s of op.value.split(',').map(s => s.trim()).filter(Boolean)) {
          if (STATES.has(s as CardState)) statesAny.add(s as CardState);
        }
        break;
      case 'tier':
        if (TIERS.has(op.value as Tier)) filters.tier = op.value;
        break;
      case 'lapses-eq':
      case 'lapses-gte':
      case 'lapses-lte': {
        const n = parseInt(op.value, 10);
        if (Number.isFinite(n)) {
          if (op.kind === 'lapses-gte') filters.hasLapses = n;
          if (op.kind === 'lapses-eq') filters.hasLapses = n; // best-effort; existing helper is min-bound
          if (op.kind === 'lapses-lte') filters.lapsesAtMost = n;
        }
        break;
      }
      case 'added':
        filters.addedWithinDays = parseDuration(op.value);
        break;
      case 'edited':
        filters.editedWithinDays = parseDuration(op.value);
        break;
      case 'is':
        switch (op.value) {
          case 'suspended': filters.suspended = true; break;
          case 'buried': filters.buried = true; break;
          case 'due': filters.dueOnly = true; break;
          case 'new':
            statesAny.add('new');
            break;
          case 'flagged':
            for (const f of FLAGS) flagsAny.add(f);
            break;
        }
        break;
      case 'flag':
        for (const f of op.value.split(',').map(s => s.trim()).filter(Boolean)) {
          if (FLAGS.has(f as NoteFlag)) flagsAny.add(f as NoteFlag);
        }
        break;
      case 'deck':
        for (const d of op.value.split(',').map(s => s.trim()).filter(Boolean)) {
          deckMatchesAny.add(d);
        }
        break;
    }
  }

  if (tagsAny.size) filters.tags = [...tagsAny];
  if (statesAny.size) filters.states = [...statesAny];
  if (flagsAny.size) filters.flags = [...flagsAny];

  return {
    filters,
    text: free.join(' ').trim(),
    deckMatches: deckMatchesAny.size ? [...deckMatchesAny] : undefined,
  };
}

/**
 * Render filters + free text back into the canonical search-syntax string,
 * suitable for round-tripping in the URL.
 */
export function stringifyQuery(filters: NoteBrowseFilters, text: string): string {
  const parts: string[] = [];
  if (filters.tier) parts.push(`tier:${filters.tier}`);
  if (filters.states?.length) parts.push(`state:${filters.states.join(',')}`);
  if (filters.tags?.length) parts.push(`tag:${filters.tags.join(',')}`);
  if (filters.hasLapses !== undefined) parts.push(`lapses>=${filters.hasLapses}`);
  if (filters.lapsesAtMost !== undefined) parts.push(`lapses<=${filters.lapsesAtMost}`);
  if (filters.addedWithinDays !== undefined) parts.push(`added:${filters.addedWithinDays}d`);
  if (filters.editedWithinDays !== undefined) parts.push(`edited:${filters.editedWithinDays}d`);
  if (filters.suspended) parts.push('is:suspended');
  if (filters.buried) parts.push('is:buried');
  if (filters.dueOnly) parts.push('is:due');
  if (filters.flags?.length) parts.push(`flag:${filters.flags.join(',')}`);
  const t = text.trim();
  if (t) parts.push(t);
  return parts.join(' ');
}

/**
 * Append the deck: operator to a stringified query. Kept separate from
 * stringifyQuery because deck filtering is encoded outside NoteBrowseFilters
 * (the consumer resolves deckMatches → deckIds at query time).
 */
export function appendDeckMatches(base: string, deckMatches: string[]): string {
  if (deckMatches.length === 0) return base;
  const part = `deck:${deckMatches.join(',')}`;
  return base ? `${base} ${part}` : part;
}

function tokenize(input: string): string[] {
  // Respect double-quoted runs as single tokens, otherwise split on whitespace.
  const out: string[] = [];
  let i = 0;
  while (i < input.length) {
    while (i < input.length && /\s/.test(input[i])) i++;
    if (i >= input.length) break;
    if (input[i] === '"') {
      i++;
      let s = '';
      while (i < input.length && input[i] !== '"') { s += input[i]; i++; }
      if (input[i] === '"') i++;
      if (s) out.push(s);
    } else {
      let s = '';
      while (i < input.length && !/\s/.test(input[i])) { s += input[i]; i++; }
      if (s) out.push(s);
    }
  }
  return out;
}

type Op =
  | { kind: 'tag' | 'state' | 'tier' | 'added' | 'edited' | 'is' | 'flag' | 'deck'; value: string }
  | { kind: 'lapses-eq' | 'lapses-gte' | 'lapses-lte'; value: string };

function matchOperator(tok: string): Op | null {
  const lap = /^lapses(>=|<=|=)(\d+)$/i.exec(tok);
  if (lap) {
    const op = lap[1];
    return {
      kind: op === '>=' ? 'lapses-gte' : op === '<=' ? 'lapses-lte' : 'lapses-eq',
      value: lap[2],
    };
  }
  const m = /^([a-z]+):(.+)$/i.exec(tok);
  if (!m) return null;
  const [, key, value] = m;
  switch (key.toLowerCase()) {
    case 'tag': return { kind: 'tag', value };
    case 'state': return { kind: 'state', value };
    case 'tier': return { kind: 'tier', value };
    case 'added': return { kind: 'added', value };
    case 'edited': return { kind: 'edited', value };
    case 'is': return { kind: 'is', value };
    case 'flag': return { kind: 'flag', value };
    case 'deck': return { kind: 'deck', value };
  }
  return null;
}

/** Parse "7d", "2w", "1m" → number of days. Falls back to integer days. */
function parseDuration(v: string): number | undefined {
  const m = /^(\d+)([dwm])?$/i.exec(v);
  if (!m) return undefined;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n)) return undefined;
  const unit = (m[2] ?? 'd').toLowerCase();
  if (unit === 'd') return n;
  if (unit === 'w') return n * 7;
  if (unit === 'm') return n * 30;
  return n;
}
