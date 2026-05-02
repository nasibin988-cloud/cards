'use client';

import { useEffect, useRef, useState } from 'react';
import {
  loadLemmaIndex,
  ensureLemmaIndexLoaded,
  clearLemmaIndex,
} from '@/lib/lookup/persian';

export default function LookupSettings() {
  const [count, setCount] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ensureLemmaIndexLoaded().then(setCount);
  }, []);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setLoading(true); setError(null);
    try {
      const { count: n } = await loadLemmaIndex(f);
      setCount(n);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const reset = async () => {
    await clearLemmaIndex();
    setCount(0);
  };

  return (
    <div className="space-y-3">
      <div className="text-xs text-dark-400 font-light leading-relaxed">
        During study, double-click any Farsi word to open a lookup panel. Local index hits are instant; misses fall back to Claude (results are cached). Optional: upload a JSONL or CSV from{' '}
        <code className="text-saffron-300 font-mono">DICTIONARY/V2</code> with columns{' '}
        <code className="text-saffron-300 font-mono">headword, gloss, etymology, example, pos</code>.
      </div>
      <div className="flex items-center gap-3">
        <input
          ref={fileRef}
          type="file"
          accept=".jsonl,.json,.csv,.txt"
          onChange={onFile}
          className="text-sm text-dark-200 file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border-0 file:bg-dark-800/50 file:text-dark-100 file:cursor-pointer hover:file:bg-dark-800/70"
        />
        {count > 0 && (
          <button
            onClick={reset}
            className="text-2xs uppercase tracking-widest text-crimson-400 hover:text-crimson-300 transition"
          >
            Clear index
          </button>
        )}
      </div>
      <div className="text-2xs uppercase tracking-widest font-mono text-dark-500">
        {loading ? 'parsing…' : count > 0 ? `${count.toLocaleString()} entries indexed` : 'no local index loaded — Claude only'}
      </div>
      {error && <div className="text-sm text-crimson-300 font-light">{error}</div>}
    </div>
  );
}
