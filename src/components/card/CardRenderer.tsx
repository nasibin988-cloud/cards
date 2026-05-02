'use client';

import { memo, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Card, Note } from '@/lib/db/schema';
import { renderFront, renderBack, renderRichText } from '@/lib/cloze/parser';
import { getMediaUrl, resolveXlink, searchNotes, type SearchHit } from '@/lib/db/queries';
import OcclusionRenderer from './OcclusionRenderer';
import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui/Tooltip';

type Side = 'front' | 'back';

interface Props {
  note: Note;
  card: Card;
  side: Side;
  className?: string;
}

function CardRendererImpl({ note, card, side, className }: Props) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [xlinkPicker, setXlinkPicker] = useState<{ q: string; hits: SearchHit[] } | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  // Close the lightbox when the card flips, navigates away, or ESC is hit.
  useEffect(() => { setLightboxOpen(false); }, [note.id, card.id, side]);
  useEffect(() => {
    if (!lightboxOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setLightboxOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightboxOpen]);

  // Captured user input for {{type::}} clozes, keyed by data-type-id.
  // Persists across the front→back flip so we can diff on reveal.
  const typedRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    let cancelled = false;
    setImageUrl(null);
    if (note.fields.image) {
      getMediaUrl(note.fields.image).then(url => {
        if (!cancelled) setImageUrl(url);
      });
    }
    return () => { cancelled = true; };
  }, [note.fields.image]);

  // After a media-replace (e.g. via the per-deck Image Source sync), the
  // cached object URL is revoked; refetch so the new bytes render.
  useEffect(() => {
    const filename = note.fields.image;
    if (!filename) return;
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<{ filenames: string[] }>).detail;
      if (!detail?.filenames?.includes(filename)) return;
      getMediaUrl(filename).then(setImageUrl);
    };
    window.addEventListener('cards:media-changed', onChange as EventListener);
    return () => window.removeEventListener('cards:media-changed', onChange as EventListener);
  }, [note.fields.image]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // We stamp the original filename onto a data attribute so a later
    // media-change event can find this element and refresh its src.
    const imgs = el.querySelectorAll<HTMLImageElement>('img');
    imgs.forEach(async img => {
      const src = img.getAttribute('src');
      if (!src) return;
      if (/^(https?:|blob:|data:)/.test(src)) return;
      img.dataset.cardsMediaSrc = src;
      const url = await getMediaUrl(src);
      if (url) img.src = url;
    });
    const audios = el.querySelectorAll<HTMLAudioElement>('audio');
    audios.forEach(async audio => {
      const src = audio.getAttribute('src');
      if (!src) return;
      if (/^(https?:|blob:|data:)/.test(src)) return;
      audio.dataset.cardsMediaSrc = src;
      const url = await getMediaUrl(src);
      if (url) audio.src = url;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id, side]);

  // Refresh blob URLs in-DOM when their underlying media row was replaced.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onChange = async (e: Event) => {
      const detail = (e as CustomEvent<{ filenames: string[] }>).detail;
      const set = new Set(detail?.filenames ?? []);
      if (set.size === 0) return;
      const matches = el.querySelectorAll<HTMLImageElement | HTMLAudioElement>(
        '[data-cards-media-src]',
      );
      for (const node of Array.from(matches)) {
        const filename = node.dataset.cardsMediaSrc;
        if (!filename || !set.has(filename)) continue;
        const url = await getMediaUrl(filename);
        if (url) (node as HTMLImageElement | HTMLAudioElement).src = url;
      }
    };
    window.addEventListener('cards:media-changed', onChange as EventListener);
    return () => window.removeEventListener('cards:media-changed', onChange as EventListener);
  }, []);

  // Pre-resolve every [[query]] xlink on mount/side-change so broken links
  // visibly indicate themselves *before* the user clicks. Without this the
  // user reads the card not knowing which references actually go anywhere.
  // Resolutions run concurrently — a card with 10 xlinks would otherwise
  // take 10× the latency of a single search round-trip.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let cancelled = false;
    const links = Array.from(el.querySelectorAll<HTMLElement>('.card-xlink'));
    if (links.length === 0) return;
    Promise.all(links.map(async (link) => {
      const q = link.getAttribute('data-xlink-q');
      if (!q) return null;
      try {
        const r = await resolveXlink(q);
        return { link, q, r };
      } catch {
        return null; // never let xlink resolution break rendering.
      }
    })).then((results) => {
      if (cancelled) return;
      for (const item of results) {
        if (!item) continue;
        const { link, q, r } = item;
        link.classList.remove('card-xlink-unresolved', 'card-xlink-ambiguous');
        if (r.kind === 'broken-deleted-id') {
          link.classList.add('card-xlink-unresolved');
          link.setAttribute('title', `Broken link: target note (${q.slice(0, 8)}…) was deleted`);
        } else if (r.kind === 'broken-no-match') {
          link.classList.add('card-xlink-unresolved');
          link.setAttribute('title', `Broken link: no note matches "${q}"`);
        } else if (r.kind === 'ambiguous') {
          link.classList.add('card-xlink-ambiguous');
          link.setAttribute('title', `Ambiguous: ${r.matches} notes match "${q}" — click to choose`);
        } else {
          link.removeAttribute('title');
        }
      }
    });
    return () => { cancelled = true; };
  }, [note.id, side]);

  // Resolve [[query]] cross-card links at click time. We attach a single
  // delegated listener on the container rather than wiring per-element
  // because the HTML is rendered via dangerouslySetInnerHTML.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onClick = async (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const link = target.closest<HTMLElement>('.card-xlink');
      if (!link) return;
      e.preventDefault();
      e.stopPropagation();
      const q = link.getAttribute('data-xlink-q');
      if (!q) return;
      // ulid noteIds are 26 chars Crockford base32 — try direct match first.
      if (/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(q)) {
        router.push(`/note/${q}`);
        return;
      }
      const hits = await searchNotes(q, 8);
      if (hits.length === 0) {
        link.classList.add('card-xlink-unresolved');
        link.setAttribute('title', `No note matches "${q}"`);
        return;
      }
      if (hits.length === 1) {
        router.push(`/note/${hits[0].noteId}`);
        return;
      }
      setXlinkPicker({ q, hits });
    };
    el.addEventListener('click', onClick);
    return () => el.removeEventListener('click', onClick);
  }, [router, note.id, side]);

  // Reset captured type-cloze inputs whenever the underlying card changes.
  useEffect(() => {
    typedRef.current = new Map();
  }, [note.id, card.id]);

  // Delegated 'input' listener on the container: captures user keystrokes on
  // any <input class="type-cloze"> regardless of whether the listener
  // attached before or after the input mounted (Playwright fill races
  // with React's post-render effects). Survives side flips because the
  // container itself never unmounts.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onInput = (e: Event) => {
      const t = e.target as HTMLInputElement | null;
      if (!t || !t.classList || !t.classList.contains('type-cloze')) return;
      const id = t.getAttribute('data-type-id');
      if (id) typedRef.current.set(id, t.value);
    };
    el.addEventListener('input', onInput);
    return () => el.removeEventListener('input', onInput);
  }, [note.id, card.id]);

  // After the DOM updates, wire type-clozes:
  //   - on front: rehydrate input values from prior side-flips, focus first
  //   - on back:  fill .type-cloze-result spans with diff display
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (side === 'front') {
      const inputs = el.querySelectorAll<HTMLInputElement>('input.type-cloze');
      inputs.forEach((input, i) => {
        const id = input.getAttribute('data-type-id') ?? '';
        const prev = typedRef.current.get(id);
        if (prev !== undefined) input.value = prev;
        if (i === 0 && !prev) {
          setTimeout(() => input.focus(), 0);
        }
      });
      return;
    }
    const spans = el.querySelectorAll<HTMLElement>('span.type-cloze-result');
    spans.forEach(span => {
      const id = span.getAttribute('data-type-id') ?? '';
      const expected = span.getAttribute('data-type-answer') ?? '';
      const typed = typedRef.current.get(id) ?? '';
      span.innerHTML = renderTypeDiff(typed, expected);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side, note.id, card.id, note.fields.front]);

  const ord = card.clozeOrd ?? 1;
  const isCloze = note.modelId === 'cloze';
  const isOcclusion = note.modelId === 'image-occlusion';

  if (isOcclusion) {
    return (
      <>
        <div ref={containerRef} className={cn('flex flex-col items-center gap-4', className)}>
          <OcclusionRenderer note={note} card={card} side={side} />
          {side === 'back' && hasExtraContent(note) && (
            <div className="w-full space-y-4 pt-4 border-t border-white/[0.05]">
              {note.fields.extra && (
                <BackBlock label="Extra" variant="extra" html={renderRichText(note.fields.extra)} />
              )}
              {note.fields.context && (
                <BackBlock label="Context" variant="context" html={renderRichText(note.fields.context)} />
              )}
              <Meta note={note} />
            </div>
          )}
        </div>
        <XlinkPicker
          state={xlinkPicker}
          onClose={() => setXlinkPicker(null)}
          onPick={hit => { setXlinkPicker(null); router.push(`/note/${hit.noteId}`); }}
        />
      </>
    );
  }

  // Sibling resolution: a card may point at a specific sibling on this note
  // (e.g. front→back vs back→front). When set, override which fields render.
  const sibling = card.siblingId
    ? note.siblings?.find(s => s.id === card.siblingId)
    : undefined;

  let frontHtml: string;
  let backHtml: string;
  if (isCloze) {
    // renderFront/renderBack already produce safe final HTML; do NOT re-pipe
    // through renderRichText or the cloze <span>s would be re-escaped.
    frontHtml = renderFront(note.fields.front, ord);
    backHtml = renderBack(note.fields.front, ord);
  } else if (sibling) {
    frontHtml = renderRichText(note.fields[sibling.frontField] ?? '');
    backHtml = renderRichText(note.fields[sibling.backField] ?? '');
  } else {
    frontHtml = renderRichText(note.fields.front);
    backHtml = renderRichText(note.fields.back);
  }

  // For cloze cards, the front field doubles as the back (with the cloze
  // revealed), so the separate `back` field is shown as additional context.
  // For basic cards the heading IS the back, so we don't repeat it.
  const showBackField = side === 'back' && isCloze && note.fields.back;

  return (
    <>
      <div ref={containerRef} className={cn('card-prose space-y-4', className)}>
        <div
          className="text-xl md:text-2xl font-extralight leading-snug tracking-tight"
          dangerouslySetInnerHTML={{ __html: side === 'front' ? frontHtml : backHtml }}
        />
        {/* Image renders on the BACK only — keep the front prose clean.
            Compact thumb (max-h-40 ≈ 160px) so the back's text + Why blocks
            don't get pushed out of view. Click → fullscreen lightbox.
            If a card genuinely needs the image on the front, the deck
            author can inline an <img> tag directly in the cloze field. */}
        {imageUrl && side === 'back' && (
          <div className="flex justify-center">
            <button
              type="button"
              onClick={() => setLightboxOpen(true)}
              className="group relative rounded-xl overflow-hidden focus-visible:outline-2 focus-visible:outline-saffron-400/70 focus-visible:outline-offset-2 transition"
              aria-label="Enlarge image"
            >
              <img
                src={imageUrl}
                alt=""
                className="rounded-xl max-h-40 object-contain transition group-hover:opacity-90"
              />
              <span
                aria-hidden
                className="absolute bottom-1.5 right-1.5 text-2xs font-mono uppercase tracking-widest text-dark-100/90 bg-dark-950/60 backdrop-blur-sm px-1.5 py-0.5 rounded opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition"
              >
                ⤢
              </span>
            </button>
          </div>
        )}
        {side === 'back' && (showBackField || hasExtraContent(note)) && (
          <div className="space-y-4 pt-4 border-t border-white/[0.05]">
            {showBackField && note.fields.back && (
              <BackBlock variant="back" html={renderRichText(note.fields.back)} />
            )}
            {note.fields.extra && (
              <BackBlock label="Extra" variant="extra" html={renderRichText(note.fields.extra)} />
            )}
            {note.fields.mnemonic && (
              <BackBlock label="Mnemonic" variant="mnemonic" html={renderRichText(note.fields.mnemonic)} />
            )}
            {note.fields.context && (
              <BackBlock label="Context" variant="context" html={renderRichText(note.fields.context)} />
            )}
            <Meta note={note} />
          </div>
        )}
      </div>
      <XlinkPicker
        state={xlinkPicker}
        onClose={() => setXlinkPicker(null)}
        onPick={hit => { setXlinkPicker(null); router.push(`/note/${hit.noteId}`); }}
      />
      {imageUrl && lightboxOpen && (
        <ImageLightbox src={imageUrl} onClose={() => setLightboxOpen(false)} />
      )}
    </>
  );
}

function ImageLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Image preview"
      className="fixed inset-0 z-[60] flex items-center justify-center p-6 bg-dark-950/80 backdrop-blur-sm animate-fade-in cursor-zoom-out"
      onClick={onClose}
    >
      <img
        src={src}
        alt=""
        className="max-w-[92vw] max-h-[92vh] object-contain rounded-xl shadow-glass-lg"
        onClick={e => e.stopPropagation()}
      />
      <button
        type="button"
        onClick={onClose}
        aria-label="Close image preview"
        className="absolute top-4 right-4 text-2xs uppercase tracking-[0.2em] font-light text-dark-200 hover:text-dark-50 hover:bg-white/[0.06] px-3 py-1.5 rounded-lg border border-white/[0.08] transition"
      >
        Close · Esc
      </button>
    </div>
  );
}

/**
 * Memoize on the props that drive the rendered output. Reviewer state
 * (timer, prefetch flag, modal toggles) doesn't reach into here; without
 * memo, every parent re-render runs the renderer's effect chain again.
 *
 * `note` and `card` are object refs from Dexie reads — `===` works as
 * long as the parent doesn't reconstruct them. Reviewer caches them in
 * its own state, so the identity is stable across non-card parent renders.
 */
const CardRenderer = memo(CardRendererImpl, (prev, next) => (
  prev.note === next.note
  && prev.card === next.card
  && prev.side === next.side
  && prev.className === next.className
));
CardRenderer.displayName = 'CardRenderer';
export default CardRenderer;

