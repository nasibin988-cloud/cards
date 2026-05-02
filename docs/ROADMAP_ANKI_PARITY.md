# Roadmap — Anki parity, but better

Living doc. Source of truth for the "Cards app surpasses Anki" plan agreed 2026-04-26.
Tasks are tracked in the session task list; this file is the durable spec so context compression doesn't lose anything.

## Status

**Phase 1 (chunks 1–9): ✅ shipped 2026-04-26.**
**Phase 2 (quick wins + mid-size + audio + auto-tune + cleanup): ✅ shipped 2026-04-26.**
**Phase 3 (Anki-distinguishing AI features + surface polish): ✅ shipped 2026-04-26.**
**Phase 4 (mobile/a11y/perf/SW polish + conversational deck creation): ✅ shipped 2026-04-26.**
**Phase 5 (daily-use polish + reading + occlusion + backup): ✅ shipped 2026-04-27.**

Phase 5 items:
- 5.1 ✅ Hotkey discoverability — `?` opens KeyboardHelp app-wide; panel adds Slash-commands section sourced from `REGISTRY`. Mounted in AppShell.
- 5.2 ✅ Sort + group in browse — `browseNotes` sort: newest/oldest/due/lapses/hardest. Group-by-deck toggle on parent decks. URL-persisted (`?sort=…&group=deck`).
- 5.3 ✅ Snooze 1h / 1d — `snoozeCard` + `restoreCardDue`; `Z` (and Shift+Z) on Reviewer; rating-bar buttons; integrated with the existing single-step Undo path.
- 5.4 ✅ Study-time stats — `getTodayStudyStats()` + `<TodayBar>` on home + discreet pill in Reviewer header.
- 5.5 ✅ Resume mid-card — `cards:resume:<deckId>` localStorage entry restored on Reviewer mount; cleared on rate; 2h TTL.
- 5.6 ✅ Quick capture — `<QuickCapture>` global modal at Alt+Shift+C (Cmd+Shift+C and Ctrl+Shift+C are devtools-reserved). Auto-creates an `Inbox` deck via `getOrCreateDeckByName`.
- 5.7 ✅ Leech surface — auto-flag broken at `lapses ≥ leech_threshold` (configurable in Settings, default 8). `/trouble` page already existed; threshold setting added.
- 5.8 ✅ Backup (already shipped: `BackupPanel` + `exportSnapshot` / `importSnapshot` in `src/lib/backup/snapshot.ts`).
- 5.9 ✅ `.apkg` re-export (already shipped: `exportApkg` in `src/lib/apkg/exporter.ts`).
- 5.10 ✅ AI batch authoring — `/generate` already had AI/Cloze-place/Bulk modes; added PDF dropzone via `pdfjs-dist` + worker copied to `public/pdf.worker.min.mjs`. New util `src/lib/pdf/extract.ts`.
- 5.11 ✅ Image occlusion (already shipped: `/occlusion/new` with rect-draw + `OcclusionRenderer`).
- 5.12 ✅ Incremental reading — new `/read` + `/read/[sourceId]`. Schema: `Source` + `Highlight` tables (Dexie v5). Selection-to-cloze: highlight phrase → "Make cloze" wraps the surrounding paragraph in `{{c1::…}}` and lands a note in the auto-`Reading::<title>` deck.
- 5.13 ✅ More E2E — added `08-parent-deck-aggregation`, `09-quick-capture`, `10-keyboard-help` specs. 43 E2E tests passing; 211 unit tests passing.

