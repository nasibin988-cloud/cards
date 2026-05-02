import Dexie, { type Table } from 'dexie';
import type {
  Card,
  Deck,
  Exam,
  ExamQuestion,
  FeynmanLog,
  Highlight,
  Media,
  Note,
  PracticeQuery,
  ReviewLog,
  Setting,
  Source,
} from './schema';
import { markDirty } from '@/lib/sync/dirty';

/**
 * Inverted-index posting: one row per (token, noteId) pair. Lets us run
 * lower-case substring search across N notes in O(log N) per token.
 * Compound primary key keeps each posting unique.
 */
export interface SearchPosting {
  /** Compound key "<token>::<noteId>" so we can use Dexie's primary key index. */
  pk: string;
  token: string;
  noteId: string;
  /** Field weight contribution from this token's location, summed at write. */
  weight: number;
}

export class CardsDB extends Dexie {
  notes!: Table<Note, string>;
  cards!: Table<Card, string>;
  decks!: Table<Deck, string>;
  reviewLogs!: Table<ReviewLog, string>;
  media!: Table<Media, string>;
  settings!: Table<Setting, string>;
  exams!: Table<Exam, string>;
  examQuestions!: Table<ExamQuestion, string>;
  practiceQueries!: Table<PracticeQuery, string>;
  searchTokens!: Table<SearchPosting, string>;
  sources!: Table<Source, string>;
  highlights!: Table<Highlight, string>;
  feynmanLogs!: Table<FeynmanLog, string>;

  constructor() {
    super('cards-v1');
    this.version(1).stores({
      notes: 'id, deckId, modelId, *tags, modifiedAt',
      cards: 'id, deckId, noteId, due, state, suspended, buried, [deckId+state], [deckId+due]',
      decks: 'id, parentId, name, modifiedAt',
      reviewLogs: 'id, cardId, deckId, review, [deckId+review]',
      media: 'id, filename',
      settings: 'key',
    });
    // v2 adds AI-exam tables. No data migration needed — they're new.
    this.version(2).stores({
      exams: 'id, deckId, status, createdAt',
      examQuestions: 'id, examId, [examId+index]',
    });
    // v3 adds saved practice queries.
    this.version(3).stores({
      practiceQueries: 'id, name, deckId, modifiedAt',
    });
    // v4 adds the search inverted index. Postings are rebuilt lazily on
    // first query if the table is empty (covers the migration case).
    this.version(4).stores({
      searchTokens: 'pk, token, noteId',
    });
    // v5 adds incremental-reading sources + highlights.
    this.version(5).stores({
      sources: 'id, title, addedAt, lastReadAt',
      highlights: 'id, sourceId, noteId, createdAt',
    });
    // v6 adds Feynman-mode attempts: per-card explanation log with grade.
    this.version(6).stores({
      feynmanLogs: 'id, cardId, noteId, deckId, createdAt, [cardId+createdAt]',
    });

    // Auto-sync dirty hooks. Any create/update/delete on user-data tables
    // fires `cards:dirty` so the auto-sync layer can debounce a push. We
    // intentionally skip `settings` (would loop on the sync_meta write
    // that push() itself does) and `media` / `searchTokens` (derived,
    // unsuitable for snapshot-replace sync). Hooks fire synchronously
    // before the operation lands; false positives (writes that later
    // fail) are harmless — the next status check just confirms in-sync.
    const dirtyTables: Array<keyof CardsDB> = [
      'cards', 'notes', 'decks', 'reviewLogs', 'exams', 'examQuestions',
      'practiceQueries', 'sources', 'highlights', 'feynmanLogs',
    ];
    for (const t of dirtyTables) {
      const tbl = (this as unknown as Record<string, Table>)[t as string];
      if (!tbl) continue;
      tbl.hook('creating', () => { markDirty(); });
      tbl.hook('updating', () => { markDirty(); });
      tbl.hook('deleting', () => { markDirty(); });
    }
  }
}

let _db: CardsDB | null = null;

export function db(): CardsDB {
  if (typeof window === 'undefined') {
    throw new Error('CardsDB is browser-only');
  }
  if (!_db) _db = new CardsDB();
  return _db;
}
