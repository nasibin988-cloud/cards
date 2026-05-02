'use client';

import { cn } from '@/lib/utils';

export type AlertTone = 'error' | 'warning' | 'info';

/**
 * Single-look inline alert. Drop-in for ad-hoc text like
 *   <div className="text-2xs text-crimson-300 font-light">{error}</div>
 * so error rendering is consistent across pages.
 */
export default function InlineAlert({
  tone = 'error', children, className,
}: {
  tone?: AlertTone;
  children: React.ReactNode;
  className?: string;
}) {
  const cls = tone === 'error'
    ? 'text-crimson-300 bg-crimson-900/15 border-crimson-700/30'
    : tone === 'warning'
    ? 'text-saffron-300 bg-saffron-900/15 border-saffron-700/30'
    : 'text-persian-200 bg-persian-900/15 border-persian-700/30';
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'rounded-xl border px-3 py-2 text-2xs font-light leading-relaxed',
        cls,
        className,
      )}
    >
      {children}
    </div>
  );
}
