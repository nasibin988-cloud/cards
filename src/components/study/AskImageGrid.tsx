'use client';

import { useEffect, useState } from 'react';
import type { Card, Note, NoteFields } from '@/lib/db/schema';
import { downloadCommonsImage, searchImages } from '@/lib/ai/commands/image';
import { updateNote } from '@/lib/db/queries';
import type { ImageHit } from '@/lib/ai/commands/types';
import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui/Tooltip';

type FieldKey = keyof NoteFields;
const INSERT_TARGETS: Array<{ key: FieldKey; label: string }> = [
  { key: 'front', label: 'Front' },
  { key: 'back', label: 'Back' },
  { key: 'extra', label: 'Extra' },
  { key: 'context', label: 'Context' },
];

/**
 * Inline image-picker rendered in the assistant turn after a `/image` query.
 * Each thumbnail offers two actions:
 *   - Use: download into media + write to note.fields.image (overwrites).
 *   - Insert: append <img src="filename"> to a chosen field.
 */
export default function AskImageGrid({
  query, refinedQuery, results: initialResults, note, card, onClose,
}: {
  query: string;
  refinedQuery: string;
  results: ImageHit[];
  note: Note;
  card: Card;
  onClose?: () => void;
}) {
  const [results, setResults] = useState(initialResults);
  const [activeRefinedQuery, setActiveRefinedQuery] = useState(refinedQuery);
  const [busyIdx, setBusyIdx] = useState<number | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [insertTarget, setInsertTarget] = useState<number | null>(null);
  const [activeNote, setActiveNote] = useState<Note>(note);

  // Inline retry state.
  const [retryQuery, setRetryQuery] = useState('');
  const [retrying, setRetrying] = useState(false);

  useEffect(() => { setActiveNote(note); }, [note.id]);

  const runRetry = async (q: string) => {
    if (!q.trim()) return;
    setRetrying(true);
    try {
      const out = await searchImages(q.trim());
      setResults(out.results);
      setActiveRefinedQuery(out.effectiveQuery);
      if (out.results.length === 0) {
        showFlash(`Still nothing for "${out.effectiveQuery}".`);
      }
    } catch (e) {
      showFlash(e instanceof Error ? e.message : 'Search failed.');
    } finally {
      setRetrying(false);
    }
  };

  const showFlash = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(null), 2500);
  };

  const useAsCardImage = async (i: number) => {
    setBusyIdx(i);
    try {
      const filename = await downloadCommonsImage(results[i]);
      await updateNote(activeNote.id, {
        fields: { ...activeNote.fields, image: filename },
      });
      setActiveNote(prev => ({ ...prev, fields: { ...prev.fields, image: filename } }));
      showFlash('Set as card image.');
    } catch (e) {
      showFlash(e instanceof Error ? e.message : 'Failed to download.');
    } finally {
      setBusyIdx(null);
    }
  };

  const insertInto = async (i: number, target: FieldKey) => {
    setBusyIdx(i);
    try {
      const filename = await downloadCommonsImage(results[i]);
      const tag = `<img src="${filename}" alt="${escapeAttr(results[i].title)}" />`;
      const current = activeNote.fields[target] ?? '';
      const next = current ? `${current}\n${tag}` : tag;
      await updateNote(activeNote.id, {
        fields: { ...activeNote.fields, [target]: next },
      });
      setActiveNote(prev => ({ ...prev, fields: { ...prev.fields, [target]: next } }));
      showFlash(`Inserted into ${target}.`);
      setInsertTarget(null);
    } catch (e) {
      showFlash(e instanceof Error ? e.message : 'Failed to insert.');
    } finally {
      setBusyIdx(null);
    }
  };

  if (results.length === 0) {
    return (
      <div className="rounded-xl bg-dark-800/40 px-4 py-3 space-y-3">
        <div className="text-sm text-dark-300 font-light">
          No images found for "{activeRefinedQuery}". Wikimedia Commons treats every word as required, so try a single canonical noun (e.g. <code className="font-mono text-saffron-300">hippocampus</code> or <code className="font-mono text-saffron-300">action potential</code>).
        </div>
        <RetryRow
          value={retryQuery}
          onChange={setRetryQuery}
          onSubmit={() => runRetry(retryQuery)}
          busy={retrying}
        />
        {flash && (
          <div className="text-2xs uppercase tracking-widest text-dark-500 font-mono">{flash}</div>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-xl bg-dark-800/40 px-4 py-3">
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="text-2xs uppercase tracking-widest text-dark-400">
          Wikimedia Commons · {results.length} result{results.length === 1 ? '' : 's'}
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="text-2xs uppercase tracking-[0.2em] text-dark-500 hover:text-dark-200 transition"
          >
            Close
          </button>
        )}
      </div>
      <div className="text-2xs text-dark-500 font-mono mb-3 truncate">
        {query && query !== activeRefinedQuery ? <>“{query}” → </> : null}
        searching: {activeRefinedQuery}
      </div>
      <RetryRow
        value={retryQuery}
        onChange={setRetryQuery}
        onSubmit={() => runRetry(retryQuery)}
        busy={retrying}
        compact
      />
      <div className="grid grid-cols-2 gap-2">
        {results.map((hit, i) => (
          <div key={hit.fullUrl} className="rounded-lg overflow-hidden border border-white/[0.04] bg-dark-900/30">
            <a
              href={hit.fullUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="block aspect-square bg-dark-800 relative"
            >
              <img
                src={hit.thumbUrl}
                alt={hit.title}
                loading="lazy"
                onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0.2'; }}
                className="w-full h-full object-cover transition hover:opacity-80"
              />
            </a>
            <div className="px-2 py-1.5 space-y-1">
              <Tooltip content={hit.title}>
                <div className="text-2xs text-dark-300 font-light truncate">
                  {hit.title.replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '')}
                </div>
              </Tooltip>
              {hit.attribution && (
                <Tooltip content={hit.attribution}>
                  <div className="text-2xs text-dark-500 font-light truncate">
                    {hit.attribution}
                  </div>
                </Tooltip>
              )}
              <div className="flex gap-1 pt-1">
                <button
                  disabled={busyIdx === i}
                  onClick={() => useAsCardImage(i)}
                  className="flex-1 text-2xs uppercase tracking-[0.2em] font-light px-2 py-1 rounded text-saffron-300 hover:text-saffron-200 hover:bg-saffron-900/15 transition disabled:opacity-40"
                >
                  Use
                </button>
                <button
                  disabled={busyIdx === i}
                  onClick={() => setInsertTarget(insertTarget === i ? null : i)}
                  className="flex-1 text-2xs uppercase tracking-[0.2em] font-light px-2 py-1 rounded text-dark-300 hover:text-dark-100 hover:bg-white/[0.04] transition disabled:opacity-40"
                >
                  Insert
                </button>
              </div>
              {insertTarget === i && (
                <div className="grid grid-cols-2 gap-1 pt-1">
                  {INSERT_TARGETS.map(t => (
                    <button
                      key={t.key}
                      disabled={busyIdx === i}
                      onClick={() => insertInto(i, t.key)}
                      className={cn(
                        'text-2xs font-mono px-2 py-1 rounded transition',
                        'bg-dark-900/50 text-dark-200 hover:bg-dark-900/80 hover:text-dark-50',
                        'disabled:opacity-40',
                      )}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      {flash && (
        <div className="mt-3 text-2xs uppercase tracking-widest text-saffron-300 font-mono">
          {flash}
        </div>
      )}
    </div>
  );
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function RetryRow({
  value, onChange, onSubmit, busy, compact,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  busy: boolean;
  compact?: boolean;
}) {
  return (
    <div className={cn('flex items-center gap-2', compact && 'mt-2 mb-2')}>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); onSubmit(); } }}
        placeholder="Try another search…"
        className="flex-1 bg-dark-900/40 rounded-lg px-3 py-1.5 text-2xs text-dark-100 placeholder:text-dark-500 outline-none focus:bg-dark-900/60 transition border border-white/[0.04] font-mono"
      />
      <button
        onClick={onSubmit}
        disabled={busy || !value.trim()}
        className="text-2xs uppercase tracking-[0.2em] font-light px-3 py-1.5 rounded-lg text-saffron-300 hover:text-saffron-200 hover:bg-saffron-900/15 transition border border-saffron-700/30 disabled:opacity-40"
      >
        {busy ? 'Searching…' : 'Search'}
      </button>
    </div>
  );
}
