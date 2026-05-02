/**
 * Internal data model. FSRS state is embedded on Card; mapping to ts-fsrs's
 * snake_case interface happens at the FSRS boundary (lib/fsrs/scheduler.ts).
 */

export type CardState = 'new' | 'learning' | 'review' | 'relearning';
export type Rating = 1 | 2 | 3 | 4; // again | hard | good | easy

export type Tier =
  | 'core'
  | 'clinical'
  | 'advanced'
  | 'bridge'
  | 'standard'
  | 'extended'
  | 'scholarly';

/**
 * Triage flag set on a Note. Distinct from `tier` (which is content rating).
 *  - revisit: marked for a second pass
 *  - broken:  card has a content/parsing problem
 *  - exemplar: a reference-quality card to model others on
 *  - errata:  contains a known mistake to fix
 */
export type NoteFlag = 'revisit' | 'broken' | 'exemplar' | 'errata';

/**
 * Sibling card definition. Each sibling on a note becomes one independently-
 * scheduled `Card` row, linked by `Card.siblingId`. Front/back fields are
 * pulled from `note.fields[frontField]` / `note.fields[backField]` at render.
 *
 * Use case: a vocabulary note with `front=word, back=definition, extra=example`
 * can declare two siblings:
 *   { id: 'fwd', frontField: 'front', backField: 'back', label: 'word→def' }
 *   { id: 'rev', frontField: 'back',  backField: 'front', label: 'def→word' }
 * to drill in both directions from a single note.
 */
export type FieldKey = keyof NoteFields;

export interface SiblingDef {
  /** Stable id, used to match Card.siblingId. ULID or short slug. */
  id: string;
  frontField: FieldKey;
  backField: FieldKey;
  /** Optional human-readable label, e.g. "word→def". */
  label?: string;
}

export interface NoteFields {
  front: string;
  back: string;
  extra?: string;
  image?: string;
  mnemonic?: string;
  context?: string;
  source?: string;
}

export interface OcclusionRect {
  /** 0-1 normalized to image dimensions, so rendering scales cleanly. */
  x: number; y: number; w: number; h: number;
  /** label shown when revealed (optional, e.g. "frontal lobe"). */
  label?: string;
}

export interface Note {
  id: string;
  deckId: string;
  modelId: 'basic' | 'cloze' | 'image-occlusion' | string;
  fields: NoteFields;
  tags: string[];
  tier?: Tier;
  flag?: NoteFlag;
  /** Only set when modelId === 'image-occlusion'. */
  occlusions?: OcclusionRect[];
  /** When set on a basic note, generates one card per sibling instead of one. */
  siblings?: SiblingDef[];
  createdAt: number;
  modifiedAt: number;
}

export interface Card {
  id: string;
  noteId: string;
  deckId: string;
  clozeOrd?: number;
  /** Set when this Card represents a Note.siblings entry. */
  siblingId?: string;

  // FSRS-5 state
  due: number;             // ms timestamp
  stability: number;
  difficulty: number;
  elapsedDays: number;
  scheduledDays: number;
  learningSteps: number;
  reps: number;
  lapses: number;
  state: CardState;
  lastReview?: number;     // ms timestamp

  suspended: boolean;
  buried: boolean;
  /**
   * When the card was last buried (ms epoch). Used by unburryStaleCards to
   * tell "buried-this-session" from "buried-yesterday-or-earlier". Without
   * this, the unbury filter has no clock to compare against and ends up
   * unburying same-session siblings immediately.
   */
  buriedAt?: number;
  createdAt: number;
  modifiedAt: number;
}

export type NewCardOrder = 'added' | 'random' | 'tagInterleaved';

/**
 * Per-file entry in a deck's image-source manifest. We hash bytes (SHA-256
 * truncated to 16 hex chars; that's still 2^64 collision domain, plenty for
 * a single-deck namespace) so re-syncing detects changes deterministically.
 */
export interface ImagesSourceEntry {
  hash: string;
  sizeBytes: number;
  mtime: number;
}

/**
 * State carried by a Deck that has been linked to a directory of source
 * images. The actual `FileSystemDirectoryHandle` lives in raw IndexedDB
 * (Dexie can't clone it); this struct stores everything else so the UI
 * can render status without dereferencing the handle.
 */
export interface ImagesSource {
  /** Display name of the linked directory at link time (e.g. "images"). */
  rootName: string;
  /** SHA-256 of bytes (per filename) at last successful sync. */
  manifest: { [filename: string]: ImagesSourceEntry };
  /** ms timestamp of the last apply. */
  lastSyncedAt: number;
  /** Number of files in the manifest at last sync (cheap to read in UI). */
  fileCount: number;
}

export interface Deck {
  id: string;
  parentId?: string;
  name: string;
  description?: string;
  fsrsParams?: number[];
  desiredRetention?: number;
  maxInterval?: number;
  newCardsPerDay?: number;
  reviewsPerDay?: number;
  /**
   * Optional: this deck's image source-of-truth on disk. The
   * `FileSystemDirectoryHandle` itself is persisted in raw IndexedDB
   * (`cards-image-source-handles`, keyed by `deckId`).
   */
  imagesSource?: ImagesSource;
  /**
   * How `getNextCardForStudy` chooses among new cards.
   *  - 'added' (default): oldest createdAt first, FIFO
   *  - 'random': shuffled across the new pool, deterministic per session start
   *  - 'tagInterleaved': round-robin across distinct first-tag groups so
   *    the user doesn't see 50 enzymes in a row
   */
  newCardOrder?: NewCardOrder;
  /**
   * Per-deck opt-in: when true, the editor's audio recorder will run live
   * Web Speech API transcription alongside the recording and stuff the
   * transcript into a target field (default: extra).
   */
  audioTranscribe?: boolean;
  createdAt: number;
  modifiedAt: number;
}

