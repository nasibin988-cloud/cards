/**
 * End-to-end report run: gather → write → render PDF → OPFS archive.
 *
 * All-in-one entry so the UI just calls one function per report type
 * with a progress callback and a Blob arrives at the end. PDF lands in
 * the user's downloads + survives in OPFS under cards-reports/ so they
 * can scroll back through past days without regenerating.
 */

import { pdf } from '@react-pdf/renderer';
import { gatherDailyActivity, gatherDecksForOverview, type ReportData } from './gather';
import { writeReport, type ReportDoc, type WriteProgress } from './write';
import { ReportPdf } from './pdf';

export type GenerateProgress =
  | { phase: 'gather'; message: string }
  | (WriteProgress & { message: string })
  | { phase: 'render'; message: string }
  | { phase: 'archive'; message: string }
  | { phase: 'done'; message: string };

export interface GeneratedReport {
  doc: ReportDoc;
  blob: Blob;
  filename: string;
  /** OPFS path (relative to the origin's directory root). null if OPFS
   *  unavailable on this browser. */
  opfsPath: string | null;
}

export interface GenerateOptions {
  onProgress?: (p: GenerateProgress) => void;
  signal?: AbortSignal;
}

export async function generateDailyReport(opts: GenerateOptions = {}): Promise<GeneratedReport> {
  return generate('daily', undefined, opts);
}

export async function generateDeckReport(deckIds: string[], opts: GenerateOptions = {}): Promise<GeneratedReport> {
  return generate('deck', deckIds, opts);
}

async function generate(
  kind: 'daily' | 'deck',
  deckIds: string[] | undefined,
  opts: GenerateOptions,
): Promise<GeneratedReport> {
  const { onProgress, signal } = opts;
  const throwIfAborted = () => {
    if (signal?.aborted) throw new Error('Report generation cancelled.');
  };

  onProgress?.({ phase: 'gather', message: 'Pulling cards…' });
  let data: ReportData;
  if (kind === 'daily') {
    data = await gatherDailyActivity();
  } else if (deckIds && deckIds.length > 0) {
    data = await gatherDecksForOverview(deckIds);
  } else {
    throw new Error('No decks selected for the report.');
  }
  throwIfAborted();

  // Early-out for daily-with-nothing: a study session that wrote zero
  // logs today shouldn't burn an Opus run.
  if (
    kind === 'daily'
    && data.learnedToday.length === 0
    && data.reviewedToday.length === 0
    && data.trouble.length === 0
  ) {
    throw new Error("No reviews logged today yet. Study something first.");
  }
  if (kind === 'deck' && data.fullDeckScope.length === 0) {
    throw new Error('Selected deck(s) have no cards.');
  }

  const doc = await writeReport(data, (wp) => {
    const msg = wp.section
      ? `${wp.section}: ${wp.phase} ${wp.current ?? ''}${wp.total ? `/${wp.total}` : ''}`
      : wp.phase;
    onProgress?.({ ...wp, message: msg } as GenerateProgress);
    throwIfAborted();
  });

  onProgress?.({ phase: 'render', message: 'Rendering PDF…' });
  // @react-pdf/renderer's pdf() wants the root Document element directly,
  // not a wrapping FunctionComponent. ReportPdf returns the <Document>,
  // so we render it once via createElement and call its render function
  // to obtain that root element.
  //
  // In practice we just hand pdf() the result of calling ReportPdf as a
  // function — bypassing React render entirely because @react-pdf's
  // pipeline does its own rendering internally.
  const rootElement = ReportPdf({ doc }) as unknown as Parameters<typeof pdf>[0];
  const blob = await pdf(rootElement).toBlob();
  throwIfAborted();

  const stamp = new Date(doc.generatedAt).toISOString().split('T')[0];
  const slug = kind === 'daily'
    ? `daily-${stamp}`
    : `deck-${stamp}-${slugify(doc.subtitle)}`;
  const filename = `cards-report-${slug}.pdf`;

  onProgress?.({ phase: 'archive', message: 'Saving to OPFS…' });
  const opfsPath = await tryArchive(blob, filename);

  onProgress?.({ phase: 'done', message: 'Done.' });
  return { doc, blob, filename, opfsPath };
}

async function tryArchive(blob: Blob, filename: string): Promise<string | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('cards-reports', { create: true });
    const file = await dir.getFileHandle(filename, { create: true });
    const w = await file.createWritable();
    await w.write(blob);
    await w.close();
    return `cards-reports/${filename}`;
  } catch {
    return null;
  }
}

function slugify(s: string): string {
  return s.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'report';
}

/** Browse the OPFS archive — used by the reports listing UI. */
export interface ArchivedReport {
  filename: string;
  size: number;
  modified: number;
}

export async function listArchivedReports(): Promise<ArchivedReport[]> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return [];
  try {
    const root = await navigator.storage.getDirectory();
    let dir;
    try {
      dir = await root.getDirectoryHandle('cards-reports', { create: false });
    } catch {
      return [];
    }
    const out: ArchivedReport[] = [];
    // OPFS iterator type is browser-private; cast to any to avoid the
    // dance with downloading types we don't ship.
    for await (const [name, handle] of (dir as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
      if (handle.kind !== 'file' || !name.endsWith('.pdf')) continue;
      const f = await (handle as FileSystemFileHandle).getFile();
      out.push({ filename: name, size: f.size, modified: f.lastModified });
    }
    out.sort((a, b) => b.modified - a.modified);
    return out;
  } catch {
    return [];
  }
}

export async function readArchivedReport(filename: string): Promise<Blob | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('cards-reports', { create: false });
    const file = await dir.getFileHandle(filename, { create: false });
    return await (await file.getFile()).slice();
  } catch {
    return null;
  }
}

/** Trigger a download of the in-memory blob. Used right after generate. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a beat to consume the URL before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
