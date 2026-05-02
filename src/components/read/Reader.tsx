'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  addHighlight,
  getSource,
  listHighlights,
  promoteHighlightToNote,
  removeHighlight,
  updateSourceProgress,
} from '@/lib/db/queries';
import type { Highlight, Source } from '@/lib/db/schema';
import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui/Tooltip';

/**
 * Long-form reader with selection-to-cloze. The body is rendered into a
 * single `<pre>` with character-offset awareness: when the user selects
 * text, we read window.getSelection() and convert the range to absolute
 * offsets via the textContent of the rendered tree (which is identical to
 * source.body since we render it verbatim).
 *
 * Highlights persist as overlay spans rebuilt on every render. Promoting
 * a highlight to a card calls `promoteHighlightToNote` which generates a
 * cloze note in the source's auto-deck.
 */
export default function Reader({ sourceId }: { sourceId: string }) {
  const [source, setSource] = useState<Source | null | undefined>(undefined);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [selection, setSelection] = useState<{ start: number; end: number; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const bodyRef = useRef<HTMLPreElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [s, h] = await Promise.all([getSource(sourceId), listHighlights(sourceId)]);
      if (!alive) return;
      setSource(s ?? null);
      setHighlights(h);
    })();
    return () => { alive = false; };
  }, [sourceId]);

  // Restore scroll position on mount and persist on scroll/unmount.
  useEffect(() => {
    if (!source || !scrollRef.current) return;
    const el = scrollRef.current;
    const persist = () => {
      const max = el.scrollHeight - el.clientHeight;
      const p = max > 0 ? el.scrollTop / max : 0;
      void updateSourceProgress(sourceId, p);
    };
    // Restore.
    const max = el.scrollHeight - el.clientHeight;
    el.scrollTop = source.progress * max;
    let timer: number | null = null;
    const onScroll = () => {
      if (timer !== null) clearTimeout(timer);
      timer = window.setTimeout(persist, 500);
    };
    el.addEventListener('scroll', onScroll);
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (timer !== null) clearTimeout(timer);
      persist();
    };
  }, [source, sourceId]);

  const onMouseUp = useCallback(() => {
    if (!bodyRef.current || !source) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      setSelection(null);
      return;
    }
    const range = sel.getRangeAt(0);
    if (!bodyRef.current.contains(range.commonAncestorContainer)) {
      setSelection(null);
      return;
    }
    // Compute character offsets relative to the body element. The body is
    // rendered as a single text node tree mirroring `source.body`, so a
    // pre-order text-length walk gives us absolute offsets.
    const start = textOffsetWithin(bodyRef.current, range.startContainer, range.startOffset);
    const end = textOffsetWithin(bodyRef.current, range.endContainer, range.endOffset);
    if (start === null || end === null || start === end) {
      setSelection(null);
      return;
    }
    const [lo, hi] = start < end ? [start, end] : [end, start];
    const text = source.body.slice(lo, hi).trim();
    if (!text) {
      setSelection(null);
      return;
    }
    setSelection({ start: lo, end: hi, text });
  }, [source]);

  const saveHighlight = async () => {
    if (!selection) return;
    setBusy('save');
    try {
      const h = await addHighlight({ sourceId, ...selection });
      setHighlights(prev => [...prev, h].sort((a, b) => a.start - b.start));
      setSelection(null);
      window.getSelection()?.removeAllRanges();
    } finally {
      setBusy(null);
    }
  };

  const makeCloze = async () => {
    if (!selection) return;
    setBusy('cloze');
    try {
      const h = await addHighlight({ sourceId, ...selection });
      const noteId = await promoteHighlightToNote(h.id);
      const updated = await listHighlights(sourceId);
      setHighlights(updated);
      setSelection(null);
      window.getSelection()?.removeAllRanges();
      if (noteId) {
        setFlash('Saved as cloze.');
        setTimeout(() => setFlash(null), 1800);
      }
    } finally {
      setBusy(null);
    }
  };

  const promoteExisting = async (highlightId: string) => {
    setBusy(highlightId);
    try {
      const noteId = await promoteHighlightToNote(highlightId);
      if (noteId) {
        const updated = await listHighlights(sourceId);
        setHighlights(updated);
        setFlash('Saved as cloze.');
        setTimeout(() => setFlash(null), 1800);
      }
    } finally {
      setBusy(null);
    }
  };

  const dropHighlight = async (highlightId: string) => {
    await removeHighlight(highlightId);
    setHighlights(prev => prev.filter(h => h.id !== highlightId));
  };

  if (source === undefined) {
    return <div className="max-w-4xl mx-auto px-6 py-10 text-dark-400">Loading…</div>;
  }
  if (!source) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-10">
        <p className="text-dark-300">Source not found.</p>
        <Link href="/read" className="text-saffron-300 underline">← Back to reading</Link>
      </div>
    );
  }

  const segments = renderSegments(source.body, highlights);

  return (
    <div className="max-w-5xl mx-auto px-6 py-8 grid grid-cols-1 md:grid-cols-[1fr_18rem] gap-6">
      <div className="min-w-0">
        <div className="flex items-baseline justify-between gap-3 mb-3">
          <h1 className="text-3xl md:text-4xl font-extralight tracking-tight bg-gradient-to-r from-saffron-300 to-persian-300 bg-clip-text text-transparent">
            {source.title}
          </h1>
          <Link href="/read" className="text-2xs uppercase tracking-widest text-dark-400 hover:text-dark-100 transition">
            ← Sources
          </Link>
        </div>

        <div
          ref={scrollRef}
          className="glass-card rounded-2xl p-6 max-h-[75vh] overflow-y-auto"
        >
          <pre
            ref={bodyRef}
            onMouseUp={onMouseUp}
            className="whitespace-pre-wrap break-words text-sm leading-relaxed text-dark-100 font-light selection:bg-saffron-500/30"
          >
            {segments.map((seg, i) =>
              seg.kind === 'text' ? (
                <span key={i}>{seg.text}</span>
              ) : (
                <Tooltip key={i} content={seg.highlight.noteId ? 'Promoted to a card' : 'Highlighted'}>
                  <mark
                    className={cn(
                      'rounded px-0.5 transition',
                      seg.highlight.noteId
                        ? 'bg-persian-900/40 text-saffron-200 underline decoration-saffron-500/40'
                        : 'bg-saffron-500/15 text-saffron-200',
                    )}
                  >
                    {seg.text}
                  </mark>
                </Tooltip>
              ),
            )}
          </pre>
        </div>

        {selection && (
          <div className="mt-3 glass-card rounded-2xl p-3 flex items-center justify-between gap-3">
            <Tooltip content={selection.text.length > 80 ? selection.text : null}>
              <span className="text-xs text-dark-300 font-light truncate max-w-[28rem]">
                <span className="text-dark-500">Selection:</span> "{selection.text.length > 80 ? selection.text.slice(0, 80) + '…' : selection.text}"
              </span>
            </Tooltip>
            <div className="flex gap-2 shrink-0">
              <button
                onClick={makeCloze}
                disabled={busy !== null}
                className="btn-gradient px-3 py-1.5 rounded-lg text-2xs uppercase tracking-[0.2em] font-light"
              >
                {busy === 'cloze' ? 'Saving…' : 'Make cloze'}
              </button>
              <button
                onClick={saveHighlight}
                disabled={busy !== null}
                className="px-3 py-1.5 rounded-lg text-2xs uppercase tracking-[0.2em] font-light text-dark-200 hover:text-dark-50 hover:bg-white/[0.04] transition border border-white/[0.06]"
              >
                {busy === 'save' ? 'Saving…' : 'Highlight only'}
              </button>
            </div>
          </div>
        )}
        {flash && (
          <div className="mt-2 text-2xs uppercase tracking-widest text-saffron-300 font-mono">{flash}</div>
        )}
      </div>

      <aside className="space-y-3">
        <div className="text-2xs uppercase tracking-widest text-dark-500">
          Highlights · {highlights.length}
        </div>
        {highlights.length === 0 ? (
          <div className="glass-card rounded-2xl p-4 text-2xs text-dark-400 font-light">
            Select text in the body to highlight or make a cloze card.
          </div>
        ) : (
          <div className="glass-card rounded-2xl divide-y divide-white/[0.04]">
            {highlights.map(h => (
              <HighlightRow
                key={h.id}
                highlight={h}
                busy={busy === h.id}
                onPromote={() => promoteExisting(h.id)}
                onRemove={() => dropHighlight(h.id)}
              />
            ))}
          </div>
        )}
        <Link
          href={`/study/${source.deckId}`}
          className="block btn-gradient px-4 py-2 rounded-xl text-2xs uppercase tracking-[0.2em] font-light text-center"
        >
          Study these cards
        </Link>
      </aside>
    </div>
  );
}

