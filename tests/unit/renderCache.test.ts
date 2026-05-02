import { describe, it, expect, beforeEach } from 'vitest';
import {
  renderFront,
  renderBack,
  renderRichText,
  clearRenderCache,
  __renderCacheSize,
} from '@/lib/cloze/parser';

beforeEach(() => {
  clearRenderCache();
});

describe('render output cache', () => {
  it('returns a stable string for the same input', () => {
    const a = renderFront('{{c1::Paris}} is the capital of France', 1);
    const b = renderFront('{{c1::Paris}} is the capital of France', 1);
    expect(a).toBe(b);
  });

  it('caches the front render under one entry', () => {
    expect(__renderCacheSize()).toBe(0);
    renderFront('{{c1::Paris}}', 1);
    expect(__renderCacheSize()).toBe(1);
    renderFront('{{c1::Paris}}', 1); // hit
    expect(__renderCacheSize()).toBe(1);
  });

  it('keys separately by side and ord', () => {
    renderFront('{{c1::A}} {{c2::B}}', 1);
    renderFront('{{c1::A}} {{c2::B}}', 2);
    renderBack('{{c1::A}} {{c2::B}}', 1);
    renderRichText('plain text');
    expect(__renderCacheSize()).toBe(4);
  });

  it('evicts oldest when over the cap', () => {
    // Fill past the documented cap (100) and confirm the cache stays
    // bounded — exact cap is intentionally not asserted, just bounded-ness.
    for (let i = 0; i < 200; i++) {
      renderFront(`{{c1::value-${i}}}`, 1);
    }
    expect(__renderCacheSize()).toBeLessThanOrEqual(100);
  });

  it('clearRenderCache empties everything', () => {
    renderFront('{{c1::a}}', 1);
    renderFront('{{c1::b}}', 1);
    expect(__renderCacheSize()).toBe(2);
    clearRenderCache();
    expect(__renderCacheSize()).toBe(0);
  });

  it('renderRichText caches plain markdown too', () => {
    const a = renderRichText('# Hello\n\n**world**');
    const b = renderRichText('# Hello\n\n**world**');
    expect(a).toBe(b);
    expect(__renderCacheSize()).toBe(1);
  });

  it('empty input bypasses cache (no point caching empty)', () => {
    expect(renderRichText('')).toBe('');
    expect(__renderCacheSize()).toBe(0);
  });
});
