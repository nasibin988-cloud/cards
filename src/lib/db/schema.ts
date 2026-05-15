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
  /**
   * AI-generated "distinct from X because Y" disambiguator, lives in
   * its own field so it never collides with the user's authored back.
   * Rendered as a labeled BackBlock on the reveal side.
   */
  disambiguator?: string;
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
  /**
   * Opus-generated alternate phrasings of `fields.front`. When non-empty,
   * the Reviewer rotates through (original, ...phrasings) on each review
   * — same FSRS state, different wording — so you learn the concept
   * rather than memorising the exact sentence. Cloze ords are preserved
   * across all phrasings (enforced at generation time).
   *
   * Top-level on Note (not inside `fields`) because `fields` is a
   * record-of-strings used by many iterating call-sites that assume
   * `string` values; phrasings are an array and would break that
   * contract.
   */
  phrasings?: string[];
  /**
   * Every phrasing this card has EVER had, including originals replaced
   * by later auto-rephrasings. Append-only; the user gets a small panel
   * on the card to step through them. Distinct from `phrasings` (the
   * live rotation pool) so we never lose past wordings the user wants
   * back.
   */
  phrasingHistory?: string[];
  /**
   * Layered Opus-generated explanations of the card's content, surfaced
   * via X in the Reviewer. Three levels:
   *   - simple:  ELI-12 plain-language version, focused on intuition.
   *   - deep:    full-mechanism, the "why under the why", at study depth.
   *   - analogy: a concrete metaphor / story that anchors the concept.
   * Generated together in one Opus call (cheaper than three). Stored on
   * the Note (not in fields) for the same record-of-strings-contract
   * reasons phrasings sits up here.
   */
  aiExplanations?: {
    simple: string;
    deep: string;
    analogy: string;
    generatedAt: number;
  };
  /**
   * Original Anki note id from the .apkg this note was imported from. Stored
   * as a string because Anki ids are 64-bit timestamps (overflow JS Number).
   * Lets reset/resync deterministically restore authoring order without the
   * .apkg in hand.
   */
  ankiNoteId?: string;
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
   * Wall-clock ms when this bury expires. The picker excludes cards while
   * `buried === true`; `unburryStaleCards` clears the flag once now passes
   * `buriedUntil`. Two distinct durations:
   *   - sibling-bury (auto): a few minutes — long enough to put cards in
   *     between c1 and c2, short enough that c2 still gets practiced today.
   *   - manual bury: tomorrow's day-start — Anki convention, "hide for today".
   * Pre-fix legacy rows with `buried: true` and no `buriedUntil` are treated
   * as expired so users aren't stranded after upgrade.
   */
  buriedUntil?: number;
  /**
   * Wall-clock ms at which this card was last narrated past in a podcast.
   * Set by the player once playback crosses the end of a segment that
   * contains this card. Used by Reviewer to show a small "primed" pip
   * so the user knows the upcoming card was just heard about.
   * Cleared on review (the card is no longer "primed", it's now studied).
   */
  lastPrimedAt?: number;
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

/* ─── Audio priming (Podcast) ────────────────────────────────── */

/**
 * Horizon over which a podcast pulls cards. Controls which queue
 * projection feeds the plan pass.
 *  - today:    cards FSRS would serve right now (overdue + intake)
 *  - tomorrow: cards that will be due by end of tomorrow's local day
 *  - week:     next 7 calendar days
 *  - new-only: only new (unseen) cards in the deck(s)
 *  - all:      every non-suspended card in the deck(s)
 */
export type PodcastHorizon = 'today' | 'tomorrow' | 'week' | 'new-only' | 'all';

/**
 * Depth tier picked by the plan pass for each segment. Determined
 * from words-per-card budget, but user can force one of these as an
 * override for the whole podcast.
 *  - flash:    ~10 wpc, theme + name mention only, no mechanism
 *  - standard: ~50 wpc, mechanism summary, no metaphor
 *  - deep:     ~150+ wpc, full mechanism + analogy + "why it matters"
 */
export type PodcastDepth = 'flash' | 'standard' | 'deep';

/** Where the rendered audio came from. */
export type PodcastTtsProvider = 'openai' | 'browser';

/**
 * Two ways the user scopes a podcast.
 *  - review:  cards FSRS will surface for review. AI picks; user picks decks.
 *  - preview: cards the user wants to learn fresh. User explicitly scopes.
 *
 * Review and preview decompose differently in the UI: review honors the
 * horizon picker (today/tomorrow/week), preview swaps that for a card-
 * selection panel (new-only / tag-filter / practice-query). Both walk
 * through the same projection → plan → script → render pipeline.
 */
export type PodcastMode = 'review' | 'preview';

/** Optional audio finishing applied at playback time (not baked into mp3). */
export type PodcastAudioStyle = 'none' | 'bumpers' | 'bed' | 'both';

/**
 * One turn in a two-voice conversational segment. `speaker` is symbolic
 * (the renderer maps A/B → actual voice ids on the parent Podcast).
 * Timestamps are filled by the renderer so the transcript view can
 * click-to-seek without word-level timing data from the TTS API.
 */
export interface PodcastTurn {
  speaker: 'A' | 'B';
  text: string;
  /** Seconds from the start of this segment's audio. Set after render. */
  startSec?: number;
  /** Seconds of audio for this turn. */
  durationSec?: number;
}

