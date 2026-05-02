'use client';

import { useEffect, useRef, useState } from 'react';
import { lookupPersianWord, type LemmaEntry } from '@/lib/lookup/persian';
import { cn } from '@/lib/utils';

interface Props {
  open: boolean;
  onClose: () => void;
  initialWord: string;
}

/**
 * Slide-over for Persian word lookup. Shown during study when the user
 * clicks/double-clicks a Farsi word inside the card prose.
 */
export default function LookupPanel({ open, onClose, initialWord }: Props) {
  const [word, setWord] = useState(initialWord);
  const [entry, setEntry] = useState<LemmaEntry | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setWord(initialWord);
    if (initialWord) doLookup(initialWord);
    setTimeout(() => inputRef.current?.focus(), 30);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialWord]);

  const doLookup = async (q: string) => {
    if (!q.trim()) return;
    setLoading(true); setError(null); setEntry(null);
    try {
      const e = await lookupPersianWord(q.trim());
      setEntry(e);
      if (!e) setError('No entry found.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <aside
      className={cn(
        'fixed top-0 right-0 h-full w-full md:w-[26rem] z-50 transform transition-transform duration-300',
        'bg-dark-950/95 backdrop-blur-xl border-l border-white/[0.05] flex flex-col',
        open ? 'translate-x-0' : 'translate-x-full',
      )}
      dir="rtl"
    >
      <header className="px-5 py-4 border-b border-white/[0.04] flex items-center justify-between" dir="ltr">
        <div>
          <h2 className="font-light tracking-tight text-dark-100">Persian lookup</h2>
          <p className="text-xs text-dark-400 mt-0.5">Local index → cache → Claude.</p>
        </div>
        <button onClick={onClose} className="text-dark-300 hover:text-dark-100 transition text-sm px-2 py-1 rounded-lg hover:bg-white/[0.04]">
          Close
        </button>
      </header>

      <div className="px-5 py-3 border-b border-white/[0.04]" dir="ltr">
        <input
          ref={inputRef}
          value={word}
          onChange={e => setWord(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') doLookup(word); }}
          placeholder="Word…"
          className="w-full bg-dark-800/30 rounded-xl px-4 py-2 text-sm font-farsi text-dark-100 placeholder:text-dark-500 outline-none focus:bg-dark-800/50 transition border border-white/[0.04] focus:border-persian-500/30"
          dir="rtl"
        />
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        {loading && <div className="text-sm text-dark-400 italic font-light loading-shimmer rounded-md px-2 py-1 inline-block" dir="ltr">Looking up…</div>}
        {error && !loading && <div className="text-sm text-crimson-300 font-light" dir="ltr">{error}</div>}
        {entry && !loading && (
          <div className="space-y-4">
            <div>
              <div className="font-farsi text-3xl font-extralight tracking-tight text-saffron-200">
                {entry.headword}
              </div>
              {entry.pos && (
                <div className="text-2xs uppercase tracking-widest text-dark-500 mt-1 font-mono" dir="ltr">{entry.pos}</div>
              )}
            </div>
            {entry.gloss && (
              <Block label="Gloss" body={entry.gloss} dir="ltr" />
            )}
            {entry.etymology && (
              <Block label="Etymology" body={entry.etymology} dir="ltr" />
            )}
            {entry.example && (
              <Block label="Example" body={entry.example} farsi />
            )}
            <div className="text-2xs uppercase tracking-widest text-dark-500 font-mono pt-2 border-t border-white/[0.04]" dir="ltr">
              source: {entry.source ?? '?'}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

function Block({ label, body, dir, farsi }: { label: string; body: string; dir?: 'ltr' | 'rtl'; farsi?: boolean }) {
  return (
    <div>
      <div className="text-2xs uppercase tracking-widest text-dark-400 mb-1" dir="ltr">{label}</div>
      <div
        className={cn('text-sm font-light text-dark-100', farsi && 'font-farsi text-base leading-relaxed')}
        dir={dir ?? (farsi ? 'rtl' : 'ltr')}
      >
        {body}
      </div>
    </div>
  );
}
