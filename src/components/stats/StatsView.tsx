'use client';

import { useEffect, useState } from 'react';
import {
  retentionWindow,
  reviewsByDay,
  reviewsOnDay,
  totalReviewsToday,
  listDecks,
  getDeckCounts,
  dueForecast,
  currentStreak,
  tagRetention,
  cardMaturity,
  reviewsByHourOfWeek,
  type CardMaturity,
  type TagRetention,
} from '@/lib/db/queries';
import type { Deck, ReviewLog } from '@/lib/db/schema';
import { Tooltip } from '@/components/ui/Tooltip';
import MaturityDonut from './MaturityDonut';
import HourOfWeekHeatmap from './HourOfWeekHeatmap';
import ExamForecast from './ExamForecast';

interface DueForecast {
  deckId: string;
  deckName: string;
  newCount: number;
  due: number[];     // length 7, due in days 0..6
}

export default function StatsView() {
  const [retention, setRetention] = useState<{ total: number; correct: number; rate: number } | null>(null);
  const [today, setToday] = useState<number>(0);
  const [streak, setStreak] = useState<number>(0);
  const [heatmap, setHeatmap] = useState<{ day: string; count: number }[]>([]);
  const [forecasts, setForecasts] = useState<DueForecast[]>([]);
  const [tagStats, setTagStats] = useState<TagRetention[]>([]);
  const [maturity, setMaturity] = useState<CardMaturity | null>(null);
  const [hourGrid, setHourGrid] = useState<number[][] | null>(null);
  const [drilldown, setDrilldown] = useState<{ day: string; logs: ReviewLog[] } | null>(null);

  useEffect(() => {
    (async () => {
      const ret = await retentionWindow(30);
      setRetention(ret);
      setToday(await totalReviewsToday());
      setStreak(await currentStreak());

      const end = new Date();
      const start = new Date();
      start.setDate(end.getDate() - 364);
      const map = await reviewsByDay(start, end);
      const heat: { day: string; count: number }[] = [];
      for (let i = 0; i < 365; i++) {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        const key = d.toISOString().split('T')[0];
        heat.push({ day: key, count: map.get(key) ?? 0 });
      }
      setHeatmap(heat);

      const decks: Deck[] = await listDecks();
      const fcs: DueForecast[] = [];
      for (const d of decks.slice(0, 10)) {
        const [c0, due] = await Promise.all([
          getDeckCounts(d.id, new Date()),
          dueForecast(d.id, 7),
        ]);
        fcs.push({
          deckId: d.id,
          deckName: d.name,
          newCount: c0.new,
          due,
        });
      }
      setForecasts(fcs);

      setTagStats(await tagRetention(20));
      setMaturity(await cardMaturity());
      setHourGrid(await reviewsByHourOfWeek(90));
    })();
  }, []);

  const onCellClick = async (dayKey: string) => {
    const logs = await reviewsOnDay(new Date(dayKey));
    setDrilldown({ day: dayKey, logs });
  };

  return (
    <div className="space-y-8">
      <div className="grid md:grid-cols-4 gap-4">
        <Card label="Reviews today" value={today.toLocaleString()} />
        <Card
          label="Streak"
          value={streak === 0 ? '—' : `${streak}d`}
          sub={streak >= 7 ? 'Keep it going.' : undefined}
        />
        <Card
          label="Retention 30d"
          value={retention && retention.total > 0 ? `${(retention.rate * 100).toFixed(1)}%` : '—'}
          sub={retention ? `${retention.correct}/${retention.total} reviews` : undefined}
        />
        <Card
          label="Total 30d"
          value={retention ? retention.total.toLocaleString() : '—'}
        />
      </div>

      {/* Renders itself out (null) when no exam_date is configured —
          zero footprint for users who aren't using the feature. */}
      <ExamForecast />

      {maturity && maturity.total > 0 && (
        <section>
          <h2 className="text-xs uppercase tracking-widest text-dark-400 mb-3">Card maturity</h2>
          <div className="glass-card rounded-2xl p-5">
            <MaturityDonut maturity={maturity} />
          </div>
        </section>
      )}

      {hourGrid && hourGrid.flat().some(n => n > 0) && (
        <section>
          <h2 className="text-xs uppercase tracking-widest text-dark-400 mb-3">When you study (last 90 days)</h2>
          <div className="glass-card rounded-2xl p-5 overflow-x-auto">
            <HourOfWeekHeatmap grid={hourGrid} />
          </div>
        </section>
      )}

      <section>
        <h2 className="text-xs uppercase tracking-widest text-dark-400 mb-3">Activity (last year)</h2>
        <div className="glass-card rounded-2xl p-4 overflow-x-auto">
          <Heatmap data={heatmap} onClick={onCellClick} />
        </div>
        {drilldown && (
          <div className="glass-card rounded-2xl p-4 mt-3 space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-light text-dark-100">
                {drilldown.day} · {drilldown.logs.length} review{drilldown.logs.length === 1 ? '' : 's'}
              </h3>
              <button
                onClick={() => setDrilldown(null)}
                className="text-2xs uppercase tracking-widest text-dark-400 hover:text-dark-100 transition"
              >
                Close
              </button>
            </div>
            {drilldown.logs.length === 0 ? (
              <p className="text-sm text-dark-400 font-light">No reviews this day.</p>
            ) : (
              <div className="grid grid-cols-4 gap-2 text-2xs uppercase tracking-widest font-mono text-dark-500">
                <div>Again: <span className="text-crimson-300">{drilldown.logs.filter(l => l.rating === 1).length}</span></div>
                <div>Hard: <span className="text-saffron-300">{drilldown.logs.filter(l => l.rating === 2).length}</span></div>
                <div>Good: <span className="text-persian-300">{drilldown.logs.filter(l => l.rating === 3).length}</span></div>
                <div>Easy: <span className="text-saffron-200">{drilldown.logs.filter(l => l.rating === 4).length}</span></div>
              </div>
            )}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-xs uppercase tracking-widest text-dark-400 mb-3">Upcoming load (next 7 days)</h2>
        <div className="glass-card rounded-2xl divide-y divide-white/[0.04]">
          {forecasts.length === 0 ? (
            <div className="px-5 py-6 text-sm text-dark-400">No decks yet.</div>
          ) : (
            forecasts.map(fc => (
              <div key={fc.deckId} className="px-5 py-4 flex items-center justify-between gap-6">
                <div className="min-w-0">
                  <div className="text-sm font-light text-dark-100 truncate">{fc.deckName}</div>
                  <div className="text-2xs uppercase tracking-widest text-dark-500 mt-0.5">
                    {fc.newCount} new · today {fc.due[0]}
                  </div>
                </div>
                <div className="flex items-end gap-1 h-12">
                  {fc.due.map((n, i) => {
                    const max = Math.max(1, ...fc.due);
                    const h = (n / max) * 100;
                    return (
                      <Tooltip key={i} content={`Day +${i}: ${n}`}>
                        <div
                          className="w-3 rounded-sm bg-gradient-to-t from-persian-700 to-saffron-500"
                          style={{ height: `${h}%`, minHeight: n > 0 ? '4px' : '2px', opacity: n > 0 ? 1 : 0.2 }}
                        />
                      </Tooltip>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      {tagStats.length > 0 && (
        <section>
          <h2 className="text-xs uppercase tracking-widest text-dark-400 mb-3">
            Retention by tag (≥ 20 reviews)
          </h2>
          <div className="glass-card rounded-2xl divide-y divide-white/[0.04]">
            {tagStats.slice(0, 25).map(t => (
              <div key={t.tag} className="px-5 py-2.5 flex items-center justify-between gap-4">
                <div className="text-2xs font-mono text-dark-200 truncate">{t.tag}</div>
                <div className="flex items-center gap-3 shrink-0">
                  <div className="text-2xs text-dark-500 font-mono">{t.reviews}</div>
                  <div
                    className={
                      t.retention >= 0.9 ? 'text-saffron-200 font-mono' :
                      t.retention >= 0.75 ? 'text-persian-200 font-mono' :
                      'text-crimson-300 font-mono'
                    }
                  >
                    {(t.retention * 100).toFixed(1)}%
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function Card({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="glass-card rounded-2xl p-5">
      <div className="text-2xs uppercase tracking-widest text-dark-400">{label}</div>
      <div className="text-3xl font-extralight tracking-tight mt-1.5">{value}</div>
      {sub && <div className="text-xs text-dark-500 font-light mt-1">{sub}</div>}
    </div>
  );
}

function Heatmap({
  data,
  onClick,
}: {
  data: { day: string; count: number }[];
  onClick?: (dayKey: string) => void;
}) {
  // Layout: columns = weeks, rows = day-of-week (Sun..Sat)
  const columns: { day: string; count: number; w: number; d: number }[][] = [];
  for (let i = 0; i < data.length; i++) {
    const date = new Date(data[i].day);
    const dow = date.getDay(); // 0..6
    const weekIdx = Math.floor(i / 7);
    if (!columns[weekIdx]) columns[weekIdx] = [];
    columns[weekIdx].push({ day: data[i].day, count: data[i].count, w: weekIdx, d: dow });
  }

  const maxCount = Math.max(1, ...data.map(d => d.count));
  const tone = (n: number): string => {
    if (n === 0) return 'heat-0';
    const r = n / maxCount;
    if (r > 0.66) return 'heat-4';
    if (r > 0.33) return 'heat-3';
    if (r > 0.10) return 'heat-2';
    return 'heat-1';
  };

  return (
    <div className="inline-flex gap-[3px]">
      {columns.map((col, i) => (
        <div key={i} className="grid grid-rows-7 gap-[3px]">
          {Array.from({ length: 7 }).map((_, dow) => {
            const cell = col.find(c => c.d === dow);
            const tip = cell ? `${cell.day}: ${cell.count}` : '';
            return (
              <Tooltip key={dow} content={tip || null}>
                <button
                  disabled={!cell || !onClick}
                  onClick={() => cell && onClick?.(cell.day)}
                  className={`w-2.5 h-2.5 rounded-sm ${cell ? tone(cell.count) : 'heat-0'} ${onClick && cell ? 'hover:ring-1 hover:ring-saffron-400/60 cursor-pointer' : 'cursor-default'}`}
                  aria-label={tip}
                />
              </Tooltip>
            );
          })}
        </div>
      ))}
    </div>
  );
}