Phase 3 items:
- Hour-of-week study heatmap on Stats (`reviewsByHourOfWeek`).
- Cross-deck search via `deck:` operator (case-insensitive substring match against deck names).
- Tag management UI at `/tags` (rename / merge / delete with bulk select; `listTagUsage`, `renameTag`, `mergeTags`, `deleteTagEverywhere`).
- Markdown toolbar over each editor textarea (B/I/code/H1-3/list/quote/link).
- Card history timeline on note edit (`listReviewsForCard` + per-card expand).
- Cmd+K command palette: extended with practice queries, tags, more actions.
- Unified Sessions page at `/sessions` combining AI exams + saved practice queries; `/practice` and `/exam` retained.
- AI cloze placement: `/generate` "Cloze a passage" mode preserves prose verbatim and inserts {{cN::}} around key terms.
- AI cross-card link suggestions: per-note Suggest links action; uses local searchNotes for candidates, Claude proposes anchored insertions, accept-or-reject UI.
- AI card-quality auditor at `/audit`: heuristic surface (lapsing/overlong/malformed/sparse) → Claude rewrite proposal → one-click accept.
- Voice answer in TypeAnswer: live Web Speech API transcription into the textarea, then existing AI grader.
- Daily summary notifications: Notification API permission flow in Settings; on-open check fires browser-native OS notification when ≥12h gap.
- AskAI slash commands: `/image`, `/clear`, `/explain`, `/mnemonic`, `/define`, `/help`. Floating autocomplete on `/`.
  - `/image`: Wikimedia Commons (CORS-friendly, no key) + Claude refines query first; thumbnail grid with Use/Insert actions; Use downloads into media for offline.

Test coverage:
- Unit: 204 tests across 19 files.
- E2E: 40 tests across 8 files, all green.
- Screenshots: now 26 (covering Audit, Tags, Sessions, hour heatmap, slash menu, etc).

Phase 2 items:
- KeyboardHelp updated with F (flag cycle).
- FlagGlyph extracted, no more inline conditionals.
- Card maturity donut on Stats (`cardMaturity()` query helper).
- Per-deck due-forecast 7-bar sparkline + 30d retention badge on home tree (`deckRetentionWindow()` query).
- CardEditor sticky-pin fields (◉ icon per field, survives `resetKey` bumps).
- New-card insertion order: `Deck.newCardOrder = added | random | tagInterleaved`. Surfaced on Tuning tab.
- LaTeX/KaTeX rendering: `$inline$` and `$$display$$`. CSS imported globally.
- Saved practice queries: `/practice` lists/creates, `/practice/[id]` runs as Reviewer with `noteIdFilter`.
- Audio recording: `<AudioRecorder>` in CardEditor. Per-deck `Deck.audioTranscribe` opt-in for live Web Speech transcription.
- Retention auto-tuning toast on Reviewer mount when |delta| ≥ 5pp; one-click apply, dismissed for 7 days per deck.
- Screenshots spec walks Tuning, Find&Replace, ConvertNoteType, Practice, BulkActionBar.

Test coverage:
- Unit: 185 tests across 18 files (added 51 in Phase 1, 27 in Phase 2).
- E2E: covers all chunks + visual snapshots.

## Phase 1 chunks (working order)

1. **Bulk ops in the deck browser.** Multi-select, suspend/unsuspend, bury/unbury, retag, move-to-deck, reset, delete. Floating action bar that fades in only when something is selected. Atomic + undoable from a 10s toast.
2. **Reset / Reschedule UI on the single-note edit page.** Per-card buttons that wrap existing `suspendCard`, `buryCard`, plus new `resetCard`, `rescheduleCard(date)`, `forgetCard` queries.
3. **Search syntax in URL.** Hidden query string in URL drives the same chips. Power users can paste `tag:enzymes added:7d state:relearning lapses>=3` in the search box. URL is shareable.
4. **Per-deck Tuning panel.** Single panel per deck with the 4 dials that matter (retention, new/day, reviews/day, max interval). Hide FSRS-19 weights behind "Show advanced".
5. **Flags + filter chips.** `?` revisit, `!` broken, `★` exemplar, `⚠` errata. Each surfaces its own filter. Flag column on note row.
6. **Sibling-card support in note types.** A note can declare `siblings: [front→back, back→front, term→def]`. Each becomes an independently scheduled card sharing scheduling-history visibility.
7. **Find & replace across notes.** ⌘F in deck browse. Regex toggle. Preview-and-confirm shows N matches across N notes before commit.
8. **Change note type with field mapping.** "Convert to cloze" / "Convert to basic" actions on the note. Field mapping shown side-by-side with diff preview.
9. **Type-the-answer cloze variant.** `{{type::}}` draws an inline input; on submit, character-level diff vs expected.

