import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '@/lib/db/dexie';
import {
  createDeck,
  createNote,
  listFeynmanForCard,
  recordFeynmanAttempt,
  recordReview,
  updateFeynmanAttempt,
} from '@/lib/db/queries';
import { feynmanScheduleMultiplier, __test as feynmanInternals } from '@/lib/ai/feynman';

beforeEach(async () => {
  const dbi = db();
  await dbi.transaction(
    'rw',
    [dbi.notes, dbi.cards, dbi.decks, dbi.reviewLogs, dbi.media, dbi.settings, dbi.searchTokens, dbi.feynmanLogs],
    async () => {
      await Promise.all([
        dbi.notes.clear(),
        dbi.cards.clear(),
        dbi.decks.clear(),
        dbi.reviewLogs.clear(),
        dbi.media.clear(),
        dbi.settings.clear(),
        dbi.searchTokens.clear(),
        dbi.feynmanLogs.clear(),
      ]);
    },
  );
});

describe('feynmanScheduleMultiplier — bonus curve', () => {
  it('returns 1.0× for Again regardless of completeness', () => {
    expect(feynmanScheduleMultiplier(1, 0)).toBe(1.0);
    expect(feynmanScheduleMultiplier(1, 1)).toBe(1.0);
  });

  it('returns 1.0× for Hard regardless of completeness', () => {
    expect(feynmanScheduleMultiplier(2, 0.9)).toBe(1.0);
  });

  it('returns 1.0× for Good/Easy when completeness < 0.6', () => {
    expect(feynmanScheduleMultiplier(3, 0.5)).toBe(1.0);
    expect(feynmanScheduleMultiplier(4, 0)).toBe(1.0);
  });

  it('scales linearly from 1.0× at 0.6 completeness to 1.5× at full completeness', () => {
    expect(feynmanScheduleMultiplier(3, 0.6)).toBeCloseTo(1.0);
    expect(feynmanScheduleMultiplier(3, 0.8)).toBeCloseTo(1.25);
    expect(feynmanScheduleMultiplier(3, 1.0)).toBeCloseTo(1.5);
    expect(feynmanScheduleMultiplier(4, 1.0)).toBeCloseTo(1.5);
  });
});

describe('Feynman storage', () => {
  it('records and lists attempts in reverse-chrono order', async () => {
    const deck = await createDeck({ name: 'D' });
    const { note, cards } = await createNote({
      deckId: deck.id,
      fields: { front: 'Q', back: 'A' },
      tags: [],
    });
    const card = cards[0];
    const attempt1 = await recordFeynmanAttempt({
      cardId: card.id,
      noteId: note.id,
      deckId: deck.id,
      explanation: 'first try at explaining this',
      inputMode: 'text',
      durationMs: 60_000,
    });
    // Force a 1ms gap so the [cardId+createdAt] index orders deterministically.
    await new Promise(r => setTimeout(r, 1));
    const attempt2 = await recordFeynmanAttempt({
      cardId: card.id,
      noteId: note.id,
      deckId: deck.id,
      explanation: 'second try with more depth',
      inputMode: 'voice',
      durationMs: 90_000,
      grade: { covered: ['x'], missed: [], vague: [], completeness: 0.9, rationale: 'good' },
    });
    const list = await listFeynmanForCard(card.id);
    expect(list.map(l => l.id)).toEqual([attempt2.id, attempt1.id]);
    expect(list[0].grade?.completeness).toBe(0.9);
    expect(list[0].inputMode).toBe('voice');
  });

  it('updateFeynmanAttempt patches rating + multiplier', async () => {
    const deck = await createDeck({ name: 'D' });
    const { note, cards } = await createNote({
      deckId: deck.id,
      fields: { front: 'Q', back: 'A' },
      tags: [],
    });
    const log = await recordFeynmanAttempt({
      cardId: cards[0].id,
      noteId: note.id,
      deckId: deck.id,
      explanation: 'an explanation',
      inputMode: 'text',
      durationMs: 30_000,
    });
    await updateFeynmanAttempt(log.id, { rating: 3, scheduleMultiplier: 1.25 });
    const fresh = await db().feynmanLogs.get(log.id);
    expect(fresh?.rating).toBe(3);
    expect(fresh?.scheduleMultiplier).toBe(1.25);
  });
});

