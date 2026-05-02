import { describe, it, expect, beforeEach } from 'vitest';
import {
  createDeck,
  createNote,
  deleteDeck,
  deleteNote,
  getDeck,
  getDeckCounts,
  getNextCardForStudy,
  getNote,
  listDecks,
  listNotes,
  recordReview,
  rollbackReview,
  buryCard,
  suspendCard,
  unburryStaleCards,
  updateNote,
  bulkImport,
  getJsonSetting,
  setJsonSetting,
  dueForecast,
} from '@/lib/db/queries';
import { db } from '@/lib/db/dexie';
import { id } from '@/lib/ulid';
import { emptyCard } from '@/lib/fsrs/scheduler';
import type { Card } from '@/lib/db/schema';

beforeEach(async () => {
  // Clear all tables between tests so each runs in isolation.
  const dbi = db();
  await dbi.transaction(
    'rw',
    [dbi.notes, dbi.cards, dbi.decks, dbi.reviewLogs, dbi.media, dbi.settings],
    async () => {
      await Promise.all([
        dbi.notes.clear(),
        dbi.cards.clear(),
        dbi.decks.clear(),
        dbi.reviewLogs.clear(),
        dbi.media.clear(),
        dbi.settings.clear(),
      ]);
    },
  );
});

describe('decks', () => {
  it('createDeck + listDecks roundtrip', async () => {
    const a = await createDeck({ name: 'Bio' });
    const b = await createDeck({ name: 'Anatomy' });
    const decks = await listDecks();
    expect(decks.map(d => d.name).sort()).toEqual(['Anatomy', 'Bio']);
    expect((await getDeck(a.id))?.name).toBe('Bio');
    expect((await getDeck(b.id))?.name).toBe('Anatomy');
  });

  it('deleteDeck cascades to notes, cards, and review logs', async () => {
    const deck = await createDeck({ name: 'Temp' });
    const { note, cards } = await createNote({
      deckId: deck.id,
      fields: { front: 'q', back: 'a' },
    });
    await recordReview(cards[0], 3, 1000);
    await deleteDeck(deck.id);

    expect(await getDeck(deck.id)).toBeUndefined();
    expect(await getNote(note.id)).toBeUndefined();
    expect(await db().cards.where('deckId').equals(deck.id).count()).toBe(0);
    expect(await db().reviewLogs.where('cardId').equals(cards[0].id).count()).toBe(0);
  });
});

