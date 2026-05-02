/**
 * Persian word lookup. Two backends compose:
 *
 *  1. Local lemma index (optional): user uploads a JSONL or CSV exported from
 *     DICTIONARY/V2 (or any compatible source). We index it in memory keyed
 *     by headword + simple variants, so common matches are instant.
 *
 *  2. Claude-backed lookup (default): on a miss, ask Claude for the gloss,
 *     etymology, and example. Cached in IndexedDB by headword so repeat
 *     hovers don't re-bill.
 */

import { db } from '@/lib/db/dexie';
import { getSetting, setSetting } from '@/lib/db/queries';
import { makeAnthropicClient } from '@/lib/ai/client';
import { DEFAULT_MODEL } from '@/lib/ai/claude';

export interface LemmaEntry {
  headword: string;
  gloss?: string;
  etymology?: string;
  example?: string;
  pos?: string;          // part of speech
  source?: string;       // 'local-index', 'claude', etc.
}

const CACHE_PREFIX = '__lemma_cache:';

/* ─── Local index (in-memory) ─────────────────────────────────── */

let localIndex: Map<string, LemmaEntry> | null = null;

function normalize(s: string): string {
  // Strip Arabic diacritics, normalize Persian/Arabic forms.
  return s
    .replace(/[ً-ْٰ]/g, '')   // tashkil
    .replace(/ي/g, 'ی')            // Arabic ya → Persian ya
    .replace(/ك/g, 'ک')            // Arabic kaf → Persian kaf
    .trim();
}

export async function loadLemmaIndex(file: File): Promise<{ count: number }> {
  const text = await file.text();
  const map = new Map<string, LemmaEntry>();
  if (file.name.endsWith('.csv')) {
    parseCsv(text, map);
  } else {
    parseJsonl(text, map);
  }
  localIndex = map;
  // Persist the raw text for re-use across sessions, capped at ~10MB.
  if (text.length < 10 * 1024 * 1024) {
    await setSetting('lemma_index_raw', JSON.stringify({ filename: file.name, body: text }));
  }
  return { count: map.size };
}

export async function ensureLemmaIndexLoaded(): Promise<number> {
  if (localIndex) return localIndex.size;
  const raw = await getSetting('lemma_index_raw');
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(raw);
    const map = new Map<string, LemmaEntry>();
    if (parsed.filename?.endsWith('.csv')) parseCsv(parsed.body, map);
    else parseJsonl(parsed.body, map);
    localIndex = map;
    return map.size;
  } catch {
    return 0;
  }
}

export async function clearLemmaIndex(): Promise<void> {
  localIndex = null;
  await db().settings.delete('lemma_index_raw');
}

function parseJsonl(text: string, map: Map<string, LemmaEntry>): void {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t) as LemmaEntry;
      if (!obj.headword) continue;
      map.set(normalize(obj.headword), { ...obj, source: 'local-index' });
    } catch { /* skip malformed lines */ }
  }
}

function parseCsv(text: string, map: Map<string, LemmaEntry>): void {
  const lines = text.split('\n');
  if (lines.length < 2) return;
  const header = lines[0].split(',').map(c => c.trim().toLowerCase());
  const idx = (k: string) => header.indexOf(k);
  const hwIdx = idx('headword') !== -1 ? idx('headword') : idx('lemma_candidate') !== -1 ? idx('lemma_candidate') : idx('lemma');
  if (hwIdx < 0) return;
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const headword = cells[hwIdx]?.trim();
    if (!headword) continue;
    map.set(normalize(headword), {
      headword,
      gloss: idx('gloss') >= 0 ? cells[idx('gloss')] : undefined,
      etymology: idx('etymology') >= 0 ? cells[idx('etymology')] : undefined,
      example: idx('example') >= 0 ? cells[idx('example')] : undefined,
      pos: idx('pos') >= 0 ? cells[idx('pos')] : undefined,
      source: 'local-index',
    });
  }
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; continue; }
    if (c === '"') { inQuotes = !inQuotes; continue; }
    if (c === ',' && !inQuotes) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

/* ─── Claude-backed lookup with cache ─────────────────────────── */

const SYSTEM_PROMPT = `You are a Persian-English lexicographer.

For a given Persian (or Arabic-script) word, return a single JSON object:
{
  "headword": "<the canonical lemma form>",
  "gloss": "<1-3 word English gloss>",
  "etymology": "<one short sentence on origin / roots, if known>",
  "example": "<one short Persian sentence using the word>",
  "pos": "<part of speech, lowercase>"
}

Rules:
- Output ONLY the JSON, no preamble, no markdown.
- If you genuinely don't know, return { "headword": "...", "gloss": "(unknown)" }.
- Be terse. No hedging. No "this word means".
- Do not use em dashes anywhere.`;

async function claudeLookup(word: string): Promise<LemmaEntry | null> {
  const apiKey = await getSetting('claude_api_key');
  if (!apiKey) throw new Error('Add your Claude API key in Settings to look up Persian words.');
  const model = (await getSetting('claude_model')) || DEFAULT_MODEL;
  const client = await makeAnthropicClient(apiKey);

  const res = await client.messages.create({
    model,
    max_tokens: 256,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: word }],
  });

  const text = res.content
    .filter(b => b.type === 'text')
    .map(b => 'text' in b ? b.text : '')
    .join('').trim();
  const cleaned = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  try {
    const obj = JSON.parse(cleaned);
    if (typeof obj.headword !== 'string' || typeof obj.gloss !== 'string') return null;
    return { ...obj, source: 'claude' };
  } catch { return null; }
}

/* ─── Public API ───────────────────────────────────────────────── */

export async function lookupPersianWord(word: string): Promise<LemmaEntry | null> {
  const norm = normalize(word);
  if (!norm) return null;

  // 1. local index hit
  await ensureLemmaIndexLoaded();
  if (localIndex && localIndex.has(norm)) return localIndex.get(norm)!;

  // 2. cache
  const cacheKey = CACHE_PREFIX + norm;
  const cached = await getSetting(cacheKey);
  if (cached) {
    try { return JSON.parse(cached) as LemmaEntry; } catch { /* fall through */ }
  }

  // 3. Claude
  const entry = await claudeLookup(norm);
  if (entry) {
    await setSetting(cacheKey, JSON.stringify(entry));
    return entry;
  }
  return null;
}
