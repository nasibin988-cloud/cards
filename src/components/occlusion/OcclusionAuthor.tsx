'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createNote, listDecks } from '@/lib/db/queries';
import { db } from '@/lib/db/dexie';
import { id as ulid } from '@/lib/ulid';
import type { Deck, OcclusionRect } from '@/lib/db/schema';
import { cn } from '@/lib/utils';

export default function OcclusionAuthor() {
  const router = useRouter();
  const [decks, setDecks] = useState<Deck[]>([]);
  const [deckId, setDeckId] = useState('');
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageFilename, setImageFilename] = useState<string | null>(null);
  const [rects, setRects] = useState<OcclusionRect[]>([]);
  const [drawing, setDrawing] = useState<OcclusionRect | null>(null);
  const [busy, setBusy] = useState(false);
  const [tags, setTags] = useState('');
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listDecks().then(d => {
      setDecks(d);
      if (d.length > 0) setDeckId(d[0].id);
    });
  }, []);

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (!file || !file.type.startsWith('image/')) {
      setError('Drop an image file.');
      return;
    }
    await handleFile(file);
  };

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) await handleFile(file);
  };

  const handleFile = async (file: File) => {
    setError(null);
    const safeName = `${ulid()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    await db().media.put({
      id: ulid(),
      filename: safeName,
      mimeType: file.type,
      blob: file,
    });
    setImageFilename(safeName);
    setImageUrl(URL.createObjectURL(file));
    setRects([]);
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (!containerRef.current || !imageUrl) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    setDrawing({ x, y, w: 0, h: 0 });
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (!drawing || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const cx = (e.clientX - rect.left) / rect.width;
    const cy = (e.clientY - rect.top) / rect.height;
    setDrawing({
      x: Math.min(drawing.x, cx),
      y: Math.min(drawing.y, cy),
      w: Math.abs(cx - drawing.x),
      h: Math.abs(cy - drawing.y),
    });
  };

  const onMouseUp = () => {
    if (drawing && drawing.w > 0.01 && drawing.h > 0.01) {
      setRects([...rects, drawing]);
    }
    setDrawing(null);
  };

  const removeRect = (i: number) => setRects(rects.filter((_, j) => j !== i));
  const setLabel = (i: number, label: string) => {
    setRects(rects.map((r, j) => j === i ? { ...r, label } : r));
  };

  const save = async () => {
    if (!deckId || !imageFilename || rects.length === 0) return;
    setBusy(true);
    try {
      const tagList = tags.trim().split(/\s+/).filter(Boolean);
      await createNote({
        deckId,
        modelId: 'image-occlusion',
        fields: {
          front: '',
          back: '',
          image: imageFilename,
        },
        tags: tagList,
        occlusions: rects,
      });
      router.push(`/deck/${deckId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (decks.length === 0) {
    return (
      <div className="glass-card rounded-2xl p-8 text-center">
        <p className="text-dark-300 mb-3">You need a deck first.</p>
        <Link href="/decks/new" className="btn-gradient px-5 py-2 rounded-xl text-sm">Create a deck</Link>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <div className="text-2xs uppercase tracking-widest text-dark-400 mb-1.5">Deck</div>
          <select
            value={deckId}
            onChange={e => setDeckId(e.target.value)}
            className="w-full bg-dark-800/30 rounded-xl px-4 py-2.5 text-sm text-dark-100 outline-none focus:bg-dark-800/50 transition border border-white/[0.04] cursor-pointer"
          >
            {decks.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>
        <label className="block">
          <div className="text-2xs uppercase tracking-widest text-dark-400 mb-1.5">Tags</div>
          <input
            value={tags}
            onChange={e => setTags(e.target.value)}
            placeholder="anatomy::brain"
            className="w-full bg-dark-800/30 rounded-xl px-4 py-2.5 text-sm text-dark-100 placeholder:text-dark-500 outline-none focus:bg-dark-800/50 transition border border-white/[0.04] font-mono"
          />
        </label>
      </div>

      {!imageUrl ? (
        <div
          onDragEnter={e => e.preventDefault()}
          onDragLeave={e => e.preventDefault()}
          onDragOver={e => e.preventDefault()}
          onDrop={onDrop}
          onClick={() => document.getElementById('occlusion-file')?.click()}
          className="glass-card rounded-2xl p-12 text-center transition cursor-pointer border-2 border-dashed border-white/[0.06] hover:border-white/[0.12]"
        >
          <input id="occlusion-file" type="file" accept="image/*" className="hidden" onChange={onPick} />
          <div className="text-3xl font-extralight tracking-tight bg-gradient-to-r from-saffron-300 to-persian-300 bg-clip-text text-transparent">
            Drop an image
          </div>
          <p className="text-dark-400 font-light mt-2 text-sm">or click to choose a file</p>
        </div>
      ) : (
        <div className="space-y-4">
          <div
            ref={containerRef}
            className="relative inline-block max-w-full select-none cursor-crosshair"
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={() => setDrawing(null)}
          >
            <img src={imageUrl} alt="" className="block max-w-full max-h-[70vh] rounded-xl pointer-events-none" />
            {rects.map((r, i) => (
              <div
                key={i}
                className="absolute pointer-events-none border-2 border-saffron-400/70 bg-saffron-400/15"
                style={{
                  left: `${r.x * 100}%`,
                  top: `${r.y * 100}%`,
                  width: `${r.w * 100}%`,
                  height: `${r.h * 100}%`,
                }}
              >
                <span className="absolute -top-5 left-0 text-2xs text-saffron-200 font-mono bg-dark-900/90 px-1 rounded">
                  c{i + 1}
                </span>
              </div>
            ))}
            {drawing && (
              <div
                className="absolute pointer-events-none border-2 border-dashed border-saffron-400 bg-saffron-400/10"
                style={{
                  left: `${drawing.x * 100}%`,
                  top: `${drawing.y * 100}%`,
                  width: `${drawing.w * 100}%`,
                  height: `${drawing.h * 100}%`,
                }}
              />
            )}
          </div>

          {rects.length > 0 && (
            <div className="glass-card rounded-2xl divide-y divide-white/[0.04]">
              {rects.map((r, i) => (
                <div key={i} className="px-4 py-2 flex items-center gap-3">
                  <span className="text-2xs text-saffron-300 font-mono w-8">c{i + 1}</span>
                  <input
                    value={r.label ?? ''}
                    onChange={e => setLabel(i, e.target.value)}
                    placeholder="optional label shown on back"
                    className="flex-1 bg-dark-800/20 rounded-md px-3 py-1 text-sm text-dark-100 placeholder:text-dark-500 outline-none focus:bg-dark-800/50 transition border border-white/[0.03]"
                  />
                  <button
                    onClick={() => removeRect(i)}
                    className="text-2xs uppercase tracking-widest text-crimson-400 hover:text-crimson-300 transition"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center gap-3">
            <button
              onClick={save}
              disabled={busy || rects.length === 0 || !deckId}
              className="btn-gradient px-5 py-2 rounded-xl text-sm"
            >
              {busy ? 'Saving…' : `Save (${rects.length} card${rects.length === 1 ? '' : 's'})`}
            </button>
            <button
              onClick={() => { setImageUrl(null); setImageFilename(null); setRects([]); }}
              className="px-4 py-2 rounded-xl text-sm text-dark-300 hover:text-dark-100 transition"
            >
              Discard image
            </button>
            {error && <span className="text-sm text-crimson-300 font-light">{error}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
