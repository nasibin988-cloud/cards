'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import type { Podcast, PodcastSegment } from '@/lib/db/schema';
import { getPodcast, listSegments } from '@/lib/db/podcast-queries';
import PodcastPlayer from '@/components/podcast/PodcastPlayer';

export default function PodcastPage() {
  const { id } = useParams<{ id: string }>();
  const [podcast, setPodcast] = useState<Podcast | null | undefined>(undefined);
  const [segments, setSegments] = useState<PodcastSegment[]>([]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    const load = async () => {
      const p = await getPodcast(id);
      if (cancelled) return;
      setPodcast(p ?? null);
      if (p) {
        const segs = await listSegments(id);
        if (!cancelled) {
          segs.sort((a, b) => a.index - b.index);
          setSegments(segs);
        }
      }
    };
    load();
    // While building, poll every 2 seconds for new segment status.
    const interval = setInterval(() => {
      getPodcast(id).then(p => {
        if (cancelled || !p) return;
        setPodcast(p);
        if (p.status === 'ready' || p.status === 'error') {
          listSegments(id).then(segs => {
            if (cancelled) return;
            segs.sort((a, b) => a.index - b.index);
            setSegments(segs);
          });
          clearInterval(interval);
        } else {
          listSegments(id).then(segs => {
            if (cancelled) return;
            segs.sort((a, b) => a.index - b.index);
            setSegments(segs);
          });
        }
      });
    }, 2000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [id]);

  if (podcast === undefined) {
    return (
      <div className="max-w-3xl mx-auto px-4 md:px-6 py-10">
        <div className="glass-card rounded-3xl h-48 loading-shimmer" />
      </div>
    );
  }

  if (podcast === null) {
    return (
      <div className="max-w-3xl mx-auto px-4 md:px-6 py-10 space-y-4">
        <h1 className="text-2xl font-extralight tracking-tight text-dark-100">Podcast not found</h1>
        <Link href="/podcast" className="text-saffron-300 hover:text-saffron-200 text-sm">
          ← Back to Listen
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 md:px-6 py-6 md:py-10 space-y-6">
      <Link
        href="/podcast"
        className="text-2xs uppercase tracking-widest font-mono text-dark-400 hover:text-saffron-300 transition"
      >
        ← Listen
      </Link>
      <PodcastPlayer podcast={podcast} segments={segments} />
    </div>
  );
}
