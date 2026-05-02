/**
 * Cloze + markdown rendering for card content.
 *
 * Pipeline:
 *   1. Cloze pass — replace each {{cN::answer[::hint]}} with the final
 *      `<span class="cloze-...">...</span>` HTML directly in the source string.
 *      Inside each cloze span we already run inline markdown through `marked`
 *      so things like `**bold**` inside an answer are honored.
 *   2. Markdown pass — `marked.parse` walks the surrounding text. Inline HTML
 *      (our cloze spans) passes through unchanged in marked's default mode.
 *   3. Sanitize pass — DOMPurify with a strict tag/attr allowlist; cloze
 *      classes are preserved because `class` is allowed.
 *
 * Handles user markdown AND imported genanki HTML in a single code path.
 */

import { marked } from 'marked';
import DOMPurify from 'dompurify';
import katex from 'katex';

const CLOZE_RE = /\{\{c(\d+)::((?:(?!\}\}).)+?)(?:::((?:(?!\}\}).)+?))?\}\}/g;
const CLOZE_TEST_RE = /\{\{c\d+::((?:(?!\}\}).)+?)(?:::((?:(?!\}\}).)+?))?\}\}/;

/**
 * LaTeX math: `$inline$` and `$$display$$`. Rendered with KaTeX before the
 * cloze and markdown passes so KaTeX's HTML lands inside the same sanitizer
 * as everything else. We use sentinel placeholders during the cloze pass so
 * `{{cN::}}` matchers don't accidentally chew on math content.
 */
const MATH_DISPLAY_RE = /\$\$([\s\S]+?)\$\$/g;
const MATH_INLINE_RE = /(?<!\$)\$(?!\$)([^\n$]+?)(?<!\$)\$(?!\$)/g;

function renderMath(text: string): string {
  // Pre-render display math first so `$$...$$` doesn't match inline twice.
  let out = text.replace(MATH_DISPLAY_RE, (_full, body) => {
    try {
      return katex.renderToString(body, { displayMode: true, throwOnError: false, output: 'html' });
    } catch {
      return _full;
    }
  });
  out = out.replace(MATH_INLINE_RE, (_full, body) => {
    try {
      return katex.renderToString(body, { displayMode: false, throwOnError: false, output: 'html' });
    } catch {
      return _full;
    }
  });
  return out;
}

/**
 * Type-the-answer clozes: `{{type::answer}}` or `{{type::answer::hint}}`.
 * They render as an inline `<input>` on the front. On the back the user's
 * typed text is diffed character-by-character against the expected answer.
 * Type clozes do NOT split a note into multiple cards; all type-clozes on a
 * note live on the same single card.
 */
const TYPE_CLOZE_RE = /\{\{type::((?:(?!\}\}).)+?)(?:::((?:(?!\}\}).)+?))?\}\}/g;
const TYPE_CLOZE_TEST_RE = /\{\{type::((?:(?!\}\}).)+?)(?:::((?:(?!\}\}).)+?))?\}\}/;

// Cross-card links: [[query]] resolves at click time via search. The query
// can be the front-text of another note ("Prefrontal cortex") or a noteId.
// `[[query|display text]]` lets the user override how the link renders.
const XLINK_RE = /\[\[([^\]|\n]+?)(?:\|([^\]\n]+?))?\]\]/g;

marked.setOptions({
  gfm: true,
  breaks: false,
});

const ALLOWED_TAGS = [
  'p', 'br', 'hr',
  'b', 'i', 'u', 'em', 'strong', 'mark', 'small', 'sub', 'sup', 'del', 'ins',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li',
  'blockquote', 'pre', 'code', 'kbd',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'a', 'img',
  'audio', 'source',
  'span', 'div',
  'input',
  // KaTeX uses semantic MathML in addition to its annotated <span> tree.
  'math', 'semantics', 'mrow', 'mi', 'mn', 'mo', 'ms', 'mtext', 'mspace',
  'msqrt', 'mroot', 'mfrac', 'msub', 'msup', 'msubsup', 'munder', 'mover',
  'munderover', 'mtable', 'mtr', 'mtd', 'mlabeledtr', 'mfenced',
  'mphantom', 'mpadded', 'mstyle', 'menclose', 'merror', 'maligngroup',
  'malignmark', 'mglyph', 'annotation', 'annotation-xml',
];

