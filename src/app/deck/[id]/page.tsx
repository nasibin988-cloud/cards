'use client';

import Link from 'next/link';
import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import type { CardState, Deck, Note, Tier } from '@/lib/db/schema';
import {
  browseNotes,
  bulkApply,
  listDecks,
  getDeck,
  getDeckCountsAggregate,
  listTagsInDeck,
  undoBulk,
  type BulkAction,
  type BulkUndo,
  type DeckCounts,
  type NoteBrowseFilters,
} from '@/lib/db/queries';
import { parseQuery, stringifyQuery } from '@/lib/search/query';
import { renderPlain } from '@/lib/cloze/parser';
import { cn } from '@/lib/utils';
import BulkActionBar from '@/components/deck/BulkActionBar';
import FindReplaceSheet from '@/components/deck/FindReplaceSheet';
import UndoToast from '@/components/ui/UndoToast';
import { FLAG_GLYPH, FLAG_LABEL, FLAGS, FlagGlyph } from '@/components/note/FlagPicker';
import type { NoteFlag } from '@/lib/db/schema';
import { Tooltip } from '@/components/ui/Tooltip';

const STATE_OPTIONS: CardState[] = ['new', 'learning', 'review', 'relearning'];
const TIER_OPTIONS: Tier[] = ['core', 'clinical', 'advanced', 'bridge', 'standard', 'extended', 'scholarly'];

