'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  createPracticeQuery,
  deletePracticeQuery,
  listPracticeQueries,
} from '@/lib/practice/queries';
import { listDecks } from '@/lib/db/queries';
import type { Deck, PracticeQuery } from '@/lib/db/schema';
import { SkeletonList } from '@/components/ui/Skeleton';
import { cn } from '@/lib/utils';

export default function PracticeList() {
  const [items, setItems] = useState<PracticeQuery[] | null>(null);
  const [decks, setDecks] = useState<Deck[]>([]);
  const [draftName, setDraftName] = useState('');
  const [draftQuery, setDraftQuery] = useState('');
  const [draftDeckId, setDraftDeckId] = useState<string>('');
  const [adding, setAdding] = useState(false);

  const refresh = async () => {
    const [list, ds] = await Promise.all([listPracticeQueries(), listDecks()]);
    setItems(list);
    setDecks(ds);
  };

  useEffect(() => {
    refresh();
  }, []);

  const save = async () => {
    if (!draftName.trim() || !draftQuery.trim()) return;
    setAdding(true);
    try {
      await createPracticeQuery({
        name: draftName.trim(),
        query: draftQuery.trim(),
        deckId: draftDeckId || undefined,
      });
      setDraftName('');
      setDraftQuery('');
      setDraftDeckId('');
      await refresh();
    } finally {
      setAdding(false);
    }
  };

  const remove = async (id: string) => {
    await deletePracticeQuery(id);
    await refresh();
  };

  if (items === null) {
    return (
      <div className="max-w-3xl mx-auto px-4 md:px-6 py-6 md:py-10 space-y-6">
        <div className="space-y-2">
          <div className="h-9 w-36 rounded loading-shimmer" />
          <div className="h-4 w-72 rounded loading-shimmer" />
        </div>
        <SkeletonList count={4} height="h-14" />
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <h1 className="text-3xl md:text-4xl font-extralight tracking-tight mb-2">Practice</h1>
      <p className="text-dark-400 font-light text-sm mb-8">
        Saved search queries you can run as a focused review session.
        FSRS state still updates — these aren't filtered decks, just a saved-search-driven queue.
      </p>

      <section className="glass-card rounded-2xl p-5 mb-8 space-y-3">
        <h2 className="text-2xs uppercase tracking-[0.2em] font-light text-dark-400">New saved query</h2>
        <input
          value={draftName}
          onChange={e => setDraftName(e.target.value)}
          placeholder="e.g. Lapsed enzymes"
          className={inputClass}
        />
        <input
          value={draftQuery}
          onChange={e => setDraftQuery(e.target.value)}
          placeholder='Search syntax: tag:enzymes lapses>=3 state:relearning'
          className={cn(inputClass, 'font-mono')}
        />
        <div className="flex items-center gap-3 flex-wrap">
          <select
            value={draftDeckId}
            onChange={e => setDraftDeckId(e.target.value)}
            className="bg-dark-800/30 rounded-xl px-3 py-2 text-sm text-dark-100 outline-none focus:bg-dark-800/50 transition border border-white/[0.04] cursor-pointer"
          >
            <option value="">All decks</option>
            {decks.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <button
            onClick={save}
            disabled={adding || !draftName.trim() || !draftQuery.trim()}
            className="btn-gradient px-4 py-2 rounded-xl text-sm uppercase tracking-[0.2em] font-light disabled:opacity-50"
          >
            {adding ? 'Saving…' : 'Save query'}
          </button>
        </div>
      </section>

      {items.length === 0 ? (
        <div className="glass-card rounded-2xl p-8 text-center text-dark-400 text-sm font-light">
          No saved queries yet. Save one above to start a focused practice queue.
        </div>
      ) : (
        <div className="glass-card rounded-2xl divide-y divide-white/[0.04]">
          {items.map(q => {
            const deckName = q.deckId ? decks.find(d => d.id === q.deckId)?.name : null;
            return (
              <div key={q.id} className="px-5 py-4 flex items-center gap-4">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-light text-dark-100 truncate">{q.name}</div>
                  <div className="text-2xs uppercase tracking-widest text-dark-500 font-mono mt-0.5 truncate">
                    {deckName ? `${deckName} · ` : 'all decks · '}{q.query}
                  </div>
                </div>
                <Link
                  href={`/practice/${q.id}`}
                  className="btn-gradient px-4 py-1.5 rounded-lg text-2xs uppercase tracking-[0.2em] font-light shrink-0"
                >
                  Run
                </Link>
                <button
                  onClick={() => remove(q.id)}
                  className="text-2xs uppercase tracking-[0.2em] font-light text-dark-400 hover:text-crimson-300 transition px-2 shrink-0"
                >
                  Delete
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const inputClass = 'w-full bg-dark-800/30 rounded-xl px-4 py-2.5 text-sm text-dark-100 placeholder:text-dark-500 outline-none focus:bg-dark-800/50 transition border border-white/[0.04] focus:border-persian-500/30';
