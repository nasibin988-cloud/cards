/**
 * /image command — finds an educational image relevant to a card or query.
 *
 * Pipeline:
 *  1. Refine the user's query (or derive one from the card) via a single
 *     Claude call. This turns "/image vesicles" into "synaptic vesicle
 *     electron micrograph" — a much higher-yield search term on Wikimedia
 *     Commons.
 *  2. Hit the Wikimedia Commons MediaWiki API directly (CORS-friendly,
 *     no API key, free). Pull top 6 file pages for the refined query.
 *  3. Resolve each file to thumbnail + full URL + license + author.
 *
 * The caller renders the result as a grid of thumbnails the user can pick
 * from to attach to a card.
 */

import { getSetting } from '@/lib/db/queries';
import { DEFAULT_MODEL } from '../claude';
import { makeAnthropicClient } from '../client';
import { renderPlain } from '@/lib/cloze/parser';
import type { CommandResult, ImageHit, SlashCommand } from './types';

const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const RESULT_LIMIT = 6;
const THUMB_WIDTH = 400;

/** Build a card-aware text fragment for query refinement. */
function cardSummary(ctx: { note: { fields: import('@/lib/db/schema').NoteFields } }): string {
  const f = ctx.note.fields;
  const parts = [
    f.front ? `Front: ${renderPlain(f.front)}` : '',
    f.back ? `Back: ${renderPlain(f.back)}` : '',
    f.context ? `Context: ${f.context}` : '',
  ].filter(Boolean);
  return parts.join('\n');
}

