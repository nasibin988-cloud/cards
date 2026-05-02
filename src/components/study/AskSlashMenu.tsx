'use client';

import { cn } from '@/lib/utils';
import type { SlashCommand } from '@/lib/ai/commands/registry';

export default function AskSlashMenu({
  commands, activeIdx, onPick,
}: {
  commands: SlashCommand[];
  activeIdx: number;
  onPick: (cmd: SlashCommand) => void;
}) {
  if (commands.length === 0) return null;
  return (
    <div className="absolute bottom-full mb-2 left-0 right-0 glass-card rounded-xl border border-white/[0.06] shadow-2xl overflow-hidden">
      <div className="text-2xs uppercase tracking-widest text-dark-500 px-4 py-2 border-b border-white/[0.04]">
        Commands · ↑↓ select · Tab/↵ accept · Esc cancel
      </div>
      <ul className="max-h-56 overflow-y-auto py-1">
        {commands.map((c, i) => (
          <li
            key={c.name}
            onMouseDown={e => { e.preventDefault(); onPick(c); }}
            className={cn(
              'px-4 py-2 cursor-pointer flex items-baseline gap-3 transition',
              i === activeIdx ? 'bg-persian-900/30 text-dark-50' : 'text-dark-200 hover:bg-white/[0.03]',
            )}
          >
            <span className="font-mono text-saffron-300 shrink-0">/{c.name}</span>
            {c.argHint && (
              <span className="text-2xs font-mono text-dark-500 shrink-0">{c.argHint}</span>
            )}
            <span className="text-2xs font-light text-dark-400 truncate">{c.description}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