describe('notes', () => {
  it('basic note creates exactly one card', async () => {
    const deck = await createDeck({ name: 'D' });
    const { note, cards } = await createNote({
      deckId: deck.id,
      fields: { front: 'plain', back: 'answer' },
    });
    expect(note.modelId).toBe('basic');
    expect(cards).toHaveLength(1);
    expect(cards[0].clozeOrd).toBeUndefined();
  });

  it('cloze note with c1 + c2 creates two cards (one per ord)', async () => {
    const deck = await createDeck({ name: 'D' });
    const { note, cards } = await createNote({
      deckId: deck.id,
      fields: { front: '{{c1::A}} and {{c2::B}}', back: '' },
    });
    expect(note.modelId).toBe('cloze');
    expect(cards).toHaveLength(2);
    const ords = cards.map(c => c.clozeOrd).sort();
    expect(ords).toEqual([1, 2]);
  });

  it('updateNote adds cards when new cloze ords are introduced', async () => {
    const deck = await createDeck({ name: 'D' });
    const { note } = await createNote({
      deckId: deck.id,
      fields: { front: '{{c1::A}}', back: '' },
    });
    expect(await db().cards.where('noteId').equals(note.id).count()).toBe(1);

    await updateNote(note.id, { fields: { front: '{{c1::A}} {{c2::B}} {{c3::C}}' } });
    const after = await db().cards.where('noteId').equals(note.id).toArray();
    expect(after.map(c => c.clozeOrd).sort()).toEqual([1, 2, 3]);
  });

  it('updateNote removes cards when ords are dropped', async () => {
    const deck = await createDeck({ name: 'D' });
    const { note } = await createNote({
      deckId: deck.id,
      fields: { front: '{{c1::A}} {{c2::B}} {{c3::C}}', back: '' },
    });
    await updateNote(note.id, { fields: { front: '{{c1::A}}' } });
    const after = await db().cards.where('noteId').equals(note.id).toArray();
    expect(after).toHaveLength(1);
    expect(after[0].clozeOrd).toBe(1);
  });

  it('deleteNote removes cards and review logs', async () => {
    const deck = await createDeck({ name: 'D' });
    const { note, cards } = await createNote({
      deckId: deck.id,
      fields: { front: 'q', back: 'a' },
    });
    await recordReview(cards[0], 3, 1000);
    await deleteNote(note.id);
    expect(await getNote(note.id)).toBeUndefined();
    expect(await db().cards.where('noteId').equals(note.id).count()).toBe(0);
    expect(await db().reviewLogs.where('cardId').equals(cards[0].id).count()).toBe(0);
  });

  it('listNotes filters by deckId and respects limit', async () => {
    const a = await createDeck({ name: 'A' });
    const b = await createDeck({ name: 'B' });
    for (let i = 0; i < 5; i++) {
      await createNote({ deckId: a.id, fields: { front: `a${i}`, back: '' } });
    }
    for (let i = 0; i < 3; i++) {
      await createNote({ deckId: b.id, fields: { front: `b${i}`, back: '' } });
    }
    expect((await listNotes(a.id)).length).toBe(5);
    expect((await listNotes(b.id)).length).toBe(3);
    expect((await listNotes(a.id, 2)).length).toBe(2);
  });
});

describe('scheduling', () => {
  it('getNextCardForStudy prioritizes due review > learning > new', async () => {
    const deck = await createDeck({ name: 'D' });

    // a new card
    await createNote({ deckId: deck.id, fields: { front: 'new1', back: 'x' } });

    // a learning card (due now)
    const { cards: learnCards } = await createNote({
      deckId: deck.id, fields: { front: 'learn1', back: 'x' },
    });
    await db().cards.update(learnCards[0].id, {
      state: 'learning',
      due: Date.now() - 1000,
    });

    // Learning card should come before new card.
    const next = await getNextCardForStudy(deck.id);
    expect(next?.id).toBe(learnCards[0].id);
  });

  it('getNextCardForStudy returns undefined when nothing is due', async () => {
    const deck = await createDeck({ name: 'D' });
    // Schedule far in the future and remove from new state.
    const { cards } = await createNote({
      deckId: deck.id, fields: { front: 'q', back: 'a' },
    });
    await db().cards.update(cards[0].id, {
      state: 'review',
      due: Date.now() + 30 * 86_400_000,
    });
    expect(await getNextCardForStudy(deck.id)).toBeUndefined();
  });

  it('skips suspended and buried cards', async () => {
    const deck = await createDeck({ name: 'D' });
    const { cards: a } = await createNote({ deckId: deck.id, fields: { front: 'a', back: '' } });
    const { cards: b } = await createNote({ deckId: deck.id, fields: { front: 'b', back: '' } });
    await db().cards.update(a[0].id, { suspended: true });
    const next = await getNextCardForStudy(deck.id);
    expect(next?.id).toBe(b[0].id);
  });

  it('getDeckCounts reflects state and due-by-now', async () => {
    const deck = await createDeck({ name: 'D' });
    await createNote({ deckId: deck.id, fields: { front: 'a', back: '' } });
    await createNote({ deckId: deck.id, fields: { front: 'b', back: '' } });
    const counts = await getDeckCounts(deck.id);
    expect(counts.total).toBe(2);
    expect(counts.new).toBe(2);
    expect(counts.review).toBe(0);
    expect(counts.learning).toBe(0);
  });
});

