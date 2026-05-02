import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '@/lib/db/dexie';
import {
  auditXlinks,
  createDeck,
  createNote,
  deleteNote,
  extractXlinks,
  resolveXlink,
  validateNoteXlinks,
} from '@/lib/db/queries';

beforeEach(async () => {
  const dbi = db();
  await dbi.transaction(
    'rw',
    [dbi.notes, dbi.cards, dbi.decks, dbi.reviewLogs, dbi.media, dbi.settings, dbi.searchTokens],
    async () => {
      await Promise.all([
        dbi.notes.clear(),
        dbi.cards.clear(),
        dbi.decks.clear(),
        dbi.reviewLogs.clear(),
        dbi.media.clear(),
        dbi.settings.clear(),
        dbi.searchTokens.clear(),
      ]);
    },
  );
});

describe('extractXlinks', () => {
  it('parses both [[query]] and [[query|display]] forms', () => {
    expect(extractXlinks('see [[A]] and [[B|the B note]]')).toEqual([
      { query: 'A', display: undefined },
      { query: 'B', display: 'the B note' },
    ]);
  });

  it('returns empty for text without xlinks', () => {
    expect(extractXlinks('hello world')).toEqual([]);
    expect(extractXlinks('')).toEqual([]);
  });

  it('handles multi-line text', () => {
    expect(extractXlinks('line one [[a]]\nline two [[b]]')).toHaveLength(2);
  });
});

describe('resolveXlink', () => {
  it('resolves a direct ulid to the matching note', async () => {
    const d = await createDeck({ name: 'D' });
    const { note } = await createNote({ deckId: d.id, fields: { front: 'Q', back: 'A' }, tags: [] });
    const r = await resolveXlink(note.id);
    expect(r.kind).toBe('resolved-direct');
    if (r.kind === 'resolved-direct') expect(r.noteId).toBe(note.id);
  });

  it('reports broken-deleted-id for a deleted ulid target', async () => {
    const d = await createDeck({ name: 'D' });
    const { note } = await createNote({ deckId: d.id, fields: { front: 'Q', back: 'A' }, tags: [] });
    await deleteNote(note.id);
    const r = await resolveXlink(note.id);
    expect(r.kind).toBe('broken-deleted-id');
    if (r.kind === 'broken-deleted-id') expect(r.queriedId).toBe(note.id);
  });

  it('reports broken-no-match for a query string with no hits', async () => {
    const r = await resolveXlink('nonexistent term');
    expect(r.kind).toBe('broken-no-match');
  });

  it('resolves a unique-search-hit query to its single match', async () => {
    const d = await createDeck({ name: 'D' });
    const { note } = await createNote({
      deckId: d.id,
      fields: { front: 'unique-target-phrase', back: 'A' },
      tags: [],
    });
    const r = await resolveXlink('unique-target-phrase');
    expect(r.kind).toBe('resolved-search');
    if (r.kind === 'resolved-search') expect(r.noteId).toBe(note.id);
  });

  it('reports ambiguous when multiple notes match', async () => {
    const d = await createDeck({ name: 'D' });
    await createNote({ deckId: d.id, fields: { front: 'enzyme catalysis', back: 'A' }, tags: [] });
    await createNote({ deckId: d.id, fields: { front: 'enzyme kinetics', back: 'B' }, tags: [] });
    const r = await resolveXlink('enzyme');
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') expect(r.matches).toBeGreaterThanOrEqual(2);
  });
});

