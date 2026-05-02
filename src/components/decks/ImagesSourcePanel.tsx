'use client';

import { useEffect, useState } from 'react';
import {
  applyImagesSyncDiff,
  disposeScanReport,
  getImagesSourceHandle,
  isImageSourceSupported,
  pickImagesSource,
  scanImagesSource,
  unlinkImagesSource,
  undoImagesSync,
  type ImageDiffAdded,
  type ImageDiffChanged,
  type ImageDiffMissing,
  type ImageScanReport,
  type UndoSnapshot,
} from '@/lib/watch/image-sync';
import { getDeck, getMediaUrl } from '@/lib/db/queries';
import type { Deck, ImagesSource } from '@/lib/db/schema';
import { cn } from '@/lib/utils';
import UndoToast from '@/components/ui/UndoToast';
import { Tooltip } from '@/components/ui/Tooltip';

type ChangedOrAdded = ImageDiffChanged | ImageDiffAdded;
type Modal =
  | { kind: 'closed' }
  | { kind: 'scanning' }
  | { kind: 'review'; report: ImageScanReport; selected: Set<string> }
  | { kind: 'applying' }
  | { kind: 'error'; message: string };

interface Props {
  deckId: string;
  onChanged?: () => void;
}

/**
 * Per-deck Image Source panel. Lives inside `/deck/[id]/edit` under the
 * "Media" tab. Lets the user link a directory once, then "Refresh from
 * source" diffs disk against the manifest, shows side-by-side previews of
 * any changed image, and applies the user's selection atomically with
 * undoable snapshots — same toast pattern as the bulk ops elsewhere.
 */
