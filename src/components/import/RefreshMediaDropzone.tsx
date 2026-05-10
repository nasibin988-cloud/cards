'use client';

import { useCallback, useRef, useState } from 'react';
import {
  refreshMediaFromApkg,
  type RefreshMediaProgress,
  type RefreshMediaSummary,
} from '@/lib/apkg/refresh-media';
import { cn } from '@/lib/utils';

/**
 * Drop a freshly-rebuilt .apkg here to update images on existing notes
 * without touching FSRS scheduling. Matches by ankiNoteId, rewrites only
 * `note.fields.image`, and adds/replaces media blobs by filename.
 */
export default function RefreshMediaDropzone() {
  const [progress, setProgress] = useState<RefreshMediaProgress | null>(null);
  const [summary, setSummary] = useState<RefreshMediaSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file: File) => {
    setError(null);
    setSummary(null);
    setProgress({ phase: 'unzipping', message: 'Starting…' });
    try {
      const s = await refreshMediaFromApkg(file, p => setProgress(p));
      setSummary(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setProgress({ phase: 'error', message: 'Refresh failed.' });
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
        <div className="text-2xl font-extralight tracking-tight bg-gradient-to-r from-saffron-300 to-persian-200 bg-clip-text text-transparent">
          Drop the rebuilt .apkg to refresh images
        </div>
        <p className="text-dark-400 font-light mt-2 text-sm">
          Updates each note's <span className="font-mono text-dark-200">image</span> field
          and imports new image bytes. Cards, schedules, lapses, and review history
          stay exactly as they are.
        </p>
      </div>

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
                Refreshed.
              </div>
              <div className="grid grid-cols-3 gap-3">
                <Stat label="Matched notes" value={summary.matched} />
                <Stat label="Unmatched" value={summary.unmatched} />
                <Stat label="Image fields rewritten" value={summary.notesUpdatedImage} />
              </div>
              {(summary.matchedByContent > 0 || summary.matchedByAnkiId > 0) && (
                <div className="text-2xs text-dark-500 font-light pt-1 text-center">
                  matched via{' '}
                  <span className="text-dark-300 font-mono">ankiNoteId</span>: {summary.matchedByAnkiId.toLocaleString()}
                  {' · '}
                  <span className="text-dark-300 font-mono">content</span>: {summary.matchedByContent.toLocaleString()}
                </div>
              )}
              <div className="grid grid-cols-3 gap-3 pt-1">
                <Stat label="Media added" value={summary.mediaAdded} />
                <Stat label="Media replaced" value={summary.mediaReplaced} />
                <Stat label="Media unchanged" value={summary.mediaUnchanged} />
              </div>
              {summary.unmatched > 0 && (
                <p className="text-xs text-dark-400 font-light pt-1">
                  Unmatched .apkg notes have an <span className="font-mono">ankiNoteId</span> with
                  no local counterpart — usually notes you added inside Anki since the original import.
                  They were ignored; nothing was deleted.
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
              {(progress.notesSeen !== undefined || progress.mediaSeen !== undefined) && (
                <div className="grid grid-cols-2 gap-3">
                  <Stat label="Notes seen" value={progress.notesSeen ?? 0} />
                  <Stat label="Media seen" value={progress.mediaSeen ?? 0} />
                </div>
              )}
              {progress.phase !== 'done' && progress.phase !== 'error' && (
                <div className="h-1 rounded-full bg-dark-800/40 overflow-hidden">
                  <div className="h-full bg-gradient-to-r from-saffron-700 to-persian-500 loading-shimmer" />
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
