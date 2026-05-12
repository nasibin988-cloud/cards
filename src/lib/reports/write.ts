/**
 * Two-stage writer pipeline for end-of-day and deck-overview reports.
 *
 *   1. Sonnet 4.6: cluster the cards inside one section into 4–10 topic
 *      buckets and write a tight section header per cluster. Cheap,
 *      fast, structured JSON output.
 *   2. Opus 4.7: for each cluster, write the prose narrative — what's
 *      in it, how the cards connect to each other, why they cohere.
 *      Plus a final cross-cluster "connections" paragraph that names
 *      bridges between topics.
 *
 * The deck-overview report uses the same shape: every note is treated
 * as if it lived in a "fullDeckScope" section that gets the full
 * cluster + narrate treatment.
 */

import { makeAnthropicClient } from '@/lib/ai/client';
import { getSetting } from '@/lib/db/queries';
import type { ReportCard, ReportData } from './gather';

const ENUMERATOR_MODEL = 'claude-sonnet-4-6';
const WRITER_MODEL = 'claude-opus-4-7';

/** Cap how many cards Sonnet sees per section in the cluster step.
 *  500+ cards in one prompt = slow + expensive + the cluster step
 *  doesn't really get sharper past this. We chunk in the caller. */
const MAX_CARDS_PER_ENUMERATE_CALL = 80;

export interface ReportCluster {
  /** Short clean heading. */
  heading: string;
  /** Note IDs in this cluster. */
  noteIds: string[];
}

export interface ReportSection {
  kind: 'learned' | 'reviewed' | 'trouble' | 'overview';
  heading: string;
  /** One-sentence section intro (Opus). */
  intro: string;
  clusters: ReportClusterWritten[];
}

export interface ReportClusterWritten {
  heading: string;
  /** Opus-written 2-4 sentence narrative covering the cluster's facts. */
  narrative: string;
  cards: ReportCard[];
}

export interface ReportDoc {
  title: string;
  subtitle: string;
  generatedAt: number;
  sections: ReportSection[];
  /** Cross-cluster + cross-section bridges. Empty when there's only one cluster. */
  connections: string;
  /** Stats line for the title page: counts per bucket. */
  meta: {
    learnedCount: number;
    reviewedCount: number;
    troubleCount: number;
    overviewCount: number;
  };
}

export interface WriteProgress {
  phase: 'enumerate' | 'narrate' | 'connect' | 'done';
  section?: string;
  current?: number;
  total?: number;
}

export async function writeReport(
  data: ReportData,
  onProgress?: (p: WriteProgress) => void,
): Promise<ReportDoc> {
  const apiKey = await getSetting('claude_api_key');
  if (!apiKey) throw new Error('Claude API key not configured. Add it in Settings.');
  const client = await makeAnthropicClient(apiKey);

  const sections: ReportSection[] = [];

  // Daily report: three buckets, only emit a section if non-empty.
  if (data.kind === 'daily') {
    if (data.learnedToday.length > 0) {
      sections.push(await buildSection(
        client, 'learned', "What I learned today", data.learnedToday, onProgress,
      ));
    }
    if (data.reviewedToday.length > 0) {
      sections.push(await buildSection(
        client, 'reviewed', "What I reviewed today", data.reviewedToday, onProgress,
      ));
    }
    if (data.trouble.length > 0) {
      sections.push(await buildSection(
        client, 'trouble', "Where I struggled", data.trouble, onProgress,
      ));
    }
  } else {
    // Deck overview: one big section.
    sections.push(await buildSection(
      client, 'overview', "What's in this deck", data.fullDeckScope, onProgress,
    ));
  }

  // Cross-section / cross-cluster bridges. Only worth a call if there's
  // more than one cluster total — otherwise there's nothing to bridge.
  const totalClusters = sections.reduce((n, s) => n + s.clusters.length, 0);
  let connections = '';
  if (totalClusters >= 2) {
    onProgress?.({ phase: 'connect' });
    connections = await writeConnections(client, sections);
  }

  onProgress?.({ phase: 'done' });

  return {
    title: data.kind === 'daily' ? "Today's study report" : 'Deck overview',
    subtitle: data.title,
    generatedAt: data.generatedAt,
    sections,
    connections,
    meta: {
      learnedCount: data.learnedToday.length,
      reviewedCount: data.reviewedToday.length,
      troubleCount: data.trouble.length,
      overviewCount: data.fullDeckScope.length,
    },
  };
}