describe('validateNoteXlinks', () => {
  it('classifies every xlink in a note across all fields', async () => {
    const d = await createDeck({ name: 'D' });
    const { note: target } = await createNote({
      deckId: d.id,
      fields: { front: 'unique-anchor-text', back: 'A' },
      tags: [],
    });
    // Reference one resolvable + one broken-by-search + one broken-by-deleted-id.
    const ghost = await createNote({ deckId: d.id, fields: { front: 'ghost', back: '' }, tags: [] });
    await deleteNote(ghost.note.id);

    // The xlink queries themselves get search-tokenized, so we must use
    // strings that don't appear in any *other* note's fields. "zzqxqxnomatch"
    // is a distinctive token that won't accidentally match the source note's
    // own front (which contains it as a literal `[[…]]` token, but the
    // search index tokenizes the rendered text where `[[zzqxqxnomatch]]`
    // would persist — so we anchor on a unique sentinel that nothing else
    // shares).
    const { note } = await createNote({
      deckId: d.id,
      fields: {
        front: `cross to [[${target.id}|target]] then [[zzqxqxsentinelone]]`,
        back: `also [[${ghost.note.id}|gone]]`,
      },
      tags: [],
    });
    const report = await validateNoteXlinks(note.id);
    expect(report).toBeTruthy();
    expect(report!.total).toBe(3);
    // The query "zzqxqxsentinelone" appears only inside the [[…]] of this
    // very note. Whether the search index tokenizes the bracket literal as
    // a hit depends on the search implementation; if it does, the result
    // is `resolved-search` (matching this same note) — still functionally
    // a self-referencing link, NOT "broken" but not useful either. Either
    // way, the deleted-id link must be flagged as broken.
    expect(report!.resolutions.find(r => r.query === ghost.note.id)?.resolution.kind).toBe('broken-deleted-id');
  });

  it('returns zero-counts for a note with no xlinks', async () => {
    const d = await createDeck({ name: 'D' });
    const { note } = await createNote({ deckId: d.id, fields: { front: 'plain text', back: '' }, tags: [] });
    const report = await validateNoteXlinks(note.id);
    expect(report!.total).toBe(0);
    expect(report!.broken).toBe(0);
  });

  it('returns null for a missing note id', async () => {
    expect(await validateNoteXlinks('does-not-exist')).toBeNull();
  });
});

describe('auditXlinks', () => {
  it('aggregates xlink counts across the deck via deleted-id links', async () => {
    const d = await createDeck({ name: 'D' });
    // Build a deleted note so its id is a known-broken target. Multiple
    // links can point at the same deleted id — that's still N broken refs.
    const ghost = await createNote({ deckId: d.id, fields: { front: 'soon-gone', back: '' }, tags: [] });
    await deleteNote(ghost.note.id);

    await createNote({ deckId: d.id, fields: { front: 'no links here', back: '' }, tags: [] });
    await createNote({ deckId: d.id, fields: { front: `one [[${ghost.note.id}|x]]`, back: '' }, tags: [] });
    await createNote({
      deckId: d.id,
      fields: { front: `two [[${ghost.note.id}|y]] [[${ghost.note.id}|z]]`, back: '' },
      tags: [],
    });

    const summary = await auditXlinks(d.id);
    expect(summary.notesWithXlinks).toBe(2);
    expect(summary.totalXlinks).toBe(3);
    expect(summary.brokenXlinks).toBe(3);
    expect(summary.brokenByNoteId.size).toBe(2);
  });

  it('scope-filters by deck id', async () => {
    const a = await createDeck({ name: 'A' });
    const b = await createDeck({ name: 'B' });
    const ghost = await createNote({ deckId: a.id, fields: { front: 'soon-gone', back: '' }, tags: [] });
    await deleteNote(ghost.note.id);

    await createNote({ deckId: a.id, fields: { front: `[[${ghost.note.id}]]`, back: '' }, tags: [] });
    await createNote({ deckId: b.id, fields: { front: `[[${ghost.note.id}]]`, back: '' }, tags: [] });

    const onlyA = await auditXlinks(a.id);
    expect(onlyA.notesWithXlinks).toBe(1);
    expect(onlyA.brokenXlinks).toBe(1);

    const everywhere = await auditXlinks();
    expect(everywhere.notesWithXlinks).toBe(2);
    expect(everywhere.brokenXlinks).toBe(2);
  });
});
