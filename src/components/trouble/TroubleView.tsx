'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { listTroubleCards, type TroubleCard } from '@/lib/db/queries';
import { renderPlain } from '@/lib/cloze/parser';

export default function TroubleView() {
  const [items, setItems] = useState<TroubleCard[] | null>(null);
  const [minLapses, setMinLapses] = useState(3);

  useEffect(() => {
    listTroubleCards(minLapses, 100).then(setItems);
  }, [minLapses]);

  if (items === null) {
    return <div className="text-dark-400">Loading…</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <span className="text-2xs uppercase tracking-widest text-dark-400">Min lapses:</span>
        {[2, 3, 5, 8].map(n => (
          <button
            key={n}
            onClick={() => setMinLapses(n)}
            className={
              minLapses === n
                ? 'text-2xs uppercase tracking-widest font-mono px-3 py-1 rounded-md bg-persian-900/40 text-saffron-200 border border-saffron-700/30'
                : 'text-2xs uppercase tracking-widest font-mono px-3 py-1 rounded-md text-dark-300 border border-white/[0.04] hover:text-dark-100 hover:border-white/[0.08] transition'
            }
          >
            {n}
          </button>
        ))}
      </div>

      {items.length === 0 ? (
        <div className="glass-card rounded-2xl p-8 text-center text-dark-400">
          No cards at this lapse threshold. You're doing well.
        </div>
      ) : (
        <div className="glass-card rounded-2xl divide-y divide-white/[0.04]">
          {items.map(({ card, note, deckName }) => (
            <Link
              key={card.id}
              href={`/note/${note.id}`}
              className="block px-5 py-3 hover:bg-white/[0.02] transition"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-dark-100 font-light line-clamp-1">
                    {renderPlain(note.fields.front)}
                  </div>
                  <div className="text-2xs text-dark-500 font-mono mt-1">
                    {deckName}{card.clozeOrd != null ? ` · cloze ${card.clozeOrd}` : ''}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-lg font-light text-crimson-300">{card.lapses}</div>
                  <div className="text-2xs uppercase tracking-widest text-dark-500">lapses</div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