/** Lifecycle of one podcast. */
export type PodcastStatus =
  | 'planning'   // queue projected, sonnet plan pass running
  | 'scripting'  // opus per-segment scripts in flight
  | 'rendering'  // tts rendering audio
  | 'ready'      // all segments rendered, playable
  | 'error';

/** Lifecycle of one segment within a podcast. */
export type PodcastSegmentStatus =
  | 'planned'    // present in plan, not yet written
  | 'scripted'   // script body authored, no audio yet
  | 'rendered'   // audio rendered + cached in podcastAudio
  | 'error';

export interface Podcast {
  id: string;
  /** Human-readable name; auto-generated from decks + horizon, user-editable. */
  name: string;
  deckIds: string[];
  horizon: PodcastHorizon;
  /** Requested target length in seconds. Final may differ slightly. */
  targetSeconds: number;
  /** When set, overrides the per-segment depth that words-per-card would choose. */
  depthOverride?: PodcastDepth;
  /** Which TTS path rendered audio (or will). */
  ttsProvider: PodcastTtsProvider;
  /**
   * Voice id for speaker A. For OpenAI: alloy/echo/fable/onyx/nova/shimmer.
   * For browser: a SpeechSynthesisVoice.voiceURI or undefined for the default.
   */
  voiceA?: string;
  /** Voice id for speaker B. Same domain as voiceA but defaults to a contrasting voice. */
  voiceB?: string;
  /** Mode selection (review vs preview). Optional for backwards compat. */
  mode?: PodcastMode;
  /** Preview-mode filters. */
  tagFilter?: string[];
  practiceQueryId?: string;
  /** Audio finishing applied at playback time. Default 'none'. */
  audioStyle?: PodcastAudioStyle;
  status: PodcastStatus;
  /** Total card count across all segments. Cached for the library tile. */
  cardCount: number;
  /** Total characters of script content. Approx-proxy for cost + duration. */
  totalChars: number;
  /** Real wall-clock duration in seconds, once rendered. */
  durationSec?: number;
  /** Bytes across all stored audio blobs. */
  totalBytes?: number;
  /** Set when status === 'error', short message for the UI. */
  error?: string;
  createdAt: number;
  completedAt?: number;
}

export interface PodcastSegment {
  id: string;
  podcastId: string;
  /** 0-based, defines play order. */
  index: number;
  /** Short label shown in the segment list (≤ 6 words). */
  title: string;
  /** One-line description: what this segment covers. */
  description: string;
  /** Card ids drawn from the projection for this segment, in narration order. */
  cardIds: string[];
  /** Depth assigned to THIS segment (after any podcast-level override). */
  depth: PodcastDepth;
  /** Target word count budget. */
  targetWords: number;
  /**
   * Authored narrative body. Single-voice text (legacy + fallback for
   * browser TTS path). When `turns` is set, this is the concatenated
   * transcript for display + browser playback only — the real audio
   * is rendered from `turns`.
   */
  script: string;
  /**
   * Two-voice conversation turns. Populated when the parent podcast was
   * scripted via the conversation prompt (default for new podcasts).
   * Each turn carries its own start time + duration once audio is rendered,
   * which the player uses for transcript click-to-seek.
   */
  turns?: PodcastTurn[];
  /** 1-sentence handoff to the next segment. Empty for final segment. */
  transition: string;
  status: PodcastSegmentStatus;
  /** Set when status === 'error'. */
  error?: string;
  /** Duration of this segment's audio in seconds; set once rendered. */
  durationSec?: number;
}

/**
 * Rendered audio blob for one segment. Stored as its own table so the
 * podcast row stays small + cheap to list, and we can stream segments
 * to disk without dragging the metadata around.
 */
export interface PodcastAudio {
  /** Compound primary key: `${podcastId}::${segmentIndex}`. */
  pk: string;
  podcastId: string;
  segmentIndex: number;
  mimeType: string;
  blob: Blob;
  bytes: number;
}

/* ─── Talk mode (Socratic voice loop) ────────────────────────── */

export type TalkRole = 'user' | 'assistant';

export interface TalkTurn {
  role: TalkRole;
  text: string;
  /** ms timestamp at the moment the turn closed (assistant: response done; user: STT returned). */
  at: number;
}

/**
 * One Socratic-conversation session. Persisted so the user can resume
 * later, scroll the transcript, and review coverage. Audio is NOT
 * persisted (the recording exists only in the moment) to keep storage
 * tight; the transcript is the durable artifact.
 */
export interface TalkSession {
  id: string;
  /** Human-readable label, auto-generated from decks + start time. */
  name: string;
  deckIds: string[];
  /** Restricts the curriculum to cards in this projection horizon. */
  horizon: PodcastHorizon;
  startedAt: number;
  endedAt?: number;
  turns: TalkTurn[];
  /**
   * Per-card coverage score 0..1. Once a card crosses 0.5 it counts as
   * "introduced" in the UI tally. Computed by fuzzy-matching the
   * assistant's most recent text against each card's plain content.
   */
  coverage: Record<string, number>;
  /** Voice used for assistant TTS (OpenAI). */
  voice?: string;
  /** Optional OpenAI tts model. */
  ttsModel?: 'tts-1' | 'tts-1-hd';
}
