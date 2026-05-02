'use client';

import Link from 'next/link';
import { useCallback, useRef, useState } from 'react';
import { importApkg, type ImportProgress, type ImportSummary } from '@/lib/apkg/importer';
import { cn } from '@/lib/utils';

export default function ApkgDropzone() {
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file: File) => {
    setError(null);
    setSummary(null);
    setProgress({ phase: 'unzipping', message: 'Starting…' });
    try {
      const s = await importApkg(file, p => setProgress(p));
      setSummary(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setProgress({ phase: 'error', message: 'Import failed.' });
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
          'glass-card rounded-2xl p-12 text-center transition cursor-pointer border-2 border-dashed',
          isDragging
            ? 'border-saffron-400/50 bg-saffron-900/10'
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
        <div className="text-3xl font-extralight tracking-tight bg-gradient-to-r from-saffron-300 to-persian-300 bg-clip-text text-transparent">
          Drop an .apkg here
        </div>
        <p className="text-dark-400 font-light mt-2 text-sm">
          or click to choose a file
        </p>
      </div>

      {/* Single progress/summary card. While running it shows phase + counts;
          once done it morphs into the success state in place. */}
      {(progress || summary) && (
        <div
          className={cn(
            'glass-card rounded-2xl p-6 space-y-3',
            summary && 'border border-saffron-700/30',
          )}
        >
          {summary ? (
            <>
              <div className="text-2xl font-extralight tracking-tight text-saffron-200">
                Imported.
              </div>
              <div className="grid grid-cols-4 gap-3">
                <Stat label="Decks" value={summary.deckCount} />
                <Stat label="Notes" value={summary.noteCount} />
                <Stat label="Cards" value={summary.cardCount} />
                <Stat label="Media" value={summary.mediaCount} />
              </div>
              <div className="flex gap-2 pt-2">
                <Link href={`/deck/${summary.primaryDeckId}`} className="btn-gradient px-4 py-2 rounded-xl text-sm">
                  Open primary deck
                </Link>
                <Link href="/" className="px-4 py-2 rounded-xl text-sm text-dark-200 hover:text-dark-50 hover:bg-white/[0.04] transition border border-white/[0.06]">
                  All decks
                </Link>
              </div>
            </>
          ) : progress ? (
            <>
              <div className="flex items-center justify-between">
                <div className="text-sm font-light text-dark-100">{progress.message}</div>
                <div className="text-2xs uppercase tracking-widest text-dark-500 font-mono">
                  {progress.phase}
                </div>
              </div>
              {(progress.notesSeen !== undefined || progress.cardsSeen !== undefined || progress.mediaSeen !== undefined) && (
                <div className="grid grid-cols-3 gap-3">
                  <Stat label="Notes" value={progress.notesSeen ?? 0} />
                  <Stat label="Cards" value={progress.cardsSeen ?? 0} />
                  <Stat label="Media" value={progress.mediaSeen ?? 0} />
                </div>
              )}
              {progress.phase !== 'done' && progress.phase !== 'error' && (
                <div className="h-1 rounded-full bg-dark-800/40 overflow-hidden">
                  <div className="h-full bg-gradient-to-r from-crimson-700 to-saffron-500 loading-shimmer" />
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
