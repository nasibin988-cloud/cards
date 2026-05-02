'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Deck } from '@/lib/db/schema';
import {
  decksByPath,
  deleteDecks,
  getCountsForDecks,
  getDeckCounts,
  type DeckCounts,
} from '@/lib/db/queries';
import { cn } from '@/lib/utils';

/**
 * Virtual deck page for a path-only intermediate (e.g. "MCAT V5 Core::
 * Behavioral Sciences" when no explicit Deck row exists for that segment,
 * but child decks like "::Ch. 01 ..." do).
 *
 * Aggregates counts across every descendant deck and lets the user drill
 * into any specific child for full management. Study at this level launches
 * each child's queue in priority order — see the per-child Study links.
 */
export default function PathDeckView({ path }: { path: string }) {
  const router = useRouter();
  const [matches, setMatches] = useState<Deck[] | null>(null);
  const [aggregate, setAggregate] = useState<DeckCounts | null>(null);
  const [perDeck, setPerDeck] = useState<Map<string, DeckCounts>>(new Map());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const decks = await decksByPath(path);
      if (cancelled) return;
      setMatches(decks);
      const ids = decks.map(d => d.id);
      const [agg, individual] = await Promise.all([
        getCountsForDecks(ids),
        Promise.all(ids.map(id => getDeckCounts(id))),
      ]);
      if (cancelled) return;
      setAggregate(agg);
      const m = new Map<string, DeckCounts>();
      for (let i = 0; i < ids.length; i++) m.set(ids[i], individual[i]);
      setPerDeck(m);
    })();
    return () => { cancelled = true; };
  }, [path]);

  if (matches === null) {
    return <div className="max-w-5xl mx-auto px-4 md:px-6 py-6 md:py-10 text-dark-400">Loading…</div>;
  }

  if (matches.length === 0) {
    return (
      <div className="max-w-5xl mx-auto px-4 md:px-6 py-6 md:py-10">
        <p className="text-dark-300">No decks under "{path}".</p>
        <Link href="/" className="text-saffron-300 underline">← Decks</Link>
      </div>
    );
  }

  const segments = path.split('::').map(s => s.trim()).filter(Boolean);
  const leaf = segments[segments.length - 1] ?? path;
  const prefix = segments.slice(0, -1);

  // Sort children by their relative path under the prefix so siblings cluster.
  const childRows = matches
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));

  const due = aggregate ? aggregate.new + aggregate.learning + aggregate.review : 0;

  const removeAll = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await deleteDecks(matches.map(d => d.id));
      router.push('/');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto px-4 md:px-6 py-6 md:py-10">
      <div className="flex items-end justify-between gap-4 md:gap-6 flex-wrap">
        <div>
          {prefix.length > 0 && (
            <div className="text-2xs uppercase tracking-[0.2em] font-mono text-dark-500 mb-1.5">
              {prefix.join(' / ')}
            </div>
          )}
          <h1 className="text-3xl md:text-4xl font-extralight tracking-tight bg-gradient-to-r from-saffron-300 to-persian-300 bg-clip-text text-transparent">
            {leaf}
          </h1>
          <p className="text-dark-400 mt-1 font-light text-sm">
            {matches.length} sub-deck{matches.length === 1 ? '' : 's'} aggregated.
          </p>
        </div>
      </div>

      {aggregate && (
        <div className="mt-6 grid grid-cols-4 gap-3 max-w-2xl">
          <Stat label="Total" value={aggregate.total} />
          <Stat label="New" value={aggregate.new} tone="saffron" />
          <Stat label="Learn" value={aggregate.learning} tone="crimson" />
          <Stat label="Review" value={aggregate.review} tone="persian" />
        </div>
      )}

      <div className="mt-8 flex items-center gap-3 flex-wrap">
        {due > 0 && (
          <Link
            href={`/study/path/${encodeURIComponent(path)}`}
            className="btn-gradient px-5 py-2 rounded-lg text-2xs uppercase tracking-[0.2em] font-light"
          >
            Study {due} card{due === 1 ? '' : 's'}
          </Link>
        )}
        {due === 0 && aggregate && aggregate.total > 0 && (
          <span className="text-2xs uppercase tracking-widest text-dark-500">
            All caught up
          </span>
        )}
      </div>

      <div className="mt-10 mb-3 flex items-center justify-between">
        <h2 className="text-xs uppercase tracking-widest text-dark-400">
          Sub-decks ({matches.length})
        </h2>
        {due > 0 && (
          <span className="text-2xs uppercase tracking-widest text-dark-500 tabular-nums">
            {due} due
          </span>
        )}
      </div>

      <div className="glass-card rounded-2xl divide-y divide-white/[0.04]">
        {childRows.map(d => {
          const counts = perDeck.get(d.id);
          const childDue = counts ? counts.new + counts.learning + counts.review : 0;
          // Strip the path prefix so the child's display name reads naturally.
          const stripped = path && d.name.startsWith(path + '::')
            ? d.name.slice(path.length + 2)
            : d.name;
          return (
            <Link
              key={d.id}
              href={`/deck/${d.id}`}
              className="block px-5 py-3 hover:bg-white/[0.02] transition flex items-center gap-4"
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm font-light text-dark-100 truncate">{stripped || d.name}</div>
                {d.description && (
                  <div className="text-2xs text-dark-500 truncate mt-0.5">{d.description}</div>
                )}
              </div>
              {counts && (
                <div className="grid grid-cols-[3rem_2.5rem_3rem] items-center gap-2 shrink-0 text-xs tracking-tight tabular-nums font-light">
                  {counts.total === 0 ? (
                    <>
                      <span /><span />
                      <span className="text-right text-dark-700">empty</span>
                    </>
                  ) : childDue === 0 ? (
                    <>
                      <span /><span />
                      <span className="text-right text-dark-600">done</span>
                    </>
                  ) : (
                    <>
                      <span className="text-right text-saffron-400">{counts.new || ''}</span>
                      <span className="text-right text-crimson-400">{counts.learning || ''}</span>
                      <span className="text-right text-persian-300">{counts.review || ''}</span>
                    </>
                  )}
                </div>
              )}
            </Link>
          );
        })}
      </div>

      <div className="mt-8 pt-6 border-t border-white/[0.04]">
        {!confirmDelete ? (
          <button
            onClick={() => setConfirmDelete(true)}
            className="text-sm text-crimson-400 hover:text-crimson-300 transition"
          >
            Delete this group
          </button>
        ) : (
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-sm text-dark-300">
              Delete {matches.length} sub-deck{matches.length === 1 ? '' : 's'} under "{leaf}" and all their cards?
            </span>
            <button
              onClick={removeAll}
              disabled={deleting}
              className="px-4 py-1.5 rounded-lg text-sm bg-crimson-900/40 text-crimson-200 hover:bg-crimson-800/50 transition disabled:opacity-50"
            >
              {deleting ? 'Deleting…' : `Yes, delete ${matches.length} deck${matches.length === 1 ? '' : 's'}`}
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              disabled={deleting}
              className="px-4 py-1.5 rounded-lg text-sm text-dark-300 hover:text-dark-100 transition"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'saffron' | 'crimson' | 'persian' }) {
  const toneClass = tone === 'saffron' ? 'text-saffron-300'
    : tone === 'crimson' ? 'text-crimson-300'
    : tone === 'persian' ? 'text-persian-200'
    : 'text-dark-100';
  return (
    <div className="glass-card rounded-2xl p-4 text-center">
      <div className={cn('text-2xl font-extralight tracking-tight tabular-nums', toneClass)}>
        {value.toLocaleString()}
      </div>
      <div className="text-2xs uppercase tracking-widest text-dark-500 mt-1">{label}</div>
    </div>
  );
}