function HighlightRow({
  highlight, busy, onPromote, onRemove,
}: {
  highlight: Highlight;
  busy: boolean;
  onPromote: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="px-3 py-2.5 space-y-1.5">
      <div className="text-xs text-dark-100 font-light line-clamp-3">
        "{highlight.text}"
      </div>
      <div className="flex items-center gap-2">
        {highlight.noteId ? (
          <Link
            href={`/note/${highlight.noteId}`}
            className="text-2xs uppercase tracking-widest text-saffron-300 hover:text-saffron-200 transition"
          >
            Open card
          </Link>
        ) : (
          <button
            onClick={onPromote}
            disabled={busy}
            className="text-2xs uppercase tracking-widest text-saffron-300 hover:text-saffron-200 transition disabled:opacity-40"
          >
            {busy ? '…' : 'Make cloze'}
          </button>
        )}
        <button
          onClick={onRemove}
          className="text-2xs uppercase tracking-widest text-dark-500 hover:text-crimson-300 transition"
        >
          Remove
        </button>
      </div>
    </div>
  );
}

/** Segment a body string into text + highlight runs. Highlights mustn't overlap. */
function renderSegments(
  body: string,
  highlights: Highlight[],
): Array<{ kind: 'text'; text: string } | { kind: 'highlight'; text: string; highlight: Highlight }> {
  if (highlights.length === 0) return [{ kind: 'text', text: body }];
  const sorted = [...highlights].sort((a, b) => a.start - b.start);
  const out: ReturnType<typeof renderSegments> = [];
  let cursor = 0;
  for (const h of sorted) {
    if (h.start < cursor) continue; // skip overlap
    if (h.start > cursor) {
      out.push({ kind: 'text', text: body.slice(cursor, h.start) });
    }
    out.push({ kind: 'highlight', text: body.slice(h.start, h.end), highlight: h });
    cursor = h.end;
  }
  if (cursor < body.length) out.push({ kind: 'text', text: body.slice(cursor) });
  return out;
}

/**
 * Compute the absolute character offset of (node, offset) within `root`,
 * walking the DOM in document order and accumulating text-node lengths.
 * Returns null if the node isn't actually inside the root.
 */
function textOffsetWithin(root: Node, node: Node, offset: number): number | null {
  let total = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let cur: Node | null = walker.currentNode;
  // Walker starts at root; advance to first text node.
  cur = walker.nextNode();
  while (cur) {
    if (cur === node) return total + offset;
    if (cur.nodeType === Node.TEXT_NODE) total += (cur.textContent ?? '').length;
    cur = walker.nextNode();
  }
  // The selection might land on a non-text container (e.g. a <mark>) when
  // the user double-clicks across one. Fall back to the container's start.
  if (root.contains(node)) {
    const w2 = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let acc = 0;
    let n = w2.nextNode();
    while (n) {
      if (node.contains(n)) return acc;
      acc += (n.textContent ?? '').length;
      n = w2.nextNode();
    }
  }
  return null;
}