function XlinkPicker({
  state, onClose, onPick,
}: {
  state: { q: string; hits: SearchHit[] } | null;
  onClose: () => void;
  onPick: (hit: SearchHit) => void;
}) {
  if (!state) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-24 px-4 bg-dark-950/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="glass-card rounded-2xl w-full max-w-lg max-h-[60vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-white/[0.04] flex items-center justify-between">
          <div>
            <div className="text-2xs uppercase tracking-widest text-dark-500">Multiple matches</div>
            <div className="text-sm font-light text-dark-100 mt-0.5 truncate">{state.q}</div>
          </div>
          <button
            onClick={onClose}
            className="text-2xs uppercase tracking-[0.2em] font-light text-dark-400 hover:text-dark-100 transition px-2 py-1 rounded-lg hover:bg-white/[0.04]"
          >
            Close
          </button>
        </div>
        <ul>
          {state.hits.map(hit => (
            <li key={hit.noteId}>
              <button
                onClick={() => onPick(hit)}
                className="w-full text-left px-5 py-3 hover:bg-white/[0.03] transition border-b border-white/[0.03] last:border-b-0"
              >
                <div className="text-sm text-dark-100 font-light line-clamp-2">{hit.snippet || '(no front text)'}</div>
                <div className="text-2xs text-dark-500 mt-0.5">{hit.deckName}</div>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function hasExtraContent(note: Note): boolean {
  return !!(
    note.fields.extra ||
    note.fields.mnemonic ||
    note.fields.context ||
    note.fields.source ||
    note.tags.length > 0
  );
}

/**
 * Back-side blocks with a deliberate visual hierarchy.
 *
 *   Front     — brightest hero (rendered above this component, dark-50, font-extralight 2xl)
 *   Back      — primary supporting fact, dark-100, no label needed
 *   Extra     — deeper "why" / mechanism, dark-200 (dimmer)
 *   Mnemonic  — saffron tint + italic, treated as a memory aid accent
 *   Context   — persian tint, smallest, single-line topic
 *
 * Labels follow the same hue family as their content so the eye can chunk
 * sections without reading.
 */
type BackVariant = 'back' | 'extra' | 'mnemonic' | 'context';

const VARIANT: Record<BackVariant, { body: string; label: string }> = {
  back: {
    body: 'text-sm md:text-base leading-relaxed font-light text-dark-100',
    label: '',
  },
  extra: {
    body: 'text-sm md:text-[0.95rem] leading-relaxed font-light text-dark-200',
    label: 'text-2xs uppercase tracking-widest text-dark-500 mb-1.5 leading-none',
  },
  mnemonic: {
    body: 'text-sm md:text-[0.95rem] leading-relaxed font-light text-saffron-200/90 italic',
    label: 'text-2xs uppercase tracking-widest text-saffron-400/80 mb-1.5 leading-none',
  },
  context: {
    body: 'text-sm leading-relaxed font-light text-persian-200/80',
    label: 'text-2xs uppercase tracking-widest text-persian-400/80 mb-1.5 leading-none',
  },
};

function BackBlock({
  label,
  variant,
  html,
}: {
  label?: string;
  variant: BackVariant;
  html: string;
}) {
  const v = VARIANT[variant];
  return (
    <div>
      {label && <div className={v.label}>{label}</div>}
      <div
        className={`${v.body} back-prose`}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

/**
 * Tag chips, with the noisy deck-breadcrumb tag filtered out and the rest
 * grouped by semantic kind:
 *
 *   HY::*    → bright saffron pill (high-yield flag, attention-getting)
 *   skill::* → persian pill
 *   xref::*  → cross-reference, dim ghost pill with arrow
 *   other    → small neutral pill
 *
 * The breadcrumb tag (core::PS::behavsci::…::prefrontal-cortex) and the
 * authored source field are both already covered by the deck name in the
 * study header, so neither gets a row here.
 */
function Meta({ note }: { note: Note }) {
  const visible = filterTags(note.tags);
  if (visible.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 pt-1">
      {visible.map(t => (
        <TagChip key={t.raw} tag={t} />
      ))}
    </div>
  );
}

interface ParsedTag {
  raw: string;
  kind: 'hy' | 'skill' | 'xref' | 'other';
  label: string;
}

const TIER_PREFIXES = new Set([
  'core', 'clinical', 'advanced', 'bridge',
  'standard', 'extended', 'scholarly',
]);

function filterTags(tags: string[]): ParsedTag[] {
  return tags
    .map(t => parseTag(t))
    .filter((t): t is ParsedTag => t !== null);
}

function parseTag(raw: string): ParsedTag | null {
  const segs = raw.split('::');
  const head = segs[0]?.toLowerCase() ?? '';

  // Drop the deck breadcrumb tag — duplicated by the deck name + source line.
  if (TIER_PREFIXES.has(head) && segs.length >= 3) return null;

  if (head === 'hy') {
    return { raw, kind: 'hy', label: segs.slice(1).join(' ') || 'flagged' };
  }
  if (head === 'skill') {
    return { raw, kind: 'skill', label: segs.slice(1).join(' ') || raw };
  }
  if (head === 'xref') {
    // xref::BB::bio::ch04_nervous_system::prefrontal-cortex
    //   → BB · bio · ch04 nervous system · prefrontal-cortex
    const tail = segs.slice(1).map(s => s.replace(/_/g, ' '));
    return { raw, kind: 'xref', label: tail.join(' · ') };
  }
  return { raw, kind: 'other', label: raw.replace(/_/g, ' ') };
}

function TagChip({ tag }: { tag: ParsedTag }) {
  const cls = (() => {
    switch (tag.kind) {
      case 'hy':
        return 'text-saffron-200 bg-saffron-900/30 border border-saffron-800/40';
      case 'skill':
        return 'text-persian-200 bg-persian-900/25 border border-persian-800/30';
      case 'xref':
        return 'text-dark-300 bg-dark-800/40 border border-white/[0.04]';
      default:
        return 'text-dark-400 bg-dark-800/30 border border-white/[0.03]';
    }
  })();
  const prefix = tag.kind === 'xref' ? '↗ ' : '';
  const labelPrefix = tag.kind === 'hy' ? 'HY · ' : tag.kind === 'skill' ? '' : '';
  return (
    <Tooltip content={tag.raw === `${prefix}${labelPrefix}${tag.label}` ? null : tag.raw}>
      <span
        className={cn(
          'text-2xs uppercase tracking-widest font-mono px-2 py-0.5 rounded',
          cls,
        )}
      >
        {prefix}{labelPrefix}{tag.label}
      </span>
    </Tooltip>
  );
}



function renderTypeDiff(typed: string, expected: string): string {
  if (!typed) {
    return `<span class="type-cloze-empty">—</span> <span class="type-cloze-expected">${escapeHtml(expected)}</span>`;
  }
  const diff = charDiff(typed, expected);
  const typedHtml = diff.typedSegments
    .map(seg => seg.match
      ? `<span class="type-cloze-match">${escapeHtml(seg.text)}</span>`
      : `<span class="type-cloze-miss">${escapeHtml(seg.text)}</span>`)
    .join("");
  const exact = typed.trim().toLowerCase() === expected.trim().toLowerCase();
  if (exact) {
    return `<span class="type-cloze-correct">${typedHtml}</span>`;
  }
  return `${typedHtml} <span class="type-cloze-arrow">→</span> <span class="type-cloze-expected">${escapeHtml(expected)}</span>`;
}

interface DiffSeg { text: string; match: boolean }

/**
 * Character-level diff using the longest-common-subsequence backtrace. Returns
 * the typed string broken into runs that either match or mismatch the
 * expected. Case-insensitive comparison; original casing is preserved in the
 * output.
 */
function charDiff(typed: string, expected: string): { typedSegments: DiffSeg[] } {
  const a = typed.toLowerCase();
  const b = expected.toLowerCase();
  const m = a.length, n = b.length;
  // LCS DP table.
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  // Walk: for each typed char, mark match if it consumes a b-char.
  const segs: DiffSeg[] = [];
  let i = 0, j = 0;
  let curText = "";
  let curMatch: boolean | null = null;
  const push = (text: string, match: boolean) => {
    if (curMatch === match) curText += text;
    else {
      if (curText) segs.push({ text: curText, match: !!curMatch });
      curText = text;
      curMatch = match;
    }
  };
  while (i < m) {
    if (j < n && a[i] === b[j]) {
      push(typed[i], true);
      i++; j++;
    } else if (j < n && dp[i + 1][j] >= dp[i][j + 1]) {
      push(typed[i], false);
      i++;
    } else if (j < n) {
      // Skip an expected char (no typed equivalent at this position).
      j++;
    } else {
      push(typed[i], false);
      i++;
    }
  }
  if (curText) segs.push({ text: curText, match: !!curMatch });
  return { typedSegments: segs };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
