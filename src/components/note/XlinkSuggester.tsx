'use client';

import { useState } from 'react';
import type { Note } from '@/lib/db/schema';
import { applyXlinkSuggestion, proposeXlinks, type XlinkSuggestion } from '@/lib/ai/xlinks';
import { updateNote } from '@/lib/db/queries';
import { cn } from '@/lib/utils';

/**
 * One-click "Suggest links" panel attached to the note editor. Calls Claude
 * with the top-N similar notes from the local search index, presents up to
 * 5 link insertions, lets the user accept any subset.
 */
export default function XlinkSuggester({
  note, onUpdated,
}: {
  note: Note;
  onUpdated: (next: Note) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<XlinkSuggestion[] | null>(null);
  const [accepted, setAccepted] = useState<Set<number>>(new Set());

  const run = async () => {
    setBusy(true);
    setError(null);
    setSuggestions(null);
    setAccepted(new Set());
    try {
      const out = await proposeXlinks({ note });
      setSuggestions(out);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (i: number) => {
    setAccepted(prev => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  const apply = async () => {
    if (!suggestions || accepted.size === 0) return;
    setBusy(true);
    try {
      // Apply suggestions in order. Each rewrites the front field.
      let nextFront = note.fields.front;
      const accepts = [...accepted].sort((a, b) => a - b).map(i => suggestions[i]);
      for (const s of accepts) {
        nextFront = applyXlinkSuggestion(nextFront, s);
      }
      await updateNote(note.id, { fields: { ...note.fields, front: nextFront } });
      onUpdated({ ...note, fields: { ...note.fields, front: nextFront }, modifiedAt: Date.now() });
      setSuggestions(null);
      setAccepted(new Set());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={run}
          disabled={busy}
          className="text-2xs uppercase tracking-[0.2em] font-light px-3 py-1.5 rounded-lg text-saffron-300 hover:text-saffron-200 hover:bg-saffron-900/15 transition border border-saffron-700/30 disabled:opacity-40"
        >
          {busy ? 'Thinking…' : 'Suggest links'}
        </button>
        <span className="text-2xs text-dark-500 font-light">
          Find semantically similar notes and propose [[xlink]] insertions.
        </span>
      </div>

      {error && (
        <div className="text-2xs text-crimson-300 font-light">{error}</div>
      )}

      {suggestions && suggestions.length === 0 && (
        <div className="text-2xs text-dark-500 font-light italic">
          No suggestions — Claude didn't find any high-confidence matches.
        </div>
      )}

      {suggestions && suggestions.length > 0 && (
        <div className="space-y-2">
          {suggestions.map((s, i) => {
            const isAccepted = accepted.has(i);
            return (
              <div
                key={i}
                onClick={() => toggle(i)}
                className={cn(
                  'rounded-xl px-4 py-3 cursor-pointer transition border space-y-1',
                  isAccepted
                    ? 'bg-saffron-900/15 border-saffron-700/40'
                    : 'bg-dark-800/30 border-white/[0.04] hover:border-white/[0.08]',
                )}
              >
                <div className="flex items-center gap-3">
                  <span className={cn(
                    'shrink-0 w-4 h-4 rounded border flex items-center justify-center',
                    isAccepted ? 'bg-saffron-500 border-saffron-400' : 'border-white/20 bg-dark-900/40',
                  )}>
                    {isAccepted && (
                      <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden>
                        <path d="M2 6 L5 9 L10 3" stroke="#0c0c10" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </span>
                  <span className="text-sm font-light text-dark-100">
                    Wrap <span className="font-mono text-saffron-300">{s.anchor}</span>
                    {s.display && s.display !== s.anchor && (
                      <> as "<span className="text-dark-200">{s.display}</span>"</>
                    )}
                  </span>
                </div>
                <div className="text-2xs text-dark-400 font-light pl-7">
                  → {s.targetSnippet}
                </div>
                <div className="text-2xs text-dark-500 italic font-light pl-7">
                  {s.rationale}
                </div>
              </div>
            );
          })}
          <div className="flex gap-3 pt-1">
            <button
              onClick={apply}
              disabled={busy || accepted.size === 0}
              className="btn-gradient px-4 py-2 rounded-xl text-2xs uppercase tracking-[0.2em] font-light disabled:opacity-50"
            >
              Apply {accepted.size}
            </button>
            <button
              onClick={() => { setSuggestions(null); setAccepted(new Set()); }}
              className="text-2xs uppercase tracking-[0.2em] font-light text-dark-400 hover:text-dark-100 transition px-3"
            >
              Discard
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