describe('recordReview interval bonus', () => {
  it('writes a longer scheduledDays + due when intervalMultiplier > 1', async () => {
    const deck = await createDeck({ name: 'D' });
    const { cards } = await createNote({
      deckId: deck.id,
      fields: { front: 'Q', back: 'A' },
      tags: [],
    });
    // Burn through the new->learning step first so the next review computes
    // a multi-day interval (otherwise FSRS picks a sub-1-day learning step
    // and the multiplier rounds to the same value).
    let card = cards[0];
    const r1 = await recordReview(card, 3, 100);
    card = r1.updatedCard;
    const r2 = await recordReview(card, 3, 100);
    card = r2.updatedCard;
    const baselineDays = card.scheduledDays;

    // Take a fresh starting point: read the card's current state and apply
    // a Good rating with no bonus → call it baseline interval.
    const baselineRun = await recordReview(card, 3, 100);
    const baselineNext = baselineRun.updatedCard.scheduledDays;

    // Now set up a parallel card and Good with a 1.5× bonus. Should be
    // strictly longer than baselineNext (we widen post-FSRS).
    const { cards: cards2 } = await createNote({
      deckId: deck.id,
      fields: { front: 'Q2', back: 'A2' },
      tags: [],
    });
    let card2 = cards2[0];
    const r3 = await recordReview(card2, 3, 100);
    card2 = r3.updatedCard;
    const r4 = await recordReview(card2, 3, 100);
    card2 = r4.updatedCard;
    const bonusRun = await recordReview(card2, 3, 100, { intervalMultiplier: 1.5 });
    expect(bonusRun.updatedCard.scheduledDays).toBeGreaterThan(baselineNext);
    // Also confirm it didn't blow past sanity (50% wider, not 50× wider).
    expect(bonusRun.updatedCard.scheduledDays).toBeLessThanOrEqual(
      Math.round(baselineNext * 1.5) + 1,
    );
    // Use baselineDays so the variable reads as intentional.
    expect(baselineDays).toBeGreaterThan(0);
  });

  it('intervalMultiplier=1 leaves the schedule unchanged', async () => {
    const deck = await createDeck({ name: 'D' });
    const { cards } = await createNote({
      deckId: deck.id,
      fields: { front: 'Q', back: 'A' },
      tags: [],
    });
    let card = cards[0];
    card = (await recordReview(card, 3, 100)).updatedCard;
    card = (await recordReview(card, 3, 100)).updatedCard;
    const noBonus = (await recordReview(card, 3, 100, { intervalMultiplier: 1 })).updatedCard;

    const { cards: cards2 } = await createNote({
      deckId: deck.id,
      fields: { front: 'Q2', back: 'A2' },
      tags: [],
    });
    let card2 = cards2[0];
    card2 = (await recordReview(card2, 3, 100)).updatedCard;
    card2 = (await recordReview(card2, 3, 100)).updatedCard;
    const noOpts = (await recordReview(card2, 3, 100)).updatedCard;
    expect(noBonus.scheduledDays).toBe(noOpts.scheduledDays);
  });
});

describe('Feynman grade JSON parser', () => {
  it('parses a clean JSON response', () => {
    const raw = JSON.stringify({
      covered: ['kinetic energy'],
      missed: ['units'],
      vague: [],
      completeness: 0.7,
      rationale: 'Solid start.',
    });
    const grade = feynmanInternals.parseGrade(raw);
    expect(grade.covered).toEqual(['kinetic energy']);
    expect(grade.missed).toEqual(['units']);
    expect(grade.completeness).toBe(0.7);
  });

  it('strips ```json fences', () => {
    const raw = '```json\n{"covered":["a"],"missed":[],"vague":[],"completeness":0.5,"rationale":"ok"}\n```';
    const grade = feynmanInternals.parseGrade(raw);
    expect(grade.covered).toEqual(['a']);
    expect(grade.completeness).toBe(0.5);
  });

  it('falls back to brace-matched substring when prefixed by prose', () => {
    const raw = 'Here is the grade:\n{"covered":[],"missed":["x"],"vague":[],"completeness":0,"rationale":"r"}\nHope this helps.';
    const grade = feynmanInternals.parseGrade(raw);
    expect(grade.missed).toEqual(['x']);
  });

  it('clamps completeness to [0, 1] and tolerates a string number', () => {
    expect(feynmanInternals.normalizeGrade({ completeness: 1.5 }).completeness).toBe(1);
    expect(feynmanInternals.normalizeGrade({ completeness: -0.3 }).completeness).toBe(0);
    expect(feynmanInternals.normalizeGrade({ completeness: '0.42' }).completeness).toBeCloseTo(0.42);
  });

  it('returns empty arrays for missing fields', () => {
    const g = feynmanInternals.normalizeGrade({});
    expect(g.covered).toEqual([]);
    expect(g.missed).toEqual([]);
    expect(g.vague).toEqual([]);
    expect(g.completeness).toBe(0);
    expect(g.rationale).toBe('');
  });
});