export default function ImagesSourcePanel({ deckId, onChanged }: Props) {
  const supported = isImageSourceSupported();

  const [deck, setDeck] = useState<Deck | null | undefined>(undefined);
  const [linked, setLinked] = useState<boolean>(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal>({ kind: 'closed' });
  const [undoSnap, setUndoSnap] = useState<UndoSnapshot | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getDeck(deckId), getImagesSourceHandle(deckId)]).then(([d, h]) => {
      if (cancelled) return;
      setDeck(d ?? null);
      setLinked(!!h && !!d?.imagesSource);
    });
    return () => { cancelled = true; };
  }, [deckId]);

  // Free preview blobs whenever the review modal closes or unmounts.
  useEffect(() => {
    return () => {
      if (modal.kind === 'review') disposeScanReport(modal.report);
    };
  }, [modal]);

  if (!supported) {
    return (
      <Panel title="Image source">
        <p className="text-sm font-light text-dark-300">
          Linking an images folder requires Chromium, Edge, or recent Safari.
          Your browser doesn&apos;t expose the File System Access API, so this
          deck can&apos;t track an on-disk source.
        </p>
      </Panel>
    );
  }

  if (deck === undefined) {
    return <Panel title="Image source"><Skeleton /></Panel>;
  }
  if (!deck) {
    return null;
  }

  const link = async () => {
    setBusy('Picking folder…');
    try {
      const result = await pickImagesSource(deckId);
      if (!result) return;
      const fresh = await getDeck(deckId);
      setDeck(fresh ?? null);
      setLinked(true);
      onChanged?.();
    } catch (e) {
      setModal({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const unlink = async () => {
    setBusy('Unlinking…');
    try {
      await unlinkImagesSource(deckId);
      const fresh = await getDeck(deckId);
      setDeck(fresh ?? null);
      setLinked(false);
      onChanged?.();
    } finally {
      setBusy(null);
    }
  };

  const refresh = async () => {
    setModal({ kind: 'scanning' });
    try {
      const report = await scanImagesSource(deckId);
      const writable = report.items.filter(it => it.kind === 'changed' || it.kind === 'added');
      const allFilenames = new Set(writable.map(it => it.filename));
      setModal({ kind: 'review', report, selected: allFilenames });
    } catch (e) {
      setModal({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  const apply = async (filenames: Iterable<string>) => {
    if (modal.kind !== 'review') return;
    const report = modal.report;
    const list = Array.from(filenames);
    if (list.length === 0) {
      setModal({ kind: 'closed' });
      return;
    }
    setModal({ kind: 'applying' });
    try {
      const snap = await applyImagesSyncDiff(deckId, report, list);
      const fresh = await getDeck(deckId);
      setDeck(fresh ?? null);
      setUndoSnap(snap);
      setToastMsg(`Updated ${snap.rewrites.length} image${snap.rewrites.length === 1 ? '' : 's'}.`);
      setModal({ kind: 'closed' });
      onChanged?.();
    } catch (e) {
      setModal({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  const undo = async () => {
    if (!undoSnap) return;
    setUndoSnap(null);
    setToastMsg(null);
    try {
      await undoImagesSync(undoSnap);
      const fresh = await getDeck(deckId);
      setDeck(fresh ?? null);
      onChanged?.();
    } catch (e) {
      setModal({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <>
      <Panel title="Image source">
        {!linked ? (
          <Empty onLink={link} busy={!!busy} />
        ) : (
          <Linked
            source={deck.imagesSource}
            busy={busy}
            onRefresh={refresh}
            onRelink={link}
            onUnlink={unlink}
          />
        )}
      </Panel>

      {modal.kind === 'scanning' && (
        <Modal onClose={() => setModal({ kind: 'closed' })}>
          <p className="text-sm font-light text-dark-200">Scanning…</p>
        </Modal>
      )}

      {modal.kind === 'review' && (
        <ReviewModal
          report={modal.report}
          selected={modal.selected}
          onSelected={set => setModal({ ...modal, selected: set })}
          onApply={() => apply(modal.selected)}
          onClose={() => setModal({ kind: 'closed' })}
        />
      )}

      {modal.kind === 'applying' && (
        <Modal onClose={() => {}}>
          <p className="text-sm font-light text-dark-200">Applying…</p>
        </Modal>
      )}

      {modal.kind === 'error' && (
        <Modal onClose={() => setModal({ kind: 'closed' })}>
          <p className="text-sm font-light text-crimson-300">{modal.message}</p>
        </Modal>
      )}

      {toastMsg && undoSnap && (
        <UndoToast
          message={toastMsg}
          onUndo={undo}
          onDismiss={() => { setToastMsg(null); setUndoSnap(null); }}
        />
      )}
    </>
  );
}

/* ─── Sub-components ─────────────────────────────────────── */

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="glass-card rounded-2xl p-6 space-y-4">
      <h3 className="text-2xs uppercase tracking-widest text-dark-400">{title}</h3>
      {children}
    </section>
  );
}

function Skeleton() {
  return <div className="h-12 rounded-xl bg-dark-800/30 animate-pulse" />;
}

function Empty({ onLink, busy }: { onLink: () => void; busy: boolean }) {
  return (
    <div className="space-y-3">
      <p className="text-sm font-light text-dark-300">
        Link a folder of source images so you can refresh this deck&apos;s
        media from disk. Filenames must match the names referenced by your
        cards. Bytes update in place; nothing is deleted automatically.
      </p>
      <button
        onClick={onLink}
        disabled={busy}
        className="btn-gradient px-4 py-2 rounded-lg text-2xs uppercase tracking-[0.2em] font-light"
      >
        {busy ? 'Picking…' : 'Link images folder'}
      </button>
    </div>
  );
}

function Linked({
  source, busy, onRefresh, onRelink, onUnlink,
}: {
  source: ImagesSource | undefined;
  busy: string | null;
  onRefresh: () => void;
  onRelink: () => void;
  onUnlink: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="text-sm font-light text-dark-200 space-y-0.5">
        <div>
          <span className="text-dark-500">Linked to:</span>{' '}
          <span className="font-mono text-saffron-300">{source?.rootName ?? 'images'}</span>
        </div>
        <div className="text-2xs uppercase tracking-widest text-dark-500 tabular-nums">
          {source?.lastSyncedAt
            ? `Last synced ${formatRelative(source.lastSyncedAt)} · ${source.fileCount} file${source.fileCount === 1 ? '' : 's'}`
            : 'Not yet synced'}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={onRefresh}
          disabled={!!busy}
          className="btn-gradient px-4 py-2 rounded-lg text-2xs uppercase tracking-[0.2em] font-light"
        >
          Refresh from source
        </button>
        <Tooltip content="Pick a different folder for this deck">
          <button
            onClick={onRelink}
            disabled={!!busy}
            className="px-3 py-2 rounded-lg text-2xs uppercase tracking-[0.2em] font-light text-dark-200 hover:text-dark-50 hover:bg-white/[0.04] border border-white/[0.06] transition"
          >
            Re-link
          </button>
        </Tooltip>
        <Tooltip content="Stop tracking; existing media stays in place">
          <button
            onClick={onUnlink}
            disabled={!!busy}
            className="px-3 py-2 rounded-lg text-2xs uppercase tracking-[0.2em] font-light text-dark-300 hover:text-crimson-300 hover:bg-crimson-900/20 border border-white/[0.04] transition"
          >
            Unlink
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

function ReviewModal({
  report, selected, onSelected, onApply, onClose,
}: {
  report: ImageScanReport;
  selected: Set<string>;
  onSelected: (s: Set<string>) => void;
  onApply: () => void;
  onClose: () => void;
}) {
  const writable = report.items.filter(
    (it): it is ChangedOrAdded => it.kind === 'changed' || it.kind === 'added',
  );
  const missing = report.items.filter(
    (it): it is ImageDiffMissing => it.kind === 'missing',
  );
  const total = writable.length;
  const allSelected = total > 0 && writable.every(it => selected.has(it.filename));
  const counts = countByKind(writable);

  const toggle = (filename: string) => {
    const next = new Set(selected);
    if (next.has(filename)) next.delete(filename);
    else next.add(filename);
    onSelected(next);
  };
  const toggleAll = () => {
    if (allSelected) onSelected(new Set());
    else onSelected(new Set(writable.map(it => it.filename)));
  };

  return (
    <Modal onClose={onClose} wide>
      <div className="flex items-baseline justify-between">
        <h2 className="text-xl font-extralight tracking-tight bg-gradient-to-r from-saffron-300 to-persian-300 bg-clip-text text-transparent">
          Review changes
        </h2>
        <div className="text-2xs uppercase tracking-widest text-dark-500 tabular-nums">
          {counts.changed} changed · {counts.added} added · {missing.length} missing · {report.unchanged} unchanged
        </div>
      </div>

      {writable.length === 0 ? (
        <p className="text-sm font-light text-dark-300 mt-3">
          Nothing to update. {report.unchanged} matching file{report.unchanged === 1 ? '' : 's'} already match this deck&apos;s manifest.
          {missing.length > 0 && ` ${missing.length} expected file${missing.length === 1 ? '' : 's'} missing on disk (cards still reference them; cached bytes remain).`}
        </p>
      ) : (
        <>
          <div className="mt-3 flex items-center justify-between text-2xs uppercase tracking-widest text-dark-500">
            <button
              onClick={toggleAll}
              className="font-mono px-2 py-1 rounded hover:bg-white/[0.04] text-dark-200 hover:text-dark-50 transition"
            >
              {allSelected ? 'Deselect all' : 'Select all'}
            </button>
            <span className="tabular-nums">
              {selected.size}/{total} selected
            </span>
          </div>
          <ul className="mt-2 max-h-[60vh] overflow-y-auto pr-1 -mr-1 divide-y divide-white/[0.04]">
            {writable.map(it => (
              <DiffRow
                key={it.filename}
                item={it}
                checked={selected.has(it.filename)}
                onToggle={() => toggle(it.filename)}
              />
            ))}
            {missing.map(it => (
              <MissingRow key={it.filename} item={it} />
            ))}
          </ul>
        </>
      )}

      <div className="mt-5 flex items-center justify-end gap-2">
        <button
          onClick={onClose}
          className="px-4 py-2 rounded-lg text-2xs uppercase tracking-[0.2em] font-light text-dark-300 hover:text-dark-100 hover:bg-white/[0.04] transition"
        >
          Cancel
        </button>
        <button
          onClick={onApply}
          disabled={selected.size === 0}
          className="btn-gradient px-4 py-2 rounded-lg text-2xs uppercase tracking-[0.2em] font-light disabled:opacity-40"
        >
          Apply {selected.size > 0 ? selected.size : ''}
        </button>
      </div>
    </Modal>
  );
}

function DiffRow({
  item, checked, onToggle,
}: {
  item: ChangedOrAdded;
  checked: boolean;
  onToggle: () => void;
}) {
  const [oldUrl, setOldUrl] = useState<string | null>(null);
  useEffect(() => {
    if (item.kind !== 'changed') return;
    let cancelled = false;
    getMediaUrl(item.filename).then(u => { if (!cancelled) setOldUrl(u); });
    return () => { cancelled = true; };
  }, [item]);

  return (
    <li className="py-2 flex items-center gap-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="accent-saffron-400 size-4 shrink-0"
      />
      <div className="flex items-center gap-2 shrink-0">
        {item.kind === 'changed' ? (
          <Thumb url={oldUrl} alt="before" tone="dim" />
        ) : (
          <span
            className="size-12 rounded-md bg-dark-800/40 border border-dashed border-white/[0.08] flex items-center justify-center text-2xs text-dark-500 font-mono"
            aria-label="No prior version"
          >
            new
          </span>
        )}
        <span aria-hidden className="text-dark-500 text-sm">→</span>
        <Thumb url={item.previewUrl} alt="after" tone="bright" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-mono text-sm text-dark-100 truncate" title={item.filename}>
          {item.filename}
        </div>
        <div className="text-2xs uppercase tracking-widest text-dark-500 tabular-nums">
          {item.kind === 'changed'
            ? `was ${item.oldEntry.hash} · now ${item.newHash}`
            : `new · ${formatBytes(item.newSize)} · referenced by ${item.referencingNoteIds.length} note${item.referencingNoteIds.length === 1 ? '' : 's'}`}
        </div>
      </div>
    </li>
  );
}

function MissingRow({ item }: { item: ImageDiffMissing }) {
  return (
    <li className="py-2 flex items-center gap-3 opacity-70">
      <span className="size-4 shrink-0" aria-hidden />
      <span className="size-12 rounded-md bg-crimson-900/20 border border-crimson-700/30 flex items-center justify-center text-2xs text-crimson-300 font-mono shrink-0">
        ?
      </span>
      <div className="flex-1 min-w-0">
        <div className="font-mono text-sm text-dark-100 truncate">{item.filename}</div>
        <div className="text-2xs uppercase tracking-widest text-crimson-400/70">
          missing on disk · {item.referencingNoteIds.length} note{item.referencingNoteIds.length === 1 ? '' : 's'} still reference it
        </div>
      </div>
    </li>
  );
}

function Thumb({ url, alt, tone }: { url: string | null; alt: string; tone: 'bright' | 'dim' }) {
  return (
    <span className={cn(
      'size-12 rounded-md overflow-hidden border bg-dark-900/40 flex items-center justify-center shrink-0',
      tone === 'bright' ? 'border-saffron-400/40' : 'border-white/[0.06]',
    )}>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={alt} className="block max-w-full max-h-full object-contain" />
      ) : (
        <span className="text-2xs text-dark-500 font-mono">{alt}</span>
      )}
    </span>
  );
}

function Modal({
  children, onClose, wide,
}: {
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-[55] flex items-start justify-center pt-16 px-4 bg-dark-950/70 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className={cn(
          'glass-card rounded-3xl p-6 w-full animate-slide-up border border-white/[0.06]',
          wide ? 'max-w-3xl' : 'max-w-md',
        )}
        onClick={e => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

/* ─── Format helpers ───────────────────────────────────── */

function countByKind(items: ChangedOrAdded[]): { changed: number; added: number } {
  let changed = 0, added = 0;
  for (const it of items) {
    if (it.kind === 'changed') changed++;
    else added++;
  }
  return { changed, added };
}

function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  const m = Math.round(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(diff / 3_600_000);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(diff / 86_400_000);
  return `${d}d ago`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