describe('recordReview', () => {
  it('persists review log and updates card; returns sibling count', async () => {
    const deck = await createDeck({ name: 'D' });
    const { cards } = await createNote({ deckId: deck.id, fields: { front: 'q', back: 'a' } });
    const before = cards[0];
    const { updatedCard, log, siblingsBurried } = await recordReview(before, 3, 1234);

    expect(log.cardId).toBe(before.id);
    expect(log.rating).toBe(3);
    expect(log.deckId).toBe(deck.id);
    expect(log.durationMs).toBe(1234);
    expect(siblingsBurried).toBe(0);

    const reread = await db().cards.get(before.id);
    expect(reread?.reps).toBeGreaterThan(0);
    expect(reread?.modifiedAt).toBe(updatedCard.modifiedAt);

    const logs = await db().reviewLogs.where('cardId').equals(before.id).toArray();
    expect(logs).toHaveLength(1);
  });
});

describe('settings', () => {
  it('JSON setting roundtrips', async () => {
    await setJsonSetting('foo', { a: 1, b: 'x' });
    expect(await getJsonSetting('foo', null)).toEqual({ a: 1, b: 'x' });
  });
  it('returns fallback on missing key', async () => {
    expect(await getJsonSetting('missing', { default: true })).toEqual({ default: true });
  });
});

describe('sibling bury on cloze review', () => {
  it('burries other cards of the same note when one is rated', async () => {
    const deck = await createDeck({ name: 'D' });
    const { cards } = await createNote({
      deckId: deck.id,
      fields: { front: '{{c1::A}} and {{c2::B}} and {{c3::C}}', back: '' },
    });
    expect(cards).toHaveLength(3);

    const result = await recordReview(cards[0], 3, 1000);
    expect(result.siblingsBurried).toBe(2);

    const all = await db().cards.where('noteId').equals(cards[0].noteId).toArray();
    const buried = all.filter(c => c.buried);
    expect(buried).toHaveLength(2);
    expect(buried.find(c => c.id === cards[0].id)).toBeUndefined();
  });

  it('rollback un-buries siblings that were buried by that review', async () => {
    const deck = await createDeck({ name: 'D' });
    const { cards } = await createNote({
      deckId: deck.id,
      fields: { front: '{{c1::A}} and {{c2::B}}', back: '' },
    });
    const { log } = await recordReview(cards[0], 3, 1000);

    const beforeRollback = await db().cards.where('noteId').equals(cards[0].noteId).toArray();
    expect(beforeRollback.filter(c => c.buried)).toHaveLength(1);

    await rollbackReview(cards[0].id, log.id);

    const afterRollback = await db().cards.where('noteId').equals(cards[0].noteId).toArray();
    expect(afterRollback.filter(c => c.buried)).toHaveLength(0);
  });

  it('does not bury siblings that are already due tomorrow or later', async () => {
    const deck = await createDeck({ name: 'D' });
    const { cards } = await createNote({
      deckId: deck.id,
      fields: { front: '{{c1::A}} and {{c2::B}}', back: '' },
    });
    // Push c2 out by 3 days; sibling-bury should leave it alone.
    await db().cards.update(cards[1].id, {
      state: 'review',
      due: Date.now() + 3 * 86_400_000,
    });
    const result = await recordReview(cards[0], 3, 1000);
    expect(result.siblingsBurried).toBe(0);
    const c2 = await db().cards.get(cards[1].id);
    expect(c2?.buried).toBe(false);
  });

  it('sibling bury survives unburryStaleCards within the same session', async () => {
    // Regression: previously unburryStaleCards filtered on `due <= now`,
    // and new cards have due = creation time (always in the past), so
    // same-session siblings unburied immediately on the next fetchNext.
    // With buriedUntil = now + SIBLING_BURY_MS, the bury must persist
    // for the configured window even as fetchNext keeps firing.
    const deck = await createDeck({ name: 'D' });
    const { cards } = await createNote({
      deckId: deck.id,
      fields: { front: '{{c1::A}} and {{c2::B}}', back: '' },
    });

    await recordReview(cards[0], 3, 1000);
    const c2Before = await db().cards.get(cards[1].id);
    expect(c2Before?.buried).toBe(true);
    expect(c2Before?.buriedUntil).toBeGreaterThan(Date.now());

    // fetchNext calls unburryStaleCards right before each pick.
    await unburryStaleCards(deck.id);

    const c2 = await db().cards.get(cards[1].id);
    expect(c2?.buried).toBe(true);

    // The picker also must not return c2 while it's buried.
    const next = await getNextCardForStudy(deck.id);
    expect(next?.id).not.toBe(cards[1].id);
  });

  it('unburryStaleCards releases siblings whose buriedUntil has passed', async () => {
    const deck = await createDeck({ name: 'D' });
    const { cards } = await createNote({
      deckId: deck.id,
      fields: { front: '{{c1::A}} and {{c2::B}}', back: '' },
    });
    // Simulate "five minutes have passed since c1 was rated" by writing
    // a buriedUntil already in the past.
    await db().cards.update(cards[1].id, {
      buried: true,
      buriedUntil: Date.now() - 1000,
    });

    await unburryStaleCards(deck.id);

    const c2 = await db().cards.get(cards[1].id);
    expect(c2?.buried).toBe(false);
    expect(c2?.buriedUntil).toBeUndefined();
  });

  it('unburryStaleCards releases legacy buried rows that lack buriedUntil', async () => {
    // Pre-fix data: cards stuck buried with no buriedUntil timestamp.
    // Treat as expired so users aren't trapped after upgrading.
    const deck = await createDeck({ name: 'D' });
    const { cards } = await createNote({
      deckId: deck.id,
      fields: { front: '{{c1::A}} and {{c2::B}}', back: '' },
    });
    await db().cards.update(cards[1].id, { buried: true });

    await unburryStaleCards(deck.id);

    const c2 = await db().cards.get(cards[1].id);
    expect(c2?.buried).toBe(false);
  });
});

