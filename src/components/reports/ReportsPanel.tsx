'use client';

import { useEffect, useRef, useState } from 'react';
import {
  generateDailyReport,
  generateDeckReport,
  listArchivedReports,
  readArchivedReport,
  downloadBlob,
  type ArchivedReport,
  type GenerateProgress,
} from '@/lib/reports/orchestrate';
import { cn } from '@/lib/utils';

/**
 * Two-mode reports surface:
 *   - daily: button kicks off a today's-activity report.
 *   - deck: button kicks off a per-deck overview (caller supplies deckIds).
 *
 * Below the trigger, a list of previously-archived reports lets the
 * user re-open past days without regenerating. Progress shows live
 * stages from the orchestrator with a soft gradient bar.
 */

interface Props {
  mode: 'daily' | 'deck';
  /** Required when mode === 'deck'. */
  deckIds?: string[];
  /** Optional label shown next to the trigger button. */
  deckLabel?: string;
}

export default function ReportsPanel({ mode, deckIds, deckLabel }: Props) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<GenerateProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [archive, setArchive] = useState<ArchivedReport[] | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    void refreshArchive();
  }, []);

  const refreshArchive = async () => {
    const list = await listArchivedReports();
    setArchive(list);
  };

  const run = async () => {
    if (running) return;
    setRunning(true);
    setError(null);
    setProgress({ phase: 'gather', message: 'Pulling cards…' });
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const result = mode === 'daily'
        ? await generateDailyReport({ signal: ac.signal, onProgress: p => setProgress(p) })
        : await generateDeckReport(deckIds ?? [], { signal: ac.signal, onProgress: p => setProgress(p) });
      downloadBlob(result.blob, result.filename);
      await refreshArchive();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
      abortRef.current = null;
      setProgress(null);
    }
  };

  const reopen = async (name: string) => {
    const blob = await readArchivedReport(name);
    if (!blob) {
      setError(`Could not read ${name}. It may have been cleared.`);
      return;
    }
    downloadBlob(blob, name);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={run}
          disabled={running || (mode === 'deck' && (!deckIds || deckIds.length === 0))}
          className="btn-gradient px-5 py-2.5 rounded-2xl text-sm uppercase tracking-[0.2em] font-light inline-flex items-center gap-2 disabled:opacity-50"
        >
          {running && <Spinner />}
          {mode === 'daily'
            ? (running ? "Building today's report" : "Build today's report")
            : (running ? 'Building deck report' : `Build report${deckLabel ? `: ${deckLabel}` : ''}`)}
        </button>
        {running && (
          <button
            onClick={() => abortRef.current?.abort()}
            className="text-2xs uppercase tracking-widest text-dark-400 hover:text-dark-100 transition"
          >
            Cancel
          </button>
        )}
      </div>

      {(running || progress) && progress && (
        <div className="space-y-2">
          <div className="text-2xs uppercase tracking-widest text-dark-400 font-mono tabular-nums">
            {progress.message}
          </div>
          <div className="h-1 rounded-full bg-dark-800/40 overflow-hidden">
            <div className="h-full bg-gradient-to-r from-saffron-600 via-saffron-400 to-persian-400 loading-shimmer" />
          </div>
        </div>
      )}

      {error && (
        <div className="text-xs text-crimson-300 font-light bg-crimson-900/20 border border-crimson-800/30 rounded-xl p-3">
          {error}
        </div>
      )}

      {archive && archive.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-2xs uppercase tracking-widest text-dark-500">Past reports</div>
          <ul className="divide-y divide-white/[0.04] rounded-2xl border border-white/[0.04] overflow-hidden">
            {archive.slice(0, 10).map(r => (
              <li key={r.filename} className="flex items-center justify-between gap-3 px-3 py-2 hover:bg-white/[0.02] transition">
                <div className="min-w-0">
                  <div className="text-sm text-dark-100 font-light truncate">{r.filename}</div>
                  <div className="text-2xs text-dark-500 font-mono tabular-nums">
                    {(r.size / 1024).toFixed(0)} KB · {new Date(r.modified).toLocaleString()}
                  </div>
                </div>
                <button
                  onClick={() => reopen(r.filename)}
                  className="text-2xs uppercase tracking-widest text-saffron-300 hover:text-saffron-200 transition shrink-0"
                >
                  Re-open
                </button>
              </li>
            ))}
          </ul>
          {archive.length > 10 && (
            <div className="text-2xs text-dark-500 font-light pt-1">
              {archive.length - 10} older report{archive.length - 10 === 1 ? '' : 's'} omitted from this view.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <svg className={cn('animate-spin')} width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
