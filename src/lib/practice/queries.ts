import { db } from '@/lib/db/dexie';
import type { PracticeQuery } from '@/lib/db/schema';
import { id as ulid } from '@/lib/ulid';
import { browseNotes } from '@/lib/db/queries';
import { parseQuery } from '@/lib/search/query';

export async function listPracticeQueries(): Promise<PracticeQuery[]> {
  const all = await db().practiceQueries.toArray();
  return all.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

export async function getPracticeQuery(id: string): Promise<PracticeQuery | undefined> {
  return db().practiceQueries.get(id);
}

export async function createPracticeQuery(input: {
  name: string;
  query: string;
  deckId?: string;
}): Promise<PracticeQuery> {
  const t = Date.now();
  const q: PracticeQuery = {
    id: ulid(),
    name: input.name.trim(),
    query: input.query.trim(),
    deckId: input.deckId,
    createdAt: t,
    modifiedAt: t,
  };
  await db().practiceQueries.put(q);
  return q;
}

export async function updatePracticeQuery(
  id: string,
  patch: Partial<Pick<PracticeQuery, 'name' | 'query' | 'deckId'>>,
): Promise<void> {
  const t = Date.now();
  await db().practiceQueries.update(id, { ...patch, modifiedAt: t });
}

export async function deletePracticeQuery(id: string): Promise<void> {
  await db().practiceQueries.delete(id);
}

/**
 * Resolve a saved query into the matching note IDs (so the Reviewer can
 * pull cards from that subset). The query is parsed by the same parser
 * the deck browser uses, so syntax stays identical.
 *
 * `deck:` operators inside the query are matched as case-insensitive
 * substrings against deck names, so `deck:Bio` will match
 * "MCAT::Biology" and "AP Bio".
 */
export async function resolvePracticeQuery(q: PracticeQuery): Promise<string[]> {
  const parsed = parseQuery(q.query);

  let deckIds: string[] | null = null;
  if (q.deckId) {
    deckIds = [q.deckId];
  } else if (parsed.deckMatches?.length) {
    const all = await db().decks.toArray();
    const wanted = parsed.deckMatches.map(s => s.toLowerCase());
    deckIds = all
      .filter(d => wanted.some(w => d.name.toLowerCase().includes(w)))
      .map(d => d.id);
  } else {
    deckIds = (await db().decks.toArray()).map(d => d.id);
  }

  const noteIds = new Set<string>();
  await Promise.all(deckIds.map(async id => {
    const notes = await browseNotes(id, { ...parsed.filters, query: parsed.text || undefined }, 5000);
    for (const n of notes) noteIds.add(n.id);
  }));
  return [...noteIds];
}
