'use client';

import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Deck, Note } from '@/lib/db/schema';
import type { NoteFlag } from '@/lib/db/schema';
import { deleteNote, getDeck, getNote, setNoteFlag, updateNote } from '@/lib/db/queries';
import CardEditor, { type NoteDraft } from '@/components/card/CardEditor';
import CardActions from '@/components/note/CardActions';
import FlagPicker from '@/components/note/FlagPicker';
import ConvertNoteType from '@/components/note/ConvertNoteType';
import XlinkSuggester from '@/components/note/XlinkSuggester';

export default function EditNotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [note, setNote] = useState<Note | null | undefined>(undefined);
  const [deck, setDeck] = useState<Deck | null>(null);
  const [busy, setBusy] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);

  useEffect(() => {
    getNote(id).then(async n => {
      setNote(n ?? null);
      if (n) setDeck((await getDeck(n.deckId)) ?? null);
    });
  }, [id]);

  const save = async (draft: NoteDraft) => {
    if (!note) return;
    setBusy(true);
    await updateNote(note.id, { fields: draft.fields, tags: draft.tags, tier: draft.tier, siblings: draft.siblings });
    setBusy(false);
    router.push(`/deck/${note.deckId}`);
  };

  const remove = async () => {
    if (!note) return;
    if (!confirm('Delete this note and its cards?')) return;
    await deleteNote(note.id);
    router.push(`/deck/${note.deckId}`);
  };

  if (note === undefined) {
    return <div className="max-w-xl mx-auto px-6 py-10 text-dark-400">Loading…</div>;
  }
  if (!note) {
    return (
      <div className="max-w-xl mx-auto px-6 py-10">
        <p className="text-dark-300">Note not found.</p>
        <Link href="/" className="text-saffron-300 underline">← Back to decks</Link>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-6 py-10">
      <Link href={`/deck/${note.deckId}`} className="text-sm text-dark-300 hover:text-dark-100 transition">← Deck</Link>
      <h1 className="text-3xl font-extralight tracking-tight mt-3 mb-6">Edit note</h1>
      <div className="mb-4 flex items-center gap-3 flex-wrap">
        <FlagPicker
          value={note.flag}
          busy={busy}
          onChange={async (next: NoteFlag | undefined) => {
            await setNoteFlag(note.id, next);
            setNote({ ...note, flag: next, modifiedAt: Date.now() });
          }}
        />
        <span className="flex-1" />
        {note.modelId !== 'image-occlusion' && (
          <button
            onClick={() => setConvertOpen(true)}
            className="text-2xs uppercase tracking-[0.2em] font-light px-3 py-1.5 rounded-lg text-dark-200 hover:text-dark-50 hover:bg-white/[0.04] transition border border-white/[0.06]"
          >
            Convert: {note.modelId === 'cloze' ? 'cloze → basic' : 'basic → cloze'}
          </button>
        )}
      </div>

      <CardEditor
        initial={{ fields: note.fields, tags: note.tags, tier: note.tier, siblings: note.siblings }}
        onSave={save}
        onCancel={() => router.push(`/deck/${note.deckId}`)}
        saveLabel="Save"
        busy={busy}
        showDelete
        onDelete={remove}
        transcribeAudio={!!deck?.audioTranscribe}
      />

      <div className="mt-10">
        <h2 className="text-xs uppercase tracking-widest text-dark-400 mb-3">Suggested links</h2>
        <XlinkSuggester note={note} onUpdated={(n) => setNote(n)} />
      </div>

      <div className="mt-10">
        <h2 className="text-xs uppercase tracking-widest text-dark-400 mb-3">Card actions</h2>
        <CardActions noteId={note.id} />
      </div>

      {convertOpen && (
        <ConvertNoteType
          note={note}
          onClose={() => setConvertOpen(false)}
          onConverted={async () => {
            setConvertOpen(false);
            const fresh = await getNote(note.id);
            setNote(fresh ?? null);
          }}
        />
      )}
    </div>
  );
}