describe('rollbackReview', () => {
  it('restores the card to pre-review state and deletes the log', async () => {
    const deck = await createDeck({ name: 'D' });
    const { cards } = await createNote({ deckId: deck.id, fields: { front: 'q', back: 'a' } });
    const before = cards[0];

    const { updatedCard, log } = await recordReview(before, 3, 1500);
    expect(updatedCard.reps).toBeGreaterThan(0);
    expect(await db().reviewLogs.where('cardId').equals(before.id).count()).toBe(1);

    const ok = await rollbackReview(before.id, log.id);
    expect(ok).toBe(true);

    const afterRollback = await db().cards.get(before.id);
    expect(afterRollback?.reps).toBe(before.reps);
    expect(afterRollback?.state).toBe(before.state);
    expect(afterRollback?.due).toBe(before.due);

    expect(await db().reviewLogs.where('cardId').equals(before.id).count()).toBe(0);
    expect(await db().settings.get(`__preReview:${log.id}`)).toBeUndefined();
  });

  it('returns false if no snapshot exists for that log', async () => {
    const deck = await createDeck({ name: 'D' });
    const { cards } = await createNote({ deckId: deck.id, fields: { front: 'q', back: 'a' } });
    const ok = await rollbackReview(cards[0].id, 'nonexistent-log-id');
    expect(ok).toBe(false);
  });
});

