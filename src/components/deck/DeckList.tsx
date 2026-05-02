'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Deck } from '@/lib/db/schema';
import { listDecks } from '@/lib/db/queries';
import DeckTree from './DeckTree';

export default function DeckList() {
  const [decks, setDecks] = useState<Deck[] | null>(null);

  useEffect(() => {
    listDecks().then(setDecks);
  }, []);

  if (decks === null) {
    return (
      <div className="space-y-4">
        {[0, 1].map(i => (
          <div key={i} className="glass-card rounded-3xl h-44 loading-shimmer" />
        ))}
      </div>
    );
  }

  if (decks.length === 0) {
    return (
      <div className="glass-card rounded-3xl p-10 text-center space-y-4">
        <h2 className="text-2xl font-extralight tracking-tight bg-gradient-to-r from-saffron-300 to-persian-300 bg-clip-text text-transparent">
          No decks yet
        </h2>
        <p className="text-dark-300 font-light max-w-md mx-auto">
          Create your first deck or import an existing Anki <code className="text-saffron-300">.apkg</code> file.
        </p>
        <div className="flex gap-3 justify-center pt-2">
          <Link href="/decks/new" className="btn-gradient px-5 py-2 rounded-xl text-sm">
            New deck
          </Link>
          <Link
            href="/import"
            className="px-5 py-2 rounded-xl text-sm text-dark-200 hover:text-dark-50 hover:bg-white/[0.04] transition border border-white/[0.06]"
          >
            Import .apkg
          </Link>
        </div>
      </div>
    );
  }

  // Tree handles flat (no `::`) decks as top-level leaf cards, so it covers
  // every shape — no toggle needed.
  return <DeckTree />;
}
