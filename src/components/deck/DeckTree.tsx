'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  listDecks,
  getDeckCounts,
  dueForecast,
  deckRetentionWindow,
  type DeckCounts,
} from '@/lib/db/queries';
import type { Deck } from '@/lib/db/schema';
import { buildDeckTree, type DeckNode } from '@/lib/decks/tree';
import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui/Tooltip';

interface SummedCounts extends DeckCounts {
  haveData: boolean;
}

interface DeckExtras {
  /** 7-element array of due cards per day starting today. */
  forecast: number[];
  /** 30-day rolling retention {0..1}, or null if too few reviews. */
  retention: number | null;
  /** Number of reviews backing the retention figure. */
  retentionN: number;
}

const ZERO: SummedCounts = { new: 0, learning: 0, review: 0, total: 0, haveData: false };
const EMPTY_EXTRAS: DeckExtras = { forecast: [0, 0, 0, 0, 0, 0, 0], retention: null, retentionN: 0 };

export default function DeckTree() {
  const [decks, setDecks] = useState<Deck[] | null>(null);
  const [counts, setCounts] = useState<Map<string, DeckCounts>>(new Map());
  const [extras, setExtras] = useState<Map<string, DeckExtras>>(new Map());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => {
    listDecks().then(async list => {
      setDecks(list);
      const countMap = new Map<string, DeckCounts>();
      await Promise.all(list.map(async d => {
        countMap.set(d.id, await getDeckCounts(d.id));
      }));
      setCounts(countMap);

      // Fire-and-progressive: forecast + retention per deck. They populate as
      // promises resolve so the count UI doesn't block on these.
      const extraMap = new Map<string, DeckExtras>();
      await Promise.all(list.map(async d => {
        const [forecast, ret] = await Promise.all([
          dueForecast(d.id, 7),
          deckRetentionWindow(d.id, 30),
        ]);
        extraMap.set(d.id, {
          forecast,
          retention: ret.total >= 5 ? ret.rate : null,
          retentionN: ret.total,
        });
      }));
      setExtras(extraMap);
    });
  }, []);

  // Hooks before any early return — rules-of-hooks. `decks` may be null
  // during initial load; we still build the tree (empty array fallback)
  // so the hook order stays stable across renders.
  const tree = useMemo(() => buildDeckTree(decks ?? []), [decks]);
  const sumByPath = useMemo(() => buildSumMap(tree, counts), [tree, counts]);
  const extrasByPath = useMemo(() => buildExtrasMap(tree, extras), [tree, extras]);

  if (decks === null) {
    return (
      <div className="space-y-4">
        {[0, 1].map(i => (
          <div key={i} className="glass-card rounded-3xl h-44 loading-shimmer" />
        ))}
      </div>
    );
  }

  if (decks.length === 0) {
    return (
      <div className="glass-card rounded-3xl p-10 text-center space-y-4">
        <h2 className="text-2xl font-extralight tracking-tight bg-gradient-to-r from-saffron-300 to-persian-300 bg-clip-text text-transparent">
          No decks yet
        </h2>
        <p className="text-dark-300 font-light max-w-md mx-auto">
          Create your first deck or import an existing Anki <code className="text-saffron-300">.apkg</code> file.
        </p>
        <div className="flex gap-3 justify-center pt-2">
          <Link href="/decks/new" className="btn-gradient px-5 py-2 rounded-xl text-sm">
            New deck
          </Link>
          <Link
            href="/import"
            className="px-5 py-2 rounded-xl text-sm text-dark-200 hover:text-dark-50 hover:bg-white/[0.04] transition border border-white/[0.06]"
          >
            Import .apkg
          </Link>
        </div>
      </div>
    );
  }

  const toggle = (path: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      {tree.map(node => (
        <DeckSection
          key={node.fullPath}
          node={node}
          counts={counts}
          extras={extras}
          sumByPath={sumByPath}
          extrasByPath={extrasByPath}
          collapsed={collapsed}
          onToggle={toggle}
        />
      ))}
    </div>
  );
}

/** Bottom-up traversal that fills `fullPath → SummedCounts` in O(N). */
function buildSumMap(
  tree: DeckNode[],
  counts: Map<string, DeckCounts>,
): Map<string, SummedCounts> {
  const out = new Map<string, SummedCounts>();
  function walk(node: DeckNode): SummedCounts {
    let acc: SummedCounts = { ...ZERO };
    if (node.deck) {
      const c = counts.get(node.deck.id);
      if (c) {
        acc = { new: c.new, learning: c.learning, review: c.review, total: c.total, haveData: true };
      }
    }
    for (const child of node.children) {
      const s = walk(child);
      acc.new += s.new;
      acc.learning += s.learning;
      acc.review += s.review;
      acc.total += s.total;
      acc.haveData = acc.haveData || s.haveData;
    }
    out.set(node.fullPath, acc);
    return acc;
  }
  for (const root of tree) walk(root);
  return out;
}

