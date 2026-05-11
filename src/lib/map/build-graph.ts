/**
 * Build a force-directed graph from a deck's notes + cards.
 *
 *   Nodes  = notes. Color = mastery (FSRS stability + state). Radius = log(reps).
 *   Edges  = Jaccard word-overlap between fronts/backs. Top-K per node so the
 *            graph doesn't drown in low-strength connections.
 *
 * Layout is a simple O(n²) force simulation: pairwise Coulomb repulsion,
 * springs along edges (stronger spring = shorter rest length), and a
 * gentle gravity pull toward center. 250 iterations of pre-rendered ticks
 * settles a typical 500-node deck in ~200 ms in JS. For huge decks we cap
 * iterations and let it look loose rather than block the UI.
 */

import type { Card, Note } from '@/lib/db/schema';
import { renderPlain } from '@/lib/cloze/parser';

export type Mastery = 'new' | 'weak' | 'fair' | 'strong' | 'mastered' | 'suspended';

export interface GraphNode {
  id: string;        // noteId (graph identity)
  cardCount: number;
  totalReps: number;
  mastery: Mastery;
  meanStability: number;
  meanLapses: number;
  /** Short truncated label for tooltip. */
  label: string;
  /** Mutable layout state. */
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  /** 0..1 Jaccard similarity. Stronger edges → shorter rest length. */
  strength: number;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

function tokenize(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/\W+/).filter(w => w.length >= 4));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Mastery bucket from an individual card's FSRS state. We aggregate to
 * a note's worst card (weakest link) so a note with one solid and one
 * lapsing cloze still shows up as fragile.
 */
function masteryFromCard(state: string, stability: number, suspended: boolean): Mastery {
  if (suspended) return 'suspended';
  if (state === 'new') return 'new';
  if (stability < 1) return 'weak';
  if (stability < 10) return 'fair';
  if (stability < 30) return 'strong';
  return 'mastered';
}

const MASTERY_ORDER: Record<Mastery, number> = {
  // higher rank = surfaces in the aggregate (we take the MAX so "weak"
  // beats "mastered" — visually red wins for at-a-glance gap-finding).
  mastered: 0,
  strong: 1,
  fair: 2,
  weak: 3,
  new: 4,
  // suspended is its own thing — render gray, but if any card is non-
  // suspended we surface that card's mastery instead.
  suspended: -1,
};

export interface BuildGraphOptions {
  /** Top-K strongest edges per node. Default 4. */
  topKEdgesPerNode?: number;
  /** Minimum Jaccard to consider an edge. Default 0.06. */
  edgeThreshold?: number;
  /** Skip suspended notes entirely. Default false. */
  excludeSuspended?: boolean;
}

export function buildGraph(notes: Note[], cards: Card[], opts: BuildGraphOptions = {}): GraphData {
  const topK = opts.topKEdgesPerNode ?? 4;
  const threshold = opts.edgeThreshold ?? 0.06;
  const skipSuspended = opts.excludeSuspended ?? false;

  // Per-note: aggregate card stats.
  const cardsByNote = new Map<string, Card[]>();
  for (const c of cards) {
    let bucket = cardsByNote.get(c.noteId);
    if (!bucket) { bucket = []; cardsByNote.set(c.noteId, bucket); }
    bucket.push(c);
  }

  const nodes: GraphNode[] = [];
  const tokensByNote = new Map<string, Set<string>>();

  for (const note of notes) {
    const noteCards = cardsByNote.get(note.id) ?? [];
    if (noteCards.length === 0) continue;

    const allSuspended = noteCards.every(c => c.suspended);
    if (allSuspended && skipSuspended) continue;

    let totalReps = 0;
    let stabilitySum = 0;
    let lapsesSum = 0;
    let worstMastery: Mastery = allSuspended ? 'suspended' : 'mastered';
    for (const c of noteCards) {
      totalReps += c.reps;
      stabilitySum += c.stability;
      lapsesSum += c.lapses;
      if (!c.suspended) {
        const m = masteryFromCard(c.state, c.stability, false);
        if (MASTERY_ORDER[m] > MASTERY_ORDER[worstMastery]) worstMastery = m;
      }
    }

    const label = renderPlain(note.fields.front).replace(/\s+/g, ' ').trim().slice(0, 80);

    nodes.push({
      id: note.id,
      cardCount: noteCards.length,
      totalReps,
      mastery: worstMastery,
      meanStability: stabilitySum / noteCards.length,
      meanLapses: lapsesSum / noteCards.length,
      label,
      x: 0, y: 0, vx: 0, vy: 0,
    });

    // Token set across front+back+extra. Used by Jaccard below. Cached
    // to avoid retokenising each note against every peer in the n² loop.
    tokensByNote.set(
      note.id,
      tokenize(
        renderPlain(note.fields.front) + ' '
        + renderPlain(note.fields.back ?? '') + ' '
        + renderPlain(note.fields.extra ?? ''),
      ),
    );
  }

  // Edges: for each node, score every other and keep the top-K. A pair's
  // strongest score wins if both endpoints would otherwise duplicate.
  const edgeMap = new Map<string, GraphEdge>();
  for (const a of nodes) {
    const at = tokensByNote.get(a.id);
    if (!at || at.size === 0) continue;
    const candidates: Array<{ id: string; strength: number }> = [];
    for (const b of nodes) {
      if (b.id === a.id) continue;
      const bt = tokensByNote.get(b.id);
      if (!bt) continue;
      const s = jaccard(at, bt);
      if (s >= threshold) candidates.push({ id: b.id, strength: s });
    }
    candidates.sort((x, y) => y.strength - x.strength);
    for (const c of candidates.slice(0, topK)) {
      const [src, tgt] = a.id < c.id ? [a.id, c.id] : [c.id, a.id];
      const key = `${src}|${tgt}`;
      const existing = edgeMap.get(key);
      if (!existing || existing.strength < c.strength) {
        edgeMap.set(key, { source: src, target: tgt, strength: c.strength });
      }
    }
  }

  return { nodes, edges: [...edgeMap.values()] };
}

