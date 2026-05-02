import { describe, it, expect } from 'vitest';
import {
  findClozes,
  clozeOrds,
  hasCloze,
  renderFront,
  renderBack,
  renderPlain,
  renderRichText,
  embedXlinks,
} from '@/lib/cloze/parser';

describe('cloze parser', () => {
  describe('findClozes', () => {
    it('parses a single cloze', () => {
      const m = findClozes('The capital is {{c1::Paris}}.');
      expect(m).toHaveLength(1);
      expect(m[0].ord).toBe(1);
      expect(m[0].answer).toBe('Paris');
      expect(m[0].hint).toBeUndefined();
    });
    it('parses multi-cloze on the same line', () => {
      const m = findClozes('{{c1::A}} and {{c2::B}} and {{c3::C}}');
      expect(m).toHaveLength(3);
      expect(m.map(x => x.ord)).toEqual([1, 2, 3]);
      expect(m.map(x => x.answer)).toEqual(['A', 'B', 'C']);
    });
    it('parses repeated ords (same cN twice)', () => {
      const m = findClozes('{{c1::east}} vs {{c1::west}}');
      expect(m).toHaveLength(2);
      expect(m.every(x => x.ord === 1)).toBe(true);
    });
    it('parses cloze with hint', () => {
      const m = findClozes('Population: {{c1::1.4 billion::approx}}');
      expect(m[0].hint).toBe('approx');
      expect(m[0].answer).toBe('1.4 billion');
    });
    it('handles colons in answer text', () => {
      const m = findClozes('{{c1::ratio 1:2}}');
      expect(m).toHaveLength(1);
      expect(m[0].answer).toBe('ratio 1:2');
    });
    it('returns empty for non-cloze text', () => {
      expect(findClozes('plain text').length).toBe(0);
    });
    it('does not match malformed cloze', () => {
      expect(findClozes('{{c1::no closing').length).toBe(0);
      expect(findClozes('{c1::missing brace}}').length).toBe(0);
    });
  });

  describe('clozeOrds', () => {
    it('returns sorted distinct ords', () => {
      expect(clozeOrds('{{c2::b}} {{c1::a}} {{c2::c}} {{c5::e}}')).toEqual([1, 2, 5]);
    });
    it('returns empty array for plain text', () => {
      expect(clozeOrds('plain')).toEqual([]);
    });
  });

  describe('hasCloze', () => {
    it('returns true for cloze and false for plain', () => {
      expect(hasCloze('{{c1::x}}')).toBe(true);
      expect(hasCloze('plain')).toBe(false);
    });
  });

  describe('renderFront', () => {
    it('masks the matching cN as a blank, reveals others', () => {
      const html = renderFront('{{c1::A}} and {{c2::B}}', 1);
      expect(html).toContain('cloze-blank');
      expect(html).toContain('cloze-other-revealed">B<');
      // The masked answer text "A" must not appear naked anywhere.
      expect(html).not.toContain('cloze-other-revealed">A<');
    });
    it('uses the hint as blank label when provided', () => {
      const html = renderFront('{{c1::1.4 billion::approx}}', 1);
      expect(html).toContain('approx');
      expect(html).not.toContain('1.4 billion');
    });
    it('strips <script> tags from answer text to prevent injection', () => {
      const html = renderFront('{{c1::A}} and {{c2::<script>x</script>}}', 1);
      expect(html).not.toContain('<script>');
      expect(html).not.toContain('alert');
    });
  });

  describe('renderBack', () => {
    it('highlights the matching cN, reveals others', () => {
      const html = renderBack('{{c1::A}} and {{c2::B}}', 1);
      expect(html).toContain('cloze-revealed">A<');
      expect(html).toContain('cloze-other-revealed">B<');
    });
  });

  describe('renderPlain', () => {
    it('strips cloze markup leaving answer text', () => {
      expect(renderPlain('{{c1::Paris}} is in {{c2::France}}'))
        .toBe('Paris is in France');
    });
  });

  describe('renderRichText', () => {
    it('preserves <b>, <i>, <br>, <strong>, <em>, <code>, <sub>, <sup>', () => {
      const html = renderRichText('<b>x</b> <i>y</i> a<br>b <code>k</code>');
      expect(html).toContain('<b>x</b>');
      expect(html).toContain('<i>y</i>');
      expect(html).toContain('<br>');
      expect(html).toContain('<code>k</code>');
    });
    it('strips <script> tags entirely', () => {
      const html = renderRichText('<script>x</script>');
      expect(html).not.toContain('<script>');
      expect(html).not.toContain('alert');
    });
    it('preserves <img src="...">', () => {
      const html = renderRichText('<img src="cell.png">');
      expect(html).toContain('<img');
      expect(html).toContain('cell.png');
    });
    it('renders markdown bold and italic', () => {
      const html = renderRichText('**bold** and *italic*');
      expect(html).toContain('<strong>bold</strong>');
      expect(html).toContain('<em>italic</em>');
    });
    it('renders markdown lists', () => {
      const html = renderRichText('- one\n- two');
      expect(html).toContain('<ul>');
      expect(html).toContain('<li>one</li>');
    });
    it('renders markdown headings', () => {
      const html = renderRichText('### Mechanism');
      expect(html).toContain('<h3>Mechanism</h3>');
    });
    it('renders markdown tables', () => {
      const html = renderRichText('| A | B |\n|---|---|\n| 1 | 2 |');
      expect(html).toContain('<table>');
      expect(html).toContain('<th>A</th>');
    });
    it('renders <p> wrappers from genanki imports unchanged', () => {
      const html = renderRichText('<p>genanki content</p>');
      expect(html).toContain('<p>genanki content</p>');
    });
  });

  describe('renderFront/renderBack final HTML pipeline', () => {
    it('renderFront output drops directly into innerHTML without escaping cloze spans', () => {
      const html = renderFront('{{c1::Paris}} is the capital of {{c2::France}}.', 1);
      // The cloze structure must be present as live HTML, not as escaped entities.
      expect(html).toMatch(/<span class="cloze-blank">/);
      expect(html).not.toMatch(/&lt;span class="cloze-blank"&gt;/);
      expect(html).toMatch(/<span class="cloze-other-revealed">France<\/span>/);
    });
    it('rich text inside cloze answer is preserved when revealed', () => {
      const html = renderBack('A {{c1::<b>bold</b>}} word.', 1);
      expect(html).toMatch(/<span class="cloze-revealed"><b>bold<\/b><\/span>/);
    });
    it('rich text in non-cloze segments is preserved', () => {
      const html = renderFront('<i>pre</i> {{c1::x}} <b>post</b>', 1);
      expect(html).toContain('<i>pre</i>');
      expect(html).toContain('<b>post</b>');
    });
    it('script in cloze answer is removed', () => {
      const html = renderBack('{{c1::<script>x</script>}}', 1);
      expect(html).not.toMatch(/<script>/);
      expect(html).not.toContain('alert');
    });
    it('script in non-cloze segments is removed', () => {
      const html = renderFront('<script>x</script> {{c1::ok}}', 1);
      expect(html).not.toMatch(/<script>/);
      expect(html).not.toContain('alert');
    });
    it('renderFront uses hint as the blank label when present', () => {
      const html = renderFront('{{c1::1.4 billion::approx}}', 1);
      expect(html).toContain('<span class="cloze-blank">approx</span>');
      expect(html).not.toContain('1.4 billion');
    });
  });

  describe('cross-card links [[query]]', () => {
    it('embeds plain bracketed query as a card-xlink span', () => {
      const out = embedXlinks('See [[Prefrontal cortex]] for details.');
      expect(out).toContain('<span class="card-xlink" data-xlink-q="Prefrontal cortex">Prefrontal cortex</span>');
    });
    it('supports a display-text override with pipe', () => {
      const out = embedXlinks('See [[Prefrontal cortex|the PFC]] for details.');
      expect(out).toContain('data-xlink-q="Prefrontal cortex"');
      expect(out).toContain('>the PFC</span>');
    });
    it('escapes HTML in the link target', () => {
      const out = embedXlinks('Click [[<script>alert(1)</script>]].');
      expect(out).not.toContain('<script>');
      expect(out).toContain('&lt;script&gt;');
    });
    it('renderRichText carries xlinks through markdown unchanged', () => {
      const html = renderRichText('See [[PFC]] details.');
      expect(html).toContain('class="card-xlink"');
      expect(html).toContain('data-xlink-q="PFC"');
    });
    it('xlinks survive cloze rendering', () => {
      const html = renderBack('The {{c1::PFC}} links to [[motor cortex]].', 1);
      expect(html).toContain('class="card-xlink"');
      expect(html).toContain('data-xlink-q="motor cortex"');
    });
  });
});
