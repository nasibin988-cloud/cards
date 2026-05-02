import { describe, it, expect, beforeEach } from 'vitest';
import {
  cardMaturity,
  createDeck,
  createNote,
  deleteTagEverywhere,
  listReviewsForCard,
  listTagUsage,
  mergeTags,
  recordReview,
  renameTag,
  reviewsByHourOfWeek,
  setNoteFlag,
} from '@/lib/db/queries';
import {
  createPracticeQuery,
  resolvePracticeQuery,
} from '@/lib/practice/queries';
import { findCandidates } from '@/lib/ai/auditor';
import { applyXlinkSuggestion, type XlinkSuggestion } from '@/lib/ai/xlinks';
import { findCommand, parseSlash, suggestCommands } from '@/lib/ai/commands/registry';
import { db } from '@/lib/db/dexie';

beforeEach(async () => {
  const dbi = db();
  await dbi.transaction(
    'rw',
    [dbi.notes, dbi.cards, dbi.decks, dbi.reviewLogs, dbi.practiceQueries, dbi.media, dbi.settings],
    async () => {
      await Promise.all([
        dbi.notes.clear(),
        dbi.cards.clear(),
        dbi.decks.clear(),
        dbi.reviewLogs.clear(),
        dbi.practiceQueries.clear(),
        dbi.media.clear(),
        dbi.settings.clear(),
      ]);
    },
  );
});

describe('reviewsByHourOfWeek', () => {
  it('returns a 7×24 grid bucketing reviews by local day-of-week and hour', async () => {
    const deck = await createDeck({ name: 'D' });
    const { cards } = await createNote({ deckId: deck.id, fields: { front: 'A', back: 'a' } });
    await recordReview(cards[0], 3, 1000);
    const grid = await reviewsByHourOfWeek(90);
    expect(grid).toHaveLength(7);
    expect(grid[0]).toHaveLength(24);
    const total = grid.flat().reduce((s, n) => s + n, 0);
    expect(total).toBe(1);
  });

  it('produces an all-zero grid when there are no reviews in window', async () => {
    const grid = await reviewsByHourOfWeek(30);
    expect(grid.flat().reduce((s, n) => s + n, 0)).toBe(0);
  });
});

describe('tag management', () => {
  it('listTagUsage counts notes per tag', async () => {
    const d = await createDeck({ name: 'D' });
    await createNote({ deckId: d.id, fields: { front: 'A', back: 'a' }, tags: ['bio', 'enzymes'] });
    await createNote({ deckId: d.id, fields: { front: 'B', back: 'b' }, tags: ['bio'] });
    const usage = await listTagUsage();
    const byName = new Map(usage.map(u => [u.tag, u.noteCount]));
    expect(byName.get('bio')).toBe(2);
    expect(byName.get('enzymes')).toBe(1);
  });

  it('renameTag rewrites every occurrence', async () => {
    const d = await createDeck({ name: 'D' });
    const { note: a } = await createNote({ deckId: d.id, fields: { front: 'A', back: 'a' }, tags: ['old'] });
    const { note: b } = await createNote({ deckId: d.id, fields: { front: 'B', back: 'b' }, tags: ['old', 'keep'] });
    const touched = await renameTag('old', 'new');
    expect(touched).toBe(2);
    const dbi = db();
    expect((await dbi.notes.get(a.id))!.tags).toEqual(['new']);
    expect((await dbi.notes.get(b.id))!.tags.sort()).toEqual(['keep', 'new']);
  });

  it('mergeTags collapses sources into target without duplicates', async () => {
    const d = await createDeck({ name: 'D' });
    const { note } = await createNote({
      deckId: d.id,
      fields: { front: 'X', back: 'x' },
      tags: ['s1', 's2', 'target'],
    });
    const touched = await mergeTags(['s1', 's2'], 'target');
    expect(touched).toBe(1);
    const live = await db().notes.get(note.id);
    expect(live!.tags).toEqual(['target']);
  });

  it('deleteTagEverywhere removes a tag from all notes', async () => {
    const d = await createDeck({ name: 'D' });
    const { note } = await createNote({ deckId: d.id, fields: { front: 'A', back: 'a' }, tags: ['bad', 'good'] });
    await deleteTagEverywhere('bad');
    const live = await db().notes.get(note.id);
    expect(live!.tags).toEqual(['good']);
  });
});

describe('listReviewsForCard', () => {
  it('returns reviews newest-first for the given card', async () => {
    const deck = await createDeck({ name: 'D' });
    const { cards } = await createNote({ deckId: deck.id, fields: { front: 'A', back: 'a' } });
    await recordReview(cards[0], 3, 1000);
    await new Promise(r => setTimeout(r, 5));
    await recordReview(cards[0], 2, 1000);
    const list = await listReviewsForCard(cards[0].id);
    expect(list).toHaveLength(2);
    expect(list[0].review).toBeGreaterThanOrEqual(list[1].review);
  });
});

