'use client';

/**
 * Image-pipeline diagnostic. Visit /debug/images to see exactly where the
 * image-rendering chain breaks for a given deck. Reports:
 *   - total notes / notes with non-empty `fields.image` / total media rows
 *   - sample mismatched filename if any
 *   - per-deck summary with a "Try resolving" button per sampled note
 *
 * Read-only. Doesn't write anything to the DB.
 */

import { useEffect, useState } from 'react';
import { db } from '@/lib/db/dexie';
import { getMediaUrl } from '@/lib/db/queries';
import type { Note, Media } from '@/lib/db/schema';

interface DeckRow {
  deckId: string;
  deckName: string;
  total: number;
  withImage: number;
  matched: number;
  mismatched: number;
  sampleNote: Note | null;
  sampleMatched: boolean | null;
  sampleResolvedUrl: string | null;
  /** Raw byte length of the underlying blob; 0 = corrupt import. */
  sampleBlobSize: number | null;
  sampleBlobMime: string | null;
  /** First ~80 bytes of the blob, decoded as ASCII — should start with '<svg' for SVGs. */
  sampleBlobPeek: string | null;
}

export default function ImageDebugPage() {
  const [report, setReport] = useState<{
    totals: { notes: number; notesWithImage: number; media: number };
    perDeck: DeckRow[];
    firstFiveMediaFilenames: string[];
    firstFiveImageFields: string[];
  } | null>(null);

  useEffect(() => {
    (async () => {
      const dbi = db();
      const [notes, mediaRows, decks] = await Promise.all([
        dbi.notes.toArray(),
        dbi.media.toArray(),
        dbi.decks.toArray(),
      ]);
      const mediaSet = new Set(mediaRows.map(m => m.filename));
      const deckById = new Map(decks.map(d => [d.id, d]));

      const mediaByFilename = new Map(mediaRows.map(m => [m.filename, m]));
      const perDeck = new Map<string, DeckRow>();
      for (const n of notes) {
        const deckId = n.deckId;
        const row = perDeck.get(deckId) ?? {
          deckId,
          deckName: deckById.get(deckId)?.name ?? '(unknown)',
          total: 0,
          withImage: 0,
          matched: 0,
          mismatched: 0,
          sampleNote: null,
          sampleMatched: null,
          sampleResolvedUrl: null,
          sampleBlobSize: null,
          sampleBlobMime: null,
          sampleBlobPeek: null,
        };
        row.total++;
        const img = n.fields?.image;
        if (img) {
          row.withImage++;
          if (mediaSet.has(img)) row.matched++;
          else row.mismatched++;
          if (!row.sampleNote) row.sampleNote = n;
        }
        perDeck.set(deckId, row);
      }
      // Resolve the first sample per deck through the same path Reviewer uses,
      // plus a direct read of the underlying blob so we can spot 0-byte
      // imports (most common cause of "resolves but renders nothing").
      for (const row of perDeck.values()) {
        if (row.sampleNote?.fields.image) {
          const filename = row.sampleNote.fields.image;
          const url = await getMediaUrl(filename);
          row.sampleMatched = url !== null;
          row.sampleResolvedUrl = url;
          const m = mediaByFilename.get(filename);
          if (m) {
            row.sampleBlobSize = m.blob.size;
            row.sampleBlobMime = m.blob.type || m.mimeType;
            // First 80 bytes as ASCII so SVG XML / PNG magic / empty-blob
            // are obvious at a glance.
            try {
              const buf = await m.blob.slice(0, 80).arrayBuffer();
              row.sampleBlobPeek = new TextDecoder('utf-8', { fatal: false })
                .decode(new Uint8Array(buf))
                .replace(/[\x00-\x1f]/g, '·');
            } catch { /* ignore */ }
          }
        }
      }

      setReport({
        totals: { notes: notes.length, notesWithImage: notes.filter(n => n.fields?.image).length, media: mediaRows.length },
        perDeck: [...perDeck.values()].filter(r => r.withImage > 0).sort((a, b) => b.withImage - a.withImage),
        firstFiveMediaFilenames: mediaRows.slice(0, 5).map(m => m.filename),
        firstFiveImageFields: notes.filter(n => n.fields?.image).slice(0, 5).map(n => n.fields.image!),
      });
    })().catch(err => {
      // eslint-disable-next-line no-console
      console.error('[debug/images]', err);
    });
  }, []);

  if (!report) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-10 text-dark-400 font-light text-sm">
        Loading diagnostic…
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-10 space-y-6">
      <h1 className="text-3xl font-extralight tracking-tight">Image diagnostic</h1>
      <p className="text-dark-400 font-light text-sm max-w-2xl">
        Read-only inspection of the image rendering chain. If a row says &quot;mismatched&quot;,
        the note&apos;s <code className="text-saffron-300">fields.image</code> filename
        doesn&apos;t exist in the media table — re-import the deck.
      </p>

      <section className="glass-card rounded-2xl p-5 space-y-2">
        <div className="text-2xs uppercase tracking-widest text-dark-400">Totals</div>
        <div className="font-mono text-sm tabular-nums">
          <div>notes: <span className="text-saffron-300">{report.totals.notes}</span></div>
          <div>notes with image field: <span className="text-saffron-300">{report.totals.notesWithImage}</span></div>
          <div>media rows: <span className="text-saffron-300">{report.totals.media}</span></div>
        </div>
      </section>

      <section className="glass-card rounded-2xl p-5 space-y-3">
        <div className="text-2xs uppercase tracking-widest text-dark-400">Sample filenames</div>
        <div className="text-2xs font-mono space-y-1">
          <div>
            <span className="text-dark-500">media table (first 5):</span>{' '}
            {report.firstFiveMediaFilenames.length > 0
              ? report.firstFiveMediaFilenames.map(f => <code key={f} className="text-persian-200 mr-2">{f}</code>)
              : <span className="text-crimson-300">(empty)</span>}
          </div>
          <div>
            <span className="text-dark-500">notes.fields.image (first 5):</span>{' '}
            {report.firstFiveImageFields.length > 0
              ? report.firstFiveImageFields.map(f => <code key={f} className="text-saffron-200 mr-2">{f}</code>)
              : <span className="text-crimson-300">(empty)</span>}
          </div>
        </div>
      </section>

      <section className="glass-card rounded-2xl p-5 space-y-3">
        <div className="text-2xs uppercase tracking-widest text-dark-400">Per deck</div>
        {report.perDeck.length === 0 ? (
          <p className="text-sm text-dark-300 font-light">
            No notes have an image field. Re-import a deck that contains images.
          </p>
        ) : (
          <ul className="divide-y divide-white/[0.04]">
            {report.perDeck.map(r => (
              <li key={r.deckId} className="py-3 space-y-1">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <span className="text-sm font-light text-dark-100">{r.deckName}</span>
                  <span className="text-2xs font-mono tabular-nums text-dark-400">
                    {r.withImage}/{r.total} have image ·{' '}
                    <span className={r.matched === r.withImage ? 'text-saffron-300' : 'text-crimson-300'}>
                      {r.matched} matched
                    </span>
                    {r.mismatched > 0 && <>, <span className="text-crimson-300">{r.mismatched} mismatched</span></>}
                  </span>
                </div>
                {r.sampleNote && (
                  <div className="text-2xs font-mono text-dark-500 break-all">
                    sample image: <span className="text-saffron-200">{r.sampleNote.fields.image}</span>
                    {' · '}
                    <span className={r.sampleMatched ? 'text-saffron-300' : 'text-crimson-300'}>
                      {r.sampleMatched ? 'resolves' : 'unresolved'}
                    </span>
                    {r.sampleBlobSize !== null && (
                      <>
                        {' · '}
                        <span className={r.sampleBlobSize > 0 ? 'text-dark-400' : 'text-crimson-300'}>
                          {r.sampleBlobSize} bytes
                        </span>
                        {r.sampleBlobMime && <> · <span className="text-dark-400">{r.sampleBlobMime || '(no mime)'}</span></>}
                      </>
                    )}
                  </div>
                )}
                {r.sampleBlobPeek && (
                  <div className="text-2xs font-mono text-dark-600 break-all bg-dark-900/40 px-2 py-1 rounded">
                    {r.sampleBlobPeek.slice(0, 80)}{r.sampleBlobPeek.length > 80 ? '…' : ''}
                  </div>
                )}
                {r.sampleResolvedUrl && (
                  <div className="pt-1">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={r.sampleResolvedUrl}
                      alt=""
                      className="rounded-lg max-h-32 min-h-12 object-contain border border-white/[0.06] bg-dark-900/40"
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
