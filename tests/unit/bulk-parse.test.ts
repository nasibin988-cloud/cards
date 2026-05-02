import { describe, it, expect } from 'vitest';
import { parseBulk } from '@/lib/authoring/bulk-parse';

describe('parseBulk', () => {
  it('parses a single MCAT V5 block', () => {
    const text = `> CARD: v5
> Tier: core
> Context: Cell biology
> Front: The defining anatomical separation between {{c1::prokaryotes}} and {{c1::eukaryotes}} is the {{c2::nuclear envelope}}.
> Back: Prokaryotes are typically smaller (1-5 μm).
> Extra: Compartmentalization is the deeper consequence.
> Tags: core::BB::bio::ch01 skill::discrimination`;
    const { drafts, errors } = parseBulk(text);
    expect(errors).toEqual([]);
    expect(drafts).toHaveLength(1);
    const d = drafts[0];
    expect(d.modelId).toBe('cloze');
    expect(d.tier).toBe('core');
    expect(d.fields.context).toBe('Cell biology');
    expect(d.fields.front).toContain('{{c1::prokaryotes}}');
    expect(d.fields.back).toContain('1-5 μm');
    expect(d.fields.extra).toContain('Compartmentalization');
    expect(d.tags).toEqual(['core::BB::bio::ch01', 'skill::discrimination']);
  });

  it('parses multiple blocks separated by blank lines', () => {
    const text = `> CARD: v5
> Front: First card front

> CARD: v5
> Front: Second card front`;
    const { drafts } = parseBulk(text);
    expect(drafts).toHaveLength(2);
    expect(drafts[0].fields.front).toBe('First card front');
    expect(drafts[1].fields.front).toBe('Second card front');
  });

  it('detects basic vs cloze from the front', () => {
    const text = `> CARD: v5
> Front: What does ATP stand for?
> Back: Adenosine triphosphate.

> CARD: v5
> Front: Energy currency: {{c1::ATP}}.`;
    const { drafts } = parseBulk(text);
    expect(drafts[0].modelId).toBe('basic');
    expect(drafts[1].modelId).toBe('cloze');
  });

  it('records a clear error for blocks without a Front field', () => {
    const text = `> CARD: v5
> Back: orphan back`;
    const { drafts, errors } = parseBulk(text);
    expect(drafts).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toMatch(/Front/);
  });

  it('preserves multi-line field values', () => {
    const text = `> CARD: v5
> Front: short
> Extra: line 1
> line 2
> line 3`;
    const { drafts } = parseBulk(text);
    expect(drafts[0].fields.extra).toBe('line 1\nline 2\nline 3');
  });

  it('tolerates extra whitespace around field names and values', () => {
    const text = `>  Front :  with extra spaces
>  Tags : a b c`;
    const { drafts } = parseBulk(text);
    expect(drafts[0].fields.front).toBe('with extra spaces');
    expect(drafts[0].tags).toEqual(['a', 'b', 'c']);
  });

  it('drops invalid Tier values silently', () => {
    const text = `> CARD: v5
> Front: x
> Tier: bogus`;
    const { drafts } = parseBulk(text);
    expect(drafts[0].tier).toBeUndefined();
  });
});
