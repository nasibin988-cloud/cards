/**
 * Persistence layer for audio-priming podcasts.
 *
 * Three tables, two access patterns:
 *   - `podcasts` + `podcastSegments` carry metadata; small rows, cheap to
 *     list / patch / hydrate in the player.
 *   - `podcastAudio` carries the rendered blobs; one row per segment so a
 *     partially-rendered podcast survives a reload and resumes cleanly.
 *
 * Audio is intentionally excluded from sync (see dexie.ts dirtyTables):
 * a 4hr OpenAI tts-1 podcast can be 60+ MB and is locally derivable from
 * the segment scripts, so we never want to ship it through Supabase.
 */

import { db } from './dexie';
import type {
  Podcast,
  PodcastAudio,
  PodcastSegment,
  PodcastSegmentStatus,
  PodcastStatus,
} from './schema';

export async function listPodcasts(): Promise<Podcast[]> {
  return db().podcasts.orderBy('createdAt').reverse().toArray();
}

export async function getPodcast(podcastId: string): Promise<Podcast | undefined> {
  return db().podcasts.get(podcastId);
}

export async function createPodcast(input: Omit<Podcast, 'createdAt'>): Promise<Podcast> {
  const row: Podcast = { ...input, createdAt: Date.now() };
  await db().podcasts.put(row);
  return row;
}

export async function updatePodcast(podcastId: string, patch: Partial<Podcast>): Promise<void> {
  await db().podcasts.update(podcastId, patch);
}

export async function setPodcastStatus(
  podcastId: string,
  status: PodcastStatus,
  extra: Partial<Podcast> = {},
): Promise<void> {
  await db().podcasts.update(podcastId, { status, ...extra });
}

export async function deletePodcast(podcastId: string): Promise<void> {
  await db().transaction(
    'rw',
    [db().podcasts, db().podcastSegments, db().podcastAudio],
    async () => {
      await db().podcasts.delete(podcastId);
      await db().podcastSegments.where('podcastId').equals(podcastId).delete();
      await db().podcastAudio.where('podcastId').equals(podcastId).delete();
    },
  );
}

export async function listSegments(podcastId: string): Promise<PodcastSegment[]> {
  return db()
    .podcastSegments
    .where('[podcastId+index]')
    .between([podcastId, -Infinity], [podcastId, Infinity])
    .toArray();
}

export async function putSegments(segments: PodcastSegment[]): Promise<void> {
  if (segments.length === 0) return;
  await db().podcastSegments.bulkPut(segments);
}

export async function updateSegment(
  segmentId: string,
  patch: Partial<PodcastSegment>,
): Promise<void> {
  await db().podcastSegments.update(segmentId, patch);
}

export async function setSegmentStatus(
  segmentId: string,
  status: PodcastSegmentStatus,
  extra: Partial<PodcastSegment> = {},
): Promise<void> {
  await db().podcastSegments.update(segmentId, { status, ...extra });
}

/* ─── Audio blobs ─────────────────────────────────────────────── */

function audioKey(podcastId: string, segmentIndex: number): string {
  return `${podcastId}::${segmentIndex}`;
}

export async function putSegmentAudio(
  podcastId: string,
  segmentIndex: number,
  mimeType: string,
  blob: Blob,
): Promise<PodcastAudio> {
  const row: PodcastAudio = {
    pk: audioKey(podcastId, segmentIndex),
    podcastId,
    segmentIndex,
    mimeType,
    blob,
    bytes: blob.size,
  };
  await db().podcastAudio.put(row);
  return row;
}

export async function getSegmentAudio(
  podcastId: string,
  segmentIndex: number,
): Promise<PodcastAudio | undefined> {
  return db().podcastAudio.get(audioKey(podcastId, segmentIndex));
}

export async function listAudioForPodcast(podcastId: string): Promise<PodcastAudio[]> {
  return db().podcastAudio.where('podcastId').equals(podcastId).toArray();
}

export async function totalAudioBytes(podcastId: string): Promise<number> {
  const audio = await listAudioForPodcast(podcastId);
  return audio.reduce((sum, a) => sum + a.bytes, 0);
}
