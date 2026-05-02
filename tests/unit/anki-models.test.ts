import { describe, it, expect } from 'vitest';
import { mapFields, type AnkiModel } from '@/lib/apkg/anki-models';

const basicModel: AnkiModel = {
  id: 'm1',
  name: 'Basic',
  type: 0,
  flds: [
    { name: 'Front', ord: 0 },
    { name: 'Back', ord: 1 },
  ],
};

const clozeModel: AnkiModel = {
  id: 'm2',
  name: 'Cloze',
  type: 1,
  flds: [
    { name: 'Text', ord: 0 },
    { name: 'Back Extra', ord: 1 },
  ],
};

const ankingModel: AnkiModel = {
  id: 'm3',
  name: 'AnKing',
  type: 1,
  flds: [
    { name: 'Text', ord: 0 },
    { name: 'Extra', ord: 1 },
    { name: 'Mnemonic', ord: 2 },
    { name: 'Image', ord: 3 },
    { name: 'Source', ord: 4 },
    { name: 'Custom Tag', ord: 5 },
  ],
};

describe('mapFields', () => {
  it('Basic: maps Front/Back', () => {
    const f = mapFields(basicModel, ['What is Dexie?', 'A wrapper around IndexedDB.']);
    expect(f.front).toBe('What is Dexie?');
    expect(f.back).toBe('A wrapper around IndexedDB.');
    expect(f.extra).toBeUndefined();
  });

  it('Cloze: text → front, back-extra → extra (since it matches /extra/)', () => {
    const f = mapFields(clozeModel, ['{{c1::Paris}} is the capital of {{c2::France}}.', 'Geography note.']);
    expect(f.front).toBe('{{c1::Paris}} is the capital of {{c2::France}}.');
    expect(f.extra).toBe('Geography note.');
  });

  it('Anking-style: maps Text→front, Extra, Mnemonic, Source; bare Image filename → image', () => {
    const f = mapFields(ankingModel, [
      '{{c1::ATP}} is the energy currency.',
      'High-yield extra context.',
      'A-T-P = Always Think Power',
      'mitochondria.png',
      'First Aid p.123',
      'optional tag value',
    ]);
    expect(f.front).toBe('{{c1::ATP}} is the energy currency.');
    expect(f.mnemonic).toBe('A-T-P = Always Think Power');
    expect(f.image).toBe('mitochondria.png');
    expect(f.source).toBe('First Aid p.123');
  });

  it('extracts <img src="..."> from an Image field', () => {
    const f = mapFields(ankingModel, [
      '{{c1::a}}', '', '',
      '<img src="cell-diagram.svg" alt="">',
      '', '',
    ]);
    expect(f.image).toBe('cell-diagram.svg');
  });

  it('puts unmapped non-empty fields into extra as labeled overflow', () => {
    const m: AnkiModel = {
      id: 'm', name: 'Custom', type: 0,
      flds: [
        { name: 'Front', ord: 0 },
        { name: 'Back', ord: 1 },
        { name: 'Author', ord: 2 },
        { name: 'Year', ord: 3 },
      ],
    };
    const f = mapFields(m, ['Q', 'A', 'Tom', '2020']);
    expect(f.front).toBe('Q');
    expect(f.back).toBe('A');
    expect(f.extra).toContain('Author: Tom');
    expect(f.extra).toContain('Year: 2020');
  });

  it('falls back: first field → front, second → back when names do not match', () => {
    const m: AnkiModel = {
      id: 'm', name: 'X', type: 0,
      flds: [
        { name: 'Foo', ord: 0 },
        { name: 'Bar', ord: 1 },
      ],
    };
    const f = mapFields(m, ['hello', 'world']);
    expect(f.front).toBe('hello');
    expect(f.back).toBe('world');
  });

  it('does not duplicate front into back if first field is the only filled one', () => {
    const m: AnkiModel = {
      id: 'm', name: 'X', type: 0,
      flds: [
        { name: 'Foo', ord: 0 },
        { name: 'Bar', ord: 1 },
      ],
    };
    const f = mapFields(m, ['only', 'only']);
    expect(f.front).toBe('only');
    expect(f.back).toBe('');
  });
});
