'use client';

import Link from 'next/link';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { Deck } from '@/lib/db/schema';
import { createNote, listDecks } from '@/lib/db/queries';
import CardEditor, { type NoteDraft } from '@/components/card/CardEditor';

function NewNoteInner() {
  const router = useRouter();
  const search = useSearchParams();
  const initialDeckId = search.get('deckId') ?? '';
  const [decks, setDecks] = useState<Deck[]>([]);
  const [deckId, setDeckId] = useState(initialDeckId);
  const [busy, setBusy] = useState(false);
  const [savedKey, setSavedKey] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    listDecks().then(setDecks);
  }, []);

  useEffect(() => {
    if (!deckId && decks.length > 0) setDeckId(decks[0].id);
  }, [decks, deckId]);

  const save = async (draft: NoteDraft) => {
    if (!deckId) return;
    setBusy(true);
    try {
      await createNote({
        deckId,
        fields: draft.fields,
        tags: draft.tags,
        tier: draft.tier,
        siblings: draft.siblings,
      });
      setSavedKey(k => k + 1);
      setFlash('Saved. Editing a fresh note.');
      setTimeout(() => setFlash(null), 1800);
    } finally {
      setBusy(false);
    }
  };

  // Hooks must run on every render — derive transcribeAudio above any early
  // return so React's hook-call order stays stable.
  const transcribeAudio = useMemo(
    () => decks.find(d => d.id === deckId)?.audioTranscribe ?? false,
    [decks, deckId],
  );

  // Only show the empty state when we genuinely have nothing — no decks
  // returned AND no deckId hinted from the URL. If the URL gave us a
  // deckId, render the form optimistically; the dropdown will fill in
  // once listDecks resolves.
  if (decks.length === 0 && !deckId) {
    return (
      <div className="max-w-xl mx-auto px-6 py-10">
        <p className="text-dark-300 mb-3">You need a deck first.</p>
        <Link href="/decks/new" className="btn-gradient px-5 py-2 rounded-xl text-sm">Create a deck</Link>
      </div>
    );
  }

  const currentDeckName = decks.find(d => d.id === deckId)?.name;

  return (
    <div className="max-w-5xl mx-auto px-6 py-10">
      <Link
        href={deckId ? `/deck/${deckId}` : '/'}
        className="text-sm text-dark-300 hover:text-dark-100 transition"
      >
        ← {currentDeckName || 'Decks'}
      </Link>

      <div className="flex items-end justify-between mt-3 mb-6 gap-4 flex-wrap">
        <h1 className="text-3xl font-extralight tracking-tight">New note</h1>
        <select
          value={deckId}
          onChange={e => setDeckId(e.target.value)}
          className="bg-dark-800/30 rounded-xl px-4 py-2 text-sm text-dark-100 outline-none focus:bg-dark-800/50 transition border border-white/[0.04] cursor-pointer"
        >
          {decks.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </div>

      {flash && (
        <div className="mb-4 px-4 py-2 rounded-xl bg-persian-900/30 text-persian-200 text-sm animate-fade-in">
          {flash}
        </div>
      )}

      <CardEditor
        resetKey={savedKey}
        onSave={save}
        saveLabel="Save & add another"
        busy={busy}
        onCancel={() => router.push(deckId ? `/deck/${deckId}` : '/')}
        transcribeAudio={transcribeAudio}
      />
    </div>
  );
}

export default function NewNotePage() {
  return (
    <Suspense fallback={<div className="max-w-xl mx-auto px-6 py-10 text-dark-400">Loading…</div>}>
      <NewNoteInner />
    </Suspense>
  );
}
