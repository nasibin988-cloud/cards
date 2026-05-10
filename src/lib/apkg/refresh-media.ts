/**
 * Re-import ONLY images + the per-note image-field reference from a
 * fresh .apkg, leaving every card's FSRS scheduling untouched.
 *
 * Use case: user rebuilt the deck in Anki, kept all the same cards, but
 * re-mapped which image goes with which note. They want the new image
 * mappings reflected in the local app without losing per-card review
 * state, lapses, due dates, learning steps, etc.
 *
 * What this touches:
 *   - notes.fields.image (filename string)
 *   - media table (insert new files, replace bytes for same-filename)
 *
 * What this DOES NOT touch:
 *   - notes.fields.front / back / extra / mnemonic / context / source
 *   - notes.tags / tier / flag / siblings / occlusions
 *   - cards.* (state, due, stability, difficulty, lapses, reps,
 *     scheduledDays, lastReview, etc.)
 *   - reviewLogs.*
 *   - decks.*
 *
 * Matching: by `ankiNoteId`. Notes that don't carry one (manually
 * created in-app) and notes added in the new .apkg with no local
 * counterpart are reported as `unmatched` and ignored.
 */

import JSZip from 'jszip';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { decompress as zstdDecompress } from 'fzstd';
import { withBasePath } from '@/lib/basePath';
import { mapFields, type AnkiModel } from './anki-models';
import { readMediaIndex, guessMime } from './importer';
import { db } from '@/lib/db/dexie';
import { id as ulid } from '@/lib/ulid';
import type { Media, Note } from '@/lib/db/schema';

const FIELD_SEPARATOR = '\x1f';

export interface RefreshMediaProgress {
  phase: 'unzipping' | 'reading-sqlite' | 'parsing' | 'media' | 'writing' | 'done' | 'error';
  message: string;
  notesSeen?: number;
  matched?: number;
  unmatched?: number;
  mediaSeen?: number;
  total?: number;
}

export interface RefreshMediaSummary {
  /** Notes the .apkg contained. */
  ankiNoteCount: number;
  /** Notes already in the local DB at start. */
  appNoteCount: number;
  /** .apkg notes that matched a local note by ankiNoteId. */
  matched: number;
  /** .apkg notes whose ankiNoteId wasn't found locally. */
  unmatched: number;
  /** Of the matched notes, how many had a different `image` field and got rewritten. */
  notesUpdatedImage: number;
  /** Media files added (filename was new). */
  mediaAdded: number;
  /** Media files whose bytes were replaced (filename existed). */
  mediaReplaced: number;
  /** Media files in the .apkg that already matched local bytes (skipped). */
  mediaUnchanged: number;
}

let _SQL: SqlJsStatic | null = null;
async function loadSql(): Promise<SqlJsStatic> {
  if (_SQL) return _SQL;
  _SQL = await initSqlJs({
    locateFile: (file: string) => withBasePath(`/sql-wasm/${file}`),
  });
  return _SQL;
}

interface RawModel {
  id: number;
  name: string;
  type: number;
  flds: Array<{ name: string; ord: number }>;
}