describe('cross-deck search via deck: operator', () => {
  it('matches deck names case-insensitively as substrings', async () => {
    const a = await createDeck({ name: 'MCAT::Bio' });
    const b = await createDeck({ name: 'MCAT::Chem' });
    await createNote({ deckId: a.id, fields: { front: 'X', back: 'x' } });
    await createNote({ deckId: b.id, fields: { front: 'Y', back: 'y' } });

    const q = await createPracticeQuery({ name: 'Bio only', query: 'deck:bio' });
    const ids = await resolvePracticeQuery(q);
    expect(ids).toHaveLength(1);
  });
});

describe('cardMaturity bucketing (sanity)', () => {
  it('counts new cards correctly', async () => {
    const d = await createDeck({ name: 'D' });
    await createNote({ deckId: d.id, fields: { front: 'A', back: 'a' } });
    await createNote({ deckId: d.id, fields: { front: 'B', back: 'b' } });
    const mat = await cardMaturity();
    expect(mat.newCards).toBe(2);
  });
});

describe('audit candidates', () => {
  it('flags a note with high lapses', async () => {
    const d = await createDeck({ name: 'D' });
    const { note, cards } = await createNote({ deckId: d.id, fields: { front: 'A', back: 'a' } });
    // Force lapses via direct update — recordReview would need many rounds.
    await db().cards.update(cards[0].id, { lapses: 8 });
    const cands = await findCandidates();
    const found = cands.find(c => c.note.id === note.id);
    expect(found).toBeDefined();
    expect(found!.reasons).toContain('lapsing');
  });

  it('flags a malformed cloze note', async () => {
    const d = await createDeck({ name: 'D' });
    const { note } = await createNote({
      deckId: d.id,
      // Force modelId='cloze' but content has no cloze syntax.
      fields: { front: 'just plain text', back: '' },
      modelId: 'cloze',
    });
    const cands = await findCandidates();
    const found = cands.find(c => c.note.id === note.id);
    expect(found).toBeDefined();
    expect(found!.reasons).toContain('malformed');
  });

  it('skips notes with no flagged reasons', async () => {
    const d = await createDeck({ name: 'D' });
    await createNote({ deckId: d.id, fields: { front: 'A reasonable card front', back: 'A reasonable answer' } });
    const cands = await findCandidates();
    expect(cands).toHaveLength(0);
  });
});

describe('xlink applyXlinkSuggestion', () => {
  it('replaces the first occurrence of the anchor with [[id|display]]', () => {
    const front = 'The PFC integrates planning and decision making.';
    const sug: XlinkSuggestion = {
      anchor: 'PFC',
      targetNoteId: '01ABC',
      targetSnippet: 'Prefrontal cortex',
      rationale: '',
    };
    const out = applyXlinkSuggestion(front, sug);
    expect(out).toBe('The [[01ABC|PFC]] integrates planning and decision making.');
  });

  it('honors a display override when provided', () => {
    const front = 'See PFC for details.';
    const sug: XlinkSuggestion = {
      anchor: 'PFC',
      display: 'Prefrontal cortex',
      targetNoteId: '01ABC',
      targetSnippet: '',
      rationale: '',
    };
    const out = applyXlinkSuggestion(front, sug);
    expect(out).toBe('See [[01ABC|Prefrontal cortex]] for details.');
  });

  it('returns input unchanged when the anchor is absent', () => {
    const out = applyXlinkSuggestion('hello world', {
      anchor: 'missing',
      targetNoteId: '01ABC',
      targetSnippet: '',
      rationale: '',
    });
    expect(out).toBe('hello world');
  });
});

describe('slash command parsing', () => {
  it('parseSlash extracts name and args', () => {
    expect(parseSlash('/image vesicles')).toEqual({ name: 'image', args: 'vesicles' });
    expect(parseSlash('/clear')).toEqual({ name: 'clear', args: '' });
    expect(parseSlash('hello')).toBeNull();
    expect(parseSlash(' /image foo ')).toEqual({ name: 'image', args: 'foo ' });
  });

  it('findCommand is case-insensitive', () => {
    expect(findCommand('image')).not.toBeNull();
    expect(findCommand('IMAGE')).not.toBeNull();
    expect(findCommand('nope')).toBeNull();
  });

  it('suggestCommands filters by prefix', () => {
    const r = suggestCommands('e');
    const names = r.map(c => c.name);
    expect(names).toContain('explain');
  });

  it('flag filtering survives via setNoteFlag + audit', async () => {
    // Smoke test: setNoteFlag works and auditor doesn't flag a healthy note.
    const d = await createDeck({ name: 'D' });
    const { note } = await createNote({ deckId: d.id, fields: { front: 'reasonable front', back: 'reasonable back' } });
    await setNoteFlag(note.id, 'exemplar');
    const cands = await findCandidates();
    expect(cands.find(c => c.note.id === note.id)).toBeUndefined();
  });
});