export interface ReviewLog {
  id: string;
  cardId: string;
  deckId: string;          // denormalized for fast deck-scoped stats
  rating: Rating;
  state: CardState;
  due: number;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  lastElapsedDays: number;
  scheduledDays: number;
  review: number;          // ms timestamp
  durationMs: number;
}

export interface Media {
  id: string;
  filename: string;
  mimeType: string;
  blob: Blob;
}

export interface Setting {
  key: string;
  value: string;           // JSON-encoded for non-string values
}

/**
 * A saved practice query: a named search-syntax string + optional deck
 * scope. Running it materializes a one-off study queue from notes that
 * match. FSRS state still updates on rate — these are NOT filtered decks
 * in the Anki sense, just a saved-search-driven study mode.
 */
export interface PracticeQuery {
  id: string;
  name: string;
  /** Search-syntax string fed through `parseQuery`. */
  query: string;
  /** When set, restricts the query to that deck. */
  deckId?: string;
  createdAt: number;
  modifiedAt: number;
}

/* ─── Feynman mode ────────────────────────────────────────────── */

/**
 * The user's plain-language explanation of a card, evaluated by Claude
 * against the card's back + extra. Stored so we can show progress over
 * time ("your explanations of glycolysis are getting more complete") and
 * so the schedule can apply a longer interval when the user actually
 * demonstrated deep understanding rather than just recognition.
 */
export interface FeynmanGrade {
  /** Bullet points of what the user explained correctly. */
  covered: string[];
  /** Bullet points present in back/extra that the user didn't say. */
  missed: string[];
  /** Terms used without explanation, contradictions, or hand-waved logic. */
  vague: string[];
  /** 0..1 — fraction of the card's reference content the user covered. */
  completeness: number;
  /** 1-2 sentence overall summary surfaced in the UI. */
  rationale: string;
}

export interface FeynmanLog {
  id: string;
  cardId: string;
  noteId: string;
  deckId: string;
  /** ms timestamp at submit time. */
  createdAt: number;
  /** Verbatim text the user typed/dictated. */
  explanation: string;
  /** How the explanation was captured. */
  inputMode: 'text' | 'voice';
  /** ms the user spent composing the explanation. */
  durationMs: number;
  /** Claude's structured grade. Absent while in flight or if the user skipped grading. */
  grade?: FeynmanGrade;
  /** Rating the user gave after seeing the grade (1-4 / Again-Easy). */
  rating?: 1 | 2 | 3 | 4;
  /** When set, the FSRS schedule was multiplied by this factor for the bonus. */
  scheduleMultiplier?: number;
}

/* ─── Incremental reading ──────────────────────────────────────── */

/**
 * A long-form text the user is reading and turning into cards over time.
 * Body is plain text (or markdown rendered as plain) and never mutated
 * after creation, so character offsets in highlights stay valid.
 */
export interface Source {
  id: string;
  title: string;
  kind: 'paste' | 'pdf';
  body: string;
  addedAt: number;
  lastReadAt?: number;
  /** Scroll position 0..1; updated when the reader unmounts or scrolls. */
  progress: number;
  /** Auto-created `Reading::<title>` deck where promoted highlights land. */
  deckId: string;
}

/**
 * A user-marked range inside a source body. When promoted to a card,
 * `noteId` points at the cloze note created from the surrounding paragraph
 * with this highlight wrapped in `{{c1::…}}`.
 */
export interface Highlight {
  id: string;
  sourceId: string;
  /** Character offset (inclusive) into source.body. */
  start: number;
  /** Character offset (exclusive). */
  end: number;
  /** The highlighted text — preserved for display + survival. */
  text: string;
  noteId?: string;
  createdAt: number;
}

/* ─── AI exam ────────────────────────────────────────────────── */

export type ExamCoverage =
  | { kind: 'random' }
  | { kind: 'lapses' }
  | { kind: 'tags'; tags: string[] };

export type ExamDifficulty = 'match' | 'harder' | 'easier';
export type ExamQuestionType = 'mcq' | 'free';
export type ExamStatus = 'draft' | 'in_progress' | 'submitted';

export interface ExamConfig {
  count: number;
  types: ExamQuestionType[];   // mix; e.g. ['mcq'] or ['mcq','free']
  difficulty: ExamDifficulty;
  coverage: ExamCoverage;
}

export interface Exam {
  id: string;
  deckId: string;
  title: string;
  config: ExamConfig;
  status: ExamStatus;
  createdAt: number;
  startedAt?: number;
  submittedAt?: number;
  /** 0..1, set after submission. */
  scoreOverall?: number;
}

export interface ExamQuestion {
  id: string;
  examId: string;
  index: number;
  type: ExamQuestionType;
  prompt: string;
  // MCQ
  choices?: string[];
  correctIndex?: number;
  // Free response
  expectedAnswer?: string;
  // Provenance: noteIds the question is derived from.
  sourceNoteIds: string[];
  // Answer state
  userAnswer?: string;
  userChoiceIndex?: number;
  /** 0..1; 1 if MCQ correct, AI-graded for free response. */
  score?: number;
  /** Markdown feedback, AI-generated for free response. */
  feedback?: string;
}
