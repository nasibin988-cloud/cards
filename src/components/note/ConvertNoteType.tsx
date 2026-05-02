'use client';

import { useState } from 'react';
import type { Note } from '@/lib/db/schema';
import { convertNoteType, previewConvertNoteType, type ConvertTarget } from '@/lib/db/queries';
import { renderFront, renderRichText } from '@/lib/cloze/parser';
import { cn } from '@/lib/utils';

export default function ConvertNoteType({
  note, onClose, onConverted,
}: {
  note: Note;
  onClose: () => void;
  onConverted: () => void;
}) {
  const current: ConvertTarget = note.modelId === 'cloze' ? 'cloze' : 'basic';
  const target: ConvertTarget = current === 'cloze' ? 'basic' : 'cloze';

  const preview = previewConvertNoteType(note, target);
  const [busy, setBusy] = useState(false);

  if (note.modelId === 'image-occlusion') {
    return (
      <Sheet onClose={onClose}>
        <p className="text-sm text-dark-300 font-light">
          Image-occlusion notes can't be converted in V1.
        </p>
      </Sheet>
    );
  }

  return (
    <Sheet onClose={onClose} title={`Convert: ${current} → ${target}`}>
      <p className="text-2xs uppercase tracking-widest text-dark-500 mb-3">
        This will drop scheduling history on the existing cards and rebuild fresh ones.
      </p>

      <div className="grid grid-cols-2 gap-3">
        <PreviewCol label={`Before · ${current}`}>
          <FieldPreview label="Front" body={note.fields.front} mode={current === 'cloze' ? 'cloze' : 'plain'} />
          <FieldPreview label="Back" body={note.fields.back} mode="plain" />
        </PreviewCol>
        <PreviewCol label={`After · ${target}`} accent>
          <FieldPreview label="Front" body={preview.fields.front} mode={target === 'cloze' ? 'cloze' : 'plain'} />
          <FieldPreview label="Back" body={preview.fields.back} mode="plain" />
        </PreviewCol>
      </div>

      <div className="flex items-center gap-3 pt-4 mt-4 border-t border-white/[0.04]">
        <button
          onClick={async () => {
            setBusy(true);
            try {
              await convertNoteType(note.id, target);
              onConverted();
            } finally {
              setBusy(false);
            }
          }}
          disabled={busy}
          className="btn-gradient px-4 py-2 rounded-xl text-sm uppercase tracking-[0.2em] font-light disabled:opacity-50"
        >
          {busy ? 'Converting…' : `Convert to ${target}`}
        </button>
        <button
          onClick={onClose}
          disabled={busy}
          className="text-2xs uppercase tracking-[0.2em] font-light text-dark-400 hover:text-dark-100 transition px-3"
        >
          Cancel
        </button>
      </div>
    </Sheet>
  );
}

function Sheet({
  title, onClose, children,
}: {
  title?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-start justify-center pt-16 px-4"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? 'convert-note-title' : undefined}
    >
      <div className="glass-card rounded-2xl w-full max-w-3xl max-h-[80vh] flex flex-col border border-white/[0.06] shadow-2xl">
        {title && (
          <div className="px-5 py-4 border-b border-white/[0.04] flex items-center justify-between">
            <h2 id="convert-note-title" className="text-sm uppercase tracking-[0.2em] font-light text-dark-100">{title}</h2>
            <button
              onClick={onClose}
              className="text-2xs uppercase tracking-[0.2em] font-light text-dark-400 hover:text-dark-100 transition"
            >
              Close
            </button>
          </div>
        )}
        <div className="px-5 py-4 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

function PreviewCol({
  label, children, accent,
}: { label: string; children: React.ReactNode; accent?: boolean }) {
  return (
    <div className={cn(
      'rounded-xl p-3 border space-y-3',
      accent ? 'border-saffron-700/30 bg-saffron-900/10' : 'border-white/[0.06] bg-dark-800/30',
    )}>
      <div className={cn(
        'text-2xs uppercase tracking-widest font-mono',
        accent ? 'text-saffron-300' : 'text-dark-400',
      )}>
        {label}
      </div>
      {children}
    </div>
  );
}

function FieldPreview({
  label, body, mode,
}: { label: string; body: string | undefined; mode: 'plain' | 'cloze' }) {
  if (!body) {
    return (
      <div>
        <div className="text-2xs uppercase tracking-widest text-dark-500 mb-1">{label}</div>
        <div className="text-2xs text-dark-500 italic">empty</div>
      </div>
    );
  }
  const html = mode === 'cloze' ? renderFront(body, 1) : renderRichText(body);
  return (
    <div>
      <div className="text-2xs uppercase tracking-widest text-dark-500 mb-1">{label}</div>
      <div
        className="card-prose text-sm font-light text-dark-100 leading-relaxed"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
