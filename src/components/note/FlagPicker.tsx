'use client';

import type { NoteFlag } from '@/lib/db/schema';
import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui/Tooltip';

export const FLAGS: ReadonlyArray<NoteFlag> = ['revisit', 'broken', 'exemplar', 'errata'];

export const FLAG_GLYPH: Record<NoteFlag, string> = {
  revisit: '?',
  broken: '!',
  exemplar: '★',
  errata: '⚠',
};

export const FLAG_LABEL: Record<NoteFlag, string> = {
  revisit: 'Revisit',
  broken: 'Broken',
  exemplar: 'Exemplar',
  errata: 'Errata',
};

const FLAG_TONE: Record<NoteFlag, string> = {
  revisit: 'text-saffron-300',
  broken: 'text-crimson-300',
  exemplar: 'text-persian-200',
  errata: 'text-saffron-200',
};

const FLAG_BG: Record<NoteFlag, string> = {
  revisit: 'bg-saffron-900/30 border-saffron-700/40',
  broken: 'bg-crimson-900/30 border-crimson-700/40',
  exemplar: 'bg-persian-900/30 border-persian-700/40',
  errata: 'bg-saffron-900/20 border-saffron-700/30',
};

export function flagClass(flag: NoteFlag, mode: 'glyph' | 'pill' = 'glyph'): string {
  if (mode === 'pill') {
    return cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-2xs uppercase tracking-widest', FLAG_TONE[flag], FLAG_BG[flag]);
  }
  return cn('inline-block w-4 text-center font-bold tabular-nums', FLAG_TONE[flag]);
}

/** Single source of truth for rendering a flag glyph + label/title. */
export function FlagGlyph({
  flag, mode = 'glyph', size = 'sm', title,
}: {
  flag: NoteFlag;
  mode?: 'glyph' | 'pill';
  size?: 'sm' | 'md';
  title?: string;
}) {
  const tipText = title ?? FLAG_LABEL[flag];
  if (mode === 'pill') {
    return (
      <Tooltip content={title && title !== FLAG_LABEL[flag] ? tipText : null}>
        <span className={flagClass(flag, 'pill')} aria-label={tipText}>
          <span className="font-bold">{FLAG_GLYPH[flag]}</span>
          {FLAG_LABEL[flag]}
        </span>
      </Tooltip>
    );
  }
  const sizeCls = size === 'md' ? 'text-base' : 'text-sm';
  return (
    <Tooltip content={tipText}>
      <span className={cn(flagClass(flag, 'glyph'), sizeCls)} aria-label={tipText}>
        {FLAG_GLYPH[flag]}
      </span>
    </Tooltip>
  );
}

export default function FlagPicker({
  value, onChange, busy,
}: {
  value: NoteFlag | undefined;
  onChange: (v: NoteFlag | undefined) => void;
  busy?: boolean;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-2xs uppercase tracking-widest text-dark-500 mr-1">Flag</span>
      <FlagButton
        active={value === undefined}
        glyph="—"
        label="None"
        onClick={() => onChange(undefined)}
        busy={busy}
      />
      {FLAGS.map(f => (
        <FlagButton
          key={f}
          active={value === f}
          glyph={FLAG_GLYPH[f]}
          label={FLAG_LABEL[f]}
          tone={FLAG_TONE[f]}
          onClick={() => onChange(value === f ? undefined : f)}
          busy={busy}
        />
      ))}
    </div>
  );
}

function FlagButton({
  active, glyph, label, tone, onClick, busy,
}: {
  active: boolean;
  glyph: string;
  label: string;
  tone?: string;
  onClick: () => void;
  busy?: boolean;
}) {
  return (
    <Tooltip content={label}>
      <button
        onClick={onClick}
        disabled={busy}
        aria-label={label}
        className={cn(
          'w-8 h-8 rounded-lg border text-sm font-bold transition flex items-center justify-center',
          active
            ? 'bg-white/[0.06] border-white/[0.12]'
            : 'bg-dark-800/30 border-white/[0.04] hover:border-white/[0.10]',
          tone ?? 'text-dark-400',
          active && 'shadow-[0_0_0_1px_rgba(255,255,255,0.05)]',
          busy && 'opacity-50',
        )}
      >
        {glyph}
      </button>
    </Tooltip>
  );
}
