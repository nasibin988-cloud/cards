# Cards V1 — Build Roadmap

Status legend: `[ ]` todo, `[~]` in progress, `[x]` done.

**Working directive:** quality > speed; tests for every behavior; visual review on every UI change. No em dashes anywhere. From [feedback_quality_over_speed_no_rush.md](../../../.claude/projects/-Users-bwv988/memory/feedback_quality_over_speed_no_rush.md).

---

## Stage A — Bugs from screenshots + small UX wins ✅

- [x] **A1.** Cloze cards now show the `back` field as additional context below the revealed front. Suppression is only applied to basic cards (where the heading already shows the back).
- [x] **A2.** Replaced the home-rolled whitelist with `marked` + DOMPurify. Handles genanki `<p>` / `<ul>` / `<table>` and authored markdown identically.
- [x] **A3.** Front: xl→2xl. Back/Extra: sm→base. Padding p-7 md:p-9. min-h-[14rem]. Card prose `line-height: 1.6` and tighter paragraph margins.
- [x] **A4.** **J / K / L / ;** added as home-row aliases for 1 / 2 / 3 / 4.
- [x] **A5.** Import page now uses one card that morphs from progress → success in place. No more duplicate stats cards.
- [x] **A6.** Click-anywhere-on-front-card reveals. Card has `role="button"`, keyboard handler, and cursor-pointer when on the front.
- [x] **A7.** Rating buttons are taller (min-h 5.5/6.5rem), text is larger (lg/xl), both keys shown (1 + J).

## Stage B — Rendering & cloze correctness ✅

- [x] **B1.** Markdown support landed via `lib/cloze/parser.ts` refactor. Cloze pass embeds final spans, then `marked.parse` handles surrounding text, then DOMPurify sanitizes. Both genanki HTML and authored markdown work in one pipeline.
- [x] **B2.** Sibling-bury on cloze. Rating any of c1/c2/c3 burries the rest until tomorrow's start. Undo restores them.

## Stage C — Search & navigation ✅

- [x] **C1.** `searchNotes()` scores by token coverage + field weighting (front 5, back 3, extra/context/mnemonic 2, tags 4). Used by Cmd+K and the in-deck search bar.
- [x] **C2.** `CommandPalette` opens on Cmd/Ctrl+K. Lists actions, decks, and live note search.
- [x] **C3.** Subdeck tree view (toggle on home when any deck name has `::`). Breadcrumb path on deck detail page. `buildDeckTree()` infers hierarchy from Anki `::` naming.
- [x] **C4.** Browse filters: free-text, state, tier, tag (any-of), lapses ≥ N. Each chip toggles inclusion.
- [x] **C5.** Tag autocomplete with Tab-to-accept dropdown.

## Stage D — AI integration ✅

- [x] **D1.** Type-answer mode toggle in Settings. When on, Front phase shows a textarea instead of "Show answer".
- [x] **D2.** AI grader returns `{ rating, critique, matched }`. Pre-selects the suggested rating; user can override before next card.
- [x] **D3.** `/generate` page. Pick deck, style, target count, optional tag prefix. Claude streams JSON, drafts shown as accept/reject cards with cloze preview.
- [x] **D4.** `H` key on the front fetches a hint that doesn't reveal the answer. Shown below the card.

## Stage E — Scheduling ✅

- [x] **E1.** `analyzeDeckRetention` reports observed vs FSRS-predicted retention from review log; recommends an adjusted `request_retention` value (single-knob optimization, since a full FSRS-RS optimizer needs a Rust runtime). Shown on deck-edit page with one-click "Apply".
- [x] **E2.** New `/trouble` page lists cards with lapses ≥ N (selectable: 2/3/5/8). Sorted by lapse count; click jumps to the note for editing.
- [x] **E3.** Predicted vs actual side-by-side metrics on each deck-edit page (when ≥ 50 reviews).

## Stage F — Authoring ✅

- [x] **F1.** `parseBulk()` parses MCAT V5 `> CARD: v5` block format. Bulk-paste tab in `/generate`. Tolerant of whitespace and multi-line values.
- [x] **F2.** Image drag-drop / paste into the Image field of the note editor. Stored in media table with a ulid-prefixed safe filename.
- [x] **F3.** Image occlusion authoring at `/occlusion/new`. Drop image, click-drag rectangles, optional per-rect labels. Saves a single `image-occlusion` note with N cards (one per rectangle). Custom `OcclusionRenderer` masks the active rectangle on the front, reveals on the back.

## Stage G — Sync & safety ✅

- [x] **G1.** `exportApkg()` builds a fresh collection.anki2 SQLite + media zip. Round-tripped through E2E test. Cloze + basic models supported; image-occlusion exports as plain image card (Anki has no native equivalent).
- [x] **G2.** `maybeRunDailyBackup()` writes a JSON snapshot to OPFS once per day; keeps last 7. Manual download (JSON or .apkg) and restore from JSON or OPFS in Settings → Backups.

## Stage H — Stats / reflection polish ✅

- [x] **H1.** Streak counter card on stats page; `currentStreak()` walks back day-by-day until it hits a zero-review day.
- [x] **H2.** Per-session progress bar in study header. Records `sessionStartDue` on first card; advances on each rate.
- [x] **H3.** Tag-level retention table at the bottom of stats; surfaces tags with ≥ 20 reviews; color-coded by retention.
- [x] **H4.** Heatmap cells are now buttons that drill into that day's review log details (rating breakdown).

## Stage I — Cross-project integrations ✅

- [x] **I1.** End-to-end encrypted Supabase sync. AES-GCM with PBKDF2(SHA-256, 200k iter) key derivation. Pluggable adapter: `SupabaseAdapter` (real backend) + `LoopbackAdapter` (localStorage, for tests/staging). State machine: untouched / in-sync / ahead / behind / diverged. Setup SQL bundled in `docs/cloud-sync-setup.md`; user runs once. Settings → Sync (cloud).
- [x] **I2.** Folder watch via File System Access API. User picks a directory once, app rescans on demand. Diffs by content hash; upserts new/changed blocks. `FileSystemDirectoryHandle` persisted in raw IndexedDB across sessions. Settings → Folder watch.
- [x] **I3.** Persian word lookup. Double-click any Farsi word during study → side panel. Backends: optional local lemma index (JSONL/CSV from DICTIONARY V2) + Claude lookup with on-device cache. Settings → Persian lookup.

---

## Working notes

- All bug fixes (Stage A) should land first; they impact daily use.
- Stage B unblocks A2's proper fix.
- Stage I item I1 (cloud sync) is the largest single piece of work; defer if it stretches.
- Add screenshots to `tests/screenshots/` after each major UI change for regression review.
