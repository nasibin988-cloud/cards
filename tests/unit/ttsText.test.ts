import { describe, it, expect } from 'vitest';
import { fieldToSpeech, cardToSpeech } from '@/lib/tts/text';
import type { Note } from '@/lib/db/schema';

function makeNote(fields: Partial<Note['fields']>): Note {
  return {
    id: 'n',
    deckId: 'd',
    modelId: 'cloze',
    fields: { front: '', back: '', ...fields },
    tags: [],
    createdAt: 0,
    modifiedAt: 0,
  };
}

describe('fieldToSpeech — front side', () => {
  it('replaces the active cloze with " blank " and pronounces other clozes', () => {
    const t = fieldToSpeech(
      'In glycolysis, glucose is split into {{c1::pyruvate}} via {{c2::substrate-level phosphorylation}}.',
      'front',
      1,
    );
    expect(t).toContain('blank');
    expect(t).toContain('substrate-level phosphorylation');
    expect(t).not.toContain('pyruvate');
  });

  it('reads unconditional clozes as blank when no clozeOrd is supplied', () => {
    const t = fieldToSpeech('The capital is {{c1::Paris}}.', 'front');
    expect(t).toContain('blank');
    expect(t).not.toContain('Paris');
  });

  it('replaces type-clozes with blank on front', () => {
    const t = fieldToSpeech('Hello {{type::world}}', 'front');
    expect(t).toContain('blank');
    expect(t).not.toContain('world');
  });
});

describe('fieldToSpeech — back side', () => {
  it('pronounces every cloze answer on the back', () => {
    const t = fieldToSpeech('{{c1::Glucose}} → {{c2::pyruvate}}', 'back');
    expect(t).toContain('Glucose');
    expect(t).toContain('pyruvate');
    expect(t).not.toContain('blank');
  });
});

describe('fieldToSpeech — sanitization', () => {
  it('strips <img>, <audio>, <script>, and <style> entirely', () => {
    const t = fieldToSpeech(
      'Before <img src="x.png" alt="foo"/> middle <audio src="a.mp3"></audio> after',
      'back',
    );
    expect(t).not.toContain('<');
    expect(t).not.toContain('img');
    expect(t).not.toContain('audio');
    expect(t).toContain('Before');
    expect(t).toContain('after');
  });

  it('strips remaining HTML tags but keeps text content', () => {
    expect(fieldToSpeech('<p>hello <b>world</b></p>', 'back')).toBe('hello world');
  });

  it('decodes the common HTML entities', () => {
    expect(fieldToSpeech('5 &lt; 10 &amp; 10 &gt; 5', 'back')).toBe('5 < 10 & 10 > 5');
  });

  it('reads xlink display text only', () => {
    expect(fieldToSpeech('See [[some-id|the foo note]] for more.', 'back'))
      .toBe('See the foo note for more.');
  });

  it('falls back to xlink query when no display label', () => {
    expect(fieldToSpeech('See [[the foo note]].', 'back')).toBe('See the foo note.');
  });

  it('strips inline and display math markers but keeps body', () => {
    expect(fieldToSpeech('Energy is $E = mc^2$ and $$F = ma$$.', 'back')).toContain('E = mc^2');
    expect(fieldToSpeech('$$F = ma$$', 'back')).toContain('F = ma');
  });

  it('drops bare LaTeX commands', () => {
    expect(fieldToSpeech('\\frac{a}{b} computes a fraction', 'back')).toContain('a');
    expect(fieldToSpeech('\\frac{a}{b} computes a fraction', 'back')).not.toContain('\\frac');
  });

  it('strips markdown headings + bold/italics + link syntax', () => {
    expect(fieldToSpeech('## Heading\n**bold** and *italic*', 'back'))
      .toBe('Heading bold and italic');
    expect(fieldToSpeech('see [the docs](https://x)', 'back')).toBe('see the docs');
  });

  it('collapses internal whitespace runs', () => {
    expect(fieldToSpeech('a    b\n\nc', 'back')).toBe('a b c');
  });

  it('returns empty string for empty input', () => {
    expect(fieldToSpeech('', 'front')).toBe('');
    expect(fieldToSpeech('   ', 'back')).toBe('');
  });
});

describe('cardToSpeech', () => {
  it('front-only on the front side', () => {
    const note = makeNote({
      front: '{{c1::Glucose}} is the substrate.',
      back: 'Should not appear on front.',
      extra: 'Why...',
    });
    const t = cardToSpeech(note, 'front', 1);
    expect(t).toContain('blank');
    expect(t).toContain('substrate');
    expect(t).not.toContain('Should not appear');
    expect(t).not.toContain('Why');
  });

  it('back combines front, back, "Why" extra, and mnemonic with explicit transitions', () => {
    const note = makeNote({
      front: '{{c1::Glucose}} → {{c2::pyruvate}}',
      back: 'Net 2 ATP per glucose.',
      extra: 'Glycolysis is anaerobic.',
      mnemonic: 'Goes Pop',
    });
    const t = cardToSpeech(note, 'back', 1);
    expect(t).toContain('Glucose');
    expect(t).toContain('pyruvate');
    expect(t).toContain('Net 2 ATP');
    expect(t).toContain('Why');
    expect(t).toContain('anaerobic');
    expect(t).toContain('Mnemonic');
    expect(t).toContain('Goes Pop');
  });

  it('skips empty optional fields cleanly', () => {
    const note = makeNote({
      front: 'A',
      back: 'B',
    });
    const t = cardToSpeech(note, 'back', undefined);
    expect(t).not.toContain('Why');
    expect(t).not.toContain('Mnemonic');
    expect(t).toContain('A');
    expect(t).toContain('B');
  });
});