const ALLOWED_ATTR = [
  'href', 'src', 'alt', 'title', 'class',
  'colspan', 'rowspan', 'align',
  // <audio controls>
  'controls', 'preload', 'loop',
  // Cross-card links: data-xlink-q encodes the search target so the click
  // handler in CardRenderer can resolve it without re-parsing the DOM.
  'data-xlink-q',
  // Type-the-answer cloze inputs.
  'type', 'placeholder', 'autocomplete', 'spellcheck', 'data-type-id', 'data-type-answer',
  // KaTeX styling + ARIA + MathML attrs.
  'style', 'aria-hidden', 'aria-label', 'role', 'encoding',
  'mathvariant', 'mathsize', 'mathbackground', 'mathcolor',
  'displaystyle', 'scriptlevel',
];

function sanitize(html: string): string {
  if (typeof window === 'undefined') return html;
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
  });
}

export interface ClozeMatch {
  ord: number;
  answer: string;
  hint?: string;
  fullMatch: string;
  index: number;
}

export function findClozes(text: string): ClozeMatch[] {
  const matches: ClozeMatch[] = [];
  for (const m of text.matchAll(CLOZE_RE)) {
    matches.push({
      ord: parseInt(m[1], 10),
      answer: m[2],
      hint: m[3],
      fullMatch: m[0],
      index: m.index ?? 0,
    });
  }
  return matches;
}

export function clozeOrds(text: string): number[] {
  const ords = new Set<number>();
  for (const m of findClozes(text)) ords.add(m.ord);
  return [...ords].sort((a, b) => a - b);
}

export function hasCloze(text: string): boolean {
  return CLOZE_TEST_RE.test(text) || TYPE_CLOZE_TEST_RE.test(text);
}

export function hasTypeCloze(text: string): boolean {
  return TYPE_CLOZE_TEST_RE.test(text);
}

export interface TypeClozeMatch {
  id: string;
  answer: string;
  hint?: string;
}

export function findTypeClozes(text: string): TypeClozeMatch[] {
  const out: TypeClozeMatch[] = [];
  let i = 0;
  for (const m of text.matchAll(TYPE_CLOZE_RE)) {
    out.push({
      id: `t${i++}`,
      answer: m[1],
      hint: m[2],
    });
  }
  return out;
}

/**
 * Render output cache. The renderers are pure functions of `(text, ord)`,
 * so we can hash on those inputs and skip the marked/DOMPurify/KaTeX
 * pipeline on cache hit.
 *
 * Hot path: reveals/rates re-render the same card; the prefetch path renders
 * the next card speculatively; a relearning step shows the same card 3-5
 * times in a session. Without the cache each of those reruns the full
 * pipeline, which on math-heavy MCAT cards is the dominant cost.
 *
 * LRU cap chosen empirically: 100 entries × ~1KB rendered HTML each = ~100KB
 * — bounded, and well past the back-to-back-to-card-N+2 reuse pattern.
 */
const RENDER_CACHE_CAP = 100;
const renderCache = new Map<string, string>();

function renderCacheGet(key: string): string | undefined {
  const cached = renderCache.get(key);
  if (cached === undefined) return undefined;
  // Bubble to most-recent on access.
  renderCache.delete(key);
  renderCache.set(key, cached);
  return cached;
}

function renderCacheSet(key: string, html: string): void {
  renderCache.set(key, html);
  while (renderCache.size > RENDER_CACHE_CAP) {
    const oldest = renderCache.keys().next();
    if (oldest.done) break;
    renderCache.delete(oldest.value);
  }
}

export function renderFront(text: string, ord: number): string {
  const key = `f|${ord}|${text}`;
  const cached = renderCacheGet(key);
  if (cached !== undefined) return cached;
  const withMath = renderMath(text);
  const typed = substituteTypeClozes(withMath, 'front');
  const html = renderClozeMarkdown(typed, ord, 'front');
  renderCacheSet(key, html);
  return html;
}

export function renderBack(text: string, ord: number): string {
  const key = `b|${ord}|${text}`;
  const cached = renderCacheGet(key);
  if (cached !== undefined) return cached;
  const withMath = renderMath(text);
  const typed = substituteTypeClozes(withMath, 'back');
  const html = renderClozeMarkdown(typed, ord, 'back');
  renderCacheSet(key, html);
  return html;
}