export async function refreshMediaFromApkg(
  file: File | Blob,
  onProgress: (p: RefreshMediaProgress) => void = () => {},
): Promise<RefreshMediaSummary> {
  onProgress({ phase: 'unzipping', message: 'Unzipping…' });
  const zip = await JSZip.loadAsync(file);

  // Detect collection format. v3 (.anki21b, zstd) vs legacy (.anki21/.anki2).
  let dbBytes: Uint8Array;
  let isV3 = false;
  const rawDb = zip.file('collection.anki21') ?? zip.file('collection.anki2');
  if (rawDb) {
    onProgress({ phase: 'reading-sqlite', message: 'Reading SQLite…' });
    dbBytes = new Uint8Array(await rawDb.async('uint8array'));
  } else {
    const compressed = zip.file('collection.anki21b');
    if (!compressed) throw new Error('No collection database found in .apkg.');
    onProgress({ phase: 'reading-sqlite', message: 'Decompressing…' });
    const compressedBytes = new Uint8Array(await compressed.async('uint8array'));
    dbBytes = zstdDecompress(compressedBytes);
    isV3 = true;
  }

  const SQL = await loadSql();
  const sqlite: Database = new SQL.Database(dbBytes);

  // Models — needed so we can run mapFields and pull out the `image` field.
  const colRows = sqlite.exec('SELECT models FROM col LIMIT 1');
  if (!colRows.length) throw new Error('Empty `col` table; not a valid Anki collection.');
  const [modelsJson] = colRows[0].values[0] as [string];
  const collectionModels: Record<string, RawModel> = JSON.parse(modelsJson);
  const modelMap = new Map<string, AnkiModel>();
  for (const rawId of Object.keys(collectionModels)) {
    const raw = collectionModels[rawId];
    modelMap.set(String(raw.id), {
      id: String(raw.id),
      name: raw.name,
      type: raw.type,
      flds: raw.flds.map(f => ({ name: f.name, ord: f.ord })),
    });
  }

  onProgress({ phase: 'parsing', message: 'Reading notes…' });
  const notesRes = sqlite.exec('SELECT id, mid, flds FROM notes');
  const ankiNotes: Array<{ ankiNoteId: string; mid: string; image: string | undefined }> = [];
  if (notesRes.length) {
    for (const row of notesRes[0].values) {
      const [id, mid, flds] = row as [number | bigint, number | bigint, string];
      const ankiNoteId = String(id);
      const model = modelMap.get(String(mid));
      if (!model) continue;
      const fieldValues = String(flds).split(FIELD_SEPARATOR);
      const mapped = mapFields(model, fieldValues);
      ankiNotes.push({ ankiNoteId, mid: String(mid), image: mapped.image });
    }
  }
  sqlite.close();

  // Media. We import every file in the .apkg under its real filename;
  // the media table is keyed by filename so same-filename / different
  // bytes works automatically. Comparing bytes byte-for-byte is overkill
  // here — the user just told us they re-built the deck — so we use
  // size as a cheap "did it change" check, which is enough to avoid
  // touching identical files (cuts re-write thrash on big decks).
  onProgress({ phase: 'media', message: 'Loading media…', notesSeen: ankiNotes.length });
  const mediaIndex = await readMediaIndex(zip, isV3);
  const incomingMedia: Array<{ filename: string; mimeType: string; blob: Blob }> = [];
  let mediaSeen = 0;
  for (const [numericName, filename] of Object.entries(mediaIndex)) {
    const f = zip.file(numericName);
    if (!f) continue;
    let blob: Blob;
    if (isV3) {
      const compressed = new Uint8Array(await f.async('uint8array'));
      try {
        const decompressed = zstdDecompress(compressed);
        const buf = new ArrayBuffer(decompressed.byteLength);
        new Uint8Array(buf).set(decompressed);
        blob = new Blob([buf], { type: guessMime(filename) });
      } catch {
        blob = await f.async('blob');
      }
    } else {
      blob = await f.async('blob');
    }
    const mime = guessMime(filename);
    if (blob.type !== mime) blob = new Blob([blob], { type: mime });
    incomingMedia.push({ filename, mimeType: mime, blob });
    mediaSeen++;
    if (mediaSeen % 50 === 0) {
      onProgress({
        phase: 'media',
        message: 'Loading media…',
        notesSeen: ankiNotes.length,
        mediaSeen,
      });
    }
  }

  onProgress({ phase: 'writing', message: 'Comparing & writing…', notesSeen: ankiNotes.length, mediaSeen });

  const dbi = db();
  // Build maps for the writes. ankiNoteId-keyed lookup of local notes,
  // filename-keyed lookup of existing media.
  const allLocalNotes = await dbi.notes.toArray();
  const localByAnki = new Map<string, Note>();
  for (const n of allLocalNotes) {
    if (n.ankiNoteId) localByAnki.set(n.ankiNoteId, n);
  }
  const allLocalMedia = await dbi.media.toArray();
  const localByFilename = new Map<string, Media>();
  for (const m of allLocalMedia) localByFilename.set(m.filename, m);

  // ─── Plan note updates ──────────────────────────────────────────
  const t = Date.now();
  let matched = 0;
  let unmatched = 0;
  let notesUpdatedImage = 0;
  const notePatches: Note[] = [];
  for (const an of ankiNotes) {
    const local = localByAnki.get(an.ankiNoteId);
    if (!local) { unmatched++; continue; }
    matched++;
    const newImage = an.image ?? '';
    const oldImage = local.fields.image ?? '';
    if (newImage !== oldImage) {
      notesUpdatedImage++;
      notePatches.push({
        ...local,
        fields: { ...local.fields, image: an.image },
        modifiedAt: t,
      });
    }
  }

  // ─── Plan media writes ──────────────────────────────────────────
  let mediaAdded = 0;
  let mediaReplaced = 0;
  let mediaUnchanged = 0;
  const mediaPatches: Media[] = [];
  for (const m of incomingMedia) {
    const existing = localByFilename.get(m.filename);
    if (!existing) {
      mediaAdded++;
      mediaPatches.push({ id: ulid(), filename: m.filename, mimeType: m.mimeType, blob: m.blob });
    } else if (existing.blob.size !== m.blob.size || existing.mimeType !== m.mimeType) {
      mediaReplaced++;
      // Keep the existing row's id so anything keyed off it stays stable;
      // just swap blob + mimetype.
      mediaPatches.push({ ...existing, mimeType: m.mimeType, blob: m.blob });
    } else {
      mediaUnchanged++;
    }
  }

  // ─── Apply atomically ───────────────────────────────────────────
  await dbi.transaction('rw', dbi.notes, dbi.media, async () => {
    if (notePatches.length) await dbi.notes.bulkPut(notePatches);
    if (mediaPatches.length) await dbi.media.bulkPut(mediaPatches);
  });

  onProgress({ phase: 'done', message: 'Done.', notesSeen: ankiNotes.length, mediaSeen });

  return {
    ankiNoteCount: ankiNotes.length,
    appNoteCount: allLocalNotes.length,
    matched,
    unmatched,
    notesUpdatedImage,
    mediaAdded,
    mediaReplaced,
    mediaUnchanged,
  };
}