async function buildSection(
  client: Awaited<ReturnType<typeof makeAnthropicClient>>,
  kind: ReportSection['kind'],
  heading: string,
  cards: ReportCard[],
  onProgress?: (p: WriteProgress) => void,
): Promise<ReportSection> {
  onProgress?.({ phase: 'enumerate', section: heading, current: 0, total: cards.length });

  // Stage 1: cluster. Chunk if needed so Sonnet doesn't choke on a
  // 1000-card prompt. We merge clusters across chunks by heading
  // similarity (very simple: same lowercased trimmed string → merge).
  const chunks: ReportCard[][] = [];
  for (let i = 0; i < cards.length; i += MAX_CARDS_PER_ENUMERATE_CALL) {
    chunks.push(cards.slice(i, i + MAX_CARDS_PER_ENUMERATE_CALL));
  }
  const allClusters: ReportCluster[] = [];
  for (const chunk of chunks) {
    const part = await enumerateClusters(client, kind, chunk);
    for (const c of part) {
      const key = c.heading.trim().toLowerCase();
      const existing = allClusters.find(x => x.heading.trim().toLowerCase() === key);
      if (existing) existing.noteIds.push(...c.noteIds);
      else allClusters.push(c);
    }
  }
  // Cards that Sonnet didn't place in any cluster (rare) bucket into
  // a fallback "Other" cluster so nothing gets dropped from the report.
  const claimed = new Set(allClusters.flatMap(c => c.noteIds));
  const orphan = cards.filter(c => !claimed.has(c.noteId));
  if (orphan.length > 0) {
    allClusters.push({
      heading: 'Other',
      noteIds: orphan.map(c => c.noteId),
    });
  }

  // Stage 2: narrate each cluster with Opus. Run in parallel up to 4
  // at a time — each call is independent.
  const cardsByNoteId = new Map<string, ReportCard>();
  for (const c of cards) cardsByNoteId.set(c.noteId, c);

  const written: ReportClusterWritten[] = new Array(allClusters.length);
  const PAR = 4;
  let done = 0;
  let next = 0;
  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= allClusters.length) return;
      const cluster = allClusters[idx];
      const clusterCards = cluster.noteIds
        .map(id => cardsByNoteId.get(id))
        .filter((c): c is ReportCard => !!c);
      const narrative = await narrateCluster(client, kind, cluster.heading, clusterCards);
      written[idx] = { heading: cluster.heading, narrative, cards: clusterCards };
      done++;
      onProgress?.({ phase: 'narrate', section: heading, current: done, total: allClusters.length });
    }
  }
  await Promise.all(Array.from({ length: Math.min(PAR, allClusters.length) }, () => worker()));

  // Brief opening line for the section as a whole.
  const intro = await writeSectionIntro(client, kind, written);

  return {
    kind,
    heading,
    intro,
    clusters: written,
  };
}

async function enumerateClusters(
  client: Awaited<ReturnType<typeof makeAnthropicClient>>,
  kind: ReportSection['kind'],
  cards: ReportCard[],
): Promise<ReportCluster[]> {
  const cardLines = cards
    .map((c, i) => `[${i}] (${c.deckName}) ${c.front}\n    → ${c.back}`)
    .join('\n');
  const systemPrompt = `You group flashcards into topic clusters for a study report.

Rules:
  - 4–10 clusters per call. Fewer is fine; more is too noisy.
  - Each card belongs to exactly one cluster. Use the [N] index to refer to cards.
  - Cluster headings are short (2–6 words), specific, and concept-oriented. Not "Card 1 to 5" — name the actual concept.
  - Group by underlying concept / mechanism, not by deck name.
  - No meta words ("review", "list"). No em dashes. No first names. No years unless load-bearing.

Output JSON only, no prose, no fence:
{ "clusters": [ { "heading": "<short>", "indices": [<int>, <int>, ...] }, ... ] }`;

  const userContent = `Bucket type: ${kind}

CARDS:
${cardLines}

Group these per the rules. JSON only.`;

  const response = await client.messages.create({
    model: ENUMERATOR_MODEL,
    max_tokens: 4000,
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userContent }],
  });
  const text = response.content
    .map(b => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();
  const json = extractJson(text);
  const parsed = JSON.parse(json) as { clusters?: Array<{ heading?: string; indices?: number[] }> };
  const out: ReportCluster[] = [];
  for (const c of parsed.clusters ?? []) {
    if (!c.heading || !Array.isArray(c.indices)) continue;
    const noteIds: string[] = [];
    for (const idx of c.indices) {
      const card = cards[idx];
      if (card) noteIds.push(card.noteId);
    }
    if (noteIds.length > 0) {
      out.push({ heading: c.heading.trim(), noteIds });
    }
  }
  return out;
}

