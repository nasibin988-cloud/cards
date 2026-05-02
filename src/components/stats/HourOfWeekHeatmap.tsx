'use client';

import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui/Tooltip';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HOURS = Array.from({ length: 24 }, (_, i) => i);

/**
 * 7×24 heatmap: day-of-week down, hour-of-day across. Cells colored by
 * review density. Hour labels are sparse (every 3 hours) to keep the grid
 * scannable on narrow viewports.
 */
export default function HourOfWeekHeatmap({ grid }: { grid: number[][] }) {
  const max = grid.flat().reduce((a, b) => Math.max(a, b), 0);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1 pl-9">
        {HOURS.map(h => (
          <span
            key={h}
            className="flex-1 text-2xs uppercase tracking-widest font-mono text-dark-500 text-center"
            style={{ visibility: h % 3 === 0 ? 'visible' : 'hidden' }}
          >
            {h.toString().padStart(2, '0')}
          </span>
        ))}
      </div>
      {DAYS.map((label, day) => (
        <div key={label} className="flex items-center gap-1">
          <span className="w-8 text-2xs uppercase tracking-widest font-mono text-dark-500 shrink-0">
            {label}
          </span>
          <div
            className="flex-1 grid gap-px"
            style={{ gridTemplateColumns: 'repeat(24, minmax(0, 1fr))' }}
          >
            {HOURS.map(hour => {
              const n = grid[day][hour];
              const intensity = max === 0 ? 0 : n / max;
              return (
                <Tooltip
                  key={hour}
                  content={`${label} ${hour.toString().padStart(2, '0')}:00 · ${n} review${n === 1 ? '' : 's'}`}
                >
                  <div
                    className={cn(
                      'aspect-square rounded-sm',
                      n === 0 ? 'bg-dark-800/40' : '',
                    )}
                    style={
                      n === 0
                        ? undefined
                        : {
                            // Saffron-to-persian gradient by intensity, with a
                            // floor so even one-review cells are visible.
                            background: `rgba(191, 162, 114, ${0.18 + intensity * 0.7})`,
                          }
                    }
                  />
                </Tooltip>
              );
            })}
          </div>
        </div>
      ))}
      <div className="flex items-center justify-between pt-1 text-2xs uppercase tracking-widest text-dark-500 pl-9">
        <span>Less</span>
        <div className="flex items-center gap-px h-2 flex-1 mx-3 max-w-32">
          {[0.18, 0.32, 0.46, 0.6, 0.74, 0.88].map(a => (
            <span
              key={a}
              className="flex-1 rounded-sm"
              style={{ background: `rgba(191, 162, 114, ${a})` }}
            />
          ))}
        </div>
        <span>More</span>
      </div>
    </div>
  );
}
