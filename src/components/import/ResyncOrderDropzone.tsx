'use client';

import { useCallback, useRef, useState } from 'react';
import {
  resyncOrderFromApkg,
  type ResyncProgress,
  type ResyncSummary,
} from '@/lib/apkg/resync-order';
import { cn } from '@/lib/utils';

export default function ResyncOrderDropzone() {
  const [progress, setProgress] = useState<ResyncProgress | null>(null);
  const [summary, setSummary] = useState<ResyncSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file: File) => {
    setError(null);
    setSummary(null);
    setProgress({ phase: 'unzipping', message: 'Starting…' });
    try {
      const s = await resyncOrderFromApkg(file, p => setProgress(p));
      setSummary(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setProgress({ phase: 'error', message: 'Resync failed.' });
    }
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    if (!file.name.endsWith('.apkg')) {
      setError('That file is not a .apkg.');
      return;
    }
    handleFile(file);
  }, [handleFile]);

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  const busy = progress !== null && progress.phase !== 'done' && progress.phase !== 'error';

  return (
    <div className="space-y-5">
      <div
        onDragEnter={e => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={e => { e.preventDefault(); setIsDragging(false); }}
        onDragOver={e => e.preventDefault()}
        onDrop={onDrop}
        className={cn(
          'glass-card rounded-2xl p-10 text-center transition cursor-pointer border-2 border-dashed',
          isDragging
            ? 'border-persian-400/50 bg-persian-900/10'
            : 'border-white/[0.06] hover:border-white/[0.12]',
        )}
        onClick={() => inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".apkg"
          className="hidden"
          onChange={onPick}
          disabled={busy}
        />
        <div className="text-2xl font-extralight tracking-tight bg-gradient-to-r from-persian-300 to-saffron-200 bg-clip-text text-transparent">
          Drop the same .apkg to resync order
        </div>
        <p className="text-dark-400 font-light mt-2 text-sm">
          Rewrites <span className="font-mono text-dark-200">createdAt</span> on existing
          notes &amp; cards to match Anki's authoring order. FSRS state is preserved.
        </p>
      </div>

      {(progress || summary) && (
        <div
          className={cn(
            'glass-card rounded-2xl p-6 space-y-3',
            summary && 'border border-persian-700/30',
          )}
        >
          {summary ? (
            <>
              <div className="text-2xl font-extralight tracking-tight text-persian-200">
                Resynced.
              </div>
              <div className="grid grid-cols-4 gap-3">
                <Stat label="In .apkg" value={summary.ankiNoteCount} />
                <Stat label="In app" value={summary.appNoteCount} />
                <Stat label="Matched" value={summary.matched} />
                <Stat label="Unmatched" value={summary.unmatched} />
              </div>
              {summary.unmatched > 0 && (
                <p className="text-xs text-dark-400 font-light pt-1">
                  Unmatched notes are usually ones added or edited inside the app
                  after import — they keep their existing <span className="font-mono">createdAt</span>.
                </p>
              )}
            </>
          ) : progress ? (
            <>
              <div className="flex items-center justify-between">
                <div className="text-sm font-light text-dark-100">{progress.message}</div>
                <div className="text-2xs uppercase tracking-widest text-dark-500 font-mono">
                  {progress.phase}
                </div>
              </div>
              {(progress.matched !== undefined || progress.unmatched !== undefined) && (
                <div className="grid grid-cols-3 gap-3">
                  <Stat label="Matched" value={progress.matched ?? 0} />
                  <Stat label="Unmatched" value={progress.unmatched ?? 0} />
                  <Stat label="Total" value={progress.total ?? 0} />
                </div>
              )}
              {progress.phase !== 'done' && progress.phase !== 'error' && (
                <div className="h-1 rounded-full bg-dark-800/40 overflow-hidden">
                  <div className="h-full bg-gradient-to-r from-persian-700 to-saffron-500 loading-shimmer" />
                </div>
              )}
            </>
          ) : null}
        </div>
      )}

      {error && (
        <div className="glass-card rounded-2xl p-6 border border-crimson-700/30">
          <div className="text-sm text-crimson-200 font-light">{error}</div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="text-center">
      <div className="text-lg font-light text-dark-100">{value.toLocaleString()}</div>
      <div className="text-2xs uppercase tracking-widest text-dark-500 mt-0.5">{label}</div>
    </div>
  );
}
