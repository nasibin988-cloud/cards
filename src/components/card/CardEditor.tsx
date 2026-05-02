'use client';

import { useEffect, useRef, useState } from 'react';
import type { NoteFields, SiblingDef, Tier } from '@/lib/db/schema';
import { renderRichText, hasCloze, renderFront, clozeOrds } from '@/lib/cloze/parser';
import { listAllTags } from '@/lib/db/queries';
import { db } from '@/lib/db/dexie';
import { id as ulid } from '@/lib/ulid';
import { cn } from '@/lib/utils';
import SiblingsEditor from './SiblingsEditor';
import { Tooltip } from '@/components/ui/Tooltip';
import AudioRecorder from './AudioRecorder';
import MarkdownToolbar from './MarkdownToolbar';

const TIERS: Tier[] = ['core', 'clinical', 'advanced', 'bridge', 'standard', 'extended', 'scholarly'];

export interface NoteDraft {
  fields: NoteFields;
  tags: string[];
  tier?: Tier;
  /** Set on basic notes to drive sibling-card creation. */
  siblings?: SiblingDef[];
}

interface Props {
  initial?: Partial<NoteDraft>;
  onSave: (draft: NoteDraft) => Promise<void> | void;
  onCancel?: () => void;
  saveLabel?: string;
  busy?: boolean;
  showDelete?: boolean;
  onDelete?: () => Promise<void> | void;
  /**
   * Bump to trigger a soft reset (used by mass-entry flow on save). Pinned
   * fields keep their values across the reset; everything else clears.
   */
  resetKey?: number;
  /** Per-deck opt-in for live Web Speech transcription on audio capture. */
  transcribeAudio?: boolean;
}

type PinKey =
  | 'front' | 'back' | 'extra' | 'image' | 'mnemonic' | 'context' | 'source'
  | 'tags' | 'tier';