/** Plain markdown render (no cloze processing). For non-cloze fields. */
export function renderRichText(text: string): string {
  if (!text) return '';
  const key = `r|0|${text}`;
  const cached = renderCacheGet(key);
  if (cached !== undefined) return cached;
  const withMath = renderMath(text);
  const withXlinks = embedXlinks(withMath);
  const html = marked.parse(withXlinks, { async: false }) as string;
  const sanitized = sanitize(html);
  renderCacheSet(key, sanitized);
  return sanitized;
}

/**
 * Drop the cache. Call on note edit so the next render reflects the change.
 * (We keep the API for callers that mutate fields outside `updateNote`.)
 */
export function clearRenderCache(): void {
  renderCache.clear();
}

/** Test helper. */
export function __renderCacheSize(): number {
  return renderCache.size;
}

/**
 * Replace [[query]] / [[query|display]] with a styled span carrying the
 * search target as data-xlink-q. The CardRenderer click handler resolves
 * the target at click time (single match → navigate; multiple → picker;
 * none → flag as unresolved). Done before markdown so the resulting HTML
 * passes through marked unchanged.
 */
export function embedXlinks(text: string): string {
  return text.replace(XLINK_RE, (_full, target, display) => {
    const q = String(target).trim();
    const label = display ? String(display).trim() : q;
    return `<span class="card-xlink" data-xlink-q="${escapeAttr(q)}">${escapeHtml(label)}</span>`;
  });
}

/** Strip cloze markup; return raw answer text. Used for AI prompts. */
export function renderPlain(text: string): string {
  return text
    .replace(CLOZE_RE, (_full, _ord, answer) => answer)
    .replace(TYPE_CLOZE_RE, (_full, answer) => answer);
}

/**
 * Pre-substitute type-clozes inline so the cloze/markdown pipelines see plain
 * placeholders instead of `{{type::...}}`. Front: an `<input>`. Back: a span
 * the renderer fills with diff output via DOM patching.
 */
function substituteTypeClozes(text: string, side: 'front' | 'back'): string {
  let i = 0;
  return text.replace(TYPE_CLOZE_RE, (_full, answer, hint) => {
    const id = `t${i++}`;
    if (side === 'front') {
      const placeholder = hint ? ` placeholder="${escapeAttr(hint)}"` : '';
      return `<input type="text" class="type-cloze" data-type-id="${id}" data-type-answer="${escapeAttr(answer)}" autocomplete="off" spellcheck="false"${placeholder}>`;
    }
    return `<span class="type-cloze-result" data-type-id="${id}" data-type-answer="${escapeAttr(answer)}"></span>`;
  });
}

function renderClozeMarkdown(text: string, ord: number, side: 'front' | 'back'): string {
  // Replace each cloze with its final span. Embed inline markdown for the
  // answer text so things like **bold** inside a cloze answer render. Apply
  // the [[xlink]] transform to the answer text too so cross-references work
  // inside cloze answers.
  const withSpans = text.replace(
    CLOZE_RE,
    (_full, ordStr, answer, hint) => {
      const matchOrd = parseInt(ordStr, 10);
      if (side === 'front') {
        if (matchOrd === ord) {
          const label = hint ?? '…';
          return `<span class="cloze-blank">${escapeHtml(label)}</span>`;
        }
        return `<span class="cloze-other-revealed">${renderInline(answer)}</span>`;
      }
      if (matchOrd === ord) {
        return `<span class="cloze-revealed">${renderInline(answer)}</span>`;
      }
      return `<span class="cloze-other-revealed">${renderInline(answer)}</span>`;
    },
  );

  // Apply xlinks AFTER cloze replacement so `[[X]]` inside non-current cloze
  // answers (now wrapped in spans) is still picked up.
  const withXlinks = embedXlinks(withSpans);

  // marked.parse processes the surrounding text as markdown; inline HTML
  // (our cloze spans) passes through unchanged in default (non-strict) mode.
  const md = marked.parse(withXlinks, { async: false }) as string;
  return sanitize(md);
}

function renderInline(text: string): string {
  if (!text) return '';
  // marked.parseInline does NOT wrap content in <p>.
  const html = marked.parseInline(text, { async: false }) as string;
  return sanitize(html);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}
