'use client';

import { cn } from '@/lib/utils';

/**
 * Single-look skeleton row for loading lists. Placeholder shimmer drawn from
 * the `loading-shimmer` utility already in globals.css.
 */
export function SkeletonRow({
  height = 'h-12', className,
}: {
  height?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'rounded-2xl loading-shimmer',
        height,
        className,
      )}
      aria-hidden
    />
  );
}

export function SkeletonList({
  count = 4, height = 'h-12', className,
}: {
  count?: number;
  height?: string;
  className?: string;
}) {
  return (
    <div className={cn('space-y-3', className)} aria-busy="true" aria-live="polite">
      {Array.from({ length: count }, (_, i) => (
        <SkeletonRow key={i} height={height} />
      ))}
    </div>
  );
}