describe('buryCard / suspendCard / unburryStaleCards', () => {
  it('buryCard marks the card buried until tomorrow midnight', async () => {
    const deck = await createDeck({ name: 'D' });
    const { cards } = await createNote({ deckId: deck.id, fields: { front: 'q', back: 'a' } });
    await buryCard(cards[0].id);
    const c = await db().cards.get(cards[0].id);
    expect(c?.buried).toBe(true);
    const tomorrow = new Date();
    tomorrow.setHours(0, 0, 0, 0);
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(c?.buriedUntil).toBe(tomorrow.getTime());
  });

  it('suspended cards are excluded from getNextCardForStudy', async () => {
    const deck = await createDeck({ name: 'D' });
    const { cards: a } = await createNote({ deckId: deck.id, fields: { front: 'a', back: '' } });
    const { cards: b } = await createNote({ deckId: deck.id, fields: { front: 'b', back: '' } });
    await suspendCard(a[0].id);
    const next = await getNextCardForStudy(deck.id);
    expect(next?.id).toBe(b[0].id);
  });

  it('unburryStaleCards clears cards whose buriedUntil has elapsed', async () => {
    const deck = await createDeck({ name: 'D' });
    const { cards } = await createNote({ deckId: deck.id, fields: { front: 'q', back: '' } });
    await db().cards.update(cards[0].id, {
      buried: true,
      buriedUntil: Date.now() - 1000,
    });
    await unburryStaleCards(deck.id);
    const c = await db().cards.get(cards[0].id);
    expect(c?.buried).toBe(false);
  });

  it('resetDeckProgress wipes FSRS state and re-sorts by ankiNoteId when present', async () => {
    const { resetDeckProgress, getNextCardForStudy } = await import('@/lib/db/queries');
    const deck = await createDeck({ name: 'M' });
    const t0 = Date.now();
    const a = await createNote({ deckId: deck.id, fields: { front: 'A', back: 'a' } });
    const b = await createNote({ deckId: deck.id, fields: { front: 'B', back: 'b' } });
    const c = await createNote({ deckId: deck.id, fields: { front: 'C', back: 'c' } });

    // Force same createdAt and assign Anki ids in B, A, C order so the
    // desired study sequence is B -> A -> C, NOT note-creation order.
    await db().notes.bulkPut([
      { ...a.note, createdAt: t0, ankiNoteId: '1000000002' },
      { ...b.note, createdAt: t0, ankiNoteId: '1000000001' },
      { ...c.note, createdAt: t0, ankiNoteId: '1000000003' },
    ]);
    await db().cards.bulkPut([
      { ...a.cards[0], createdAt: t0, state: 'review', due: t0 - 1000, reps: 5 },
      { ...b.cards[0], createdAt: t0, state: 'learning', due: t0 - 1000, reps: 2 },
      { ...c.cards[0], createdAt: t0 },
    ] as Card[]);

    const r = await resetDeckProgress(deck.id);
    expect(r.cardsReset).toBe(3);
    expect(r.reorderedByAnki).toBe(true);

    const cards = await db().cards.where('deckId').equals(deck.id).toArray();
    expect(cards.every(card => card.state === 'new')).toBe(true);
    expect(cards.every(card => card.reps === 0)).toBe(true);

    const next = await getNextCardForStudy(deck.id);
    expect(next?.noteId).toBe(b.note.id);
  });

  it('resetDeckProgress preserves createdAt when ankiNoteId is absent', async () => {
    // Legacy data: importer ran before ankiNoteId was stored. The createdAt
    // we have IS the best ordering signal — reset must NOT clobber it with
    // a ULID guess.
    const { resetDeckProgress, getNextCardForStudy } = await import('@/lib/db/queries');
    const deck = await createDeck({ name: 'M' });
    const a = await createNote({ deckId: deck.id, fields: { front: 'A', back: 'a' } });
    const b = await createNote({ deckId: deck.id, fields: { front: 'B', back: 'b' } });

    // Sequential createdAt that intentionally inverts ULID order — A's
    // createdAt is HIGHER than B's, so picker should return B first if we
    // respect createdAt. (If we wrongly fell back to ULID we'd get A
    // because it was authored earlier and has the smaller ULID.)
    const t0 = Date.now();
    await db().notes.bulkPut([
      { ...a.note, createdAt: t0 + 5_000 },
      { ...b.note, createdAt: t0 },
    ]);
    await db().cards.bulkPut([
      { ...a.cards[0], createdAt: t0 + 5_000, state: 'learning', reps: 1 },
      { ...b.cards[0], createdAt: t0 },
    ] as Card[]);

    const r = await resetDeckProgress(deck.id);
    expect(r.reorderedByAnki).toBe(false);

    const aFresh = await db().notes.get(a.note.id);
    const bFresh = await db().notes.get(b.note.id);
    expect(aFresh?.createdAt).toBe(t0 + 5_000);
    expect(bFresh?.createdAt).toBe(t0);

    const next = await getNextCardForStudy(deck.id);
    expect(next?.noteId).toBe(b.note.id);
  });

  it('unburryStaleCards keeps cards whose buriedUntil is still ahead', async () => {
    const deck = await createDeck({ name: 'D' });
    const { cards } = await createNote({ deckId: deck.id, fields: { front: 'q', back: '' } });
    await db().cards.update(cards[0].id, {
      buried: true,
      buriedUntil: Date.now() + 5 * 60 * 1000,
    });
    await unburryStaleCards(deck.id);
    const c = await db().cards.get(cards[0].id);
    expect(c?.buried).toBe(true);
  });
});

