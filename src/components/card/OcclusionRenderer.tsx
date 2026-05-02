'use client';

import { memo, useEffect, useState } from 'react';
import type { Card, Note } from '@/lib/db/schema';
import { getMediaUrl } from '@/lib/db/queries';
import { cn } from '@/lib/utils';

/**
 * Image-occlusion card render. The note carries:
 *   - fields.image: a media filename (drop the image into the editor)
 *   - occlusions: array of rectangles in normalized (0..1) coords
 * Each Card has clozeOrd = N, meaning "mask the Nth rectangle on the front,
 * reveal it on the back; other rectangles are revealed-by-default in both phases".
 */
function OcclusionRendererImpl({ note, card, side, className }: {
  note: Note;
  card: Card;
  side: 'front' | 'back';
  className?: string;
}) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (note.fields.image) {
      getMediaUrl(note.fields.image).then(url => {
        if (!cancelled) setImageUrl(url);
      });
    }
    return () => { cancelled = true; };
  }, [note.fields.image]);

  // Refresh on per-deck image-source sync (and any other media replacement).
  useEffect(() => {
    const filename = note.fields.image;
    if (!filename) return;
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<{ filenames: string[] }>).detail;
      if (!detail?.filenames?.includes(filename)) return;
      getMediaUrl(filename).then(setImageUrl);
    };
    window.addEventListener('cards:media-changed', onChange as EventListener);
    return () => window.removeEventListener('cards:media-changed', onChange as EventListener);
  }, [note.fields.image]);

  if (!imageUrl) {
    return (
      <div className={cn('flex items-center justify-center min-h-[16rem] text-dark-400 text-sm', className)}>
        Image missing.
      </div>
    );
  }

  const occlusions = note.occlusions ?? [];
  const activeIdx = (card.clozeOrd ?? 1) - 1;

  return (
    <div className={cn('relative inline-block max-w-full', className)}>
      <img src={imageUrl} alt="" className="block max-w-full max-h-[60vh] rounded-xl" />
      {occlusions.map((r, i) => {
        const isActive = i === activeIdx;
        // On the front, mask the active rectangle. On the back, reveal it
        // (faint outline) and leave inactive rectangles revealed both sides.
        const masked = side === 'front' && isActive;
        return (
          <div
            key={i}
            className={cn(
              'absolute pointer-events-none border-2 transition',
              masked
                ? 'bg-dark-900/90 border-saffron-400/60 shadow-glow'
                : isActive && side === 'back'
                  ? 'bg-saffron-400/15 border-saffron-400/70'
                  : 'border-transparent',
            )}
            style={{
              left: `${r.x * 100}%`,
              top: `${r.y * 100}%`,
              width: `${r.w * 100}%`,
              height: `${r.h * 100}%`,
            }}
            aria-hidden
          >
            {masked && (
              <div className="absolute inset-0 flex items-center justify-center text-saffron-300 font-mono text-sm">
                ?
              </div>
            )}
            {isActive && side === 'back' && r.label && (
              <div className="absolute -bottom-6 left-0 text-2xs text-saffron-300 font-mono bg-dark-900/80 px-1.5 py-0.5 rounded">
                {r.label}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const OcclusionRenderer = memo(OcclusionRendererImpl, (prev, next) => (
  prev.note === next.note
  && prev.card === next.card
  && prev.side === next.side
  && prev.className === next.className
));
OcclusionRenderer.displayName = 'OcclusionRenderer';
export default OcclusionRenderer;
