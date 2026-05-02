'use client';

import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import type { Deck } from '@/lib/db/schema';
import { getDeck } from '@/lib/db/queries';
import Reviewer from '@/components/study/Reviewer';

export default function StudyPage({ params }: { params: Promise<{ deckId: string }> }) {
  const { deckId } = use(params);
  const [deck, setDeck] = useState<Deck | null | undefined>(undefined);

  useEffect(() => {
    getDeck(deckId).then(d => setDeck(d ?? null));
  }, [deckId]);

  if (deck === undefined) {
    return <div className="min-h-screen flex items-center justify-center text-dark-400 font-light">Loading…</div>;
  }
  if (!deck) {
    return (
      <div className="max-w-xl mx-auto px-6 py-10">
        <p className="text-dark-300">Deck not found.</p>
        <Link href="/" className="text-saffron-300 underline">← Back to decks</Link>
      </div>
    );
  }
  return <Reviewer deck={deck} />;
}