describe('dueForecast', () => {
  it('counts review-state cards by day-of-due', async () => {
    const deck = await createDeck({ name: 'D' });
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const todayMs = startOfToday.getTime();

    // Create 3 cards: one due today, one due in 2 days, one due in 5 days.
    const { cards: a } = await createNote({ deckId: deck.id, fields: { front: 'a', back: '' } });
    const { cards: b } = await createNote({ deckId: deck.id, fields: { front: 'b', back: '' } });
    const { cards: c } = await createNote({ deckId: deck.id, fields: { front: 'c', back: '' } });
    await db().cards.update(a[0].id, { state: 'review', due: todayMs + 1000 });
    await db().cards.update(b[0].id, { state: 'review', due: todayMs + 2 * 86_400_000 });
    await db().cards.update(c[0].id, { state: 'review', due: todayMs + 5 * 86_400_000 });

    const f = await dueForecast(deck.id, 7);
    expect(f).toHaveLength(7);
    expect(f[0]).toBe(1); // today
    expect(f[2]).toBe(1); // day 2
    expect(f[5]).toBe(1); // day 5
    expect(f[1] + f[3] + f[4] + f[6]).toBe(0);
  });

  it('rolls overdue cards into today', async () => {
    const deck = await createDeck({ name: 'D' });
    const { cards } = await createNote({ deckId: deck.id, fields: { front: 'q', back: '' } });
    await db().cards.update(cards[0].id, {
      state: 'review',
      due: Date.now() - 7 * 86_400_000, // overdue by a week
    });
    const f = await dueForecast(deck.id, 7);
    expect(f[0]).toBe(1);
  });

  it('excludes new and learning state from forecast', async () => {
    const deck = await createDeck({ name: 'D' });
    await createNote({ deckId: deck.id, fields: { front: 'a', back: '' } }); // stays new
    const f = await dueForecast(deck.id, 7);
    expect(f.reduce((a, b) => a + b, 0)).toBe(0);
  });
});

describe('bulkImport', () => {
  it('puts decks, notes, cards, and media atomically', async () => {
    const t = Date.now();
    const e = emptyCard(new Date(t));
    const deckId = id();
    const noteId = id();
    const cardId = id();
    await bulkImport({
      decks: [{ id: deckId, name: 'Imported', createdAt: t, modifiedAt: t }],
      notes: [{
        id: noteId, deckId, modelId: 'basic',
        fields: { front: 'q', back: 'a' },
        tags: ['imported'], createdAt: t, modifiedAt: t,
      }],
      cards: [{
        id: cardId, noteId, deckId, ...e,
        suspended: false, buried: false, createdAt: t, modifiedAt: t,
      }],
      media: [],
    });
    expect(await db().decks.count()).toBe(1);
    expect(await db().notes.count()).toBe(1);
    expect(await db().cards.count()).toBe(1);
  });
});
