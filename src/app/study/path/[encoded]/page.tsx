'use client';

import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import type { Deck } from '@/lib/db/schema';
import { listDecksAtOrUnderPath } from '@/lib/db/queries';
import { db } from '@/lib/db/dexie';
import Reviewer from '@/components/study/Reviewer';

/**
 * Study route for a virtual parent — i.e. an Anki "::" prefix that has child
 * decks but no Deck row of its own (e.g. "MCAT" when only
 * "MCAT::Biology::Ch01_*" rows exist).
 *
 * We resolve the path to a list of real deck ids and feed the Reviewer in
 * `virtualScope` mode so it pulls from that exact set instead of computing
 * descendants off a single deck. A synthetic Deck object stands in for the
 * `deck` prop so the Reviewer's existing UI path keeps working without
 * special-casing every header read.
 */
export default function StudyPathPage({ params }: { params: Promise<{ encoded: string }> }) {
  const { encoded } = use(params);
  const path = decodeURIComponent(encoded);

  const [resolution, setResolution] = useState<
    | { kind: 'loading' }
    | { kind: 'empty' }
    | { kind: 'ready'; deckIds: string[]; representative: Deck }
  >({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ids = await listDecksAtOrUnderPath(path);
      if (cancelled) return;
      if (ids.length === 0) {
        setResolution({ kind: 'empty' });
        return;
      }
      // The Reviewer uses `deck` for its retention auto-tune path (which we
      // skip for virtual scope) and for some `deck.id`-keyed bookkeeping. We
      // hand it the first descendant as a representative so any
      // accidentally-leaky `deck.id` use lands on a real row.
      const first = await db().decks.get(ids[0]);
      if (!first || cancelled) return;
      setResolution({ kind: 'ready', deckIds: ids, representative: first });
    })();
    return () => { cancelled = true; };
  }, [path]);

  if (resolution.kind === 'loading') {
    return <div className="min-h-screen flex items-center justify-center text-dark-400 font-light">Loading…</div>;
  }
  if (resolution.kind === 'empty') {
    return (
      <div className="max-w-xl mx-auto px-6 py-10">
        <p className="text-dark-300">No decks under &quot;{path}&quot;.</p>
        <Link href="/" className="text-saffron-300 underline">← Back to decks</Link>
      </div>
    );
  }
  // Synthesize a `deck` whose `id` is the path itself so any unintended
  // `deck.id` reads at least encode the scope. Real bookkeeping (resume,
  // dismiss-key) is keyed by `virtualScope.label` inside the Reviewer.
  const synthetic: Deck = {
    ...resolution.representative,
    id: `path:${path}`,
    name: path,
  };
  return (
    <Reviewer
      deck={synthetic}
      virtualScope={{ deckIds: resolution.deckIds, label: path }}
    />
  );
}
