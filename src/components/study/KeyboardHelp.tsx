'use client';

import { useEffect } from 'react';
import { cn } from '@/lib/utils';
import { REGISTRY } from '@/lib/ai/commands/registry';

interface Props {
  open: boolean;
  onClose: () => void;
}

interface Row { keys: string[]; description: string }

const GLOBAL_ROWS: Row[] = [
  { keys: ['⌘K'], description: 'Command palette' },
  { keys: ['⌥⇧C'], description: 'Quick capture into Inbox' },
  { keys: ['⌘F'], description: 'Find & replace (deck browse)' },
  { keys: ['?'], description: 'Toggle this panel' },
  { keys: ['Esc'], description: 'Close panels / dismiss' },
];

const STUDY_ROWS: Row[] = [
  { keys: ['Space', 'Enter', '←', '→', 'click'], description: 'Reveal answer (when on front)' },
  { keys: ['1', 'J', '←'], description: 'Again' },
  { keys: ['2', 'K'], description: 'Hard' },
  { keys: ['3', 'L', '→'], description: 'Good' },
  { keys: ['4', ';'], description: 'Easy' },
  { keys: ['N'], description: 'Snooze 1 hour ("not now")' },
  { keys: ['M'], description: 'Snooze 1 day ("mañana")' },
  { keys: ['A'], description: 'Ask AI about this card' },
  { keys: ['H'], description: 'Hint without revealing (AI)' },
  { keys: ['T'], description: 'Teach back (Feynman mode, AI-graded; widens interval if thorough)' },
  { keys: ['R'], description: 'Refine card with Opus (auto-fix leakage / weak cloze / duplication)' },
  { keys: ['K', 'Esc'], description: 'Keep the refined card (during compare)' },
  { keys: ['Z'], description: 'Revert the refine (during compare — plain Z, not Cmd+Z)' },
  { keys: ['⇧R'], description: 'Revert the last refine on this card after compare is closed' },
  { keys: ['G'], description: 'Generate mnemonic with Opus (writes to the mnemonic field)' },
  { keys: ['⇧G'], description: 'Revert the last mnemonic generation on this card' },
  { keys: ['D'], description: 'Disambiguate against the most confusable peer card (appends to back)' },
  { keys: ['⇧D'], description: 'Revert the last disambiguator on this card' },
  { keys: ['P'], description: 'Read aloud / stop (TTS — toggle in Settings)' },
  { keys: ['E'], description: 'Edit this note' },
  { keys: ['B'], description: 'Bury until tomorrow' },
  { keys: ['S'], description: 'Suspend (hide indefinitely)' },
  { keys: ['F'], description: 'Cycle flag (revisit, broken, exemplar, errata)' },
  { keys: ['U', '⌘Z'], description: 'Undo last review' },
];

export default function KeyboardHelp({ open, onClose }: Props) {
  // Escape closes the panel app-wide. Bound at document level so it works
  // even when nothing inside the modal has focus (e.g. opened from a page
  // with no focusable elements).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-dark-950/70 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className={cn(
          'glass-card rounded-3xl p-7 max-w-xl w-full animate-slide-up',
          'border border-white/[0.06] max-h-[85vh] overflow-y-auto',
        )}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-baseline justify-between mb-5">
          <h2 className="text-2xl font-extralight tracking-tight bg-gradient-to-r from-saffron-300 to-persian-300 bg-clip-text text-transparent">
            Keyboard
          </h2>
          <button
            onClick={onClose}
            className="text-sm text-dark-400 hover:text-dark-100 transition px-2 py-1"
          >
            Esc
          </button>
        </div>

        <Section title="Global">
          {GLOBAL_ROWS.map(row => <KeyRow key={row.description} row={row} />)}
        </Section>

        <Section title="During study">
          {STUDY_ROWS.map(row => <KeyRow key={row.description} row={row} />)}
        </Section>

        <Section title="Slash commands (AskAI)">
          {REGISTRY.map(cmd => (
            <li key={cmd.name} className="flex items-center justify-between gap-4">
              <span className="text-sm text-dark-200 font-light">
                <span className="font-mono text-saffron-300">/{cmd.name}</span>
                {cmd.argHint && <span className="text-dark-500 font-mono ml-1">{cmd.argHint}</span>}
                <span className="text-dark-400"> — {cmd.description}</span>
              </span>
            </li>
          ))}
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-5 last:mb-0">
      <h3 className="text-2xs uppercase tracking-widest text-dark-500 mb-2">{title}</h3>
      <ul className="space-y-2">{children}</ul>
    </div>
  );
}

function KeyRow({ row }: { row: Row }) {
  return (
    <li className="flex items-center justify-between gap-4">
      <span className="text-sm text-dark-200 font-light">{row.description}</span>
      <span className="flex gap-1.5 shrink-0">
        {row.keys.map(k => (
          <kbd
            key={k}
            className="text-2xs font-mono px-2 py-1 rounded-md bg-dark-800/50 border border-white/[0.06] text-dark-100"
          >
            {k}
          </kbd>
        ))}
      </span>
    </li>
  );
}