/** Bottom-up traversal that fills `fullPath → DeckExtras` in O(N). */
function buildExtrasMap(
  tree: DeckNode[],
  extras: Map<string, DeckExtras>,
): Map<string, DeckExtras> {
  const out = new Map<string, DeckExtras>();
  function walk(node: DeckNode): DeckExtras {
    const forecast = [0, 0, 0, 0, 0, 0, 0];
    let weightedSum = 0;
    let totalReviews = 0;
    if (node.deck) {
      const e = extras.get(node.deck.id);
      if (e) {
        for (let i = 0; i < 7; i++) forecast[i] += e.forecast[i] ?? 0;
        if (e.retention !== null) {
          weightedSum += e.retention * e.retentionN;
          totalReviews += e.retentionN;
        }
      }
    }
    for (const child of node.children) {
      const cExtras = walk(child);
      for (let i = 0; i < 7; i++) forecast[i] += cExtras.forecast[i] ?? 0;
      if (cExtras.retention !== null) {
        weightedSum += cExtras.retention * cExtras.retentionN;
        totalReviews += cExtras.retentionN;
      }
    }
    const result: DeckExtras = {
      forecast,
      retention: totalReviews >= 5 ? weightedSum / totalReviews : null,
      retentionN: totalReviews,
    };
    out.set(node.fullPath, result);
    return result;
  }
  for (const root of tree) walk(root);
  return out;
}

