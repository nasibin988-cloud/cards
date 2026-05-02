'use client';

import { useEffect, useState } from 'react';
import type { DeckRetentionReport } from '@/lib/fsrs/analyze';
import { Tooltip } from '@/components/ui/Tooltip';

export interface RetentionTuneToastProps {
  report: DeckRetentionReport;
  onApply: () => Promise<void> | void;
  onDismiss: () => void;
}

/**
 * Drops down from the top of the Reviewer when this deck's observed
 * retention has drifted ≥5pp from the target. Single primary action ("Apply
 * suggested retention") plus a Dismiss. The parent stores a "don't show
 * again for 7 days" flag on dismissal.
 */
export default function RetentionTuneToast({
  report, onApply, onDismiss,
}: RetentionTuneToastProps) {
  const [busy, setBusy] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Slide in on mount.
    const t = setTimeout(() => setVisible(true), 50);
    return () => clearTimeout(t);
  }, []);

  if (
    report.observedRetention === null ||
    report.recommendedRetentionTarget === null
  ) return null;

  const observed = Math.round(report.observedRetention * 100);
  const target = Math.round(report.currentRetentionTarget * 100);
  const recommended = Math.round(report.recommendedRetentionTarget * 100);
  const delta = report.delta ?? 0;

  return (
    <div
      className={`fixed top-16 left-1/2 -translate-x-1/2 z-30 transition-all duration-300 ${
        visible ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-2'
      }`}
    >
      <div className="glass-card rounded-2xl px-5 py-3 flex items-center gap-4 border border-white/[0.08] shadow-2xl max-w-2xl">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="text-sm font-light text-dark-100">
            Retention drift detected
          </span>
          <span className="text-2xs uppercase tracking-widest font-mono text-dark-500 tabular-nums">
            obs {observed}% · target {target}% · {delta >= 0 ? '+' : ''}{(delta * 100).toFixed(1)}pp
          </span>
        </div>
        <Tooltip content={report.reasoning} side="bottom">
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try { await onApply(); } finally { setBusy(false); }
            }}
            className="btn-gradient px-3 py-1.5 rounded-lg text-2xs uppercase tracking-[0.2em] font-light shrink-0 disabled:opacity-50"
          >
            {busy ? 'Applying…' : `Apply ${recommended}%`}
          </button>
        </Tooltip>
        <button
          onClick={onDismiss}
          className="text-2xs uppercase tracking-[0.2em] font-light text-dark-400 hover:text-dark-100 transition shrink-0"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
