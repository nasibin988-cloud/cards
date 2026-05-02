'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createDeck } from '@/lib/db/queries';

export default function NewDeckPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    const deck = await createDeck({ name: name.trim(), description: description.trim() || undefined });
    router.push(`/deck/${deck.id}`);
  };

  return (
    <div className="max-w-xl mx-auto px-4 md:px-6 py-6 md:py-10">
      <div className="flex items-end justify-between mb-6 gap-3 flex-wrap">
        <h1 className="text-3xl font-extralight tracking-tight">New deck</h1>
        <Link
          href="/decks/new/conversational"
          className="text-2xs uppercase tracking-[0.2em] font-light px-3 py-1.5 rounded-lg text-saffron-300 hover:text-saffron-200 hover:bg-saffron-900/15 transition border border-saffron-700/30"
        >
          Talk to a deck (AI) →
        </Link>
      </div>

      <div className="space-y-4 glass-card rounded-2xl p-6">
        <label className="block">
          <div className="text-2xs uppercase tracking-widest text-dark-400 mb-1.5">Name</div>
          <input
            autoFocus
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && save()}
            className="w-full bg-dark-800/30 rounded-xl px-4 py-2.5 text-sm text-dark-100 outline-none focus:bg-dark-800/50 transition border border-white/[0.04] focus:border-persian-500/30"
            placeholder="MCAT — Biology, Persian Vocabulary, …"
          />
        </label>
        <label className="block">
          <div className="text-2xs uppercase tracking-widest text-dark-400 mb-1.5">Description (optional)</div>
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            rows={3}
            className="w-full bg-dark-800/30 rounded-xl px-4 py-2.5 text-sm text-dark-100 outline-none focus:bg-dark-800/50 transition border border-white/[0.04] focus:border-persian-500/30"
          />
        </label>
        <div className="flex items-center gap-3 pt-2">
          <button onClick={save} disabled={busy || !name.trim()} className="btn-gradient px-5 py-2 rounded-xl text-sm">
            {busy ? 'Creating…' : 'Create deck'}
          </button>
          <Link href="/" className="text-dark-300 hover:text-dark-100 px-3 py-1.5 text-sm transition">
            Cancel
          </Link>
        </div>
      </div>
    </div>
  );
}
