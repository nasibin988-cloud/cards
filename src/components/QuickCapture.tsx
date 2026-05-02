'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { createNote, getOrCreateDeckByName } from '@/lib/db/queries';
import { cn } from '@/lib/utils';

/**
 * Global Quick Capture modal. Opens on `Cmd+Shift+C` (Ctrl+Shift+C on
 * Linux/Windows). Single textarea — first line becomes `front`, the rest
 * becomes `back`. Submits with Cmd/Ctrl+Enter, closes with Esc. The note
 * lands in an auto-created `Inbox` deck so the user never has to navigate.
 *
 * Mounted once in AppShell so it works from anywhere in the app.
 */
export default function QuickCapture() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [savedId, setSavedId] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Global hotkey listener. Uses Alt+Shift+C / Opt+Shift+C — Cmd+Shift+C
  // is reserved by Chrome on macOS for "Inspect element," and Ctrl+Shift+C
  // collides with the same shortcut on Linux/Windows. Alt+Shift+C is free
  // across platforms and ergonomically close to Anki's Ctrl+N.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const wantsCapture = e.altKey && e.shiftKey && (e.key === 'c' || e.key === 'C' || e.code === 'KeyC');
      if (!wantsCapture) return;
      e.preventDefault();
      setOpen(o => !o);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Autofocus when the modal opens.
  useEffect(() => {
    if (open) setTimeout(() => textareaRef.current?.focus(), 0);
  }, [open]);

  const close = () => {
    setOpen(false);
    setText('');
    setSavedId(null);
  };

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      const deck = await getOrCreateDeckByName('Inbox', 'Quick-capture notes for triage.');
      const lines = trimmed.split(/\r?\n/);
      const front = lines[0];
      const back = lines.slice(1).join('\n').trim();
      const { note } = await createNote({
        deckId: deck.id,
        fields: { front, back },
        tags: ['inbox'],
      });
      setSavedId(note.id);
      setText('');
      // Clear the saved-toast after a short window.
      setTimeout(() => setSavedId(null), 3000);
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center pt-24 px-4 bg-dark-950/70 backdrop-blur-sm animate-fade-in"
      onClick={close}
    >
      <div
        className={cn(
          'glass-card rounded-3xl p-6 max-w-xl w-full animate-slide-up',
          'border border-white/[0.06] space-y-3',
        )}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-baseline justify-between">
          <h2 className="text-xl font-extralight tracking-tight bg-gradient-to-r from-saffron-300 to-persian-300 bg-clip-text text-transparent">
            Quick capture
          </h2>
          <span className="text-2xs uppercase tracking-widest text-dark-500">
            → Inbox deck
          </span>
        </div>

        <textarea
          ref={textareaRef}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              close();
            }
          }}
          rows={5}
          placeholder="First line becomes the front. Rest becomes the back."
          className="w-full bg-dark-900/40 rounded-xl px-4 py-3 text-sm text-dark-100 placeholder:text-dark-500 outline-none focus:bg-dark-900/60 transition border border-white/[0.04] resize-none"
        />

        <div className="flex items-center justify-between text-2xs uppercase tracking-widest text-dark-500">
          <span>
            <kbd className="font-mono text-dark-300">⌘↵</kbd> save · <kbd className="font-mono text-dark-300">Esc</kbd> close
          </span>
          {savedId && (
            <Link
              href={`/note/${savedId}`}
              className="text-saffron-300 hover:text-saffron-200 transition normal-case tracking-normal"
              onClick={close}
            >
              Saved → open note
            </Link>
          )}
          <button
            onClick={submit}
            disabled={!text.trim() || busy}
            className="btn-gradient px-4 py-1.5 rounded-lg text-2xs uppercase tracking-[0.2em] font-light disabled:opacity-40"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
