'use client';

import type { FieldKey, SiblingDef } from '@/lib/db/schema';
import { id } from '@/lib/ulid';
import { cn } from '@/lib/utils';

const FIELDS: ReadonlyArray<{ key: FieldKey; label: string }> = [
  { key: 'front', label: 'front' },
  { key: 'back', label: 'back' },
  { key: 'extra', label: 'extra' },
  { key: 'mnemonic', label: 'mnemonic' },
  { key: 'context', label: 'context' },
  { key: 'source', label: 'source' },
];

const PRESETS: ReadonlyArray<{ label: string; siblings: () => SiblingDef[] }> = [
  {
    label: 'Front ↔ Back',
    siblings: () => [
      { id: id(), frontField: 'front', backField: 'back', label: 'front→back' },
      { id: id(), frontField: 'back', backField: 'front', label: 'back→front' },
    ],
  },
  {
    label: 'Front → Back, Front → Extra',
    siblings: () => [
      { id: id(), frontField: 'front', backField: 'back', label: 'front→back' },
      { id: id(), frontField: 'front', backField: 'extra', label: 'front→extra' },
    ],
  },
];

export default function SiblingsEditor({
  value, onChange,
}: {
  value: SiblingDef[] | undefined;
  onChange: (next: SiblingDef[] | undefined) => void;
}) {
  const list = value ?? [];

  const addRow = () => {
    onChange([
      ...list,
      { id: id(), frontField: 'front', backField: 'back', label: 'front→back' },
    ]);
  };

  const updateRow = (idx: number, patch: Partial<SiblingDef>) => {
    const next = list.map((s, i) => i === idx ? { ...s, ...patch } : s);
    onChange(next);
  };

  const removeRow = (idx: number) => {
    const next = list.filter((_, i) => i !== idx);
    onChange(next.length ? next : undefined);
  };

  const clearAll = () => onChange(undefined);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-2xs text-dark-500 font-light leading-relaxed">
          Each sibling becomes its own independently scheduled card on this note. Pick which field shows as the prompt and which shows as the answer.
        </div>
        {list.length > 0 && (
          <button
            onClick={clearAll}
            className="text-2xs uppercase tracking-[0.2em] font-light text-dark-400 hover:text-crimson-300 transition shrink-0"
          >
            Clear all
          </button>
        )}
      </div>

      {list.length === 0 && (
        <div className="flex flex-wrap gap-2 pt-1">
          <span className="text-2xs uppercase tracking-widest text-dark-500 self-center mr-1">Preset:</span>
          {PRESETS.map(p => (
            <button
              key={p.label}
              onClick={() => onChange(p.siblings())}
              className="text-2xs uppercase tracking-[0.2em] font-light px-3 py-1.5 rounded-lg text-dark-200 hover:text-dark-50 hover:bg-white/[0.04] transition border border-white/[0.06]"
            >
              {p.label}
            </button>
          ))}
          <button
            onClick={addRow}
            className="text-2xs uppercase tracking-[0.2em] font-light px-3 py-1.5 rounded-lg text-saffron-300 hover:text-saffron-200 hover:bg-saffron-900/15 transition border border-saffron-700/30"
          >
            + Custom
          </button>
        </div>
      )}

      {list.length > 0 && (
        <div className="space-y-2">
          {list.map((s, i) => (
            <div key={s.id} className="flex items-center gap-2 flex-wrap bg-dark-800/30 rounded-xl px-3 py-2 border border-white/[0.04]">
              <span className="text-2xs uppercase tracking-widest text-dark-500 font-mono shrink-0">#{i + 1}</span>
              <FieldSelect
                label="Front"
                value={s.frontField}
                onChange={v => updateRow(i, { frontField: v })}
              />
              <span className="text-dark-500">→</span>
              <FieldSelect
                label="Back"
                value={s.backField}
                onChange={v => updateRow(i, { backField: v })}
              />
              <input
                value={s.label ?? ''}
                onChange={e => updateRow(i, { label: e.target.value || undefined })}
                placeholder="label (optional)"
                className="flex-1 min-w-[140px] bg-dark-900/40 rounded-lg px-3 py-1.5 text-2xs text-dark-100 placeholder:text-dark-500 outline-none focus:bg-dark-900/60 transition border border-white/[0.04] font-mono"
              />
              <button
                onClick={() => removeRow(i)}
                className="text-2xs uppercase tracking-[0.2em] font-light text-dark-400 hover:text-crimson-300 transition px-2 shrink-0"
              >
                Remove
              </button>
            </div>
          ))}
          <button
            onClick={addRow}
            className="text-2xs uppercase tracking-[0.2em] font-light px-3 py-1.5 rounded-lg text-saffron-300 hover:text-saffron-200 hover:bg-saffron-900/15 transition border border-saffron-700/30"
          >
            + Add sibling
          </button>
        </div>
      )}
    </div>
  );
}

function FieldSelect({
  label, value, onChange,
}: { label: string; value: FieldKey; onChange: (v: FieldKey) => void }) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="text-2xs uppercase tracking-widest text-dark-500">{label}</span>
      <select
        value={value}
        onChange={e => onChange(e.target.value as FieldKey)}
        className={cn(
          'bg-dark-900/40 rounded-md px-2 py-1 text-2xs text-dark-100 outline-none focus:bg-dark-900/60 transition border border-white/[0.04] cursor-pointer font-mono',
        )}
      >
        {FIELDS.map(f => (
          <option key={f.key} value={f.key}>{f.label}</option>
        ))}
      </select>
    </label>
  );
}