export default function DeckPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const searchParams = useSearchParams();
  const [deck, setDeck] = useState<Deck | null | undefined>(undefined);
  const [notes, setNotes] = useState<Note[]>([]);
  const [counts, setCounts] = useState<DeckCounts | null>(null);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [allDecks, setAllDecks] = useState<Deck[]>([]);

  // Single source of truth: the search input string. Parsed on every change
  // into structured filters + free-text. URL ?q= is the persistence layer.
  const initialQ = searchParams?.get('q') ?? '';
  const [searchInput, setSearchInput] = useState(initialQ);
  const { filters, text: query } = parseQuery(searchInput);

  // Render-time concerns kept separate from search filters: sort + group
  // are URL-persisted but never folded into the q= operator string. Both
  // default to the most natural choice.
  type SortKey = 'newest' | 'oldest' | 'due' | 'lapses' | 'hardest';
  const initialSort: SortKey = (searchParams?.get('sort') as SortKey) || 'newest';
  const [sort, setSort] = useState<SortKey>(initialSort);
  const initialGroup = searchParams?.get('group') === 'deck';
  const [groupByDeck, setGroupByDeck] = useState<boolean>(initialGroup);

  // Bulk-selection state.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<null | { undo: BulkUndo; message: string }>(null);

  // Find & replace sheet
  const [findOpen, setFindOpen] = useState(false);

  const refreshSidebars = useCallback(async () => {
    const [c, tags] = await Promise.all([
      getDeckCountsAggregate(id),
      listTagsInDeck(id, true),
    ]);
    setCounts(c);
    setAllTags(tags);
  }, [id]);

  useEffect(() => {
    Promise.all([
      getDeck(id),
      getDeckCountsAggregate(id),
      listTagsInDeck(id, true),
      listDecks(),
    ]).then(([d, c, tags, decks]) => {
      setDeck(d ?? null);
      setCounts(c);
      setAllTags(tags);
      setAllDecks(decks);
    });
  }, [id]);

  // Re-fetch notes whenever search/sort changes. Debounce light to avoid a
  // refetch on every keystroke during typing.
  useEffect(() => {
    if (!deck) return;
    const t = setTimeout(() => {
      const { filters: f, text } = parseQuery(searchInput);
      browseNotes(id, {
        ...f,
        includeDescendants: true,
        query: text || undefined,
        sort,
      }, 500).then(setNotes);
    }, 80);
    return () => clearTimeout(t);
  }, [id, deck, searchInput, sort]);

  // Mirror searchInput, sort, group into the URL so reloads/shares stick.
  // Replace (not push) so we don't pollute history on every keystroke.
  useEffect(() => {
    const params = new URLSearchParams(searchParams?.toString() ?? '');
    if (searchInput) params.set('q', searchInput); else params.delete('q');
    if (sort !== 'newest') params.set('sort', sort); else params.delete('sort');
    if (groupByDeck) params.set('group', 'deck'); else params.delete('group');
    const qs = params.toString();
    const cur = searchParams?.toString() ?? '';
    if (qs !== cur) router.replace(qs ? `?${qs}` : '?', { scroll: false });
  }, [searchInput, sort, groupByDeck, router, searchParams]);

  // Esc clears selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selected.size > 0) {
        setSelected(new Set());
        setAnchor(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected.size]);

  // Cmd/Ctrl+F → find & replace sheet.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F') && !e.shiftKey) {
        const tgt = e.target as HTMLElement | null;
        const inField = tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable);
        // Only intercept when the search box itself isn't already focused —
        // otherwise let the browser's native ⌘F still work for in-page text.
        if (inField && (tgt as HTMLElement).matches?.('input[placeholder*="Search"]')) return;
        e.preventDefault();
        setFindOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (deck === undefined) {
    return <div className="max-w-5xl mx-auto px-6 py-10 text-dark-400">Loading…</div>;
  }
  if (!deck) {
    return (
      <div className="max-w-5xl mx-auto px-6 py-10">
        <p className="text-dark-300">Deck not found.</p>
        <Link href="/" className="text-saffron-300 underline">← Back to decks</Link>
      </div>
    );
  }

  const due = counts ? counts.new + counts.learning + counts.review : 0;

  // All chip handlers route through the central searchInput so the URL stays
  // in sync; no parallel filters state to drift from it.
  const updateFilters = (patch: Partial<NoteBrowseFilters>) => {
    const next = { ...filters, ...patch } as NoteBrowseFilters;
    // Normalize undefineds out so stringifyQuery doesn't render empty operators.
    for (const k of Object.keys(next) as (keyof NoteBrowseFilters)[]) {
      const v = next[k];
      if (v === undefined || (Array.isArray(v) && v.length === 0)) delete next[k];
    }
    setSearchInput(stringifyQuery(next, query));
  };
  const toggleState = (s: CardState) => {
    const cur = filters.states ?? [];
    const nextStates = cur.includes(s) ? cur.filter(x => x !== s) : [...cur, s];
    updateFilters({ states: nextStates.length ? nextStates : undefined });
  };
  const toggleTag = (t: string) => {
    const cur = filters.tags ?? [];
    const nextTags = cur.includes(t) ? cur.filter(x => x !== t) : [...cur, t];
    updateFilters({ tags: nextTags.length ? nextTags : undefined });
  };
  const setTier = (t: Tier | '') => {
    updateFilters({ tier: t || undefined });
  };
  const setHasLapses = (v: number | undefined) => {
    updateFilters({ hasLapses: v });
  };
  const toggleFlag = (f: NoteFlag) => {
    const cur = filters.flags ?? [];
    const nextFlags = cur.includes(f) ? cur.filter(x => x !== f) : [...cur, f];
    updateFilters({ flags: nextFlags.length ? nextFlags : undefined });
  };
  const clearFilters = () => {
    setSearchInput('');
  };

  const hasActiveFilters = searchInput.trim().length > 0;

  return (
    <div className="max-w-5xl mx-auto px-4 md:px-6 py-6 md:py-10">
      {/* Title row — always its own line. */}
      <div>
        <DeckBreadcrumb name={deck.name} />
        {deck.description && <p className="text-dark-400 mt-1 font-light">{deck.description}</p>}
      </div>

      {/* Action + stats row — Study big on the left; New/Learn/Review each
          in their own card on the right; overflow menu on the far right
          carries Sim test, AI exam, Add note, Find & replace, Edit deck. */}
      <div className="mt-5 flex items-center gap-3 flex-wrap">
        {/* Primary action — sized to dominate the row. */}
        <Link
          href={`/study/${deck.id}`}
          className="btn-gradient px-7 md:px-8 py-3 md:py-3.5 rounded-2xl text-base font-light tracking-tight inline-flex items-center gap-2.5 shadow-[0_4px_20px_rgba(191,162,114,0.12)]"
        >
          <span>Study</span>
          {due > 0 && (
            <span className="text-2xs uppercase tracking-[0.2em] font-mono tabular-nums opacity-80 px-1.5 py-0.5 rounded-md bg-white/[0.08]">
              {due}
            </span>
          )}
        </Link>

        {/* Right cluster — pushed to the end of the row with ml-auto. */}
        <div className="ml-auto flex items-center gap-2">
          {counts && <InlineStats counts={counts} />}
          <DeckActionsMenu
            deckId={deck.id}
            onFind={() => setFindOpen(true)}
          />
        </div>
      </div>

      <div className="mt-10 flex items-center justify-between">
        <h2 className="text-xs uppercase tracking-widest text-dark-400">
          Notes ({notes.length}{notes.length === 500 ? '+' : ''})
        </h2>
        {hasActiveFilters && (
          <button
            onClick={clearFilters}
            className="text-2xs uppercase tracking-widest text-dark-400 hover:text-dark-100 transition"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Filter bar */}
      <div className="mt-3 glass-card rounded-2xl p-4 space-y-3">
        <div className="flex items-center gap-3">
          <input
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            placeholder='Search… try "tag:enzymes added:7d state:relearning lapses>=3"'
            className="flex-1 bg-dark-800/30 rounded-xl px-4 py-2 text-sm text-dark-100 placeholder:text-dark-500 outline-none focus:bg-dark-800/50 transition border border-white/[0.04] focus:border-persian-500/30 font-mono"
          />
          <select
            value={filters.tier ?? ''}
            onChange={e => setTier(e.target.value as Tier | '')}
            className="bg-dark-800/30 rounded-xl px-3 py-2 text-sm text-dark-100 outline-none focus:bg-dark-800/50 transition border border-white/[0.04] cursor-pointer"
          >
            <option value="">All tiers</option>
            {TIER_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <Tooltip content="Sort">
            <select
              value={sort}
              onChange={e => setSort(e.target.value as SortKey)}
              aria-label="Sort"
              className="bg-dark-800/30 rounded-xl px-3 py-2 text-sm text-dark-100 outline-none focus:bg-dark-800/50 transition border border-white/[0.04] cursor-pointer"
            >
              <option value="newest">Sort: newest</option>
              <option value="oldest">Sort: oldest</option>
              <option value="due">Sort: due (earliest)</option>
              <option value="lapses">Sort: lapses (most)</option>
              <option value="hardest">Sort: hardest</option>
            </select>
          </Tooltip>
          <Tooltip content="Group notes by sub-deck">
            <button
              onClick={() => setGroupByDeck(v => !v)}
              className={cn(
                'rounded-xl px-3 py-2 text-sm font-light transition border',
                groupByDeck
                  ? 'bg-persian-900/40 text-saffron-200 border-saffron-700/40'
                  : 'bg-dark-800/30 text-dark-300 border-white/[0.04] hover:text-dark-100 hover:border-white/[0.08]',
              )}
            >
              Group by deck
            </button>
          </Tooltip>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-2xs uppercase tracking-widest text-dark-500">State:</span>
          {STATE_OPTIONS.map(s => (
            <FilterChip
              key={s}
              label={s}
              active={(filters.states ?? []).includes(s)}
              onClick={() => toggleState(s)}
            />
          ))}
          <span className="text-2xs uppercase tracking-widest text-dark-500 ml-3">Lapses ≥</span>
          <select
            value={filters.hasLapses ?? ''}
            onChange={e => setHasLapses(e.target.value ? parseInt(e.target.value, 10) : undefined)}
            className="bg-dark-800/30 rounded-md px-2 py-0.5 text-2xs text-dark-100 outline-none focus:bg-dark-800/50 transition border border-white/[0.04] cursor-pointer"
          >
            <option value="">any</option>
            <option value="1">1</option>
            <option value="3">3</option>
            <option value="5">5</option>
          </select>
          <span className="text-2xs uppercase tracking-widest text-dark-500 ml-3">Flag:</span>
          {FLAGS.map(f => {
            const active = (filters.flags ?? []).includes(f);
            return (
              <Tooltip key={f} content={FLAG_LABEL[f]}>
                <button
                  onClick={() => toggleFlag(f)}
                  className={cn(
                    'text-xs px-2 py-0.5 rounded-md border transition uppercase tracking-wider',
                    active
                      ? 'bg-persian-900/40 text-saffron-200 border-saffron-700/40'
                      : 'bg-dark-800/30 text-dark-300 border-white/[0.04] hover:text-dark-100 hover:border-white/[0.08]',
                  )}
                >
                  <span className="font-bold mr-1">{FLAG_GLYPH[f]}</span>{f}
                </button>
              </Tooltip>
            );
          })}
        </div>
        {allTags.length > 0 && (
          <div className="flex flex-wrap items-start gap-2 pt-1 border-t border-white/[0.04]">
            <span className="text-2xs uppercase tracking-widest text-dark-500 pt-1">Tags:</span>
            <div className="flex flex-wrap gap-1.5">
              {allTags.slice(0, 40).map(t => (
                <FilterChip
                  key={t}
                  label={t}
                  active={(filters.tags ?? []).includes(t)}
                  onClick={() => toggleTag(t)}
                  small
                />
              ))}
              {allTags.length > 40 && (
                <span className="text-2xs text-dark-500 italic">+{allTags.length - 40} more</span>
              )}
            </div>
          </div>
        )}
      </div>

      {notes.length === 0 ? (
        <div className="glass-card rounded-2xl p-8 text-center text-dark-400 mt-4">
          {hasActiveFilters ? (
            <>No matching notes. <button onClick={clearFilters} className="text-saffron-300 hover:underline">Clear filters</button></>
          ) : (
            <>No notes yet. <Link href={`/note/new?deckId=${deck.id}`} className="text-saffron-300 hover:underline">Add the first one</Link>.</>
          )}
        </div>
      ) : (
        <div className="glass-card rounded-2xl divide-y divide-white/[0.04] mt-4">
          {selected.size > 0 && (
            <div className="px-5 py-2 text-2xs uppercase tracking-widest text-dark-400 bg-white/[0.02] flex items-center gap-3">
              <span className="tabular-nums">{selected.size} of {notes.length} selected</span>
              <button
                onClick={() => {
                  if (selected.size === notes.length) {
                    setSelected(new Set());
                    setAnchor(null);
                  } else {
                    setSelected(new Set(notes.map(n => n.id)));
                  }
                }}
                className="text-saffron-300/80 hover:text-saffron-200 transition"
              >
                {selected.size === notes.length ? 'Deselect all' : 'Select all'}
              </button>
            </div>
          )}
          <NotesList
            notes={notes}
            allDecks={allDecks}
            parentDeckId={id}
            parentDeckName={deck.name}
            groupByDeck={groupByDeck}
            selected={selected}
            onSelect={handleSelect}
          />
        </div>
      )}

      <BulkActionBar
        selectedCount={selected.size}
        decks={allDecks}
        currentDeckId={id}
        busy={busy}
        onClear={() => { setSelected(new Set()); setAnchor(null); }}
        onAction={async (action) => {
          if (selected.size === 0) return;
          setBusy(true);
          try {
            const ids = Array.from(selected);
            const undo = await bulkApply(ids, action);
            const message = describeAction(action, ids.length);
            setToast({ undo, message });
            setSelected(new Set());
            setAnchor(null);
            // Refresh notes + counts.
            const [updated] = await Promise.all([
              browseNotes(id, { ...filters, includeDescendants: true, query: query.trim() || undefined, sort }, 500),
              refreshSidebars(),
            ]);
            setNotes(updated);
          } finally {
            setBusy(false);
          }
        }}
      />

      {toast && (
        <UndoToast
          message={toast.message}
          onUndo={async () => {
            await undoBulk(toast.undo);
            const [updated] = await Promise.all([
              browseNotes(id, { ...filters, includeDescendants: true, query: query.trim() || undefined, sort }, 500),
              refreshSidebars(),
            ]);
            setNotes(updated);
          }}
          onDismiss={() => setToast(null)}
        />
      )}

      {findOpen && (
        <FindReplaceSheet
          defaultDeckId={id}
          onClose={async () => {
            setFindOpen(false);
            // Re-fetch in case a replace landed.
            const updated = await browseNotes(id, { ...filters, includeDescendants: true, query: query.trim() || undefined, sort }, 500);
            setNotes(updated);
          }}
        />
      )}

    </div>
  );

  function handleSelect(e: React.MouseEvent, noteId: string) {
    e.preventDefault();
    e.stopPropagation();
    const isMeta = e.metaKey || e.ctrlKey;
    const isShift = e.shiftKey;

    setSelected(prev => {
      const next = new Set(prev);
      if (isShift && anchor) {
        const ids = notes.map(n => n.id);
        const a = ids.indexOf(anchor);
        const b = ids.indexOf(noteId);
        if (a !== -1 && b !== -1) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          for (let i = lo; i <= hi; i++) next.add(ids[i]);
        }
      } else if (isMeta) {
        if (next.has(noteId)) next.delete(noteId);
        else next.add(noteId);
      } else {
        if (next.has(noteId)) next.delete(noteId);
        else next.add(noteId);
      }
      return next;
    });
    setAnchor(noteId);
  }
}

