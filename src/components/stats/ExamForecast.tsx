'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { db } from '@/lib/db/dexie';
import { getJsonSetting, getSetting } from '@/lib/db/queries';
import { buildForecast, type ForecastSummary } from '@/lib/fsrs/forecast';
import { cn } from '@/lib/utils';

/**
 * Compact retention-forecast panel for the Stats page. Hidden when the
 * user hasn't set an exam date in Settings — zero footprint for users
 * who aren't using the feature.
 *
 * What it renders when active:
 *   - One header line: target date, overall mean recall %, cards considered.
 *   - A small bar list of decks worst-recall-first (clipped to top 8 by
 *     default; "Show all" expands).
 *   - A collapsed "Drill at-risk cards" affordance — opens a practice
 *     route scoped to the worst N. Clicking is opt-in; nothing happens
 *     unless the user wants it to.
 *
 * Heavy lifting (FSRS forward simulation over every card) runs once on
 * mount + when settings change. ~50K cards take ~50ms in JS so we don't
 * bother with a worker.
 */
export default function ExamForecast() {
  const [summary, setSummary] = useState<ForecastSummary | null>(null);
  const [examDate, setExamDate] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const ed = await getSetting('exam_date');
      if (!ed) { if (alive) { setExamDate(null); setSummary(null); } return; }
      const threshold = await getJsonSetting<number>('forecast_threshold', 0.6);
      const target = new Date(ed);
      if (Number.isNaN(target.getTime())) return;
      // Anchor to local end-of-day so a "May 15" exam means "you study
      // up through May 15", not "midnight May 15 — anything you do that
      // day didn't count".
      target.setHours(23, 59, 59, 999);
      const dbi = db();
      const [cards, decks] = await Promise.all([
        dbi.cards.toArray(),
        dbi.decks.toArray(),
      ]);
      if (!alive) return;
      const s = buildForecast(cards, decks, target, threshold);
      setExamDate(ed);
      setSummary(s);
    })();
    return () => { alive = false; };
  }, []);

  if (!examDate) return null;
  if (!summary) {
    return (
      <section>
        <h2 className="text-xs uppercase tracking-widest text-dark-400 mb-3">Exam forecast</h2>
        <div className="text-sm text-dark-500 font-light">Computing…</div>
      </section>
    );
  }

  const daysUntil = Math.max(0, Math.round((summary.targetDate - Date.now()) / 86_400_000));
  const visible = showAll ? summary.byDeck : summary.byDeck.slice(0, 8);

  return (
    <section>
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-xs uppercase tracking-widest text-dark-400">Exam forecast</h2>
        <div className="text-2xs uppercase tracking-widest font-mono text-dark-500 tabular-nums">
          {new Date(summary.targetDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
          {' · '}
          <span className="text-dark-300">{daysUntil}d</span>
          {' · '}
          <span className={cn(
            summary.overallMeanRecall >= 0.85 ? 'text-persian-300'
            : summary.overallMeanRecall >= 0.7 ? 'text-saffron-300'
            : 'text-crimson-300',
          )}>
            {(summary.overallMeanRecall * 100).toFixed(0)}% mean
          </span>
        </div>
      </div>

      {summary.cardsConsidered === 0 ? (
        <div className="text-sm text-dark-500 font-light">
          No reviewed cards yet — forecast becomes meaningful once you&rsquo;ve
          rated some cards out of the learning phase.
        </div>
      ) : (
        <>
          <div className="glass-card rounded-2xl p-4 space-y-2">
            {visible.map(d => (
              <DeckRow key={d.deckId} name={d.deckName} recall={d.meanRecall} count={d.cardCount} atRisk={d.atRisk} />
            ))}
            {summary.byDeck.length > 8 && (
              <button
                onClick={() => setShowAll(s => !s)}
                className="text-2xs uppercase tracking-widest text-dark-500 hover:text-dark-200 transition mt-1"
              >
                {showAll ? 'Show less' : `Show all ${summary.byDeck.length} decks`}
              </button>
            )}
          </div>

          {summary.atRiskCardIds.length > 0 && (
            <div className="mt-3 flex items-center justify-between gap-3">
              <div className="text-2xs uppercase tracking-widest text-dark-500">
                <span className="text-crimson-300 tabular-nums">{summary.atRiskCardIds.length.toLocaleString()}</span>{' '}
                cards below <span className="text-dark-300">{(summary.threshold * 100).toFixed(0)}%</span> on exam day
              </div>
              <Link
                href={`/trouble?source=forecast&threshold=${summary.threshold}`}
                className="text-2xs uppercase tracking-widest text-saffron-300 hover:text-saffron-200 transition"
              >
                View → Trouble
              </Link>
            </div>
          )}

          <div className="text-2xs text-dark-600 font-light mt-2 leading-relaxed">
            Forecast uses each card&rsquo;s current FSRS stability + last review to
            estimate retrievability on the exam date. Cards still in learning /
            new are excluded (no signal yet).
          </div>
        </>
      )}
    </section>
  );
}

function DeckRow({ name, recall, count, atRisk }: { name: string; recall: number; count: number; atRisk: number }) {
  const pct = Math.max(0, Math.min(1, recall));
  const tone = recall >= 0.85 ? 'persian' : recall >= 0.7 ? 'saffron' : 'crimson';
  const barColor = tone === 'persian'
    ? 'from-persian-700 via-persian-500 to-persian-300'
    : tone === 'saffron'
      ? 'from-saffron-700 via-saffron-500 to-saffron-300'
      : 'from-crimson-700 via-crimson-500 to-crimson-300';
  const textColor = tone === 'persian' ? 'text-persian-200'
    : tone === 'saffron' ? 'text-saffron-200'
    : 'text-crimson-200';
  return (
    <div className="grid grid-cols-[1fr_auto] gap-3 items-center">
      <div className="min-w-0">
        <div className="text-sm font-light text-dark-100 truncate" title={name}>{name}</div>
        <div className="h-1 rounded-full bg-dark-800/60 overflow-hidden mt-1">
          <div
            className={cn('h-full bg-gradient-to-r', barColor)}
            style={{ width: `${pct * 100}%` }}
          />
        </div>
      </div>
      <div className="flex items-baseline gap-3 text-2xs uppercase tracking-widest font-mono tabular-nums shrink-0">
        <span className={textColor}>{(pct * 100).toFixed(0)}%</span>
        <span className="text-dark-500">{count}</span>
        {atRisk > 0 && <span className="text-crimson-400">{atRisk} ↓</span>}
      </div>
    </div>
  );
}