export default function CardEditor({
  initial,
  onSave,
  onCancel,
  saveLabel = 'Save',
  busy,
  showDelete,
  onDelete,
  resetKey,
  transcribeAudio,
}: Props) {
  const [pinned, setPinned] = useState<Set<PinKey>>(new Set());
  const togglePin = (key: PinKey) => {
    setPinned(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const [front, setFront] = useState(initial?.fields?.front ?? '');
  const [back, setBack] = useState(initial?.fields?.back ?? '');
  const [extra, setExtra] = useState(initial?.fields?.extra ?? '');
  const [imageField, setImageField] = useState(initial?.fields?.image ?? '');
  const [mnemonic, setMnemonic] = useState(initial?.fields?.mnemonic ?? '');
  const [context, setContext] = useState(initial?.fields?.context ?? '');
  const [source, setSource] = useState(initial?.fields?.source ?? '');
  const [tagsRaw, setTagsRaw] = useState((initial?.tags ?? []).join(' '));
  const [tier, setTier] = useState<Tier | ''>(initial?.tier ?? '');
  const [siblings, setSiblings] = useState<SiblingDef[] | undefined>(initial?.siblings);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([]);
  const tagInputRef = useRef<HTMLInputElement>(null);
  const frontRef = useRef<HTMLTextAreaElement>(null);
  const backRef = useRef<HTMLTextAreaElement>(null);
  const extraRef = useRef<HTMLTextAreaElement>(null);
  const [imageDragging, setImageDragging] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);

  const handleImageFile = async (file: File) => {
    setImageError(null);
    if (!file.type.startsWith('image/')) {
      setImageError('Not an image file.');
      return;
    }
    // Persist into the media table; reference by filename in the editor.
    const safeName = `${ulid()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    await db().media.put({
      id: ulid(),
      filename: safeName,
      mimeType: file.type,
      blob: file,
    });
    setImageField(safeName);
  };

  const onImageDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setImageDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) await handleImageFile(file);
  };

  const onImagePaste = async (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imgItem = items.find(it => it.type.startsWith('image/'));
    if (!imgItem) return;
    const file = imgItem.getAsFile();
    if (file) {
      e.preventDefault();
      await handleImageFile(file);
    }
  };

  // Load known tags once on mount.
  useEffect(() => {
    listAllTags().then(setAllTags);
  }, []);

  // Compute suggestions for the token currently being typed.
  useEffect(() => {
    const partial = currentTagToken(tagsRaw);
    if (!partial) {
      setTagSuggestions([]);
      return;
    }
    const lower = partial.toLowerCase();
    const used = new Set(tagsRaw.split(/\s+/).filter(Boolean));
    setTagSuggestions(
      allTags
        .filter(t => t.toLowerCase().includes(lower) && !used.has(t))
        .slice(0, 6),
    );
  }, [tagsRaw, allTags]);

  function applyTagSuggestion(s: string) {
    const tokens = tagsRaw.split(/\s+/).filter(Boolean);
    if (!tagsRaw.endsWith(' ') && tokens.length) tokens.pop();
    tokens.push(s);
    setTagsRaw(tokens.join(' ') + ' ');
    setTagSuggestions([]);
    setTimeout(() => tagInputRef.current?.focus(), 0);
  }

  useEffect(() => {
    if (!pinned.has('front'))    setFront(initial?.fields?.front ?? '');
    if (!pinned.has('back'))     setBack(initial?.fields?.back ?? '');
    if (!pinned.has('extra'))    setExtra(initial?.fields?.extra ?? '');
    if (!pinned.has('image'))    setImageField(initial?.fields?.image ?? '');
    if (!pinned.has('mnemonic')) setMnemonic(initial?.fields?.mnemonic ?? '');
    if (!pinned.has('context'))  setContext(initial?.fields?.context ?? '');
    if (!pinned.has('source'))   setSource(initial?.fields?.source ?? '');
    if (!pinned.has('tags'))     setTagsRaw((initial?.tags ?? []).join(' '));
    if (!pinned.has('tier'))     setTier(initial?.tier ?? '');
    setSiblings(initial?.siblings);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(initial), resetKey]);

  const isCloze = hasCloze(front);
  const ords = clozeOrds(front);

  const handleSave = async () => {
    await onSave({
      fields: {
        front,
        back,
        extra: extra || undefined,
        image: imageField || undefined,
        mnemonic: mnemonic || undefined,
        context: context || undefined,
        source: source || undefined,
      },
      tags: tagsRaw.split(/\s+/).map(t => t.trim()).filter(Boolean),
      tier: tier || undefined,
      siblings: !isCloze && siblings && siblings.length ? siblings : (isCloze ? undefined : (siblings === undefined ? undefined : [])),
    });
  };

  // renderFront already produces final HTML with safe <span> wrappers; do not
  // re-pipe it through renderRichText or the cloze structure would re-escape.
  const previewFront = isCloze && ords.length > 0
    ? renderFront(front, ords[0])
    : renderRichText(front);

  return (
    <div className="grid lg:grid-cols-2 gap-6">
      <div className="space-y-4">
        <Field label="Front" hint="Cloze syntax: {{c1::answer::optional hint}}" pinKey="front" pinned={pinned} onTogglePin={togglePin}>
          <MarkdownToolbar textareaRef={frontRef} onChange={setFront} />
          <textarea
            ref={frontRef}
            value={front}
            onChange={e => setFront(e.target.value)}
            rows={5}
            className={inputClass}
            placeholder="The capital of France is {{c1::Paris}}."
            autoFocus
          />
        </Field>
        <Field label="Back" pinKey="back" pinned={pinned} onTogglePin={togglePin}>
          <MarkdownToolbar textareaRef={backRef} onChange={setBack} />
          <textarea
            ref={backRef}
            value={back}
            onChange={e => setBack(e.target.value)}
            rows={3}
            className={inputClass}
          />
        </Field>
        <Field label="Extra (optional)" pinKey="extra" pinned={pinned} onTogglePin={togglePin}>
          <MarkdownToolbar textareaRef={extraRef} onChange={setExtra} />
          <textarea ref={extraRef} value={extra} onChange={e => setExtra(e.target.value)} rows={2} className={inputClass} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Mnemonic" pinKey="mnemonic" pinned={pinned} onTogglePin={togglePin}>
            <input value={mnemonic} onChange={e => setMnemonic(e.target.value)} className={inputClass} />
          </Field>
          <Field label="Context" pinKey="context" pinned={pinned} onTogglePin={togglePin}>
            <input value={context} onChange={e => setContext(e.target.value)} className={inputClass} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Image" hint="Drop / paste an image, or type a filename" pinKey="image" pinned={pinned} onTogglePin={togglePin}>
            <div
              onDragEnter={e => { e.preventDefault(); setImageDragging(true); }}
              onDragLeave={e => { e.preventDefault(); setImageDragging(false); }}
              onDragOver={e => e.preventDefault()}
              onDrop={onImageDrop}
              onPaste={onImagePaste}
              className={cn(
                'rounded-xl border transition',
                imageDragging
                  ? 'border-saffron-400/50 bg-saffron-900/10'
                  : 'border-white/[0.04]',
              )}
            >
              <input
                value={imageField}
                onChange={e => setImageField(e.target.value)}
                className="w-full bg-dark-800/30 rounded-xl px-4 py-2.5 text-sm text-dark-100 placeholder:text-dark-500 outline-none focus:bg-dark-800/50 transition border-0"
                placeholder="bio_cell_diagram.svg"
              />
            </div>
            {imageError && (
              <div className="text-2xs text-crimson-300 mt-1.5 font-light">{imageError}</div>
            )}
          </Field>
          <Field label="Source" pinKey="source" pinned={pinned} onTogglePin={togglePin}>
            <input value={source} onChange={e => setSource(e.target.value)} className={inputClass} />
          </Field>
        </div>
        <div>
          <div className="text-2xs uppercase tracking-widest text-dark-400 mb-1.5">Audio</div>
          <AudioRecorder
            transcribe={!!transcribeAudio}
            onSaved={(filename) => {
              // Append <audio> tag to the Extra field so playback shows up
              // on card review without breaking other markdown content.
              const tag = `<audio src="${filename}" controls></audio>`;
              setExtra(prev => prev ? `${prev}\n${tag}` : tag);
            }}
            onTranscript={(text) => {
              // Append the latest transcript to Extra; replaces any previous
              // <!--TRANSCRIPT--> block we wrote so the field doesn't grow.
              setExtra(prev => {
                const stripped = prev.replace(/<!--TRANSCRIPT-START-->[\s\S]*?<!--TRANSCRIPT-END-->/g, '').trim();
                const block = `<!--TRANSCRIPT-START-->\n${text}\n<!--TRANSCRIPT-END-->`;
                return stripped ? `${stripped}\n\n${block}` : block;
              });
            }}
          />
        </div>
        <div className="grid grid-cols-[1fr_180px] gap-3">
          <Field label="Tags" hint="Space-separated, hierarchical (a::b::c)" pinKey="tags" pinned={pinned} onTogglePin={togglePin}>
            <div className="relative">
              <input
                ref={tagInputRef}
                value={tagsRaw}
                onChange={e => setTagsRaw(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Tab' && tagSuggestions.length > 0) {
                    e.preventDefault();
                    applyTagSuggestion(tagSuggestions[0]);
                  }
                }}
                className={inputClass}
              />
              {tagSuggestions.length > 0 && (
                <div className="absolute z-10 left-0 right-0 mt-1 glass-card rounded-xl py-1 max-h-60 overflow-y-auto">
                  {tagSuggestions.map(s => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => applyTagSuggestion(s)}
                      className="block w-full text-left px-3 py-1.5 text-xs font-mono text-dark-200 hover:bg-white/[0.03] hover:text-saffron-200 transition"
                    >
                      {s}
                    </button>
                  ))}
                  <div className="px-3 py-1 text-2xs text-dark-500 border-t border-white/[0.04]">Tab to accept</div>
                </div>
              )}
            </div>
          </Field>
          <Field label="Tier" pinKey="tier" pinned={pinned} onTogglePin={togglePin}>
            <select value={tier} onChange={e => setTier(e.target.value as Tier | '')} className={cn(inputClass, 'cursor-pointer')}>
              <option value="">—</option>
              {TIERS.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
        </div>

        {!isCloze && (
          <div className="pt-3 border-t border-white/[0.04]">
            <div className="text-2xs uppercase tracking-widest text-dark-400 mb-2">Siblings</div>
            <SiblingsEditor value={siblings} onChange={setSiblings} />
          </div>
        )}

        <div className="flex items-center gap-3 pt-2">
          <button onClick={handleSave} disabled={busy || !front.trim()} className="btn-gradient px-5 py-2 rounded-xl text-sm">
            {busy ? 'Saving…' : saveLabel}
          </button>
          {onCancel && (
            <button onClick={onCancel} className="px-4 py-2 rounded-xl text-sm text-dark-300 hover:text-dark-100 hover:bg-white/[0.04] transition">
              Cancel
            </button>
          )}
          {showDelete && onDelete && (
            <button
              onClick={onDelete}
              className="ml-auto px-4 py-2 rounded-xl text-sm text-crimson-300 hover:text-crimson-200 hover:bg-crimson-900/20 transition"
            >
              Delete note
            </button>
          )}
        </div>
      </div>

      <div className="space-y-4">
        <div>
          <div className="text-2xs uppercase tracking-widest text-dark-500 mb-2">
            Preview {isCloze && `(cloze, ${ords.length} card${ords.length === 1 ? '' : 's'})`}
          </div>
          <div className="glass-card rounded-2xl p-6">
            <div className="card-prose text-lg font-extralight" dangerouslySetInnerHTML={{ __html: previewFront }} />
            {back && (
              <div className="mt-4 pt-4 border-t border-white/[0.05] text-sm font-light text-dark-100" dangerouslySetInnerHTML={{ __html: renderRichText(back) }} />
            )}
          </div>
        </div>
        {isCloze && ords.length > 0 && (
          <div className="text-xs text-dark-400 font-light">
            This note will produce {ords.length} card{ords.length === 1 ? '' : 's'} (one per cloze ord: {ords.join(', ')}).
          </div>
        )}
      </div>
    </div>
  );
}

const inputClass = 'w-full bg-dark-800/30 rounded-xl px-4 py-2.5 text-sm text-dark-100 placeholder:text-dark-500 outline-none focus:bg-dark-800/50 transition border border-white/[0.04] focus:border-persian-500/30';

function currentTagToken(raw: string): string {
  if (raw.endsWith(' ')) return '';
  const tokens = raw.split(/\s+/).filter(Boolean);
  return tokens.length ? tokens[tokens.length - 1] : '';
}

function Field({
  label, hint, children, pinKey, pinned, onTogglePin,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  pinKey?: PinKey;
  pinned?: Set<PinKey>;
  onTogglePin?: (k: PinKey) => void;
}) {
  const isPinned = pinKey && pinned ? pinned.has(pinKey) : false;
  return (
    <label className="block">
      <div className="flex items-baseline justify-between mb-1.5 gap-2">
        <span className="text-2xs uppercase tracking-widest text-dark-400 flex items-center gap-2">
          {label}
          {pinKey && onTogglePin && (
            <Tooltip content={isPinned ? `Unpin ${label}` : `Pin ${label} so its value persists across new notes`}>
              <button
                type="button"
                onClick={(e) => { e.preventDefault(); onTogglePin(pinKey); }}
                className={cn(
                  'text-2xs leading-none transition',
                  isPinned ? 'text-saffron-300' : 'text-dark-600 hover:text-dark-400',
                )}
                aria-pressed={isPinned}
                aria-label={isPinned ? `Unpin ${label}` : `Pin ${label}`}
              >
                ◉
              </button>
            </Tooltip>
          )}
        </span>
        {hint && <span className="text-2xs text-dark-500 font-light">{hint}</span>}
      </div>
      {children}
    </label>
  );
}
