'use client';

import { useEffect, useRef, useState } from 'react';
import {
  diffSnapshot,
  exportSnapshot,
  importSnapshot,
  listBackups,
  readBackup,
  maybeRunDailyBackup,
  type Snapshot,
  type SnapshotDiff,
} from '@/lib/backup/snapshot';
import { exportApkg } from '@/lib/apkg/exporter';
import { cn } from '@/lib/utils';

interface PendingRestore {
  source: { kind: 'opfs'; name: string } | { kind: 'file'; filename: string };
  snap: Snapshot;
  diff: SnapshotDiff;
}

export default function BackupPanel() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [backups, setBackups] = useState<Array<{ name: string; size: number; modified: number }>>([]);
  const [pending, setPending] = useState<PendingRestore | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    listBackups().then(setBackups);
    maybeRunDailyBackup().then(({ ran }) => {
      if (ran) listBackups().then(setBackups);
    });
  }, []);

  const downloadJson = async () => {
    setBusy('snapshot'); setError(null);
    try {
      const snap = await exportSnapshot();
      downloadFile(
        `cards-snapshot-${new Date().toISOString().split('T')[0]}.json`,
        new Blob([JSON.stringify(snap)], { type: 'application/json' }),
      );
      setInfo('Snapshot downloaded.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const downloadApkg = async () => {
    setBusy('apkg'); setError(null);
    try {
      const blob = await exportApkg();
      downloadFile(`cards-export-${new Date().toISOString().split('T')[0]}.apkg`, blob);
      setInfo('Anki .apkg exported.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const previewFromFile = async (file: File) => {
    setBusy('preview'); setError(null);
    try {
      const text = await file.text();
      const snap = JSON.parse(text) as Snapshot;
      const diff = await diffSnapshot(snap);
      setPending({ source: { kind: 'file', filename: file.name }, snap, diff });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const previewFromOpfs = async (name: string) => {
    setBusy('preview'); setError(null);
    try {
      const snap = await readBackup(name);
      const diff = await diffSnapshot(snap);
      setPending({ source: { kind: 'opfs', name }, snap, diff });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const confirmRestore = async () => {
    if (!pending) return;
    setBusy('restore'); setError(null);
    try {
      await importSnapshot(pending.snap, 'replace');
      const label = pending.source.kind === 'opfs'
        ? pending.source.name
        : pending.source.filename;
      setInfo(`Restored from ${label}.`);
      setPending(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid md:grid-cols-2 gap-3">
        <button
          onClick={downloadJson}
          disabled={busy !== null}
          className="glass-card glass-card-hover rounded-2xl p-5 text-left transition"
        >
          <div className="text-sm font-light text-dark-100">Download snapshot (JSON)</div>
          <div className="text-2xs text-dark-400 mt-1 font-light">
            Full database including media. Use to back up or move between devices.
          </div>
          {busy === 'snapshot' && <div className="text-2xs text-saffron-300 mt-2">Building…</div>}
        </button>
        <button
          onClick={downloadApkg}
          disabled={busy !== null}
          className="glass-card glass-card-hover rounded-2xl p-5 text-left transition"
        >
          <div className="text-sm font-light text-dark-100">Export .apkg (Anki)</div>
          <div className="text-2xs text-dark-400 mt-1 font-light">
            Round-trippable Anki package. Cloze + basic note types preserved.
          </div>
          {busy === 'apkg' && <div className="text-2xs text-saffron-300 mt-2">Building…</div>}
        </button>
      </div>

      <div className="glass-card rounded-2xl p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-light text-dark-100">Local backups (OPFS)</h3>
          <button
            onClick={async () => {
              await maybeRunDailyBackup();
              setBackups(await listBackups());
            }}
            className="text-2xs uppercase tracking-widest text-dark-400 hover:text-dark-100 transition"
          >
            Run now
          </button>
        </div>
        {backups.length === 0 ? (
          <p className="text-sm text-dark-400 font-light">
            No automatic backups yet. They run daily; the latest 7 are kept.
          </p>
        ) : (
          <ul className="divide-y divide-white/[0.04]">
            {backups.map(b => (
              <li key={b.name} className="py-2 flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm text-dark-100 font-light">{b.name}</div>
                  <div className="text-2xs text-dark-500 font-mono">
                    {(b.size / 1024 / 1024).toFixed(2)} MB · {new Date(b.modified).toLocaleString()}
                  </div>
                </div>
                <button
                  onClick={() => previewFromOpfs(b.name)}
                  disabled={busy !== null}
                  className="text-2xs uppercase tracking-widest text-saffron-300 hover:text-saffron-200 transition"
                >
                  {busy === 'preview' ? 'Comparing…' : 'Compare + restore'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="glass-card rounded-2xl p-5">
        <h3 className="text-sm font-light text-dark-100 mb-2">Restore from JSON</h3>
        <input
          ref={fileRef}
          type="file"
          accept="application/json"
          onChange={e => e.target.files?.[0] && previewFromFile(e.target.files[0])}
          className="text-sm text-dark-200 file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border-0 file:bg-dark-800/50 file:text-dark-100 file:cursor-pointer hover:file:bg-dark-800/70"
        />
        {busy === 'restore' && <div className="text-2xs text-saffron-300 mt-2">Restoring…</div>}
      </div>

      {info && <div className="text-sm text-saffron-300 font-light">{info}</div>}
      {error && <div className="text-sm text-crimson-300 font-light">{error}</div>}

      {pending && (
        <RestoreDiffModal
          pending={pending}
          busy={busy === 'restore'}
          onCancel={() => setPending(null)}
          onConfirm={confirmRestore}
        />
      )}
    </div>
  );
}

function RestoreDiffModal({
  pending, busy, onCancel, onConfirm,
}: {
  pending: PendingRestore;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);
  const { diff, source, snap } = pending;
  const label = source.kind === 'opfs' ? source.name : source.filename;
  const exportedAt = new Date(snap.exportedAt).toLocaleString();
  const totalLost = diff.decks.removed + diff.notes.removed + diff.cards.removed
    + diff.media.removed + diff.reviewLogs.removed;
  return (
    <div
      className="fixed inset-0 z-[55] flex items-start justify-center pt-16 px-4 bg-dark-950/70 backdrop-blur-sm animate-fade-in"
      onClick={onCancel}
    >
      <div
        className="glass-card rounded-3xl p-6 w-full max-w-2xl animate-slide-up border border-white/[0.06]"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-baseline justify-between mb-1">
          <h2 className="text-xl font-extralight tracking-tight bg-gradient-to-r from-saffron-300 to-persian-300 bg-clip-text text-transparent">
            Restore preview
          </h2>
          <span className="text-2xs uppercase tracking-widest text-dark-500 tabular-nums">
            {exportedAt}
          </span>
        </div>
        <p className="text-2xs text-dark-400 font-light mb-5 font-mono">{label}</p>

        <div className="grid grid-cols-2 gap-x-6 gap-y-2 mb-5">
          <DiffRow label="Decks" t={diff.decks} />
          <DiffRow label="Notes" t={diff.notes} />
          <DiffRow label="Cards" t={diff.cards} />
          <DiffRow label="Media" t={diff.media} />
          <DiffRow label="Review logs" t={diff.reviewLogs} />
        </div>

        {totalLost > 0 && (
          <div className="rounded-xl bg-crimson-900/20 border border-crimson-700/30 p-3 mb-4 text-xs font-light text-crimson-200 space-y-1">
            <div className="font-mono uppercase tracking-widest text-2xs text-crimson-300/80">Will lose</div>
            <div>
              {diff.notes.removed > 0 && `${diff.notes.removed} note${diff.notes.removed === 1 ? '' : 's'}`}
              {diff.notes.removed > 0 && diff.cards.removed > 0 && ' · '}
              {diff.cards.removed > 0 && `${diff.cards.removed} card${diff.cards.removed === 1 ? '' : 's'}`}
              {(diff.notes.removed > 0 || diff.cards.removed > 0) && diff.reviewLogs.removed > 0 && ' · '}
              {diff.reviewLogs.removed > 0 && `${diff.reviewLogs.removed} review log${diff.reviewLogs.removed === 1 ? '' : 's'}`}
            </div>
            {diff.deckNamesLost.length > 0 && (
              <div className="text-2xs text-crimson-300/80 font-mono truncate">
                Decks lost: {diff.deckNamesLost.join(', ')}{diff.decks.removed > diff.deckNamesLost.length ? ', …' : ''}
              </div>
            )}
          </div>
        )}

        {(diff.notes.added > 0 || diff.decks.added > 0) && (
          <div className="rounded-xl bg-persian-900/20 border border-persian-700/30 p-3 mb-4 text-xs font-light text-persian-100 space-y-1">
            <div className="font-mono uppercase tracking-widest text-2xs text-persian-200/80">Will gain</div>
            <div>
              {diff.notes.added > 0 && `${diff.notes.added} note${diff.notes.added === 1 ? '' : 's'}`}
              {diff.notes.added > 0 && diff.decks.added > 0 && ' · '}
              {diff.decks.added > 0 && `${diff.decks.added} deck${diff.decks.added === 1 ? '' : 's'}`}
            </div>
            {diff.deckNamesGained.length > 0 && (
              <div className="text-2xs text-persian-200/70 font-mono truncate">
                Decks restored: {diff.deckNamesGained.join(', ')}{diff.decks.added > diff.deckNamesGained.length ? ', …' : ''}
              </div>
            )}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="px-4 py-2 rounded-lg text-2xs uppercase tracking-[0.2em] font-light text-dark-300 hover:text-dark-100 hover:bg-white/[0.04] transition"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className={cn(
              'px-4 py-2 rounded-lg text-2xs uppercase tracking-[0.2em] font-light',
              totalLost > 0
                ? 'bg-crimson-900/40 text-crimson-200 hover:bg-crimson-800/50 border border-crimson-700/30'
                : 'btn-gradient',
            )}
          >
            {busy ? 'Restoring…' : totalLost > 0 ? 'Restore (replace current)' : 'Restore'}
          </button>
        </div>
      </div>
    </div>
  );
}

function DiffRow({
  label, t,
}: {
  label: string;
  t: { added: number; removed: number; current: number; snapshot: number };
}) {
  return (
    <div className="flex items-center justify-between text-2xs font-mono tabular-nums">
      <span className="text-dark-300 uppercase tracking-widest">{label}</span>
      <span className="text-dark-400">
        <span className="text-dark-500">{t.current}</span>
        <span className="text-dark-700 mx-1">→</span>
        <span className="text-dark-200">{t.snapshot}</span>
        {t.added > 0 && <span className="text-persian-200/90 ml-2">+{t.added}</span>}
        {t.removed > 0 && <span className="text-crimson-300/90 ml-1">-{t.removed}</span>}
      </span>
    </div>
  );
}

function downloadFile(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
