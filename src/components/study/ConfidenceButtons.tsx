'use client';

import { cn } from '@/lib/utils';
import type { Rating } from '@/lib/db/schema';
import type { ScheduledRating } from '@/lib/fsrs/scheduler';

interface Props {
  intervals: ScheduledRating[];
  onRate: (rating: Rating) => void;
  disabled?: boolean;
}

/**
 * Binary "knew it / didn't" rating that maps to FSRS Good (3) / Again (1).
 * Used when settings.study_confidence_mode is on. Shaves decision fatigue
 * for long sessions; the lost Hard/Easy ratings are usually misused anyway.
 */
export default function ConfidenceButtons({ intervals, onRate, disabled }: Props) {
  const again = intervals.find(i => i.rating === 1);
  const good = intervals.find(i => i.rating === 3);

  return (
    <div className="grid grid-cols-2 gap-3 md:gap-4 w-full">
      <button
        onClick={() => onRate(1)}
        disabled={disabled}
        className={cn(
          'group relative flex flex-col items-center justify-center min-h-[5.5rem] md:min-h-[6.5rem] py-4 md:py-5 px-3 rounded-2xl border border-white/[0.06]',
          'bg-gradient-to-br from-crimson-700 to-crimson-900 hover:from-crimson-600 hover:to-crimson-800',
          'text-dark-50 transition shadow-glass',
          'hover:scale-[1.015] active:scale-[0.99]',
          'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100',
        )}
      >
        <span className="text-xs uppercase tracking-widest font-light text-white/75">Didn&rsquo;t</span>
        <span className="text-lg md:text-xl font-extralight tracking-tight mt-1">
          {again?.intervalLabel ?? '—'}
        </span>
        <span className="absolute top-2 right-2 flex gap-1">
          <kbd className="text-2xs text-white/40 font-mono px-1 py-0.5 rounded bg-black/20">J</kbd>
        </span>
      </button>
      <button
        onClick={() => onRate(3)}
        disabled={disabled}
        className={cn(
          'group relative flex flex-col items-center justify-center min-h-[5.5rem] md:min-h-[6.5rem] py-4 md:py-5 px-3 rounded-2xl border border-white/[0.06]',
          'bg-gradient-to-br from-persian-700 to-persian-900 hover:from-persian-600 hover:to-persian-800',
          'text-dark-50 transition shadow-glass',
          'hover:scale-[1.015] active:scale-[0.99]',
          'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100',
        )}
      >
        <span className="text-xs uppercase tracking-widest font-light text-white/75">Knew it</span>
        <span className="text-lg md:text-xl font-extralight tracking-tight mt-1">
          {good?.intervalLabel ?? '—'}
        </span>
        <span className="absolute top-2 right-2 flex gap-1">
          <kbd className="text-2xs text-white/40 font-mono px-1 py-0.5 rounded bg-black/20">L</kbd>
        </span>
      </button>
    </div>
  );
}
