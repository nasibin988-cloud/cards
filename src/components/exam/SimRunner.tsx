'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import type { Card, Deck, Note } from '@/lib/db/schema';
import { getDeck, listCardsByDeck, getNote } from '@/lib/db/queries';
import CardRenderer from '@/components/card/CardRenderer';
import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui/Tooltip';

/**
 * Pre-test simulation: pull N random cards from a deck, no FSRS update,
 * no review log writes. User answers "knew it / didn't" through the set;
 * final scorecard with per-card breakdown.
 *
 * Use case: weekly baseline check before practice exams. Lets you see how
 * well you actually retain a deck's content without polluting your FSRS
 * scheduler state.
 */

type Phase = 'config' | 'study' | 'done';

interface SimResult {
  cardId: string;
  noteId: string;
  knewIt: boolean;
}

export default function SimRunner({ deckId }: { deckId: string }) {
  const [deck, setDeck] = useState<Deck | null>(null);
  const [allCards, setAllCards] = useState<Card[]>([]);
  const [phase, setPhase] = useState<Phase>('config');
  const [size, setSize] = useState<number>(50);
  const [pool, setPool] = useState<Array<{ card: Card; note: Note }>>([]);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [results, setResults] = useState<SimResult[]>([]);
  const [startedAt, setStartedAt] = useState<number>(0);

  useEffect(() => {
    (async () => {
      const [d, cs] = await Promise.all([
        getDeck(deckId),
        listCardsByDeck(deckId, 5000),
      ]);
      setDeck(d ?? null);
      // Skip suspended cards. Keep buried — sim is a one-shot.
      setAllCards(cs.filter(c => !c.suspended));
    })();
  }, [deckId]);

  const start = async () => {
    const sample = pickRandom(allCards, Math.min(size, allCards.length));
    const enriched: Array<{ card: Card; note: Note }> = [];
    for (const c of sample) {
      const n = await getNote(c.noteId);
      if (n) enriched.push({ card: c, note: n });
    }
    setPool(enriched);
    setIndex(0);
    setRevealed(false);
    setResults([]);
    setStartedAt(Date.now());
    setPhase('study');
  };

  const answer = (knewIt: boolean) => {
    if (index >= pool.length) return;
    const cur = pool[index];
    setResults(prev => [...prev, { cardId: cur.card.id, noteId: cur.note.id, knewIt }]);
    if (index + 1 >= pool.length) {
      setPhase('done');
    } else {
      setIndex(index + 1);
      setRevealed(false);
    }
  };

  // Keyboard shortcuts: Space reveals, J/L (or 1/3) answers.
  useEffect(() => {
    if (phase !== 'study') return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA') return;
      if (!revealed) {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          setRevealed(true);
        }
        return;
      }
      if (e.key === 'j' || e.key === 'J' || e.key === '1') {
        e.preventDefault();
        answer(false);
      } else if (e.key === 'l' || e.key === 'L' || e.key === '3') {
        e.preventDefault();
        answer(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, revealed, index, pool]);

  if (phase === 'config') {
    return <ConfigView deck={deck} totalCards={allCards.length} size={size} setSize={setSize} onStart={start} />;
  }

  if (phase === 'done') {
    return <ResultView deck={deck} pool={pool} results={results} elapsedMs={Date.now() - startedAt} onRestart={() => setPhase('config')} />;
  }

  // study phase
  const cur = pool[index];
  if (!cur) return null;
  const score = results.filter(r => r.knewIt).length;
  const progress = ((index) / pool.length) * 100;

  return (
    <div className="min-h-screen flex flex-col">
      <header className="px-6 py-4 flex items-center justify-between border-b border-white/[0.04] backdrop-blur-md bg-dark-950/40 sticky top-0 z-30 gap-4">
        <Tooltip content="Abandon simulation" side="bottom">
          <Link href={`/`} className="text-2xs uppercase tracking-[0.2em] font-light text-dark-400 hover:text-dark-100 transition shrink-0">
            ← Quit
          </Link>
        </Tooltip>
        <div className="flex-1 flex items-center gap-3 max-w-md">
          <div className="flex-1 h-1.5 rounded-full bg-dark-800/60 overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-saffron-500 to-persian-400 transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="text-2xs uppercase tracking-widest tabular-nums text-dark-400 shrink-0">
            {index + 1}/{pool.length}
          </span>
        </div>
        <div className="text-2xs uppercase tracking-widest tabular-nums shrink-0">
          <span className="text-saffron-300">{score}</span>
          <span className="text-dark-600"> / {results.length || '—'}</span>
        </div>
      </header>

      <div className="flex-1 flex flex-col items-center justify-start pt-12 md:pt-16 pb-10 px-6 max-w-3xl mx-auto w-full">
        <div className="w-full space-y-6">
          <div className="glass-card rounded-3xl p-7 md:p-9 min-h-[14rem] flex items-center justify-center">
            <CardRenderer note={cur.note} card={cur.card} side={revealed ? 'back' : 'front'} className="w-full" />
          </div>

          {!revealed ? (
            <div className="flex justify-center">
              <button
                onClick={() => setRevealed(true)}
                className="btn-gradient px-10 py-3 rounded-2xl text-sm uppercase tracking-[0.2em] font-light"
              >
                Reveal
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 md:gap-4">
              <button
                onClick={() => answer(false)}
                className={cn(
                  'flex flex-col items-center justify-center min-h-[5.5rem] py-4 px-3 rounded-2xl border border-white/[0.06]',
                  'bg-gradient-to-br from-crimson-700 to-crimson-900 hover:from-crimson-600 hover:to-crimson-800',
                  'text-dark-50 transition hover:scale-[1.015] active:scale-[0.99]',
                )}
              >
                <span className="text-xs uppercase tracking-widest font-light text-white/75">Didn&rsquo;t</span>
                <kbd className="mt-2 text-2xs text-white/40 font-mono px-1 py-0.5 rounded bg-black/20">J</kbd>
              </button>
              <button
                onClick={() => answer(true)}
                className={cn(
                  'flex flex-col items-center justify-center min-h-[5.5rem] py-4 px-3 rounded-2xl border border-white/[0.06]',
                  'bg-gradient-to-br from-persian-700 to-persian-900 hover:from-persian-600 hover:to-persian-800',
                  'text-dark-50 transition hover:scale-[1.015] active:scale-[0.99]',
                )}
              >
                <span className="text-xs uppercase tracking-widest font-light text-white/75">Knew it</span>
                <kbd className="mt-2 text-2xs text-white/40 font-mono px-1 py-0.5 rounded bg-black/20">L</kbd>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ConfigView({
  deck, totalCards, size, setSize, onStart,
}: {
  deck: Deck | null;
  totalCards: number;
  size: number;
  setSize: (n: number) => void;
  onStart: () => void;
}) {
  return (
    <div className="max-w-xl mx-auto px-6 py-12">
      <h1 className="text-3xl md:text-4xl font-extralight tracking-tight mb-2">Pre-test simulation</h1>
      <p className="text-dark-400 font-light text-sm mb-8">
        {deck ? deck.name : '…'}. Pulls a random sample, no FSRS updates. Use it to baseline retention before a practice exam.
      </p>

      <div className="glass-card rounded-2xl p-6 space-y-5">
        <div>
          <div className="text-2xs uppercase tracking-widest text-dark-400 mb-2">Sample size</div>
          <div className="grid grid-cols-4 gap-2">
            {[10, 25, 50, 100].map(n => (
              <button
                key={n}
                onClick={() => setSize(n)}
                disabled={n > totalCards && n !== 10}
                className={cn(
                  'rounded-xl py-2 text-sm transition',
                  size === n
                    ? 'bg-persian-900/40 text-saffron-200 border border-saffron-700/30'
                    : 'border border-white/[0.06] text-dark-300 hover:text-dark-100 hover:bg-white/[0.04]',
                  n > totalCards && 'opacity-30 cursor-not-allowed',
                )}
              >
                {n}
              </button>
            ))}
          </div>
          <div className="text-2xs text-dark-500 mt-2">
            Deck has {totalCards.toLocaleString()} eligible cards.
          </div>
        </div>

        <button
          onClick={onStart}
          disabled={totalCards === 0}
          className="btn-gradient w-full px-5 py-3 rounded-2xl text-sm uppercase tracking-[0.2em] font-light disabled:opacity-50"
        >
          Start
        </button>
      </div>
    </div>
  );
}

function ResultView({
  deck, pool, results, elapsedMs, onRestart,
}: {
  deck: Deck | null;
  pool: Array<{ card: Card; note: Note }>;
  results: SimResult[];
  elapsedMs: number;
  onRestart: () => void;
}) {
  const correct = results.filter(r => r.knewIt).length;
  const pct = Math.round((correct / Math.max(1, results.length)) * 100);
  const minutes = Math.floor(elapsedMs / 60_000);
  const seconds = Math.floor((elapsedMs % 60_000) / 1000);

  const tagBreakdown = useMemo(() => {
    const map = new Map<string, { total: number; correct: number }>();
    for (const r of results) {
      const note = pool.find(p => p.note.id === r.noteId)?.note;
      if (!note) continue;
      for (const tag of note.tags) {
        if (tag.startsWith('xref::')) continue;
        const cur = map.get(tag) ?? { total: 0, correct: 0 };
        cur.total += 1;
        if (r.knewIt) cur.correct += 1;
        map.set(tag, cur);
      }
    }
    return [...map.entries()]
      .map(([tag, c]) => ({ tag, ...c, rate: c.correct / c.total }))
      .filter(x => x.total >= 2)
      .sort((a, b) => a.rate - b.rate)
      .slice(0, 12);
  }, [results, pool]);

  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <h1 className="text-4xl font-extralight tracking-tight mb-2">{pct}%</h1>
      <p className="text-dark-400 font-light text-sm mb-8">
        {correct} of {results.length} on {deck?.name ?? 'deck'}, {minutes}m {seconds}s.
      </p>

      {tagBreakdown.length > 0 && (
        <div className="glass-card rounded-2xl p-6 mb-6">
          <h2 className="text-lg font-light text-dark-100 mb-4">Weakest tags</h2>
          <ul className="space-y-2">
            {tagBreakdown.map(t => (
              <li key={t.tag} className="flex items-center gap-3">
                <span className="flex-1 text-sm text-dark-200 truncate font-light">{t.tag}</span>
                <span className="text-2xs uppercase tracking-widest tabular-nums text-saffron-300">
                  {Math.round(t.rate * 100)}%
                </span>
                <span className="text-2xs uppercase tracking-widest tabular-nums text-dark-500 w-12 text-right">
                  {t.correct}/{t.total}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <details className="glass-card rounded-2xl p-6 mb-6">
        <summary className="cursor-pointer text-lg font-light text-dark-100">Per-card review</summary>
        <ul className="mt-4 divide-y divide-white/[0.04]">
          {results.map((r, i) => {
            const note = pool.find(p => p.note.id === r.noteId)?.note;
            const front = note?.fields.front ?? '(missing)';
            const stripped = front.replace(/\{\{c\d+::([^:}]+)(?:::[^}]*)?\}\}/g, '$1').replace(/<[^>]*>/g, '').trim();
            return (
              <li key={i} className="py-2 flex items-start gap-3">
                <span className={cn(
                  'shrink-0 w-6 text-center text-2xs uppercase tracking-widest font-mono pt-0.5',
                  r.knewIt ? 'text-saffron-400' : 'text-crimson-400',
                )}>
                  {r.knewIt ? '✓' : '✗'}
                </span>
                <Link href={`/note/${r.noteId}`} className="flex-1 text-sm text-dark-200 hover:text-dark-50 transition line-clamp-2 font-light">
                  {stripped.slice(0, 200)}
                </Link>
              </li>
            );
          })}
        </ul>
      </details>

      <div className="flex gap-3">
        <button onClick={onRestart} className="btn-gradient px-5 py-2.5 rounded-xl text-sm uppercase tracking-[0.2em] font-light">
          Run again
        </button>
        <Link href="/" className="px-5 py-2.5 rounded-xl text-sm text-dark-300 hover:text-dark-100 transition border border-white/[0.06]">
          Back to decks
        </Link>
      </div>
    </div>
  );
}

function pickRandom<T>(arr: T[], n: number): T[] {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}
