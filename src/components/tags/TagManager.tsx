'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  deleteTagEverywhere,
  listTagUsage,
  mergeTags,
  renameTag,
  type TagUsage,
} from '@/lib/db/queries';
import { SkeletonList } from '@/components/ui/Skeleton';
import InlineAlert from '@/components/ui/InlineAlert';
import { cn } from '@/lib/utils';

type Action = null | 'rename' | 'merge' | 'delete';

export default function TagManager() {
  const [tags, setTags] = useState<TagUsage[] | null>(null);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const [action, setAction] = useState<Action>(null);
  const [renameTo, setRenameTo] = useState('');
  const [mergeTo, setMergeTo] = useState('');

  const refresh = async () => setTags(await listTagUsage());

  useEffect(() => {
    refresh();
  }, []);

  const filtered = useMemo(() => {
    const list = tags ?? [];
    const q = filter.trim().toLowerCase();
    if (!q) return list;
    return list.filter(t => t.tag.toLowerCase().includes(q));
  }, [tags, filter]);

  const showFlash = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(null), 3000);
  };

  const toggle = (tag: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag); else next.add(tag);
      return next;
    });
  };

  const doRename = async () => {
    if (selected.size !== 1 || !renameTo.trim()) return;
    setBusy(true);
    try {
      const [from] = [...selected];
      const n = await renameTag(from, renameTo.trim());
      showFlash(`Renamed ${from} → ${renameTo.trim()} on ${n} note${n === 1 ? '' : 's'}.`);
      setSelected(new Set());
      setRenameTo('');
      setAction(null);
      await refresh();
    } finally { setBusy(false); }
  };

  const doMerge = async () => {
    if (selected.size < 1 || !mergeTo.trim()) return;
    setBusy(true);
    try {
      const sources = [...selected];
      const n = await mergeTags(sources, mergeTo.trim());
      showFlash(`Merged ${sources.length} tag${sources.length === 1 ? '' : 's'} into ${mergeTo.trim()} (${n} note${n === 1 ? '' : 's'} updated).`);
      setSelected(new Set());
      setMergeTo('');
      setAction(null);
      await refresh();
    } finally { setBusy(false); }
  };

  const doDelete = async () => {
    if (selected.size === 0) return;
    setBusy(true);
    try {
      let total = 0;
      for (const tag of selected) total += await deleteTagEverywhere(tag);
      showFlash(`Removed ${selected.size} tag${selected.size === 1 ? '' : 's'} from ${total} note${total === 1 ? '' : 's'}.`);
      setSelected(new Set());
      setAction(null);
      await refresh();
    } finally { setBusy(false); }
  };

  if (tags === null) {
    return (
      <div className="max-w-3xl mx-auto px-4 md:px-6 py-6 md:py-10 space-y-6">
        <div className="space-y-2">
          <div className="h-9 w-32 rounded loading-shimmer" />
          <div className="h-4 w-64 rounded loading-shimmer" />
        </div>
        <SkeletonList count={6} height="h-12" />
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <h1 className="text-3xl md:text-4xl font-extralight tracking-tight mb-2">Tags</h1>
      <p className="text-dark-400 font-light text-sm mb-8">
        {tags.length} tag{tags.length === 1 ? '' : 's'} across all decks. Select to rename, merge, or remove.
      </p>

      <div className="flex items-center gap-3 flex-wrap mb-4">
        <input
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="Filter tags…"
          className="flex-1 min-w-0 bg-dark-800/30 rounded-xl px-4 py-2 text-sm text-dark-100 placeholder:text-dark-500 outline-none focus:bg-dark-800/50 transition border border-white/[0.04]"
        />
        {selected.size > 0 && (
          <span className="text-2xs uppercase tracking-widest text-dark-400 tabular-nums">
            {selected.size} selected
          </span>
        )}
        {selected.size > 0 && (
          <>
            <ActionBtn label="Rename" disabled={selected.size !== 1 || busy} onClick={() => setAction('rename')} />
            <ActionBtn label="Merge" disabled={busy} onClick={() => setAction('merge')} />
            <ActionBtn label="Delete" tone="crimson" disabled={busy} onClick={() => setAction('delete')} />
            <ActionBtn label="Clear" onClick={() => setSelected(new Set())} />
          </>
        )}
      </div>

      {action === 'rename' && (
        <div className="glass-card rounded-2xl p-4 mb-4 space-y-2">
          <div className="text-2xs uppercase tracking-[0.2em] text-dark-400">
            Rename "{[...selected][0]}" to:
          </div>
          <div className="flex gap-2">
            <input
              autoFocus
              value={renameTo}
              onChange={e => setRenameTo(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && doRename()}
              placeholder="bio::ch04::nervous-system"
              className="flex-1 bg-dark-800/30 rounded-xl px-3 py-2 text-sm text-dark-100 outline-none focus:bg-dark-800/50 transition border border-white/[0.04] font-mono"
            />
            <button onClick={doRename} disabled={busy || !renameTo.trim()} className="btn-gradient px-4 py-2 rounded-xl text-2xs uppercase tracking-[0.2em] font-light disabled:opacity-50">Rename</button>
            <button onClick={() => setAction(null)} className="text-2xs uppercase tracking-[0.2em] font-light text-dark-400 hover:text-dark-100 transition px-3">Cancel</button>
          </div>
        </div>
      )}

      {action === 'merge' && (
        <div className="glass-card rounded-2xl p-4 mb-4 space-y-2">
          <div className="text-2xs uppercase tracking-[0.2em] text-dark-400">
            Merge {selected.size} tag{selected.size === 1 ? '' : 's'} into:
          </div>
          <div className="flex gap-2">
            <input
              autoFocus
              value={mergeTo}
              onChange={e => setMergeTo(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && doMerge()}
              placeholder="target tag"
              className="flex-1 bg-dark-800/30 rounded-xl px-3 py-2 text-sm text-dark-100 outline-none focus:bg-dark-800/50 transition border border-white/[0.04] font-mono"
            />
            <button onClick={doMerge} disabled={busy || !mergeTo.trim()} className="btn-gradient px-4 py-2 rounded-xl text-2xs uppercase tracking-[0.2em] font-light disabled:opacity-50">Merge</button>
            <button onClick={() => setAction(null)} className="text-2xs uppercase tracking-[0.2em] font-light text-dark-400 hover:text-dark-100 transition px-3">Cancel</button>
          </div>
          <div className="text-2xs text-dark-500 font-light">
            Sources removed; target keeps existing notes plus everything that had a source tag.
          </div>
        </div>
      )}

      {action === 'delete' && (
        <div className="glass-card rounded-2xl p-4 mb-4 border border-crimson-700/30">
          <div className="text-2xs uppercase tracking-[0.2em] text-crimson-300 mb-2">
            Remove {selected.size} tag{selected.size === 1 ? '' : 's'} from every note?
          </div>
          <div className="text-xs text-dark-300 font-light mb-3">
            {[...selected].slice(0, 8).join(', ')}{selected.size > 8 ? ` +${selected.size - 8}` : ''}
          </div>
          <div className="flex gap-2">
            <button onClick={doDelete} disabled={busy} className="px-4 py-2 rounded-xl text-2xs uppercase tracking-[0.2em] font-light bg-crimson-900/40 text-crimson-100 hover:bg-crimson-800/50 transition border border-crimson-700/30">Confirm delete</button>
            <button onClick={() => setAction(null)} className="text-2xs uppercase tracking-[0.2em] font-light text-dark-400 hover:text-dark-100 transition px-3">Cancel</button>
          </div>
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="glass-card rounded-2xl p-8 text-center text-dark-400 text-sm font-light">
          {filter ? 'No matching tags.' : 'No tags yet.'}
        </div>
      ) : (
        <div className="glass-card rounded-2xl divide-y divide-white/[0.04]">
          {filtered.map(t => {
            const isSelected = selected.has(t.tag);
            return (
              <button
                key={t.tag}
                onClick={() => toggle(t.tag)}
                className={cn(
                  'w-full px-5 py-3 flex items-center gap-3 transition text-left',
                  isSelected ? 'bg-saffron-900/10' : 'hover:bg-white/[0.02]',
                )}
              >
                <span className={cn(
                  'shrink-0 w-4 h-4 rounded border flex items-center justify-center',
                  isSelected ? 'bg-saffron-500 border-saffron-400' : 'border-white/20 bg-dark-900/40',
                )}>
                  {isSelected && (
                    <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden>
                      <path d="M2 6 L5 9 L10 3" stroke="#0c0c10" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </span>
                <span className="flex-1 text-sm font-mono text-dark-100 truncate">{t.tag}</span>
                <span className="text-2xs uppercase tracking-widest text-dark-500 tabular-nums">
                  {t.noteCount} note{t.noteCount === 1 ? '' : 's'}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {flash && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-2 rounded-xl bg-dark-800/90 backdrop-blur-md border border-white/[0.06] text-sm text-dark-100 z-40">
          {flash}
        </div>
      )}
    </div>
  );
}

function ActionBtn({
  label, tone, onClick, disabled,
}: { label: string; tone?: 'crimson'; onClick: () => void; disabled?: boolean }) {
  const cls = tone === 'crimson'
    ? 'text-2xs uppercase tracking-[0.2em] font-light px-3 py-1.5 rounded-lg text-crimson-300 hover:text-crimson-200 hover:bg-crimson-900/20 transition disabled:opacity-40'
    : 'text-2xs uppercase tracking-[0.2em] font-light px-3 py-1.5 rounded-lg text-dark-200 hover:text-dark-50 hover:bg-white/[0.04] transition border border-white/[0.06] disabled:opacity-40';
  return (
    <button onClick={onClick} disabled={disabled} className={cls}>
      {label}
    </button>
  );
}
