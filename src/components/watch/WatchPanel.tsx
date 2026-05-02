'use client';

import { useEffect, useState } from 'react';
import { listDecks } from '@/lib/db/queries';
import {
  pickDirectory,
  getStoredHandle,
  rescan,
  getWatchInfo,
  clearWatch,
  type ScanReport,
} from '@/lib/watch/folder-watch';
import type { Deck } from '@/lib/db/schema';

export default function WatchPanel() {
  const [supported, setSupported] = useState<boolean>(false);
  const [decks, setDecks] = useState<Deck[]>([]);
  const [deckId, setDeckId] = useState<string>('');
  const [hasHandle, setHasHandle] = useState<boolean>(false);
  const [info, setInfo] = useState<{ deckId: string; lastScanMs: number; entries: number } | null>(null);
  const [report, setReport] = useState<ScanReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSupported(typeof (window as any).showDirectoryPicker === 'function');
    listDecks().then(d => {
      setDecks(d);
      if (d.length > 0) setDeckId(d[0].id);
    });
    getStoredHandle().then(h => setHasHandle(!!h));
    getWatchInfo().then(setInfo);
  }, []);

  const choose = async () => {
    setBusy(true); setError(null);
    try {
      const handle = await pickDirectory();
      if (!handle) return;
      setHasHandle(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const sync = async () => {
    setBusy(true); setError(null); setReport(null);
    try {
      const handle = await getStoredHandle();
      if (!handle) throw new Error('No directory chosen.');
      if (!deckId) throw new Error('Pick a target deck first.');
      const r = await rescan(handle, deckId);
      setReport(r);
      setInfo(await getWatchInfo());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const reset = async () => {
    if (!confirm('Disconnect the watched folder? (Notes already imported are kept.)')) return;
    await clearWatch();
    setHasHandle(false);
    setInfo(null);
    setReport(null);
  };

  if (!supported) {
    return (
      <div className="text-sm text-dark-400 font-light">
        Folder watch requires the File System Access API. Use Chromium, Edge, or Safari 17+.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="text-xs text-dark-400 font-light leading-relaxed">
        Point the app at any directory of <code className="text-saffron-300 font-mono">.md</code> files containing{' '}
        <code className="text-saffron-300 font-mono">{'>'} CARD: v5</code> blocks. Each rescan diffs by content hash and upserts new/changed notes.
      </div>

      <label className="block">
        <div className="text-2xs uppercase tracking-widest text-dark-400 mb-1.5">Target deck</div>
        <select
          value={deckId}
          onChange={e => setDeckId(e.target.value)}
          className="w-full bg-dark-800/30 rounded-xl px-4 py-2.5 text-sm text-dark-100 outline-none focus:bg-dark-800/50 transition border border-white/[0.04] cursor-pointer"
          disabled={decks.length === 0}
        >
          {decks.length === 0 && <option value="">(no decks)</option>}
          {decks.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </label>

      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={choose}
          disabled={busy}
          className="btn-gradient px-4 py-2 rounded-xl text-sm"
        >
          {hasHandle ? 'Choose another folder' : 'Choose folder'}
        </button>
        <button
          onClick={sync}
          disabled={busy || !hasHandle || !deckId}
          className="px-4 py-2 rounded-xl text-sm text-dark-200 hover:text-dark-50 hover:bg-white/[0.04] transition border border-white/[0.06]"
        >
          {busy ? 'Scanning…' : 'Sync now'}
        </button>
        {hasHandle && (
          <button
            onClick={reset}
            className="px-4 py-2 rounded-xl text-sm text-crimson-300 hover:bg-crimson-900/20 transition border border-crimson-800/30"
          >
            Disconnect
          </button>
        )}
      </div>

      {info && (
        <div className="text-2xs uppercase tracking-widest font-mono text-dark-500">
          {info.entries} blocks tracked · last scan {info.lastScanMs ? new Date(info.lastScanMs).toLocaleString() : '—'}
        </div>
      )}

      {report && (
        <div className="glass-card rounded-2xl p-4 grid grid-cols-5 gap-3">
          <Metric label="Files" value={report.filesScanned} />
          <Metric label="Added" value={report.notesAdded} tone="saffron" />
          <Metric label="Updated" value={report.notesUpdated} tone="persian" />
          <Metric label="Unchanged" value={report.notesUnchanged} />
          <Metric label="Orphans" value={report.orphans} tone="crimson" />
          {report.errors.length > 0 && (
            <div className="col-span-5 mt-2 pt-3 border-t border-white/[0.04]">
              <div className="text-2xs uppercase tracking-widest text-crimson-300 mb-2">
                {report.errors.length} block{report.errors.length === 1 ? '' : 's'} skipped
              </div>
              <ul className="text-2xs font-mono text-dark-300 space-y-0.5 max-h-32 overflow-y-auto">
                {report.errors.slice(0, 20).map((e, i) => (
                  <li key={i}>
                    <span className="text-dark-500">{e.filePath}:</span> {e.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {error && <div className="text-sm text-crimson-300 font-light">{error}</div>}
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: 'saffron' | 'persian' | 'crimson' }) {
  const toneClass = tone === 'saffron' ? 'text-saffron-300'
    : tone === 'persian' ? 'text-persian-200'
    : tone === 'crimson' ? 'text-crimson-300'
    : 'text-dark-100';
  return (
    <div className="text-center">
      <div className={`text-lg font-light ${toneClass}`}>{value}</div>
      <div className="text-2xs uppercase tracking-widest text-dark-500 mt-0.5">{label}</div>
    </div>
  );
}