async function narrateCluster(
  client: Awaited<ReturnType<typeof makeAnthropicClient>>,
  kind: ReportSection['kind'],
  heading: string,
  cards: ReportCard[],
): Promise<string> {
  const cardLines = cards
    .map(c => `- ${c.front}\n    → ${c.back}${c.extra ? `\n    extra: ${c.extra}` : ''}`)
    .join('\n');
  const systemPrompt = `You write the prose narrative for a single cluster in a study report.

Style:
  - 2–4 sentences. Mechanism over narrative. Active voice.
  - Name the concept the cluster covers, then point out how the cards fit together (shared mechanism, sibling concepts, contrast, hierarchy).
  - When two cards in the cluster are obviously connected, say so explicitly.
  - For ${kind === 'trouble' ? 'a TROUBLE cluster: also briefly diagnose the likely failure mode (similar-looking concepts, weak cloze, overloaded fact).' : `a ${kind.toUpperCase()} cluster: keep the tone clean and informative — no praise, no commentary on the user's performance.`}
  - No meta words, no em dashes, no first names, no years unless load-bearing.
  - Output PLAIN PROSE. No headings, no bullets, no markdown.`;

  const userContent = `CLUSTER HEADING: ${heading}

CARDS:
${cardLines}

Write 2–4 sentences per the rules.`;

  const response = await client.messages.create({
    model: WRITER_MODEL,
    max_tokens: 600,
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userContent }],
  });
  return response.content.map(b => (b.type === 'text' ? b.text : '')).join('').trim();
}

async function writeSectionIntro(
  client: Awaited<ReturnType<typeof makeAnthropicClient>>,
  kind: ReportSection['kind'],
  clusters: ReportClusterWritten[],
): Promise<string> {
  const headings = clusters.map(c => c.heading).join(', ');
  const systemPrompt = `You write a one-sentence intro to a study-report section. Name the top-level topics, keep it terse, no preamble, no em dashes, no meta words. Output one plain sentence.`;
  const userContent = `Section kind: ${kind}
Cluster headings: ${headings}

Write the one-sentence intro.`;
  const response = await client.messages.create({
    model: WRITER_MODEL,
    max_tokens: 200,
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userContent }],
  });
  return response.content.map(b => (b.type === 'text' ? b.text : '')).join('').trim();
}

async function writeConnections(
  client: Awaited<ReturnType<typeof makeAnthropicClient>>,
  sections: ReportSection[],
): Promise<string> {
  const sectionLines = sections
    .map(s => `## ${s.heading}\n${s.clusters.map(c => `  - ${c.heading}: ${c.narrative}`).join('\n')}`)
    .join('\n\n');
  const systemPrompt = `You write the "Connections" closing paragraph of a study report. Identify 2–4 bridges across clusters or sections — places where two clusters' concepts depend on each other, contrast, or share a mechanism. Mechanism over name-dropping. 4–8 sentences total. No em dashes. No meta words. Output PLAIN PROSE only.`;
  const userContent = `SECTIONS:

${sectionLines}

Write the Connections paragraph.`;
  const response = await client.messages.create({
    model: WRITER_MODEL,
    max_tokens: 1000,
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userContent }],
  });
  return response.content.map(b => (b.type === 'text' ? b.text : '')).join('').trim();
}

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (fenced) return fenced[1].trim();
  const brace = text.indexOf('{');
  return brace >= 0 ? text.slice(brace) : text;
}
