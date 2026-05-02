'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Deck, Exam } from '@/lib/db/schema';
import { listAllExams } from '@/lib/exam/queries';
import { listDecks, getDeckCounts } from '@/lib/db/queries';
import { cn } from '@/lib/utils';

export default function ExamHistory() {
  const [exams, setExams] = useState<Exam[] | null>(null);
  const [decks, setDecks] = useState<Deck[]>([]);
  const [deckById, setDeckById] = useState<Map<string, Deck>>(new Map());
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    Promise.all([listAllExams(200), listDecks()]).then(([es, ds]) => {
      setExams(es);
      setDecks(ds);
      setDeckById(new Map(ds.map(d => [d.id, d])));
    });
  }, []);

  if (exams === null) {
    return <div className="max-w-3xl mx-auto px-6 py-10 text-dark-400">Loading…</div>;
  }

  const empty = exams.length === 0;

  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <div className="flex items-end justify-between mb-8 gap-4">
        <div>
          <h1 className="text-3xl md:text-4xl font-extralight tracking-tight">Exams</h1>
          <p className="text-dark-400 font-light text-sm mt-2">
            {empty
              ? 'No exams yet. Pick a deck to generate one.'
              : 'AI-generated practice exams across your decks.'}
          </p>
        </div>
        {decks.length > 0 && (
          <button
            onClick={() => setPickerOpen(true)}
            className="btn-gradient px-4 py-2 rounded-xl text-sm uppercase tracking-[0.2em] font-light"
          >
            + New exam
          </button>
        )}
      </div>

      {empty ? (
        <EmptyDeckPicker decks={decks} />
      ) : (
        <div className="space-y-3">
          {exams.map(e => {
            const deck = deckById.get(e.deckId);
            const score = e.scoreOverall;
            const dest = e.status === 'submitted' ? `/exam/result/${e.id}` : `/exam/take/${e.id}`;
            const date = new Date(e.createdAt).toISOString().slice(0, 10);
            return (
              <Link
                key={e.id}
                href={dest}
                className="glass-card glass-card-hover rounded-2xl px-5 py-4 flex items-center gap-4 transition"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-light text-dark-100 truncate">{e.title}</div>
                  <div className="text-2xs uppercase tracking-widest text-dark-500 mt-1">
                    {deck?.name?.split('::').slice(-1)[0] ?? ''} · {date} · {e.config.count}Q · {e.status === 'submitted' ? 'submitted' : e.status === 'in_progress' ? 'in progress' : 'draft'}
                  </div>
                </div>
                {score !== undefined && (
                  <span className={cn(
                    'shrink-0 text-lg font-extralight tabular-nums tracking-tight',
                    score >= 0.85 ? 'text-saffron-300'
                      : score >= 0.6 ? 'text-saffron-400'
                      : 'text-crimson-300',
                  )}>
                    {Math.round(score * 100)}%
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      )}

      {pickerOpen && (
        <DeckPickerDialog decks={decks} onClose={() => setPickerOpen(false)} />
      )}
    </div>
  );
}

function EmptyDeckPicker({ decks }: { decks: Deck[] }) {
  if (decks.length === 0) {
    return (
      <div className="glass-card rounded-2xl p-8 text-center">
        <p className="text-dark-300 font-light text-sm">
          Create a deck first, then come back to generate an exam.
        </p>
        <Link href="/decks/new" className="btn-gradient inline-block mt-4 px-4 py-2 rounded-xl text-sm uppercase tracking-[0.2em] font-light">
          + New deck
        </Link>
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-2xs uppercase tracking-[0.2em] text-dark-500 mb-3">Pick a deck</h2>
      <DeckGrid decks={decks} />
    </div>
  );
}

function DeckPickerDialog({ decks, onClose }: { decks: Deck[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 backdrop-blur-sm pt-20 px-6"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div ref={ref} className="glass-card rounded-2xl w-full max-w-xl max-h-[70vh] overflow-hidden flex flex-col">
        <div className="px-5 py-4 border-b border-white/[0.04] flex items-center justify-between">
          <h2 className="text-sm uppercase tracking-[0.2em] font-light text-dark-100">Pick a deck</h2>
          <button onClick={onClose} className="text-2xs uppercase tracking-[0.2em] text-dark-400 hover:text-dark-100 transition">
            Close
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          <DeckGrid decks={decks} />
        </div>
      </div>
    </div>
  );
}

function DeckGrid({ decks }: { decks: Deck[] }) {
  const [counts, setCounts] = useState<Map<string, number>>(new Map());

  useEffect(() => {
    let cancelled = false;
    Promise.all(decks.map(d => getDeckCounts(d.id).then(c => [d.id, c.total] as const)))
      .then(entries => { if (!cancelled) setCounts(new Map(entries)); });
    return () => { cancelled = true; };
  }, [decks]);

  const sorted = useMemo(
    () => [...decks].sort((a, b) => a.name.localeCompare(b.name)),
    [decks],
  );

  return (
    <div className="grid gap-2">
      {sorted.map(d => {
        const total = counts.get(d.id);
        const leaf = d.name.split('::').slice(-1)[0];
        const prefix = d.name.includes('::') ? d.name.split('::').slice(0, -1).join(' :: ') : null;
        return (
          <Link
            key={d.id}
            href={`/exam/new/${d.id}`}
            className="glass-card glass-card-hover rounded-xl px-4 py-3 flex items-center justify-between gap-3 transition"
          >
            <div className="min-w-0">
              {prefix && (
                <div className="text-2xs uppercase tracking-widest text-dark-500 font-mono truncate">{prefix}</div>
              )}
              <div className="text-sm font-light text-dark-100 truncate">{leaf}</div>
            </div>
            <span className="text-xs tabular-nums text-dark-400 shrink-0">
              {total === undefined ? '…' : `${total} card${total === 1 ? '' : 's'}`}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
