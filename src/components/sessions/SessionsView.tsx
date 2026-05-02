'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { Deck, Exam, PracticeQuery } from '@/lib/db/schema';
import { listDecks } from '@/lib/db/queries';
import { listAllExams } from '@/lib/exam/queries';
import { listPracticeQueries } from '@/lib/practice/queries';
import { SkeletonList } from '@/components/ui/Skeleton';
import { cn } from '@/lib/utils';

/**
 * Unified Sessions surface: both saved practice queries (focused review on a
 * search-syntax string) and AI-generated exams (MCQ + free response). The
 * underlying /practice and /exam routes still work — this is a friendlier
 * landing page than two separate nav entries.
 */
export default function SessionsView() {
  const [exams, setExams] = useState<Exam[] | null>(null);
  const [queries, setQueries] = useState<PracticeQuery[] | null>(null);
  const [decks, setDecks] = useState<Deck[]>([]);

  useEffect(() => {
    Promise.all([
      listAllExams(50),
      listPracticeQueries(),
      listDecks(),
    ]).then(([es, ps, ds]) => {
      setExams(es);
      setQueries(ps);
      setDecks(ds);
    });
  }, []);

  const deckById = new Map(decks.map(d => [d.id, d]));

  if (exams === null || queries === null) {
    return (
      <div className="max-w-3xl mx-auto px-4 md:px-6 py-6 md:py-10 space-y-8">
        <div className="space-y-2">
          <div className="h-9 w-40 rounded loading-shimmer" />
          <div className="h-4 w-72 rounded loading-shimmer" />
        </div>
        <SkeletonList count={3} height="h-14" />
        <SkeletonList count={3} height="h-14" />
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <h1 className="text-3xl md:text-4xl font-extralight tracking-tight mb-2">Sessions</h1>
      <p className="text-dark-400 font-light text-sm mb-8">
        AI exams and saved practice queries side-by-side.
      </p>

      <section className="mb-10">
        <div className="flex items-center justify-between gap-4 mb-3">
          <h2 className="text-xs uppercase tracking-widest text-dark-400">AI exams</h2>
          <Link href="/exam" className="text-2xs uppercase tracking-[0.2em] font-light text-dark-400 hover:text-dark-100 transition">
            View all →
          </Link>
        </div>
        {exams.length === 0 ? (
          <div className="glass-card rounded-2xl p-6 text-sm text-dark-400 font-light">
            No exams yet.{' '}
            {decks.length > 0 ? (
              <>
                Generate one from any deck — open a deck and click <span className="text-saffron-300">AI exam</span>.
              </>
            ) : (
              <>Create a deck first.</>
            )}
          </div>
        ) : (
          <ul className="glass-card rounded-2xl divide-y divide-white/[0.04]">
            {exams.slice(0, 6).map(e => {
              const deck = deckById.get(e.deckId);
              const dest = e.status === 'submitted' ? `/exam/result/${e.id}` : `/exam/take/${e.id}`;
              return (
                <li key={e.id}>
                  <Link href={dest} className="px-5 py-3 flex items-center gap-4 hover:bg-white/[0.02] transition">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-light text-dark-100 truncate">{e.title}</div>
                      <div className="text-2xs uppercase tracking-widest text-dark-500 mt-0.5">
                        {deck?.name?.split('::').slice(-1)[0] ?? ''} · {e.config.count}Q · {e.status}
                      </div>
                    </div>
                    {e.scoreOverall !== undefined && (
                      <span className={cn(
                        'shrink-0 text-base font-extralight tabular-nums tracking-tight',
                        e.scoreOverall >= 0.85 ? 'text-saffron-300'
                          : e.scoreOverall >= 0.6 ? 'text-saffron-400'
                          : 'text-crimson-300',
                      )}>
                        {Math.round(e.scoreOverall * 100)}%
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section>
        <div className="flex items-center justify-between gap-4 mb-3">
          <h2 className="text-xs uppercase tracking-widest text-dark-400">Saved practice queries</h2>
          <Link href="/practice" className="text-2xs uppercase tracking-[0.2em] font-light text-dark-400 hover:text-dark-100 transition">
            Manage →
          </Link>
        </div>
        {queries.length === 0 ? (
          <div className="glass-card rounded-2xl p-6 text-sm text-dark-400 font-light">
            No saved queries yet. Create one from <Link href="/practice" className="text-saffron-300 underline">Practice</Link>.
          </div>
        ) : (
          <ul className="glass-card rounded-2xl divide-y divide-white/[0.04]">
            {queries.slice(0, 8).map(q => {
              const deckName = q.deckId ? deckById.get(q.deckId)?.name : null;
              return (
                <li key={q.id}>
                  <Link href={`/practice/${q.id}`} className="px-5 py-3 flex items-center gap-4 hover:bg-white/[0.02] transition">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-light text-dark-100 truncate">{q.name}</div>
                      <div className="text-2xs uppercase tracking-widest text-dark-500 font-mono mt-0.5 truncate">
                        {deckName ? `${deckName} · ` : 'all decks · '}{q.query}
                      </div>
                    </div>
                    <span className="text-2xs uppercase tracking-[0.2em] text-saffron-300 shrink-0">Run</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
