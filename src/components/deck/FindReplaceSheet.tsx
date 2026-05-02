'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  findInNotes,
  replaceInNotes,
  restoreSnapshot,
  snapshotScope,
  type FindMatch,
  type FindReplaceOptions,
} from '@/lib/db/find-replace';
import type { Note } from '@/lib/db/schema';
import UndoToast from '@/components/ui/UndoToast';
import { cn } from '@/lib/utils';

interface Props {
  defaultDeckId: string;
  onClose: () => void;
}

export default function FindReplaceSheet({ defaultDeckId, onClose }: Props) {
  const [find, setFind] = useState('');
  const [replacement, setReplacement] = useState('');
  const [scope, setScope] = useState<'deck' | 'all'>('deck');
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);

  const [matches, setMatches] = useState<FindMatch[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [undoData, setUndoData] = useState<null | { snapshot: Note[]; message: string }>(null);

  const findRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    findRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const opts: FindReplaceOptions = {
    deckId: scope === 'deck' ? defaultDeckId : undefined,
    regex,
    caseSensitive,
  };

  // Live preview as the user types.
  useEffect(() => {
    let cancelled = false;
    if (!find) {
      setMatches([]);
      setTruncated(false);
      setError(null);
      return;
    }
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const res = await findInNotes(find, opts, 200);
        if (cancelled) return;
        setMatches(res.matches);
        setTruncated(res.truncated);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 120);
    return () => { cancelled = true; clearTimeout(t); };
  }, [find, regex, caseSensitive, scope, defaultDeckId]);

  const totalMatches = matches.reduce((acc, m) => acc + m.count, 0);

  const onReplaceAll = async () => {
    if (!find || matches.length === 0) return;
    setBusy(true);
    try {
      const snap = await snapshotScope(opts);
      const result = await replaceInNotes(find, replacement, opts);
      setUndoData({
        snapshot: snap,
        message: `Replaced ${result.matchesReplaced} match${result.matchesReplaced === 1 ? '' : 'es'} in ${result.notesTouched} note${result.notesTouched === 1 ? '' : 's'}`,
      });
      setMatches([]);
      setFind('');
      setReplacement('');
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-start justify-center pt-16 px-4"
        onClick={e => { if (e.target === e.currentTarget) onClose(); }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="find-replace-title"
      >
        <div className="glass-card rounded-2xl w-full max-w-2xl max-h-[80vh] flex flex-col border border-white/[0.06] shadow-2xl">
          <div className="px-5 py-4 border-b border-white/[0.04] flex items-center justify-between">
            <h2 id="find-replace-title" className="text-sm uppercase tracking-[0.2em] font-light text-dark-100">Find &amp; replace</h2>
            <button
              onClick={onClose}
              className="text-2xs uppercase tracking-[0.2em] font-light text-dark-400 hover:text-dark-100 transition"
            >
              Close
            </button>
          </div>

          <div className="px-5 py-4 space-y-3 border-b border-white/[0.04]">
            <input
              ref={findRef}
              value={find}
              onChange={e => setFind(e.target.value)}
              placeholder="Find…"
              className="w-full bg-dark-800/30 rounded-xl px-4 py-2 text-sm text-dark-100 placeholder:text-dark-500 outline-none focus:bg-dark-800/50 transition border border-white/[0.04] focus:border-persian-500/30 font-mono"
            />
            <input
              value={replacement}
              onChange={e => setReplacement(e.target.value)}
              placeholder="Replace with…"
              className="w-full bg-dark-800/30 rounded-xl px-4 py-2 text-sm text-dark-100 placeholder:text-dark-500 outline-none focus:bg-dark-800/50 transition border border-white/[0.04] focus:border-persian-500/30 font-mono"
            />
            <div className="flex items-center gap-3 flex-wrap">
              <ChipToggle label="This deck" active={scope === 'deck'} onClick={() => setScope('deck')} />
              <ChipToggle label="All decks" active={scope === 'all'} onClick={() => setScope('all')} />
              <span className="w-px h-5 bg-white/[0.06] mx-1" />
              <ChipToggle label="Regex" active={regex} onClick={() => setRegex(r => !r)} />
              <ChipToggle label="Case sensitive" active={caseSensitive} onClick={() => setCaseSensitive(c => !c)} />
              <span className="flex-1" />
              <span className="text-2xs uppercase tracking-widest text-dark-500 tabular-nums">
                {searching ? '…' : `${totalMatches} match${totalMatches === 1 ? '' : 'es'} in ${matches.length} note${matches.length === 1 ? '' : 's'}${truncated ? ' (cap reached)' : ''}`}
              </span>
            </div>
            {error && (
              <div className="text-2xs text-crimson-300 font-light">{error}</div>
            )}
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-3">
            {matches.length === 0 ? (
              <div className="text-2xs uppercase tracking-widest text-dark-500 py-6 text-center">
                {find ? 'No matches' : 'Type to search'}
              </div>
            ) : (
              <ul className="space-y-1.5">
                {matches.map((m, i) => (
                  <li key={`${m.noteId}-${m.field}-${i}`}>
                    <Link
                      href={`/note/${m.noteId}`}
                      className="block px-3 py-2 rounded-xl hover:bg-white/[0.03] transition"
                      onClick={onClose}
                    >
                      <div className="flex items-center gap-2 text-2xs uppercase tracking-widest text-dark-500 font-mono">
                        <span>{m.field}</span>
                        <span>·</span>
                        <span>{m.count}×</span>
                      </div>
                      <div className="text-xs text-dark-200 font-mono leading-relaxed mt-0.5">
                        {highlight(m.excerpt, find, regex, caseSensitive)}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="px-5 py-4 border-t border-white/[0.04] flex items-center gap-3">
            <button
              onClick={onReplaceAll}
              disabled={busy || matches.length === 0 || !find}
              className="btn-gradient px-4 py-2 rounded-xl text-sm uppercase tracking-[0.2em] font-light disabled:opacity-50"
            >
              {busy ? 'Replacing…' : 'Replace all'}
            </button>
            <span className="text-2xs text-dark-500 font-light">
              {matches.length === 0 ? '' : 'Replacement is undoable from the toast.'}
            </span>
          </div>
        </div>
      </div>

      {undoData && (
        <UndoToast
          message={undoData.message}
          onUndo={async () => {
            await restoreSnapshot(undoData.snapshot);
          }}
          onDismiss={() => setUndoData(null)}
        />
      )}
    </>
  );
}

function ChipToggle({
  label, active, onClick,
}: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'text-2xs uppercase tracking-widest px-2.5 py-1 rounded-md transition border',
        active
          ? 'bg-persian-900/40 text-saffron-200 border-saffron-700/40'
          : 'bg-dark-800/30 text-dark-300 border-white/[0.04] hover:text-dark-100 hover:border-white/[0.08]',
      )}
    >
      {label}
    </button>
  );
}

function highlight(s: string, find: string, regex: boolean, caseSensitive: boolean): React.ReactNode {
  if (!find) return s;
  let pattern: RegExp;
  try {
    const flags = caseSensitive ? 'g' : 'gi';
    pattern = regex
      ? new RegExp(find, flags)
      : new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  } catch {
    return s;
  }
  const out: React.ReactNode[] = [];
  let last = 0;
  for (const m of s.matchAll(pattern)) {
    const i = m.index ?? 0;
    if (i > last) out.push(s.slice(last, i));
    out.push(<mark key={i} className="bg-saffron-500/30 text-saffron-100 px-0.5 rounded">{m[0]}</mark>);
    last = i + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
