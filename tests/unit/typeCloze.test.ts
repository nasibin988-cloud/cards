import { describe, it, expect } from 'vitest';
import {
  findTypeClozes,
  hasCloze,
  hasTypeCloze,
  renderBack,
  renderFront,
  renderPlain,
} from '@/lib/cloze/parser';

describe('type-the-answer cloze {{type::...}}', () => {
  it('hasCloze returns true for either cloze flavor', () => {
    expect(hasCloze('plain text')).toBe(false);
    expect(hasCloze('{{c1::Paris}}')).toBe(true);
    expect(hasCloze('{{type::Paris}}')).toBe(true);
  });

  it('hasTypeCloze distinguishes type clozes from regular ones', () => {
    expect(hasTypeCloze('{{c1::Paris}}')).toBe(false);
    expect(hasTypeCloze('{{type::Paris}}')).toBe(true);
  });

  it('findTypeClozes returns one entry per occurrence', () => {
    const m = findTypeClozes('Capital is {{type::Paris}}, currency is {{type::Euro::3 letters}}.');
    expect(m).toHaveLength(2);
    expect(m[0]).toMatchObject({ answer: 'Paris', hint: undefined });
    expect(m[1]).toMatchObject({ answer: 'Euro', hint: '3 letters' });
  });

  it('renderFront emits an <input> placeholder per type-cloze', () => {
    const html = renderFront('Capital is {{type::Paris}}.', 1);
    expect(html).toContain('<input');
    expect(html).toContain('class="type-cloze"');
    // Answer is preserved as a data-attr for the back-side diff.
    expect(html).toContain('data-type-answer="Paris"');
    expect(html).toContain('data-type-id="t0"');
    // Naked answer text should not appear on the front.
    expect(html).not.toMatch(/>Paris</);
  });

  it('renderFront uses the hint as input placeholder when present', () => {
    const html = renderFront('{{type::Euro::3 letters}}', 1);
    expect(html).toContain('placeholder="3 letters"');
  });

  it('renderBack emits a result span carrying the expected answer', () => {
    const html = renderBack('Capital is {{type::Paris}}.', 1);
    expect(html).toContain('class="type-cloze-result"');
    expect(html).toContain('data-type-answer="Paris"');
    expect(html).toContain('data-type-id="t0"');
  });

  it('renderPlain strips type-cloze syntax leaving the answer text', () => {
    expect(renderPlain('Capital is {{type::Paris}}.')).toBe('Capital is Paris.');
    expect(renderPlain('{{c1::A}} {{type::B}}')).toBe('A B');
  });

  it('strips script content from a malicious answer', () => {
    const html = renderFront('{{type::"x" <script>alert(1)</script>}}', 1);
    // No <script> element survives the sanitizer.
    expect(html).not.toMatch(/<script[\s>]/i);
    expect(html).not.toContain('alert(1)');
    // The input element is still rendered.
    expect(html).toContain('<input');
    expect(html).toContain('class="type-cloze"');
  });

  it('preserves a benign answer in the data attribute', () => {
    const html = renderFront('Capital is {{type::Paris}}.', 1);
    expect(html).toContain('data-type-answer="Paris"');
  });

  it('co-exists with regular clozes on the same note', () => {
    const html = renderFront('{{c1::A}} and {{type::B}}', 1);
    expect(html).toContain('cloze-blank');         // c1 is masked
    expect(html).toContain('class="type-cloze"');  // type-cloze rendered as input
  });
});
