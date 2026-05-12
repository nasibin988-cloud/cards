'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { listDecks } from '@/lib/db/queries';
import type { Deck } from '@/lib/db/schema';

/**
 * Reports landing. Two trigger surfaces side by side: today's-activity
 * (no input) and per-deck overview (deck multi-select). PDF download
 * fires automatically when generation completes; past reports stay
 * accessible via the panel.
 */
const ReportsPanel = dynamic(() => import('@/components/reports/ReportsPanel'), { ssr: false });

export default function ReportsPage() {
  const [decks, setDecks] = useState<Deck[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    listDecks().then(d => setDecks([...d].sort((a, b) => a.name.localeCompare(b.name))));
  }, []);

  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="max-w-3xl mx-auto px-6 py-10 space-y-12">
      <section>
        <h1 className="text-4xl font-extralight tracking-tight bg-gradient-to-r from-saffron-300 to-persian-300 bg-clip-text text-transparent">
          Reports
        </h1>
        <p className="text-dark-400 font-light mt-1">
          Opus + Sonnet build a sleek PDF summary of either today&rsquo;s study or a chosen deck&rsquo;s
          contents. Saved locally to OPFS so you can scroll back through them.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xs uppercase tracking-widest text-dark-400">Today&rsquo;s activity</h2>
        <ReportsPanel mode="daily" />
      </section>

      <section className="space-y-4">
        <h2 className="text-xs uppercase tracking-widest text-dark-400">Deck overview</h2>
        <p className="text-2xs text-dark-500 font-light">
          Pick one or more decks. Reports walk all notes including descendants of any deck whose name uses <code className="text-saffron-300 font-mono">::</code>.
        </p>
        {decks === null ? (
          <div className="text-sm text-dark-500 font-light loading-shimmer rounded-md px-3 py-1.5 inline-block">Loading decks…</div>
        ) : decks.length === 0 ? (
          <div className="text-sm text-dark-400 font-light">No decks yet — create one first.</div>
        ) : (
          <div className="space-y-3">
            <ul className="max-h-72 overflow-y-auto rounded-2xl border border-white/[0.04] divide-y divide-white/[0.04]">
              {decks.map(d => {
                const checked = selected.has(d.id);
                return (
                  <li key={d.id}>
                    <label className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-white/[0.02] transition">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(d.id)}
                        className="accent-saffron-400"
                      />
                      <span className="text-sm font-light text-dark-100 truncate">{d.name}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
            <ReportsPanel
              mode="deck"
              deckIds={[...selected]}
              deckLabel={selected.size === 1
                ? decks.find(d => selected.has(d.id))?.name
                : selected.size > 1 ? `${selected.size} decks` : undefined}
            />
          </div>
        )}
      </section>
    </div>
  );
}
