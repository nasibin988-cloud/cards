/**
 * Smoke tests for renderRichText handling of the new constructs added in
 * this round: KaTeX math passthrough, audio tag preservation, and the
 * type-cloze input rendering.
 */
import { describe, it, expect } from 'vitest';
import { renderRichText, renderFront, renderBack, hasCloze } from '@/lib/cloze/parser';

describe('LaTeX rendering via KaTeX', () => {
  it('renders inline $...$ as KaTeX HTML', () => {
    const html = renderRichText('Energy is $E = mc^2$ in special relativity.');
    expect(html).toContain('class="katex"');
    expect(html).not.toContain('$E = mc^2$');
  });

  it('renders display $$...$$ in displayMode', () => {
    const html = renderRichText('$$\\int_0^1 x^2 dx = \\frac{1}{3}$$');
    expect(html).toContain('class="katex"');
    // Display mode wraps in katex-display.
    expect(html).toContain('katex-display');
  });

  it('falls back to original text on invalid LaTeX', () => {
    const html = renderRichText('plain $\\not_valid{` text');
    // No KaTeX output at all — we just leave the source intact.
    expect(html).not.toContain('class="katex"');
  });

  it('passes math through cloze rendering', () => {
    const html = renderFront('The energy is $E = mc^2$ where {{c1::m}} is mass.', 1);
    expect(html).toContain('class="katex"');
    expect(html).toContain('cloze-blank');
  });
});

describe('audio embed survives sanitizer', () => {
  it('preserves <audio src="..." controls>', () => {
    const html = renderRichText('Listen: <audio src="my-clip.webm" controls></audio>');
    expect(html).toContain('<audio');
    expect(html).toContain('src="my-clip.webm"');
    expect(html).toContain('controls');
  });

  it('preserves audio embeds inside a cloze back-side', () => {
    const html = renderBack('{{c1::Paris}} <audio src="paris.webm" controls></audio>', 1);
    expect(html).toContain('cloze-revealed');
    expect(html).toContain('<audio');
  });
});

describe('hasCloze still recognizes both flavors', () => {
  it('matches a regular cloze', () => {
    expect(hasCloze('{{c1::A}}')).toBe(true);
  });
  it('matches a type cloze', () => {
    expect(hasCloze('{{type::A}}')).toBe(true);
  });
});