/**
 * Notes list with optional virtualization. Below ~100 notes we render
 * everything inline (cheaper than the virtualizer's overhead for small
 * lists). At/above the threshold we flatten group-headers + note-rows into
 * a single items array and let `useWindowVirtualizer` render only the
 * visible slice. Window-mode is the right fit because the deck page
 * scrolls naturally with the document — no fixed-height parent container.
 */
const VIRTUALIZE_THRESHOLD = 100;
type NotesListItem =
  | { kind: 'header'; deckId: string; label: string; count: number }
  | { kind: 'row'; note: Note; subdeckLabel: string | null };

function NotesList({
  notes, allDecks, parentDeckId, parentDeckName, groupByDeck, selected, onSelect,
}: {
  notes: Note[];
  allDecks: Deck[];
  parentDeckId: string;
  parentDeckName: string;
  groupByDeck: boolean;
  selected: Set<string>;
  onSelect: (e: React.MouseEvent, id: string) => void;
}) {
  // Pre-compute the unified items array. Memoized so virtualizer ranges stay stable.
  const items = useMemo<NotesListItem[]>(() => {
    const out: NotesListItem[] = [];
    if (groupByDeck) {
      for (const group of groupNotesByDeck(notes, allDecks)) {
        out.push({ kind: 'header', deckId: group.deckId, label: group.label, count: group.notes.length });
        for (const n of group.notes) out.push({ kind: 'row', note: n, subdeckLabel: null });
      }
    } else {
      for (const n of notes) {
        out.push({
          kind: 'row',
          note: n,
          subdeckLabel: n.deckId !== parentDeckId ? subdeckLabelFor(n.deckId, parentDeckName, allDecks) : null,
        });
      }
    }
    return out;
  }, [notes, allDecks, parentDeckId, parentDeckName, groupByDeck]);

  if (items.length < VIRTUALIZE_THRESHOLD) {
    return (
      <div>
        {items.map((it, i) => (
          <ItemRow
            key={it.kind === 'row' ? it.note.id : `h:${it.deckId}:${i}`}
            item={it}
            selected={selected}
            anySelected={selected.size > 0}
            onSelect={onSelect}
          />
        ))}
      </div>
    );
  }
  return <VirtualizedNotesList items={items} selected={selected} onSelect={onSelect} />;
}

