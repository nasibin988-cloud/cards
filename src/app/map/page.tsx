'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { listDecks } from '@/lib/db/queries';
import type { Deck } from '@/lib/db/schema';
import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui/Tooltip';

/**
 * Concept-graph view of a single deck. Notes are nodes; edges form from
 * front+back+extra word-overlap. Color = FSRS mastery so weak spots pop
 * red against a sea of teal. Click a node to jump straight to that note.
 *
 * SSR-disabled because the graph builder reads Dexie (browser-only) and
 * runs a synchronous force simulation in the main thread.
 */
const ConceptGraph = dynamic(() => import('@/components/map/ConceptGraph'), { ssr: false });

export default function MapPage() {
  const [decks, setDecks] = useState<Deck[] | null>(null);
  const [activeDeckId, setActiveDeckId] = useState<string | null>(null);

  useEffect(() => {
    listDecks().then(d => {
      // Surface leaf decks first by name length descending — paths
      // like "MCAT::Bio::Ch01" are usually what the user wants.
      const sorted = [...d].sort((a, b) => a.name.localeCompare(b.name));
      setDecks(sorted);
      if (sorted.length > 0) setActiveDeckId(sorted[0].id);
    });
  }, []);

  if (!decks) {
    return (
      <div className="px-6 py-10">
        <div className="text-sm text-dark-500 font-light loading-shimmer rounded-md px-3 py-1.5 inline-block">
          Loading decks…
        </div>
      </div>
    );
  }

  if (decks.length === 0) {
    return (
      <div className="max-w-md mx-auto px-6 py-16 text-center space-y-3">
        <h1 className="text-3xl font-extralight tracking-tight bg-gradient-to-r from-saffron-300 to-persian-300 bg-clip-text text-transparent">
          No decks to map
        </h1>
        <p className="text-dark-300 font-light">
          Create a deck or import a <code className="text-saffron-300 font-mono">.apkg</code> first.
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100vh-3.5rem)] flex flex-col">
      <header className="px-3 md:px-6 py-3 flex items-center gap-3 md:gap-5 border-b border-white/[0.04] backdrop-blur-md bg-dark-950/40">
        <h1 className="text-xl md:text-2xl font-extralight tracking-tight bg-gradient-to-r from-saffron-300 to-persian-300 bg-clip-text text-transparent shrink-0">
          Map
        </h1>
        <select
          value={activeDeckId ?? ''}
          onChange={e => setActiveDeckId(e.target.value)}
          className="bg-dark-800/30 rounded-xl px-3 py-1.5 text-sm text-dark-100 outline-none focus:bg-dark-800/50 border border-white/[0.04] cursor-pointer min-w-0 truncate"
        >
          {decks.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <div className="flex-1" />
        {/* Legend — dot + short label per mastery bucket. Hidden on
            phones because it'd crowd; the tooltip on hover covers the
            same info anyway. */}
        <Tooltip content="Mastery = the WEAKEST card on this note. So a half-mastered note still flags red — useful for finding the actual gaps." side="bottom">
          <div className="hidden md:flex items-center gap-3 text-2xs uppercase tracking-widest font-mono text-dark-500 select-none">
            <Swatch color="#b54552" label="new" />
            <Swatch color="#c47949" label="weak" />
            <Swatch color="#d4c09c" label="fair" />
            <Swatch color="#7ab09a" label="strong" />
            <Swatch color="#3d6b5f" label="mastered" />
          </div>
        </Tooltip>
      </header>

      <div className="px-3 md:px-6 pt-2 pb-2 text-2xs text-dark-500 font-light">
        Hover a node to highlight its neighbors. Click to open that note.
      </div>

      {/* Key on activeDeckId so the renderer remounts cleanly on switch —
          force layout is per-deck and we don't want partial state to
          carry over. */}
      {activeDeckId && <ConceptGraph key={activeDeckId} deckId={activeDeckId} />}
    </div>
  );
}

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{ background: color, boxShadow: `0 0 6px ${color}55` }}
      />
      <span className="text-dark-400">{label}</span>
    </span>
  );
}