## Already exists (don't rebuild)

- Deck browse with filters (query, tier, state, lapses, tags, suspended, buried) — `/deck/[id]` + `browseNotes()`.
- FSRS-5 scheduling, sibling-bury for cloze, undo last review (Cmd+Z).
- AskAI per card, AI exam generator, sim test, image occlusion, folder watch, .apkg import, backup/sync, stats heatmap.
- ULID IDs, ts-fsrs, IndexedDB via Dexie v2.
- Glassmorphic design tokens (persian/crimson/saffron/dark) in `globals.css`.

## Design constraints (verbatim from earlier sessions)

- All actions atomic + undoable when possible. Toasts persist 10s with single Undo button.
- No dialogs for confirmations on bulk ops — toast-then-undo is the pattern.
- Match BINESH design tokens: `font-extralight tracking-tight`, glass cards, gradient accent, no em-dashes in user-visible text.
- No new top-level back arrows (we just removed them).
- Keyboard-first where natural (Shift+click range, ⌘+click individual, Esc to clear selection).
- Scope: this app is single-user local-first. No multi-tenant concerns.

## Detail per chunk

### 1. Bulk ops in deck browser

**Selection model**
- Click a row → navigate (current behavior).
- Click checkbox in row → toggle selection.
- Shift-click checkbox → range select from last anchor.
- ⌘/Ctrl-click checkbox → toggle without disturbing range.
- Esc → clear selection.

**Floating action bar** (fades in when `selected.size > 0`)
- "N selected"
- Suspend / Unsuspend (toggles based on majority state)
- Bury (24h)
- Reset progress (sends cards back to `new`)
- Move to deck… (deck picker)
- Retag… (add tag / remove tag from selection)
- Delete

**Undo path:** every bulk op writes a `BulkAction` snapshot to a small in-memory queue. Toast with "Undo" calls the inverse. Reset = remember prior state, restore on undo.

**DB additions** (`src/lib/db/queries.ts`):
- `unsuspendCard(id)`, `unburyCard(id)`
- `resetCardProgress(id)` → wipe FSRS, set state='new', clear due, lapses=0, reps=0
- `rescheduleCard(id, dueDate)` → set due, state='review' if missing, log to reviewLogs
- `forgetCard(id)` (alias for resetCardProgress; semantic match for Anki users)
- `bulkApply(noteIds, action)` for atomic batches

### 2. Reset / Reschedule on note page

Add a "Card actions" pane below CardEditor showing one row per card under this note. Each row:
- State badge (`new`/`learning`/`review`/`relearning`)
- Stats: due date, stability, lapses
- Buttons: Suspend/Unsuspend, Bury, Reset, Reschedule (date input)

### 3. Search syntax in URL

Parser converts `tag:foo added:7d state:relearning lapses>=3 deck:enzymes` into a `NoteBrowseFilters` shape. Two-way binding: chips edit URL, URL edits chips.

Operators:
- `tag:foo` (multi: `tag:foo,bar`)
- `state:new|learning|review|relearning`
- `lapses>=N`, `lapses<=N`, `lapses=N`
- `added:7d` (last 7 days), `added:30d`, `edited:1d`
- `tier:core|clinical|advanced|...`
- `is:suspended`, `is:buried`, `is:due`, `is:new`
- `text:...` (free-text fallback; default if no operator)

URL: `/deck/[id]?q=tag%3Aenzymes+added%3A7d`

### 4. Per-deck Tuning panel

Lives at `/deck/[id]/edit` (already exists for name/desc) — add second tab "Tuning":
- Desired retention (slider 0.80 → 0.95)
- New cards / day (number)
- Reviews / day (number)
- Max interval days (number)
- "Show advanced" → 19 FSRS weights as a JSON textarea + "Reset to default" button

### 5. Flags

Schema: `note.flag?: 'revisit' | 'broken' | 'exemplar' | 'errata'`.
Filter chips: 4 toggleable.
Toggle from note edit + from study session (key `F` cycles through none → revisit → broken → exemplar → errata → none).
Glyph in browse row: `?` `!` `★` `⚠` in the appropriate accent color.