function VirtualizedNotesList({
  items, selected, onSelect,
}: {
  items: NotesListItem[];
  selected: Set<string>;
  onSelect: (e: React.MouseEvent, id: string) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const v = useWindowVirtualizer({
    count: items.length,
    // Headers are shorter than rows; the variance is small enough that a
    // single average estimate keeps total-height drift acceptable. The
    // virtualizer measures real heights as items render and corrects.
    estimateSize: (i) => (items[i].kind === 'header' ? 36 : 64),
    overscan: 8,
    scrollMargin: parentRef.current?.offsetTop ?? 0,
  });

  return (
    <div ref={parentRef} className="relative" style={{ height: `${v.getTotalSize()}px` }}>
      {v.getVirtualItems().map(virtualItem => {
        const it = items[virtualItem.index];
        return (
          <div
            key={virtualItem.key}
            data-index={virtualItem.index}
            ref={v.measureElement}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              transform: `translateY(${virtualItem.start - v.options.scrollMargin}px)`,
            }}
          >
            <ItemRow
              item={it}
              selected={selected}
              anySelected={selected.size > 0}
              onSelect={onSelect}
            />
          </div>
        );
      })}
    </div>
  );
}

function ItemRow({
  item, selected, anySelected, onSelect,
}: {
  item: NotesListItem;
  selected: Set<string>;
  anySelected: boolean;
  onSelect: (e: React.MouseEvent, id: string) => void;
}) {
  if (item.kind === 'header') {
    return (
      <div className="px-5 py-2 text-2xs uppercase tracking-widest text-dark-400 bg-white/[0.02] flex items-center justify-between border-b border-white/[0.04]">
        <span>{item.label}</span>
        <span className="tabular-nums text-dark-500">{item.count}</span>
      </div>
    );
  }
  return (
    <NoteRow
      note={item.note}
      selected={selected.has(item.note.id)}
      anySelected={anySelected}
      onSelect={(e) => onSelect(e, item.note.id)}
      subdeckLabel={item.subdeckLabel}
    />
  );
}