async function refineQuery(userQuery: string, summary: string): Promise<string> {
  // Trivially short queries get used as-is so we don't pay an API round-trip
  // when the user has obviously specified the search term already.
  const trimmed = userQuery.trim();
  if (trimmed.length >= 25) return trimmed;

  const apiKey = await getSetting('claude_api_key');
  if (!apiKey) {
    if (trimmed) return trimmed;
    throw new Error('Add your Claude API key in Settings to derive an image query from this card.');
  }
  const model = (await getSetting('claude_model')) || DEFAULT_MODEL;
  const client = await makeAnthropicClient(apiKey);

  const system = `You are a search-query refinement assistant. The user is studying a flashcard and wants an educational image (anatomy, biology, biochemistry, physics, history) from Wikimedia Commons.

Output ONLY the query, 2-4 words, no commentary, no quotes. Wikimedia Commons search is a strict AND across all words — every extra token slashes hit rate. Pick the single canonical noun phrase a Wikipedia editor would use as a file caption (e.g. "hippocampus" not "temporal lobe hippocampus diagram"). If the user named a specific structure, use that name verbatim.`;

  const userText = trimmed
    ? `User asked: "${trimmed}"\n\nCard:\n${summary || '(no card context)'}\n\nRefined query:`
    : `Card:\n${summary || '(no context — make a generic, sensible query)'}\n\nRefined query:`;

  const r = await client.messages.create({
    model,
    max_tokens: 60,
    system,
    messages: [{ role: 'user', content: userText }],
  });
  const out = r.content
    .map(c => (c.type === 'text' ? c.text : ''))
    .join('')
    .trim()
    .replace(/^["']|["']$/g, ''); // strip stray quotes
  return out || trimmed || 'diagram';
}

interface CommonsSearchHit { title: string; }

async function searchCommonsRaw(query: string): Promise<CommonsSearchHit[]> {
  const url = new URL(COMMONS_API);
  url.searchParams.set('action', 'query');
  url.searchParams.set('list', 'search');
  url.searchParams.set('srsearch', query);
  url.searchParams.set('srnamespace', '6');                 // File namespace
  url.searchParams.set('srlimit', String(RESULT_LIMIT));
  url.searchParams.set('format', 'json');
  url.searchParams.set('origin', '*');                      // CORS

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Wikimedia search failed (${res.status}).`);
  const json = await res.json() as { query?: { search?: Array<{ title: string }> } };
  return json.query?.search ?? [];
}

/**
 * Cascading search: the full query first, then progressively drop words
 * (last-first, since the first words are usually the most specific noun)
 * until we get hits or shrink to one token.
 *
 * Returns the hits AND the actual query that produced them so the UI can
 * tell the user what worked when their typed phrase didn't.
 */
async function searchCommons(query: string): Promise<{ hits: CommonsSearchHit[]; effectiveQuery: string }> {
  const tokens = query.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { hits: [], effectiveQuery: query };

  // Try the full query first. If 0 hits, drop the LAST token (which is most
  // often a generic suffix like "diagram" / "anatomy") and retry.
  for (let len = tokens.length; len >= 1; len--) {
    const sub = tokens.slice(0, len).join(' ');
    const hits = await searchCommonsRaw(sub);
    if (hits.length > 0) return { hits, effectiveQuery: sub };
  }
  return { hits: [], effectiveQuery: query };
}

interface ImageInfo {
  thumburl?: string;
  url?: string;
  mime?: string;
  width?: number;
  height?: number;
  extmetadata?: Record<string, { value?: string }>;
}

async function resolveCommonsHits(titles: string[]): Promise<ImageHit[]> {
  if (titles.length === 0) return [];
  const url = new URL(COMMONS_API);
  url.searchParams.set('action', 'query');
  url.searchParams.set('titles', titles.join('|'));
  url.searchParams.set('prop', 'imageinfo');
  url.searchParams.set('iiprop', 'url|mime|size|extmetadata');
  url.searchParams.set('iiurlwidth', String(THUMB_WIDTH));
  url.searchParams.set('format', 'json');
  url.searchParams.set('origin', '*');

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Wikimedia metadata failed (${res.status}).`);
  const json = await res.json() as {
    query?: { pages?: Record<string, { title: string; imageinfo?: ImageInfo[] }> };
  };
  const pages = Object.values(json.query?.pages ?? {});
  const out: ImageHit[] = [];
  for (const p of pages) {
    const info = p.imageinfo?.[0];
    if (!info?.url) continue;
    // Only show images we can actually render.
    if (info.mime && !info.mime.startsWith('image/')) continue;
    const ext = info.extmetadata ?? {};
    const artist = sanitizeMetaValue(ext.Artist?.value);
    const license = sanitizeMetaValue(ext.LicenseShortName?.value) || 'CC';
    out.push({
      title: p.title,
      thumbUrl: info.thumburl ?? info.url,
      fullUrl: info.url,
      mime: info.mime ?? 'image/jpeg',
      attribution: artist ? `${artist}, ${license}` : license,
      width: info.width,
      height: info.height,
    });
  }
  // Preserve the search ranking order.
  const orderById = new Map(titles.map((t, i) => [t, i]));
  out.sort((a, b) => (orderById.get(a.title) ?? 99) - (orderById.get(b.title) ?? 99));
  return out;
}

/**
 * Wikimedia returns HTML in extmetadata; strip tags so the attribution string
 * stays plain and CORS-safe.
 */
function sanitizeMetaValue(raw: string | undefined): string {
  if (!raw) return '';
  return raw.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

export const imageCommand: SlashCommand = {
  name: 'image',
  description: 'Find an image (Wikimedia Commons)',
  argHint: '[query?]',
  needsAI: true,
  run: async (rawArgs, ctx) => {
    try {
      const summary = cardSummary(ctx);
      const refined = await refineQuery(rawArgs, summary);
      const { hits, effectiveQuery } = await searchCommons(refined);
      const titles = hits.map(h => h.title);
      const results = await resolveCommonsHits(titles);
      // Surface the query that ACTUALLY produced hits when it differs from
      // the original refinement — that's what the user wants to know when
      // their first phrasing turned up empty.
      return { kind: 'images', query: rawArgs.trim(), refinedQuery: effectiveQuery, results };
    } catch (err) {
      return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  },
};

/**
 * Direct image search — used by the inline retry control in the result
 * panel when the user wants to try a different phrasing without invoking
 * Claude's refinement again.
 */
export async function searchImages(query: string): Promise<{ results: ImageHit[]; effectiveQuery: string }> {
  const { hits, effectiveQuery } = await searchCommons(query);
  const titles = hits.map(h => h.title);
  const results = await resolveCommonsHits(titles);
  return { results, effectiveQuery };
}

/**
 * Download an image into the local media table so subsequent renders are
 * offline-capable. Returns the filename written.
 */
export async function downloadCommonsImage(hit: ImageHit): Promise<string> {
  const { db } = await import('@/lib/db/dexie');
  const { id } = await import('@/lib/ulid');
  const res = await fetch(hit.fullUrl);
  if (!res.ok) throw new Error(`Image fetch failed (${res.status}).`);
  const blob = await res.blob();
  const ext = guessExt(hit.mime) || guessExtFromUrl(hit.fullUrl) || 'img';
  const filename = `${id()}.${ext}`;
  await db().media.put({
    id: id(),
    filename,
    mimeType: hit.mime,
    blob,
  });
  return filename;
}

function guessExt(mime: string): string | null {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/gif') return 'gif';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/svg+xml') return 'svg';
  return null;
}

function guessExtFromUrl(url: string): string | null {
  const m = /\.([a-z0-9]{3,4})(?:[?#]|$)/i.exec(url);
  return m ? m[1].toLowerCase() : null;
}

// Re-export for convenience so the registry can use the same module entry.
export type { CommandResult };
