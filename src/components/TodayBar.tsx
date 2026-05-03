'use client';

import { useEffect, useState } from 'react';
import { getTodayStudyStats, currentStreak, resetTodayStats, type TodayStudyStats } from '@/lib/db/queries';
import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui/Tooltip';

/**
 * Compact today-summary pill row shown at the top of the home page. Three
 * metrics: cards reviewed today, total study time, pace (cards/min). A
 * fourth slot shows the current streak when it's at least one day, since
 * a zero streak isn't motivating to display.
 *
 * Re-fetches when the tab becomes visible so the numbers stay live across
 * a long study session in another tab.
 */
export default function TodayBar() {
  const [stats, setStats] = useState<TodayStudyStats | null>(null);
  const [streak, setStreak] = useState<number>(0);
  const [confirming, setConfirming] = useState(false);

  const refresh = async () => {
    const [s, st] = await Promise.all([getTodayStudyStats(), currentStreak()]);
    setStats(s);
    setStreak(st);
  };

  useEffect(() => {
    let alive = true;
    const refreshIfAlive = async () => {
      const [s, st] = await Promise.all([getTodayStudyStats(), currentStreak()]);
      if (!alive) return;
      setStats(s);
      setStreak(st);
    };
    refreshIfAlive();
    const onVisible = () => { if (document.visibilityState === 'visible') refreshIfAlive(); };
    document.addEventListener('visibilitychange', onVisible);
    const t = setInterval(refreshIfAlive, 60_000);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(t);
    };
  }, []);

  const doReset = async () => {
    await resetTodayStats();
    setConfirming(false);
    await refresh();
  };

  if (!stats) return null;
  if (stats.count === 0 && streak === 0) return null;

  const minutes = stats.totalMs / 60_000;
  const minutesLabel = minutes < 1
    ? `${Math.round(stats.totalMs / 1000)}s`
    : `${minutes.toFixed(minutes < 10 ? 1 : 0)}m`;
  const paceLabel = stats.perMinute >= 1
    ? `${stats.perMinute.toFixed(1)} /min`
    : stats.secondsPerCard > 0
      ? `${stats.secondsPerCard.toFixed(1)}s /card`
      : '—';

  return (
    <div className="mb-5 flex items-center gap-2.5 flex-wrap">
      <Pill label="Today" value={stats.count.toLocaleString()} sub="cards" tone="saffron" />
      <Pill label="Time" value={minutesLabel} sub="" tone="persian" />
      <Pill label="Pace" value={paceLabel} sub="" tone="crimson" />
      {streak > 0 && (
        <Pill label="Streak" value={streak.toString()} sub={streak === 1 ? 'day' : 'days'} tone="saffron" />
      )}
      {stats.count > 0 && (
        confirming ? (
          <span className="inline-flex items-baseline gap-1.5 px-3 py-1.5 rounded-xl bg-crimson-900/20 border border-crimson-800/30">
            <span className="text-2xs uppercase tracking-widest text-crimson-300">Reset?</span>
            <button
              onClick={doReset}
              className="text-xs text-crimson-200 hover:text-crimson-100 font-light"
            >
              Yes
            </button>
            <button
              onClick={() => setConfirming(false)}
              className="text-xs text-dark-400 hover:text-dark-200 font-light"
            >
              Cancel
            </button>
          </span>
        ) : (
          <Tooltip content="Reset today's count to zero (keeps the underlying review history; streak unaffected)" side="bottom">
            <button
              onClick={() => setConfirming(true)}
              aria-label="Reset today's count"
              className="px-2.5 py-1.5 rounded-xl bg-dark-800/30 border border-white/[0.04] text-dark-500 hover:text-dark-200 hover:bg-white/[0.04] transition text-sm leading-none"
            >
              ↺
            </button>
          </Tooltip>
        )
      )}
    </div>
  );
}

function Pill({ label, value, sub, tone }: { label: string; value: string; sub: string; tone: 'saffron' | 'crimson' | 'persian' }) {
  const toneClass = tone === 'saffron' ? 'text-saffron-300'
    : tone === 'crimson' ? 'text-crimson-300'
    : 'text-persian-200';
  return (
    <div className="px-3 py-1.5 rounded-xl bg-dark-800/30 border border-white/[0.04] inline-flex items-baseline gap-2">
      <span className="text-2xs uppercase tracking-widest text-dark-500">{label}</span>
      <span className={cn('text-sm font-light tabular-nums', toneClass)}>{value}</span>
      {sub && <span className="text-2xs text-dark-500 font-light">{sub}</span>}
    </div>
  );
}
