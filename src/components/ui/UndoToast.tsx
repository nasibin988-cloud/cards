'use client';

import { useEffect, useState } from 'react';

export interface UndoToastProps {
  message: string;
  onUndo: () => void;
  onDismiss: () => void;
  durationMs?: number;
}

/**
 * Bottom-of-viewport toast with a single Undo affordance.
 * Auto-dismisses after `durationMs` (default 10s).
 */
export default function UndoToast({
  message,
  onUndo,
  onDismiss,
  durationMs = 10_000,
}: UndoToastProps) {
  const [remaining, setRemaining] = useState(durationMs);

  useEffect(() => {
    const start = Date.now();
    const i = setInterval(() => {
      const left = Math.max(0, durationMs - (Date.now() - start));
      setRemaining(left);
      if (left <= 0) {
        clearInterval(i);
        onDismiss();
      }
    }, 100);
    return () => clearInterval(i);
  }, [durationMs, onDismiss]);

  const pct = (remaining / durationMs) * 100;

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 pointer-events-none">
      <div className="glass-card rounded-2xl px-5 py-3 flex items-center gap-4 pointer-events-auto shadow-2xl border border-white/[0.06] min-w-[280px] relative overflow-hidden">
        <div className="absolute bottom-0 left-0 h-0.5 bg-saffron-400/60 transition-all" style={{ width: `${pct}%` }} />
        <span className="text-sm font-light text-dark-100 flex-1">{message}</span>
        <button
          onClick={() => { onUndo(); onDismiss(); }}
          className="text-2xs uppercase tracking-[0.2em] font-light text-saffron-300 hover:text-saffron-200 transition"
        >
          Undo
        </button>
        <button
          onClick={onDismiss}
          className="text-dark-400 hover:text-dark-100 transition text-lg leading-none"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
    </div>
  );
}