### 6. Sibling cards

Note type extension: `note.siblings?: Array<{ id: string; frontField: string; backField: string }>`.
Each sibling becomes a `Card` row tied to the note with `siblingId` instead of `clozeOrd`.
Reviewer pulls cards exactly like cloze cards do today; rendering uses the mapped fields.

### 7. Find & replace

⌘F opens a top sheet on `/deck/[id]`:
- Find: text box (regex toggle)
- Replace with: text box
- Scope: this deck / all decks
- Preview list: matches highlighted in-context, N matches across N notes
- "Replace all" (with Undo toast)

### 8. Change note type

Note edit page → "Convert" menu → cloze ↔ basic ↔ custom-type. Modal shows side-by-side field mapping with diff preview before commit.

### 9. Type-the-answer

Cloze parser extension: `{{type::Paris}}` (or `{{type::Paris::hint}}`) renders as an `<input>` on the front. Submission diffs character-level against expected. Highlight is green for matched runs, crimson underline for mismatched.

---

## Status

See task list in active session. After each chunk: build, smoke-test through the running launchctl service on `:3737`, mark done.

---

## Phase 5 — Daily-use polish, reading, occlusion, backup

13-item plan agreed 2026-04-27. Order is small-to-large for momentum; each lands as its own commit-sized change. Build + restart launchctl service on `:3737` after every item.

### 5.1 Hotkey discoverability — `?` opens KeyboardHelp app-wide

`?` (Shift+`/`) opens the existing `KeyboardHelp` panel from anywhere, not just `/study/[deckId]`. Skip when focus is inside `INPUT`, `TEXTAREA`, or `[contenteditable]`. Help panel grows a "Slash commands" section listing every registered command from `src/lib/ai/commands/`, with arg hints. Owner: a global `<KeyboardHelpProvider>` mounted in `AppShell`.

### 5.2 Sort + group in browse

`/deck/[id]` gains a Sort dropdown (`due / lapses / newest / oldest / hardest`) and, when on a deck whose descendants have notes, a Group toggle (`group: by deck`). Both persist in URL (`?sort=lapses&group=deck`). `browseNotes` extended with `sort?: 'due' | 'lapses' | 'newest' | 'oldest' | 'hardest'`. Hardest = highest `difficulty` from cards. Grouping renders a small section header per child deck.

### 5.3 Snooze 1h / 1d on rating bar

A `Z` snooze button next to the rating row in `Reviewer`. Default Z = 1h; Shift+Z = 1d. Implementation: `snoozeCard(id, ms)` writes `due = now + ms` and keeps the rest of the FSRS state untouched. Logged in `reviewLogs` with a sentinel `rating: 0` so it doesn't pollute retention math but stays auditable. Same Undo flow as a normal review.

### 5.4 Study time tracking — today's stats panel

Surface today's totals (since local `startOfToday`):
- Total reviews
- Total study time = sum of `reviewLogs.durationMs`
- Pace = reviews / minutes (display as `cards/min`, capped to one decimal)
- Avg seconds per card

Locations:
- Home page header (just under the title): `Today: 47 cards · 12.3 min · 3.8/min`
- `Reviewer` shows the same row in a discreet pill bottom-left, plus session-only metrics (started X min ago, this session: Y).

DB additions: `getTodayStudyStats()` returning `{ count, totalMs, perMinute, secondsPerCard }` from `reviewLogs.where('review').above(startOfToday)`.

### 5.5 Resume mid-card

Persist `{ deckId, cardId, phase }` to `localStorage` (`cards:resume`) on every front/back transition in `Reviewer`. On mount, if the saved card is still due in scope, restore it (skip `getNextCardForStudy`). Clear after rate. Stale (>2h) entries discarded.

### 5.6 Quick capture — global `⌘⇧C` → Inbox deck

Anywhere in the app, `Cmd+Shift+C` opens a small modal textarea. Submit (Cmd+Enter) creates a basic note in the auto-created `Inbox` deck. Shows a 2s toast linking to the note. No card-form clutter — body becomes `front`, second line (if present) becomes `back`. Closes on Esc.

