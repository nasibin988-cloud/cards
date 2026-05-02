'use client';

import { cn } from '@/lib/utils';
import type { Rating } from '@/lib/db/schema';
import type { ScheduledRating } from '@/lib/fsrs/scheduler';

interface Props {
  intervals: ScheduledRating[];
  onRate: (rating: Rating) => void;
  disabled?: boolean;
}

const META: Record<Rating, { label: string; keys: string[]; tone: string }> = {
  1: {
    label: 'Again',
    keys: ['1', 'J'],
    tone: 'from-crimson-700 to-crimson-900 hover:from-crimson-600 hover:to-crimson-800',
  },
  2: {
    label: 'Hard',
    keys: ['2', 'K'],
    tone: 'from-saffron-800 to-saffron-900 hover:from-saffron-700 hover:to-saffron-800',
  },
  3: {
    label: 'Good',
    keys: ['3', 'L'],
    tone: 'from-persian-700 to-persian-900 hover:from-persian-600 hover:to-persian-800',
  },
  4: {
    label: 'Easy',
    keys: ['4', ';'],
    tone: 'from-saffron-700 via-persian-700 to-saffron-700 hover:brightness-125',
  },
};

export default function RatingButtons({ intervals, onRate, disabled }: Props) {
  return (
    <div className="grid grid-cols-4 gap-2 md:gap-3 w-full">
      {([1, 2, 3, 4] as const).map(rating => {
        const interval = intervals.find(i => i.rating === rating);
        const meta = META[rating];
        return (
          <button
            key={rating}
            onClick={() => onRate(rating)}
            disabled={disabled}
            className={cn(
              'group relative flex flex-col items-center justify-center min-h-[5.5rem] md:min-h-[6.5rem] py-4 md:py-5 px-3 rounded-2xl border border-white/[0.06]',
              'bg-gradient-to-br text-dark-50 transition shadow-glass',
              'hover:scale-[1.015] active:scale-[0.99]',
              'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100',
              meta.tone,
            )}
          >
            <span className="text-xs uppercase tracking-widest font-light text-white/75">
              {meta.label}
            </span>
            <span className="text-lg md:text-xl font-extralight tracking-tight mt-1">
              {interval?.intervalLabel ?? '—'}
            </span>
            <span className="absolute top-2 right-2 flex gap-1">
              {meta.keys.map(k => (
                <kbd
                  key={k}
                  className="text-2xs text-white/40 font-mono px-1 py-0.5 rounded bg-black/20"
                >
                  {k}
                </kbd>
              ))}
            </span>
          </button>
        );
      })}
    </div>
  );
}
