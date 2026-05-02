'use client';

import { useEffect, useRef, useState } from 'react';
import type { Deck } from '@/lib/db/schema';
import type { BulkAction } from '@/lib/db/queries';

export interface BulkActionBarProps {
  selectedCount: number;
  decks: Deck[];
  currentDeckId: string;
  busy: boolean;
  onClear: () => void;
  onAction: (action: BulkAction) => void;
}

/**
 * Floating bar that fades in only when a selection exists.
 * Each button maps to a BulkAction; the parent applies it via bulkApply()
 * and shows an undo toast on success.
 */
export default function BulkActionBar({
  selectedCount,
  decks,
  currentDeckId,
  busy,
  onClear,
  onAction,
}: BulkActionBarProps) {
  const visible = selectedCount > 0;
  const [openMenu, setOpenMenu] = useState<null | 'move' | 'tag'>(null);
  const [tagDraft, setTagDraft] = useState('');
  const [tagMode, setTagMode] = useState<'add' | 'remove'>('add');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!visible) setOpenMenu(null);
  }, [visible]);

  useEffect(() => {
    if (!openMenu) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [openMenu]);

  if (!visible) return null;

  const movableDecks = decks.filter(d => d.id !== currentDeckId);

  return (
    <div
      ref={ref}
      className="fixed bottom-4 inset-x-3 sm:bottom-6 sm:inset-x-auto sm:left-1/2 sm:-translate-x-1/2 z-40 glass-card rounded-2xl shadow-2xl border border-white/[0.06] backdrop-blur-xl overflow-x-auto no-scrollbar"
      role="toolbar"
      aria-label="Bulk note actions"
    >
      <div className="flex items-center gap-1 px-3 py-2 w-max">
      <span className="text-2xs uppercase tracking-[0.2em] font-light text-dark-300 px-3 tabular-nums shrink-0">
        {selectedCount} selected
      </span>
      <div className="w-px h-6 bg-white/[0.06] mx-1" />

      <ActionButton label="Suspend" onClick={() => onAction({ kind: 'suspend' })} disabled={busy} />
      <ActionButton label="Unsuspend" onClick={() => onAction({ kind: 'unsuspend' })} disabled={busy} />
      <ActionButton label="Bury" onClick={() => onAction({ kind: 'bury' })} disabled={busy} />
      <ActionButton label="Reset" onClick={() => onAction({ kind: 'reset' })} disabled={busy} />

      <div className="relative">
        <ActionButton
          label="Move"
          onClick={() => { setOpenMenu(openMenu === 'move' ? null : 'move'); }}
          disabled={busy || movableDecks.length === 0}
        />
        {openMenu === 'move' && movableDecks.length > 0 && (
          <div className="absolute bottom-full mb-2 right-0 glass-card rounded-xl border border-white/[0.06] py-1 min-w-[260px] max-h-72 overflow-y-auto shadow-xl">
            {movableDecks.map(d => (
              <button
                key={d.id}
                onClick={() => { onAction({ kind: 'move', targetDeckId: d.id }); setOpenMenu(null); }}
                className="block w-full text-left px-4 py-2 text-sm text-dark-200 hover:bg-white/[0.04] hover:text-dark-50 transition truncate"
              >
                {d.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="relative">
        <ActionButton
          label="Tag"
          onClick={() => { setOpenMenu(openMenu === 'tag' ? null : 'tag'); }}
          disabled={busy}
        />
        {openMenu === 'tag' && (
          <div className="absolute bottom-full mb-2 right-0 glass-card rounded-xl border border-white/[0.06] p-3 w-72 shadow-xl space-y-2">
            <div className="flex gap-1">
              {(['add', 'remove'] as const).map(m => (
                <button
                  key={m}
                  onClick={() => setTagMode(m)}
                  className={
                    tagMode === m
                      ? 'flex-1 text-2xs uppercase tracking-widest font-mono px-2 py-1 rounded-md bg-persian-900/30 text-saffron-300'
                      : 'flex-1 text-2xs uppercase tracking-widest font-mono px-2 py-1 rounded-md text-dark-400 hover:text-dark-100 hover:bg-white/[0.03] transition'
                  }
                >
                  {m === 'add' ? 'Add tag' : 'Remove tag'}
                </button>
              ))}
            </div>
            <input
              autoFocus
              value={tagDraft}
              onChange={e => setTagDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && tagDraft.trim()) {
                  onAction(
                    tagMode === 'add'
                      ? { kind: 'addTag', tag: tagDraft.trim() }
                      : { kind: 'removeTag', tag: tagDraft.trim() },
                  );
                  setTagDraft('');
                  setOpenMenu(null);
                }
              }}
              placeholder="bio::ch04::nervous-system"
              className="w-full bg-dark-800/30 rounded-lg px-3 py-1.5 text-sm text-dark-100 placeholder:text-dark-500 outline-none focus:bg-dark-800/50 transition border border-white/[0.04] font-mono"
            />
            <div className="flex justify-end">
              <button
                onClick={() => {
                  if (!tagDraft.trim()) return;
                  onAction(
                    tagMode === 'add'
                      ? { kind: 'addTag', tag: tagDraft.trim() }
                      : { kind: 'removeTag', tag: tagDraft.trim() },
                  );
                  setTagDraft('');
                  setOpenMenu(null);
                }}
                disabled={!tagDraft.trim() || busy}
                className="btn-gradient px-3 py-1 rounded-lg text-2xs uppercase tracking-[0.2em] font-light disabled:opacity-50"
              >
                Apply
              </button>
            </div>
          </div>
        )}
      </div>

      <ActionButton
        label="Delete"
        tone="crimson"
        onClick={() => onAction({ kind: 'delete' })}
        disabled={busy}
      />

      <div className="w-px h-6 bg-white/[0.06] mx-1" />
      <button
        onClick={onClear}
        className="text-2xs uppercase tracking-[0.2em] font-light text-dark-400 hover:text-dark-100 transition px-3 py-1.5"
      >
        Clear
      </button>
      </div>
    </div>
  );
}

function ActionButton({
  label, onClick, disabled, tone,
}: { label: string; onClick: () => void; disabled?: boolean; tone?: 'crimson' }) {
  const cls = tone === 'crimson'
    ? 'text-2xs uppercase tracking-[0.2em] font-light px-3 py-1.5 rounded-lg text-crimson-300 hover:text-crimson-200 hover:bg-crimson-900/20 transition disabled:opacity-40'
    : 'text-2xs uppercase tracking-[0.2em] font-light px-3 py-1.5 rounded-lg text-dark-200 hover:text-dark-50 hover:bg-white/[0.04] transition disabled:opacity-40';
  return (
    <button onClick={onClick} disabled={disabled} className={cls}>
      {label}
    </button>
  );
}
