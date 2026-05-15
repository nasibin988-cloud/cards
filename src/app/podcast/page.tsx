'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Podcast } from '@/lib/db/schema';
import { listPodcasts, deletePodcast } from '@/lib/db/podcast-queries';
import { resumePodcastBuild, type BuildEvent } from '@/lib/podcast/build';
import PodcastBuilder from '@/components/podcast/PodcastBuilder';
import { cn } from '@/lib/utils';

export default function PodcastIndex() {
  const [podcasts, setPodcasts] = useState<Podcast[] | null>(null);
  const [resumingId, setResumingId] = useState<string | null>(null);
  const [resumeProgress, setResumeProgress] = useState<BuildEvent | null>(null);
  const [resumeError, setResumeError] = useState<string | null>(null);

  const refresh = () => listPodcasts().then(setPodcasts);
  useEffect(() => { refresh(); }, []);

  const onDelete = async (id: string) => {
    if (!confirm('Delete this podcast and its audio?')) return;
    await deletePodcast(id);
    refresh();
  };

  const onResume = async (id: string, retryErrors: boolean) => {
    setResumingId(id);
    setResumeError(null);
    setResumeProgress({ stage: 'projecting' });
    try {
      await resumePodcastBuild(id, ev => setResumeProgress(ev), undefined, { retryErrors });
      refresh();
    } catch (err) {
      setResumeError(err instanceof Error ? err.message : String(err));
    } finally {
      setResumingId(null);
      setResumeProgress(null);
    }
  };

  return (
    <div className="max-w-3xl mx-auto px-4 md:px-6 py-6 md:py-10 space-y-8">
      <div className="space-y-2">
        <h1 className="text-3xl md:text-4xl font-extralight tracking-tight bg-gradient-to-r from-saffron-300 to-persian-300 bg-clip-text text-transparent">
          Listen
        </h1>
        <p className="text-sm text-dark-300 font-light max-w-xl">
          Generate a podcast that primes you for the cards you&apos;re about to study.
          Pick decks, a length, and a horizon; the rest is written and narrated for
          passive listening.
        </p>
      </div>

      <PodcastBuilder onCreated={refresh} />

      <div className="space-y-3">
        <h2 className="text-2xs uppercase tracking-widest text-dark-500 font-mono">Library</h2>
        {resumeError && (
          <div className="text-sm text-red-300 font-light px-3 py-2 rounded-xl bg-red-900/15 border border-red-900/30">
            Resume failed: {resumeError}
          </div>
        )}
        {podcasts === null ? (
          <div className="glass-card rounded-3xl h-24 loading-shimmer" />
        ) : podcasts.length === 0 ? (
          <div className="glass-card rounded-3xl p-6 text-sm text-dark-400 font-light">
            No podcasts yet.
          </div>
        ) : (
          <ul className="space-y-2">
            {podcasts.map(p => {
              const inFlight = p.status === 'planning' || p.status === 'scripting' || p.status === 'rendering';
              const resumable = inFlight || p.status === 'error';
              const resumingThis = resumingId === p.id;
              return (
                <li key={p.id} className="glass-card glass-card-hover rounded-2xl p-4 flex items-center gap-3 flex-wrap">
                  <Link href={`/podcast/${p.id}`} className="flex-1 min-w-0">
                    <div className="text-sm text-dark-100 font-light truncate">{p.name}</div>
                    <div className="text-2xs text-dark-500 font-mono mt-0.5 flex items-center gap-2 flex-wrap">
                      <span>{p.cardCount} cards</span>
                      <span className="text-dark-700">·</span>
                      <span>{fmtDuration(p.durationSec ?? p.targetSeconds)}</span>
                      <span className="text-dark-700">·</span>
                      <span>{p.ttsProvider === 'openai' ? `OpenAI ${p.voiceA ?? ''}/${p.voiceB ?? ''}` : 'Browser TTS'}</span>
                      <span className="text-dark-700">·</span>
                      <span>{new Date(p.createdAt).toLocaleString()}</span>
                    </div>
                    {resumingThis && resumeProgress && (
                      <div className="mt-2 text-2xs text-saffron-300 font-mono">
                        {progressLabel(resumeProgress)}
                      </div>
                    )}
                  </Link>
                  <StatusBadge status={p.status} />
                  {resumable && !resumingThis && (
                    <button
                      type="button"
                      onClick={() => onResume(p.id, p.status === 'error')}
                      disabled={resumingId !== null}
                      className="text-2xs uppercase tracking-widest font-mono text-saffron-300 hover:text-saffron-200 transition px-2 disabled:opacity-50"
                      title={p.status === 'error' ? 'Retry failed segments + finish' : 'Resume from the last completed step'}
                    >
                      {p.status === 'error' ? 'retry' : 'resume'}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onDelete(p.id)}
                    disabled={resumingThis}
                    className="text-2xs uppercase tracking-widest font-mono text-dark-500 hover:text-red-300 transition px-2 disabled:opacity-50"
                    title="Delete"
                  >
                    delete
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function progressLabel(ev: BuildEvent): string {
  switch (ev.stage) {
    case 'projecting': return 'pulling cards…';
    case 'planning':   return `planning (${ev.cardCount} cards)…`;
    case 'planned':    return `plan ready (${ev.plan.segments.length} segments)…`;
    case 'scripting':  return `writing segments ${ev.done}/${ev.total}…`;
    case 'rendering':  return `rendering audio ${ev.done}/${ev.total}…`;
    case 'ready':      return 'done.';
    case 'aborted':    return 'cancelled.';
    case 'error':      return `error: ${ev.message}`;
  }
}

function StatusBadge({ status }: { status: Podcast['status'] }) {
  const styles = (() => {
    switch (status) {
      case 'ready':     return 'bg-emerald-900/30 text-emerald-200 border-emerald-700/40';
      case 'planning':
      case 'scripting':
      case 'rendering': return 'bg-saffron-900/30 text-saffron-200 border-saffron-700/40 animate-pulse';
      case 'error':     return 'bg-red-900/30 text-red-200 border-red-700/40';
    }
  })();
  return (
    <span className={cn('text-2xs uppercase tracking-widest font-mono px-2 py-1 rounded-md border', styles)}>
      {status}
    </span>
  );
}

function fmtDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
