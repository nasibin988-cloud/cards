'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { db } from '@/lib/db/dexie';
import { buildGraph, runForceLayout, type GraphData, type GraphNode, type Mastery } from '@/lib/map/build-graph';
import { cn } from '@/lib/utils';

/**
 * Palette aligned with the rest of the app (crimson / saffron / persian).
 * Worst → best left-to-right so a glance at the legend matches a glance
 * at the graph.
 */
const MASTERY_COLOR: Record<Mastery, string> = {
  new:       '#b54552',   // crimson
  weak:      '#c47949',   // saffron-deep ochre
  fair:      '#d4c09c',   // saffron pale
  strong:    '#7ab09a',   // persian light
  mastered:  '#3d6b5f',   // persian deep
  suspended: '#3a3742',   // dark grey
};

interface Props {
  /** Deck whose notes to render. */
  deckId: string;
}

export default function ConceptGraph({ deckId }: Props) {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [building, setBuilding] = useState(false);
  const [hoverId, setHoverId] = useState<string | null>(null);

  // ResizeObserver so the layout adapts when the user resizes the window
  // or toggles the sidebar. First measurement also seeds the initial
  // layout call.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      setDims({ w: Math.max(320, r.width), h: Math.max(360, r.height) });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Recompute layout whenever deck or viewport changes. We rebuild the
  // graph from scratch each time — fast enough and avoids stale-data
  // bugs when the user comes back from a study session that mutated
  // FSRS state.
  useEffect(() => {
    if (!dims) return;
    let cancelled = false;
    setBuilding(true);
    (async () => {
      const [notes, cards] = await Promise.all([
        db().notes.where('deckId').equals(deckId).toArray(),
        db().cards.where('deckId').equals(deckId).toArray(),
      ]);
      if (cancelled) return;
      const g = buildGraph(notes, cards);
      // Cap iters for very large decks to keep the first paint snappy.
      // 500 nodes → 240 iters. 2000 nodes → 120 iters. 5000+ → 60.
      const iters = g.nodes.length <= 500 ? 240
        : g.nodes.length <= 2000 ? 120
        : 60;
      runForceLayout(g, { width: dims.w, height: dims.h, iters });
      if (cancelled) return;
      setGraph(g);
      setBuilding(false);
    })();
    return () => { cancelled = true; };
  }, [deckId, dims]);

  const nodeById = useMemo(() => {
    if (!graph) return new Map<string, GraphNode>();
    const m = new Map<string, GraphNode>();
    for (const n of graph.nodes) m.set(n.id, n);
    return m;
  }, [graph]);

  // Neighbors of the currently hovered node — used to highlight its
  // immediate connections + dim the rest of the graph.
  const neighborIds = useMemo(() => {
    if (!hoverId || !graph) return null;
    const set = new Set<string>([hoverId]);
    for (const e of graph.edges) {
      if (e.source === hoverId) set.add(e.target);
      else if (e.target === hoverId) set.add(e.source);
    }
    return set;
  }, [hoverId, graph]);

  return (
    <div ref={containerRef} className="flex-1 relative overflow-hidden bg-[radial-gradient(ellipse_at_center,rgba(160,141,184,0.04),transparent_70%)]">
      {(building || !graph) && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="text-2xs uppercase tracking-widest text-dark-500 font-mono loading-shimmer rounded-md px-4 py-2 bg-dark-900/40">
            Computing map…
          </div>
        </div>
      )}
      {graph && dims && (
        <svg
          width={dims.w}
          height={dims.h}
          className="absolute inset-0 animate-fade-in"
        >
          {/* Edges first so nodes overlay them. */}
          <g>
            {graph.edges.map(e => {
              const a = nodeById.get(e.source);
              const b = nodeById.get(e.target);
              if (!a || !b) return null;
              const inFocus = neighborIds === null || (neighborIds.has(a.id) && neighborIds.has(b.id));
              return (
                <line
                  key={`${e.source}-${e.target}`}
                  x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                  stroke="#a08db8"
                  strokeOpacity={inFocus ? 0.10 + e.strength * 0.35 : 0.03}
                  strokeWidth={inFocus ? 0.6 + e.strength * 0.8 : 0.3}
                  style={{ transition: 'stroke-opacity 200ms, stroke-width 200ms' }}
                />
              );
            })}
          </g>
          {/* Nodes. A subtle outer halo at full mastery color sells the
              glassy aesthetic. */}
          <g>
            {graph.nodes.map(node => {
              const r = 3.5 + Math.log(1 + node.totalReps) * 1.4;
              const color = MASTERY_COLOR[node.mastery];
              const inFocus = neighborIds === null || neighborIds.has(node.id);
              const isHover = hoverId === node.id;
              return (
                <g
                  key={node.id}
                  onMouseEnter={() => setHoverId(node.id)}
                  onMouseLeave={() => setHoverId(curr => (curr === node.id ? null : curr))}
                  onClick={() => router.push(`/note/${node.id}?from=map`)}
                  className="cursor-pointer"
                  style={{ transition: 'opacity 200ms', opacity: inFocus ? 1 : 0.18 }}
                >
                  <circle
                    cx={node.x} cy={node.y}
                    r={r + (isHover ? 6 : 3)}
                    fill={color}
                    opacity={isHover ? 0.35 : 0.18}
                    style={{ transition: 'r 160ms, opacity 160ms' }}
                  />
                  <circle
                    cx={node.x} cy={node.y}
                    r={isHover ? r * 1.25 : r}
                    fill={color}
                    style={{
                      transition: 'r 160ms',
                      filter: isHover ? `drop-shadow(0 0 8px ${color})` : undefined,
                    }}
                  />
                </g>
              );
            })}
          </g>
        </svg>
      )}

      {/* Hover tooltip — positioned next to the hovered node, never off-screen. */}
      {hoverId && graph && dims && (() => {
        const node = nodeById.get(hoverId);
        if (!node) return null;
        const tipW = 320;
        const tipH = 80;
        const left = Math.min(dims.w - tipW - 12, Math.max(12, node.x + 14));
        const top  = Math.min(dims.h - tipH - 12, Math.max(12, node.y + 14));
        return (
          <div
            className="absolute pointer-events-none rounded-xl bg-dark-900/95 backdrop-blur-md border border-white/[0.06] px-3.5 py-2.5 shadow-xl animate-fade-in"
            style={{ left, top, width: tipW }}
          >
            <div className="text-sm text-dark-100 font-light leading-snug line-clamp-2">{node.label}</div>
            <div className="mt-1 flex items-center gap-2 text-2xs uppercase tracking-widest font-mono text-dark-500 tabular-nums">
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ background: MASTERY_COLOR[node.mastery] }}
              />
              <span className="text-dark-300">{node.mastery}</span>
              <span>·</span>
              <span>{node.cardCount}× cards</span>
              <span>·</span>
              <span>{node.totalReps} reps</span>
              {node.meanLapses >= 1 && (
                <>
                  <span>·</span>
                  <span className="text-crimson-400">{node.meanLapses.toFixed(1)} lapses</span>
                </>
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
