'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { listDecks, listAllTags, searchNotes, type SearchHit } from '@/lib/db/queries';
import { listPracticeQueries } from '@/lib/practice/queries';
import type { Deck, PracticeQuery } from '@/lib/db/schema';
import { renderPlain } from '@/lib/cloze/parser';
import { cn } from '@/lib/utils';

interface Command {
  id: string;
  label: string;
  hint?: string;
  href?: string;
  action?: () => void;
}

interface SearchEntry {
  id: string;
  label: string;
  hint?: string;
  href: string;
  group: 'deck' | 'note' | 'tag' | 'practice' | 'action';
}

export default function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<SearchEntry[]>([]);
  const [active, setActive] = useState(0);
  const [decks, setDecks] = useState<Deck[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [queries, setQueries] = useState<PracticeQuery[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  // Toggle on Cmd/Ctrl-K, close on Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isModK = (e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K');
      if (isModK) {
        e.preventDefault();
        setOpen(o => !o);
      } else if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Refresh secondary indexes when opening.
  useEffect(() => {
    if (!open) return;
    listDecks().then(setDecks);
    listAllTags().then(setTags);
    listPracticeQueries().then(setQueries);
    setQuery('');
    setActive(0);
    setTimeout(() => inputRef.current?.focus(), 30);
  }, [open]);

  // Compose items based on the query.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    const actions: SearchEntry[] = [
      { id: 'a-decks', label: 'Decks', hint: 'Home', href: '/', group: 'action' },
      { id: 'a-import', label: 'Import .apkg', href: '/import', group: 'action' },
      { id: 'a-stats', label: 'Stats', href: '/stats', group: 'action' },
      { id: 'a-settings', label: 'Settings', href: '/settings', group: 'action' },
      { id: 'a-new-deck', label: 'New deck', href: '/decks/new', group: 'action' },
      { id: 'a-generate', label: 'Generate cards from paste (AI)', href: '/generate', group: 'action' },
      { id: 'a-practice', label: 'Saved practice queries', href: '/practice', group: 'action' },
      { id: 'a-exam', label: 'Exams', href: '/exam', group: 'action' },
      { id: 'a-tags', label: 'Manage tags', href: '/tags', group: 'action' },
      { id: 'a-trouble', label: 'Trouble cards', href: '/trouble', group: 'action' },
      { id: 'a-audit', label: 'AI card-quality audit', href: '/audit', group: 'action' },
      { id: 'a-occlusion', label: 'New image occlusion', href: '/occlusion/new', group: 'action' },
    ];

    const deckEntries: SearchEntry[] = decks.map(d => ({
      id: `d-${d.id}`,
      label: d.name,
      hint: d.description ?? undefined,
      href: `/study/${d.id}`,
      group: 'deck',
    }));
    const practiceEntries: SearchEntry[] = queries.map(p => ({
      id: `p-${p.id}`,
      label: p.name,
      hint: p.query,
      href: `/practice/${p.id}`,
      group: 'practice',
    }));
    const tagEntries: SearchEntry[] = tags.map(t => ({
      id: `t-${t}`,
      label: t,
      href: `/tags`,
      group: 'tag',
    }));

    if (!q) {
      setItems([...actions, ...practiceEntries, ...deckEntries]);
      setActive(0);
      return;
    }

    const lower = q.toLowerCase();
    const filteredActions = actions.filter(a => a.label.toLowerCase().includes(lower));
    const filteredDecks = deckEntries.filter(d => d.label.toLowerCase().includes(lower));
    const filteredQueries = practiceEntries.filter(p => p.label.toLowerCase().includes(lower));
    const filteredTags = tagEntries.filter(t => t.label.toLowerCase().includes(lower)).slice(0, 8);

    let cancelled = false;
    searchNotes(q, 20).then((hits: SearchHit[]) => {
      if (cancelled) return;
      const noteEntries: SearchEntry[] = hits.map(h => ({
        id: `n-${h.noteId}`,
        label: renderPlain(h.snippet) || '(empty front)',
        hint: h.deckName,
        href: `/note/${h.noteId}`,
        group: 'note',
      }));
      setItems([...filteredActions, ...filteredQueries, ...filteredDecks, ...filteredTags, ...noteEntries]);
      setActive(0);
    });

    return () => { cancelled = true; };
  }, [query, decks, tags, queries, open]);

  const navigate = (entry: SearchEntry) => {
    setOpen(false);
    router.push(entry.href);
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] px-4 bg-dark-950/70 backdrop-blur-sm animate-fade-in"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-xl glass-card rounded-2xl overflow-hidden animate-slide-up border border-white/[0.06]"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-white/[0.04]">
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive(a => Math.min(a + 1, items.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive(a => Math.max(a - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                if (items[active]) navigate(items[active]);
              }
            }}
            placeholder="Search decks, notes, actions… (Cmd+K)"
            className="w-full bg-transparent text-base font-light text-dark-50 placeholder:text-dark-500 outline-none"
            autoFocus
          />
        </div>
        <ul className="max-h-[55vh] overflow-y-auto py-1">
          {items.length === 0 && (
            <li className="px-5 py-4 text-sm text-dark-500 italic font-light">No results.</li>
          )}
          {items.map((it, i) => (
            <li
              key={it.id}
              onMouseEnter={() => setActive(i)}
              onClick={() => navigate(it)}
              className={cn(
                'px-5 py-2.5 cursor-pointer transition flex items-center gap-3',
                i === active ? 'bg-persian-900/30 text-dark-50' : 'text-dark-200 hover:bg-white/[0.03]',
              )}
            >
              <span
                className={cn(
                  'text-2xs uppercase tracking-widest font-mono w-14 shrink-0',
                  it.group === 'deck' && 'text-saffron-400',
                  it.group === 'note' && 'text-persian-300',
                  it.group === 'practice' && 'text-saffron-300',
                  it.group === 'tag' && 'text-dark-300',
                  it.group === 'action' && 'text-dark-500',
                )}
              >
                {it.group}
              </span>
              <span className="flex-1 truncate text-sm font-light">{it.label}</span>
              {it.hint && (
                <span className="text-2xs text-dark-500 truncate max-w-[40%]">{it.hint}</span>
              )}
            </li>
          ))}
        </ul>
        <div className="px-5 py-2 border-t border-white/[0.04] text-2xs text-dark-500 font-mono flex items-center justify-between">
          <span>↑↓ navigate · ↵ open · Esc close</span>
          <span>Cmd+K</span>
        </div>
      </div>
    </div>
  );
}