/**
 * Simple force-directed layout. Mutates node x/y/vx/vy in place. Pre-
 * runs `iters` synchronous ticks so the caller can render the settled
 * positions in one paint. For very large decks we cap iters in the
 * caller — visual quality degrades gracefully.
 */
export function runForceLayout(
  graph: GraphData,
  opts: { width: number; height: number; iters?: number },
): void {
  const { width, height, iters = 240 } = opts;
  const n = graph.nodes.length;
  if (n === 0) return;

  const cx = width / 2;
  const cy = height / 2;

  // Initial layout: scattered on a ring around the center. Random offset
  // breaks symmetry so the first repulsion tick has something to push
  // against.
  graph.nodes.forEach((node, i) => {
    const angle = (i / n) * Math.PI * 2 + Math.random() * 0.1;
    const r = Math.min(width, height) * (0.30 + Math.random() * 0.08);
    node.x = cx + Math.cos(angle) * r;
    node.y = cy + Math.sin(angle) * r;
    node.vx = 0;
    node.vy = 0;
  });

  const nodeById = new Map<string, GraphNode>();
  for (const node of graph.nodes) nodeById.set(node.id, node);

  // Tuned for the typical deck (200-2000 nodes). For huge decks the
  // gravity constant keeps everything from drifting off-screen.
  const repulsion = 1800;
  const springK = 0.08;
  const idealLen = 60;
  const gravity = 0.012;
  const damping = 0.86;
  const maxStep = 12;

  for (let iter = 0; iter < iters; iter++) {
    // O(n²) Coulomb repulsion. For n=1000 that's 500K iterations per
    // tick × 240 ticks = 120M ops, ~100 ms in V8. Fine.
    for (let i = 0; i < n; i++) {
      const a = graph.nodes[i];
      for (let j = i + 1; j < n; j++) {
        const b = graph.nodes[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist2 = dx * dx + dy * dy + 1;
        const dist = Math.sqrt(dist2);
        const f = repulsion / dist2;
        const fx = (dx / dist) * f;
        const fy = (dy / dist) * f;
        a.vx -= fx; a.vy -= fy;
        b.vx += fx; b.vy += fy;
      }
    }

    // Springs along edges (stronger jaccard → tighter).
    for (const e of graph.edges) {
      const a = nodeById.get(e.source);
      const b = nodeById.get(e.target);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) + 0.01;
      const rest = idealLen * (1 - e.strength * 0.5); // stronger → shorter
      const stretch = dist - rest;
      const k = springK * (0.5 + e.strength);
      const fx = (dx / dist) * k * stretch;
      const fy = (dy / dist) * k * stretch;
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
    }

    // Gravity to center.
    for (const node of graph.nodes) {
      node.vx += (cx - node.x) * gravity;
      node.vy += (cy - node.y) * gravity;
    }

    // Apply velocities with damping + per-step clamp.
    for (const node of graph.nodes) {
      node.vx *= damping;
      node.vy *= damping;
      const stepX = Math.max(-maxStep, Math.min(maxStep, node.vx));
      const stepY = Math.max(-maxStep, Math.min(maxStep, node.vy));
      node.x += stepX;
      node.y += stepY;
      // Keep inside the viewport with a 24px margin.
      node.x = Math.max(24, Math.min(width - 24, node.x));
      node.y = Math.max(24, Math.min(height - 24, node.y));
    }
  }
}
