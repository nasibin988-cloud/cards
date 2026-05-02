import { describe, it, expect, beforeEach } from 'vitest';
import {
  convertNoteType,
  createDeck,
  createNote,
  getNote,
  listCardsByNote,
  previewConvertNoteType,
  recordReview,
} from '@/lib/db/queries';
import { db } from '@/lib/db/dexie';

beforeEach(async () => {
  const dbi = db();
  await dbi.transaction(
    'rw',
    [dbi.notes, dbi.cards, dbi.decks, dbi.reviewLogs],
    async () => {
      await Promise.all([dbi.notes.clear(), dbi.cards.clear(), dbi.decks.clear(), dbi.reviewLogs.clear()]);
    },
  );
});

describe('previewConvertNoteType', () => {
  it('basic → cloze wraps back as {{c1::...}} appended to front', async () => {
    const deck = await createDeck({ name: 'X' });
    const { note } = await createNote({
      deckId: deck.id,
      fields: { front: 'capital of France?', back: 'Paris' },
    });
    const p = previewConvertNoteType(note, 'cloze');
    expect(p.fields.front).toContain('{{c1::Paris}}');
    expect(p.fields.back).toBe('');
  });

  it('cloze → basic extracts answer text into back, strips cloze syntax', async () => {
    const deck = await createDeck({ name: 'X' });
    const { note } = await createNote({
      deckId: deck.id,
      fields: { front: 'The capital is {{c1::Paris}}.', back: '' },
    });
    const p = previewConvertNoteType(note, 'basic');
    expect(p.fields.front).toBe('The capital is Paris.');
    expect(p.fields.back).toBe('Paris');
  });

  it('cloze → basic joins multiple cloze answers with " / "', async () => {
    const deck = await createDeck({ name: 'X' });
    const { note } = await createNote({
      deckId: deck.id,
      fields: { front: '{{c1::A}} and {{c2::B}}', back: '' },
    });
    const p = previewConvertNoteType(note, 'basic');
    expect(p.fields.back).toBe('A / B');
  });

  it('returns the original fields when target equals current model', async () => {
    const deck = await createDeck({ name: 'X' });
    const { note } = await createNote({
      deckId: deck.id,
      fields: { front: '{{c1::A}}', back: '' },
    });
    const p = previewConvertNoteType(note, 'cloze');
    expect(p.willDeleteHistory).toBe(false);
    expect(p.fields.front).toBe(note.fields.front);
  });
});

describe('convertNoteType', () => {
  it('basic → cloze regenerates one card per ord and drops scheduling history', async () => {
    const deck = await createDeck({ name: 'X' });
    const { note, cards } = await createNote({
      deckId: deck.id,
      fields: { front: 'Q', back: 'Paris' },
    });
    await recordReview(cards[0], 3, 1000);
    const dbi = db();
    expect(await dbi.reviewLogs.count()).toBeGreaterThan(0);

    await convertNoteType(note.id, 'cloze');

    const fresh = await getNote(note.id);
    expect(fresh!.modelId).toBe('cloze');
    expect(fresh!.fields.front).toContain('{{c1::Paris}}');

    const newCards = await listCardsByNote(note.id);
    expect(newCards).toHaveLength(1);
    expect(newCards[0].clozeOrd).toBe(1);
    expect(newCards[0].reps).toBe(0);
    expect(await dbi.reviewLogs.count()).toBe(0);
  });

  it('cloze → basic produces a single card', async () => {
    const deck = await createDeck({ name: 'X' });
    const { note } = await createNote({
      deckId: deck.id,
      fields: { front: '{{c1::A}} and {{c2::B}}', back: '' },
    });
    expect(await listCardsByNote(note.id)).toHaveLength(2);

    await convertNoteType(note.id, 'basic');
    const fresh = await getNote(note.id);
    expect(fresh!.modelId).toBe('basic');

    const cards = await listCardsByNote(note.id);
    expect(cards).toHaveLength(1);
    expect(cards[0].clozeOrd).toBeUndefined();
    expect(cards[0].siblingId).toBeUndefined();
  });

  it('image-occlusion notes are not converted', async () => {
    const deck = await createDeck({ name: 'X' });
    const { note } = await createNote({
      deckId: deck.id,
      fields: { front: 'q', back: 'a' },
      modelId: 'image-occlusion',
      occlusions: [{ x: 0, y: 0, w: 0.1, h: 0.1 }],
    });
    await convertNoteType(note.id, 'cloze');
    const fresh = await getNote(note.id);
    expect(fresh!.modelId).toBe('image-occlusion');
  });
});
