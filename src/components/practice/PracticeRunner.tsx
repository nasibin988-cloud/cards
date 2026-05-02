'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { Deck, PracticeQuery } from '@/lib/db/schema';
import { getDeck } from '@/lib/db/queries';
import { getPracticeQuery, resolvePracticeQuery } from '@/lib/practice/queries';
import { DEFAULT_RETENTION, DEFAULT_MAX_INTERVAL } from '@/lib/fsrs/defaults';
import Reviewer from '@/components/study/Reviewer';

const VIRTUAL_DECK_ID = '_practice';

/**
 * Runs a saved practice query as a study session: resolves the query to a
 * note-ID set, then mounts Reviewer with that filter. When the saved query
 * is scoped to a single deck, that deck's FSRS params are honored.
 */
export default function PracticeRunner({ id }: { id: string }) {
  const [query, setQuery] = useState<PracticeQuery | null | undefined>(undefined);
  const [noteIds, setNoteIds] = useState<Set<string> | null>(null);
  const [deck, setDeck] = useState<Deck | null>(null);

  useEffect(() => {
    (async () => {
      const q = await getPracticeQuery(id);
      setQuery(q ?? null);
      if (!q) return;

      const ids = await resolvePracticeQuery(q);
      setNoteIds(new Set(ids));

      // Synthesize a Deck object so the Reviewer can read FSRS params.
      // For deck-scoped saved queries, use the real deck.
      if (q.deckId) {
        const real = await getDeck(q.deckId);
        if (real) {
          setDeck({ ...real, name: q.name });
          return;
        }
      }
      setDeck({
        id: VIRTUAL_DECK_ID,
        name: q.name,
        desiredRetention: DEFAULT_RETENTION,
        maxInterval: DEFAULT_MAX_INTERVAL,
        createdAt: 0,
        modifiedAt: 0,
      });
    })();
  }, [id]);

  if (query === undefined) {
    return <div className="max-w-2xl mx-auto px-6 py-10 text-dark-400">Loading…</div>;
  }
  if (!query) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-10">
        <p className="text-dark-300">Practice query not found.</p>
        <Link href="/practice" className="text-saffron-300 underline">← Practice</Link>
      </div>
    );
  }
  if (!deck || !noteIds) {
    return <div className="max-w-2xl mx-auto px-6 py-10 text-dark-400">Resolving…</div>;
  }
  if (noteIds.size === 0) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-10">
        <h1 className="text-3xl font-extralight tracking-tight mb-2">{query.name}</h1>
        <p className="text-dark-300 font-light text-sm">
          No notes match this query right now. Edit the query in <Link href="/practice" className="text-saffron-300 underline">Practice</Link> or add notes that fit.
        </p>
      </div>
    );
  }

  return <Reviewer deck={deck} noteIdFilter={noteIds} />;
}