/**
 * Strip the parent deck's name (and `::` separator) from the note's deck
 * name, so a row in `MCAT::Biology` viewed under the `MCAT` parent reads
 * `Biology`. Falls back to the leaf segment if no prefix match.
 */
function subdeckLabelFor(noteDeckId: string, parentName: string, decks: Deck[]): string | null {
  const noteDeck = decks.find(d => d.id === noteDeckId);
  if (!noteDeck) return null;
  if (noteDeck.name === parentName) return null;
  const prefix = parentName + '::';
  if (noteDeck.name.startsWith(prefix)) {
    return noteDeck.name.slice(prefix.length);
  }
  // Last segment as a last resort (covers explicit-parentId without name match).
  const segs = noteDeck.name.split('::');
  return segs[segs.length - 1] ?? noteDeck.name;
}

function NoteRow({
  note, selected, anySelected, onSelect, subdeckLabel,
}: {
  note: Note;
  selected: boolean;
  anySelected: boolean;
  onSelect: (e: React.MouseEvent) => void;
  /** Sub-deck path relative to the parent page, when this note lives in a descendant. */
  subdeckLabel?: string | null;
}) {
  // When something is selected, the whole row toggles instead of navigating —
  // power-user multi-select without forcing the user to aim at a 16px checkbox.
  const onRowClick = (e: React.MouseEvent) => {
    if (anySelected) onSelect(e);
  };
  return (
    <div
      onClick={onRowClick}
      className={cn(
        'flex items-center gap-3 px-5 py-3 transition group',
        selected ? 'bg-saffron-900/10 hover:bg-saffron-900/15' : 'hover:bg-white/[0.02]',
        anySelected && 'cursor-pointer',
      )}
    >
      <button
        onClick={onSelect}
        onMouseDown={e => e.stopPropagation()}
        className={cn(
          'shrink-0 w-4 h-4 rounded border transition flex items-center justify-center',
          selected
            ? 'bg-saffron-500 border-saffron-400'
            : 'border-white/20 hover:border-saffron-400/60 bg-dark-900/40',
        )}
        aria-label={selected ? 'Deselect note' : 'Select note'}
      >
        {selected && (
          <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden>
            <path d="M2 6 L5 9 L10 3" stroke="#0c0c10" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>
      {note.flag && <FlagGlyph flag={note.flag} />}
      <Link
        href={anySelected ? '#' : `/note/${note.id}`}
        onClick={e => { if (anySelected) e.preventDefault(); }}
        className="flex-1 min-w-0 block"
      >
        <div className="text-sm text-dark-100 font-light line-clamp-1">
          {renderPlain(note.fields.front)}
        </div>
        {(note.tags.length > 0 || subdeckLabel) && (
          <div className="mt-1 flex flex-wrap gap-1 items-center">
            {subdeckLabel && (
              <span
                className="text-2xs uppercase tracking-wider text-persian-200/80 bg-persian-900/25 px-1.5 py-0.5 rounded font-mono"
                title={`Lives in sub-deck ${subdeckLabel}`}
              >
                {subdeckLabel}
              </span>
            )}
            {note.tags.slice(0, 5).map(t => (
              <span key={t} className="text-2xs uppercase tracking-wider text-saffron-300/60 bg-saffron-900/15 px-1.5 py-0.5 rounded">
                {t}
              </span>
            ))}
          </div>
        )}
      </Link>
    </div>
  );
}

/**
 * Cluster notes by their deckId, preserving the input ordering for the
 * group order (whichever deck's first note appears first wins). Each group
 * uses the deck's leaf name as the label; missing decks get a synthetic one
 * so the group still renders.
 */
function groupNotesByDeck(notes: Note[], decks: Deck[]): Array<{ deckId: string; label: string; notes: Note[] }> {
  const byId = new Map(decks.map(d => [d.id, d]));
  const order: string[] = [];
  const buckets = new Map<string, Note[]>();
  for (const n of notes) {
    if (!buckets.has(n.deckId)) {
      buckets.set(n.deckId, []);
      order.push(n.deckId);
    }
    buckets.get(n.deckId)!.push(n);
  }
  return order.map(deckId => {
    const d = byId.get(deckId);
    const segments = (d?.name ?? deckId).split('::');
    const label = segments[segments.length - 1] || (d?.name ?? deckId);
    return { deckId, label, notes: buckets.get(deckId)! };
  });
}

function describeAction(action: BulkAction, count: number): string {
  const n = `${count} note${count === 1 ? '' : 's'}`;
  switch (action.kind) {
    case 'suspend': return `Suspended ${n}`;
    case 'unsuspend': return `Unsuspended ${n}`;
    case 'bury': return `Buried ${n} until tomorrow`;
    case 'unbury': return `Unburied ${n}`;
    case 'reset': return `Reset progress on ${n}`;
    case 'delete': return `Deleted ${n}`;
    case 'move': return `Moved ${n}`;
    case 'addTag': return `Tagged ${n} with ${action.tag}`;
    case 'removeTag': return `Removed ${action.tag} from ${n}`;
  }
}

/**
 * Compact inline stat readout — number + small label, three groups grouped
 * inside one rounded card. Sits to the right of the Study button.
 */
function InlineStats({ counts }: { counts: DeckCounts }) {
  return (
    <div className="inline-flex items-center gap-3 px-4 py-2 md:py-2.5 rounded-xl bg-dark-800/30 border border-white/[0.04]">
      <StatPill label="New" value={counts.new} tone="saffron" />
      <StatPill label="Learn" value={counts.learning} tone="crimson" />
      <StatPill label="Review" value={counts.review} tone="persian" />
    </div>
  );
}

function StatPill({ label, value, tone }: { label: string; value: number; tone: 'saffron' | 'crimson' | 'persian' }) {
  const toneClass = tone === 'saffron' ? 'text-saffron-300'
    : tone === 'crimson' ? 'text-crimson-300'
    : 'text-persian-200';
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className={cn('text-base font-light tabular-nums', toneClass)}>
        {value.toLocaleString()}
      </span>
      <span className="text-2xs uppercase tracking-widest text-dark-500">{label}</span>
    </span>
  );
}

/**
 * Overflow menu for low-frequency deck actions (Add note / Find / Edit).
 * Collapsing them frees horizontal space so the action row stays one line.
 */
function DeckActionsMenu({ deckId, onFind }: { deckId: string; onFind: () => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && !t.closest?.('[data-deck-menu]')) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="relative" data-deck-menu>
      <button
        onClick={() => setOpen(v => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More deck actions"
        className="px-3 py-2 rounded-xl text-sm font-light text-dark-300 hover:text-dark-100 hover:bg-white/[0.04] transition border border-white/[0.06] inline-flex items-center gap-1.5"
      >
        <span aria-hidden className="text-base leading-none">⋯</span>
        <span className="sr-only">More</span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-2 z-30 min-w-[11rem] rounded-xl bg-dark-900/95 backdrop-blur-md border border-white/[0.06] shadow-xl py-1"
        >
          <Link
            href={`/exam/sim/${deckId}`}
            role="menuitem"
            className="block px-4 py-2 text-sm font-light text-dark-200 hover:text-dark-50 hover:bg-white/[0.04] transition"
            onClick={() => setOpen(false)}
          >
            Sim test
          </Link>
          <Link
            href={`/exam/new/${deckId}`}
            role="menuitem"
            className="block px-4 py-2 text-sm font-light text-dark-200 hover:text-dark-50 hover:bg-white/[0.04] transition"
            onClick={() => setOpen(false)}
          >
            AI exam
          </Link>
          <div className="my-1 border-t border-white/[0.04]" aria-hidden />
          <Link
            href={`/note/new?deckId=${deckId}`}
            role="menuitem"
            className="block px-4 py-2 text-sm font-light text-dark-200 hover:text-dark-50 hover:bg-white/[0.04] transition"
            onClick={() => setOpen(false)}
          >
            Add note
          </Link>
          <Tooltip content="Find & replace (⌘F)" side="left">
            <button
              role="menuitem"
              onClick={() => { setOpen(false); onFind(); }}
              className="block w-full text-left px-4 py-2 text-sm font-light text-dark-200 hover:text-dark-50 hover:bg-white/[0.04] transition"
            >
              Find &amp; replace
            </button>
          </Tooltip>
          <Link
            href={`/deck/${deckId}/edit`}
            role="menuitem"
            className="block px-4 py-2 text-sm font-light text-dark-200 hover:text-dark-50 hover:bg-white/[0.04] transition"
            onClick={() => setOpen(false)}
          >
            Edit deck
          </Link>
        </div>
      )}
    </div>
  );
}

function FilterChip({
  label, active, onClick, small,
}: { label: string; active: boolean; onClick: () => void; small?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        small ? 'text-2xs px-2 py-0.5' : 'text-xs px-2.5 py-1',
        'uppercase tracking-wider rounded-md transition border',
        active
          ? 'bg-persian-900/40 text-saffron-200 border-saffron-700/40'
          : 'bg-dark-800/30 text-dark-300 border-white/[0.04] hover:text-dark-100 hover:border-white/[0.08]',
      )}
    >
      {label}
    </button>
  );
}

/**
 * Render the deck name; if it contains "::", render each segment as part of
 * a breadcrumb path with the leaf segment as the active title.
 */
function DeckBreadcrumb({ name }: { name: string }) {
  // Show only the leaf name. The path comes from the deck tree the user
  // came from; repeating it here adds a row without adding information.
  const segments = name.split('::').map(s => s.trim()).filter(Boolean);
  const leaf = segments[segments.length - 1] ?? name;
  return (
    <h1 className="text-3xl md:text-4xl font-extralight tracking-tight bg-gradient-to-r from-saffron-300 to-persian-300 bg-clip-text text-transparent">
      {leaf}
    </h1>
  );
}