function DeckSection({
  node, counts, extras, sumByPath, extrasByPath, collapsed, onToggle,
}: {
  node: DeckNode;
  counts: Map<string, DeckCounts>;
  extras: Map<string, DeckExtras>;
  sumByPath: Map<string, SummedCounts>;
  extrasByPath: Map<string, DeckExtras>;
  collapsed: Set<string>;
  onToggle: (path: string) => void;
}) {
  const sum = sumByPath.get(node.fullPath) ?? ZERO;
  const sumExtras = extrasByPath.get(node.fullPath) ?? EMPTY_EXTRAS;
  const due = sum.new + sum.learning + sum.review;
  const isCollapsed = collapsed.has(node.fullPath);
  const hasChildren = node.children.length > 0;

  // Top-level leaf (a flat deck without children) renders as a tidy
  // single-row card so flat decks coexist with hierarchical ones.
  // Click goes to the deck-detail page (/deck/[id]) for management; the
  // detail page has a prominent Study button as the primary action.
  if (!hasChildren && node.deck) {
    return (
      <div className="glass-card glass-card-hover rounded-3xl px-4 md:px-6 py-4 md:py-5 relative">
        <Link
          href={`/deck/${node.deck.id}`}
          className="absolute inset-0 rounded-3xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-persian-400"
          aria-label={`Open ${node.displayName}`}
        />
        <div className="flex items-center justify-between gap-3 md:gap-4">
          <h2 className="flex-1 text-xl md:text-2xl font-extralight tracking-tight bg-gradient-to-r from-saffron-300 to-persian-300 bg-clip-text text-transparent truncate">
            {node.displayName}
          </h2>
          <DeckIndicators extras={sumExtras} />
          <CountChips sum={sum} due={due} />
        </div>
      </div>
    );
  }

  // Section with children: chevron toggles, the rest of the row navigates
  // to /deck/[id] when there's a real deck behind this node. Pure path-only
  // intermediates (no `node.deck`) fall back to toggle on title click since
  // there's nothing to open.
  return (
    <section className="glass-card rounded-3xl overflow-hidden">
      <div className="w-full flex items-center gap-3 md:gap-4 px-4 md:px-6 py-4 md:py-5">
        <button
          type="button"
          onClick={() => onToggle(node.fullPath)}
          className="shrink-0 -m-2 p-2 rounded-md hover:bg-white/[0.04] transition"
          aria-expanded={!isCollapsed}
          aria-label={isCollapsed ? `Expand ${node.displayName}` : `Collapse ${node.displayName}`}
        >
          <Chevron open={!isCollapsed} tone="bright" />
        </button>
        <Link
          href={node.deck ? `/deck/${node.deck.id}` : `/decks/path/${encodeURIComponent(node.fullPath)}`}
          className="flex-1 min-w-0 flex items-center gap-3 md:gap-4 text-left hover:bg-white/[0.02] transition rounded-xl -mx-2 px-2 -my-2 py-2"
          aria-label={`Open ${node.displayName}`}
        >
          <h2 className="flex-1 text-xl md:text-2xl font-extralight tracking-tight bg-gradient-to-r from-saffron-300 to-persian-300 bg-clip-text text-transparent truncate">
            {node.displayName}
          </h2>
          <DeckIndicators extras={sumExtras} dim={isCollapsed} />
          <CountChips sum={sum} due={due} dim={isCollapsed} />
        </Link>
      </div>
      {!isCollapsed && (
        <div className="border-t border-white/[0.04] py-1.5">
          {node.children.map(child => (
            <DeckRow
              key={child.fullPath}
              node={child}
              depth={1}
              counts={counts}
              extras={extras}
              sumByPath={sumByPath}
              extrasByPath={extrasByPath}
              collapsed={collapsed}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function DeckRow({
  node, depth, counts, extras, sumByPath, extrasByPath, collapsed, onToggle,
}: {
  node: DeckNode;
  depth: number;
  counts: Map<string, DeckCounts>;
  extras: Map<string, DeckExtras>;
  sumByPath: Map<string, SummedCounts>;
  extrasByPath: Map<string, DeckExtras>;
  collapsed: Set<string>;
  onToggle: (path: string) => void;
}) {
  const sum = sumByPath.get(node.fullPath) ?? ZERO;
  const sumExtras = extrasByPath.get(node.fullPath) ?? EMPTY_EXTRAS;
  const due = sum.new + sum.learning + sum.review;
  const isCollapsed = collapsed.has(node.fullPath);
  const hasChildren = node.children.length > 0;
  const isLeaf = node.deck !== null && !hasChildren;

  // 1.5rem base + 1.25rem per nesting level. The vertical guide line sits
  // half a level out so it visually anchors to the parent's chevron column.
  const indent = 1.5 + (depth - 1) * 1.25;
  const guideLeft = 1.5 + (depth - 1.5) * 1.25;

  // Title area opens /deck/[id] when this node maps to a real deck, even
  // for parent rows with children. Only the chevron toggles expand/collapse.
  // Pure path-only intermediates (no `node.deck`) fall back to toggle on
  // title click.
  const titleClass = cn(
    'truncate',
    depth === 1
      ? 'text-base font-light text-dark-100'
      : 'text-sm font-light text-dark-200',
  );

  return (
    <div>
      <div
        className="group relative flex items-center gap-3 pr-6 py-2.5 hover:bg-white/[0.025] transition"
        style={{ paddingLeft: `${indent}rem` }}
      >
        {/* Subtle vertical guide so the eye can chunk siblings without lines. */}
        {depth > 1 && (
          <span
            aria-hidden
            className="absolute top-0 bottom-0 w-px bg-white/[0.04] pointer-events-none"
            style={{ left: `${guideLeft}rem` }}
          />
        )}

        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggle(node.fullPath)}
            className="shrink-0 -m-1 p-1 rounded text-dark-500 hover:text-dark-200 hover:bg-white/[0.04] transition"
            aria-expanded={!isCollapsed}
            aria-label={isCollapsed ? `Expand ${node.displayName}` : `Collapse ${node.displayName}`}
          >
            <Chevron open={!isCollapsed} tone="dim" />
          </button>
        ) : (
          <span aria-hidden className="shrink-0 w-3 h-3 inline-flex items-center justify-center text-dark-700 text-2xs">·</span>
        )}

        <Link
          href={node.deck ? `/deck/${node.deck.id}` : `/decks/path/${encodeURIComponent(node.fullPath)}`}
          className="flex-1 min-w-0 flex items-center gap-3"
          aria-label={`Open ${node.displayName}`}
        >
          <span className={titleClass}>{node.displayName}</span>
        </Link>

        <DeckIndicators extras={sumExtras} dim={hasChildren && isCollapsed} />
        <CountChips sum={sum} due={due} dim={hasChildren && isCollapsed} />
      </div>
      {hasChildren && !isCollapsed && (
        <div>
          {node.children.map(child => (
            <DeckRow
              key={child.fullPath}
              node={child}
              depth={depth + 1}
              counts={counts}
              extras={extras}
              sumByPath={sumByPath}
              extrasByPath={extrasByPath}
              collapsed={collapsed}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Compact two-part indicator next to the count chips:
 *   - 7 thin vertical bars (today + next 6 days due)
 *   - 2-3 char retention % when ≥5 reviews back it
 * Both pieces collapse gracefully when no data is available, so empty/new
 * decks stay clean.
 */
function DeckIndicators({ extras, dim }: { extras: DeckExtras; dim?: boolean }) {
  const hasForecast = extras.forecast.some(n => n > 0);
  const max = Math.max(1, ...extras.forecast);
  const r = extras.retention;
  const retClass = r === null
    ? 'text-dark-700'
    : r >= 0.85 ? 'text-saffron-300'
    : r >= 0.7 ? 'text-saffron-400'
    : 'text-crimson-300';
  // `relative` lifts the indicators above any absolute Link overlay (the
  // top-level leaf card uses one), so pointer events reach the tooltip
  // triggers. In the section/row layouts where there's no overlay it's a
  // no-op.
  return (
    <div className={cn('hidden md:flex items-center gap-3 shrink-0 relative', dim && 'opacity-50')}>
      {/* Show the 7-day due-forecast sparkline only when there's actual due
          load. With all-zeros it renders as a confusing row of dashes. */}
      {hasForecast ? (
        <Tooltip content={`Next 7 days: ${extras.forecast.join(', ')} due/day`}>
          <div
            className="flex items-end gap-px h-4 w-12"
            role="img"
            aria-label={`Due over the next 7 days: ${extras.forecast.join(', ')}`}
          >
            {extras.forecast.map((n, i) => (
              <span
                key={i}
                aria-hidden
                className="flex-1 rounded-sm bg-persian-400/40"
                style={{ height: `${Math.max(8, (n / max) * 100)}%` }}
              />
            ))}
          </div>
        </Tooltip>
      ) : (
        <span className="w-12 text-2xs text-dark-700 text-center" aria-hidden>—</span>
      )}
      <Tooltip
        content={r === null
          ? `30-day retention: not enough data (${extras.retentionN} reviews)`
          : `30-day retention · ${extras.retentionN} reviews`}
      >
        <span
          className={cn('text-2xs uppercase tracking-widest tabular-nums w-9 text-right', retClass)}
          aria-label={r === null
            ? `30-day retention: not enough data, ${extras.retentionN} reviews`
            : `30-day retention ${Math.round(r * 100)} percent, ${extras.retentionN} reviews`}
        >
          {r === null ? '—' : `${Math.round(r * 100)}%`}
        </span>
      </Tooltip>
    </div>
  );
}

function Chevron({ open, tone }: { open: boolean; tone: 'bright' | 'dim' }) {
  const cls = tone === 'bright' ? 'text-saffron-400/80' : 'text-dark-500';
  return (
    <svg
      viewBox="0 0 12 12"
      width="10"
      height="10"
      className={cn('shrink-0 transition-transform duration-200', cls, open ? 'rotate-90' : 'rotate-0')}
      aria-hidden
    >
      <path d="M3 1.5 L8 6 L3 10.5" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Three right-aligned, fixed-width columns so the same kind of number
 * stacks vertically across rows. Implemented as an explicit CSS grid
 * (rather than flex with `w-*` spans) because empty spans inside a flex
 * container collapse to zero width — which broke the column alignment
 * we want here.
 */
function CountChips({ sum, due, dim }: { sum: SummedCounts; due: number; dim?: boolean }) {
  const cls = cn(
    'grid grid-cols-[3rem_2.5rem_3rem] items-center gap-2 shrink-0 text-xs tracking-tight tabular-nums font-light',
    dim && 'opacity-50',
  );

  if (sum.total === 0) {
    return (
      <div className={cls}>
        <span />
        <span />
        <span className="text-right text-dark-700">empty</span>
      </div>
    );
  }
  if (due === 0) {
    return (
      <div className={cls}>
        <span />
        <span />
        <span className="text-right text-dark-600">done</span>
      </div>
    );
  }

  return (
    <div className={cls}>
      <span className="text-right text-saffron-400">{sum.new || ''}</span>
      <span className="text-right text-crimson-400">{sum.learning || ''}</span>
      <span className="text-right text-persian-300">{sum.review || ''}</span>
    </div>
  );
}

// `sumCounts` and `sumExtrasOf` were O(N²) helpers (walked the full subtree
// per render). Replaced by `buildSumMap` / `buildExtrasMap` at the parent —
// one O(N) pass, then each row's lookup is O(1) Map.get.