### 5.7 Leech surface

When `recordReview` lands a rating that pushes `card.lapses >= 8` and `note.flag` is unset, auto-set `note.flag = 'broken'`. New `/leeches` page lists those notes (uses existing `flags=['broken']` filter via `browseNotes` cross-deck). Each row gets a one-click "Rewrite via auditor" button that deep-links to `/audit?noteId=...`. Settings entry: `leech_threshold` (default 8).

### 5.8 Backup — JSON.gz export + import

Settings page section "Backup":
- **Export** → downloads `cards-YYYY-MM-DD.json.gz` containing `{ schemaVersion, exportedAt, decks, notes, cards, reviewLogs, media (base64), settings }`. Streams via `pako.gzip` to keep memory bounded.
- **Import** → file picker; modal warning ("This replaces your local data"); replaces every table in a single Dexie transaction. Refuses if `schemaVersion > current`.

### 5.9 `.apkg` re-export

From `Settings` (or `/deck/[id]/edit`): "Export to Anki" downloads `cards-{deckName}-{date}.apkg`. Maps our schema:
- `modelId='basic'` → Anki Basic model.
- `modelId='cloze'` → Anki Cloze model.
- `modelId='occlusion'` → fall back to a Basic with the rendered image (Anki has no native occlusion).

Validate by round-tripping a 50-card test deck and diffing fields.

### 5.10 AI batch authoring from text/PDF

`/generate` gets a third tab "Batch from passage":
1. Paste text or drop PDF (uses `pdfjs-dist` already in deps).
2. Choose target deck + tier + tags.
3. Claude streams 3-10 candidate cards (basic + cloze) with one-line rationale per card.
4. Per-card Accept / Reject / Edit. Accepted batch saves atomically.

Prompt design: lean on the same context-block approach as `/explain`, with system instructions emphasizing single canonical noun phrases and the "no MCAT meta, no anecdotes" constraints from `feedback_mcat_v5_mechanism_discipline.md`.

### 5.11 Image occlusion

`/occlusion/new` becomes a real editor:
- Upload image → stored in `media` table.
- Canvas overlay with rectangle-draw, drag-resize, delete.
- "Save" produces N cards sharing the same `note.fields.image` + a `note.fields.occlusions: Rect[]` field. Each card has `clozeOrd = i+1`.
- Render path in `CardRenderer`: front shows image with all rects opaque except the active one; back shows full image with the active rect outlined.

DB additions: `occlusions?: Array<{ x: number; y: number; w: number; h: number; label?: string }>` on `NoteFields`.

### 5.12 Incremental reading

`/read` becomes the reading workspace:
- Sources list (left rail).
- New source: paste URL (fetched + sanitized via Readability), drop PDF (extracted via pdfjs), or paste markdown.
- Source view: scrollable text with persistent highlights.
- Selection toolbar: "Make cloze" wraps the highlighted span with `{{cN::}}` and saves a new note in the source's deck (one deck per source, auto-named `Reading::<title>`).
- Reading queue: source's `progress` percent + last-position scroll.

Tables: `sources { id, title, kind: 'url'|'pdf'|'md', body, mime, addedAt, lastReadAt, progress }`, `highlights { id, sourceId, range, noteId? }`.

### 5.13 More E2E

New Playwright specs:
- `parent-deck-study.spec.ts` — create a parent + 2 child decks, add cards to children, study the parent, verify cards from both children show up.
- `parent-deck-browse.spec.ts` — same setup, verify `/deck/[parent]` lists notes from descendants.
- `path-only-deck.spec.ts` — virtual `/decks/path/[encoded]` page renders aggregated counts.
- `quick-capture.spec.ts` — `⌘⇧C` flow.
- `snooze.spec.ts` — Z key delays due, one-click Undo restores.
- `backup-roundtrip.spec.ts` — export, wipe DB, import, all data restored.
- `occlusion-render.spec.ts` — multi-occlusion note renders one card per occlusion.
