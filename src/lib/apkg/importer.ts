import JSZip from 'jszip';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { decompress as zstdDecompress } from 'fzstd';
import { id as ulid } from '@/lib/ulid';
import { withBasePath } from '@/lib/basePath';
import type { Card, Deck, Media, Note } from '@/lib/db/schema';
import { emptyCard } from '@/lib/fsrs/scheduler';
import { mapFields, type AnkiModel } from './anki-models';
import { bulkImport } from '@/lib/db/queries';

export interface ImportProgress {
  phase: 'unzipping' | 'reading-sqlite' | 'parsing' | 'media' | 'saving' | 'done' | 'error';
  message: string;
  notesSeen?: number;
  cardsSeen?: number;
  mediaSeen?: number;
  error?: string;
}

let _SQL: SqlJsStatic | null = null;
async function loadSql(): Promise<SqlJsStatic> {
  if (_SQL) return _SQL;
  _SQL = await initSqlJs({
    // basePath-aware so the .wasm resolves under /cards/sql-wasm/ in prod.
    locateFile: (file: string) => withBasePath(`/sql-wasm/${file}`),
  });
  return _SQL;
}

const FIELD_SEPARATOR = '\x1f';

interface CollectionRow {
  models: Record<string, RawModel>;
  decks: Record<string, RawDeck>;
}

interface RawModel {
  id: number;
  name: string;
  type: number;
  flds: Array<{ name: string; ord: number }>;
}

interface RawDeck {
  id: number;
  name: string;
}

export interface ImportSummary {
  deckCount: number;
  noteCount: number;
  cardCount: number;
  mediaCount: number;
  primaryDeckId: string;
}

export async function importApkg(
  file: File | Blob,
  onProgress: (p: ImportProgress) => void = () => {},
): Promise<ImportSummary> {
  onProgress({ phase: 'unzipping', message: 'Unzipping…' });
  const zip = await JSZip.loadAsync(file);

  // Detect schema version. Anki ≤ 2.1 uses .anki2 / .anki21 (raw SQLite).
  // Anki 23.10+ uses .anki21b (zstd-compressed SQLite); we transparently
  // decompress so the user doesn't need to "switch to old schema" first.
  let dbBytes: Uint8Array;
  let isV3 = false;
  const rawDb = zip.file('collection.anki21') ?? zip.file('collection.anki2');
  if (rawDb) {
    onProgress({ phase: 'reading-sqlite', message: 'Reading SQLite…' });
    dbBytes = new Uint8Array(await rawDb.async('uint8array'));
  } else {
    const compressed = zip.file('collection.anki21b');
    if (!compressed) throw new Error('No collection database found in .apkg.');
    onProgress({ phase: 'reading-sqlite', message: 'Decompressing zstd-encoded collection…' });
    const compressedBytes = new Uint8Array(await compressed.async('uint8array'));
    dbBytes = zstdDecompress(compressedBytes);
    isV3 = true;
  }

  const SQL = await loadSql();
  const sqlite: Database = new SQL.Database(dbBytes);

  // col table is one row; models and decks are JSON.
  const colRows = sqlite.exec('SELECT models, decks FROM col LIMIT 1');
  if (!colRows.length) throw new Error('Empty `col` table; not a valid Anki collection.');
  const [modelsJson, decksJson] = colRows[0].values[0] as [string, string];
  const collection: CollectionRow = {
    models: JSON.parse(modelsJson),
    decks: JSON.parse(decksJson),
  };

  onProgress({ phase: 'parsing', message: 'Reading notes & cards…' });

  // Build deck map: Anki did → our Deck
  const deckMap = new Map<string, Deck>();
  const t = Date.now();
  for (const rawId of Object.keys(collection.decks)) {
    const raw = collection.decks[rawId];
    if (raw.name === 'Default' && Object.keys(collection.decks).length > 1) continue; // skip default if other decks exist
    const deck: Deck = {
      id: ulid(),
      name: raw.name,
      createdAt: t,
      modifiedAt: t,
    };
    deckMap.set(String(raw.id), deck);
  }
  // If no decks except Default, keep it.
  if (deckMap.size === 0) {
    const fallback: Deck = {
      id: ulid(),
      name: 'Imported',
      createdAt: t,
      modifiedAt: t,
    };
    deckMap.set('1', fallback);
  }

  // Build model map
  const modelMap = new Map<string, AnkiModel>();
  for (const rawId of Object.keys(collection.models)) {
    const raw = collection.models[rawId];
    modelMap.set(String(raw.id), {
      id: String(raw.id),
      name: raw.name,
      type: raw.type,
      flds: raw.flds.map(f => ({ name: f.name, ord: f.ord })),
    });
  }

  // Read notes
  const notesRes = sqlite.exec('SELECT id, mid, tags, flds FROM notes');
  const ankiNotes: { id: string; mid: string; tags: string; flds: string }[] = [];
  if (notesRes.length) {
    for (const row of notesRes[0].values) {
      const [id, mid, tags, flds] = row as [number | bigint, number | bigint, string, string];
      ankiNotes.push({ id: String(id), mid: String(mid), tags, flds });
    }
  }
  // Anki's note.id is the creation timestamp (ms since epoch) and increases
  // monotonically with authoring order. Sort by it so we can hand each note
  // a sequential index → preserves the deck's authoring order in our
  // createdAt-based picker. Use BigInt because ids overflow JS Number safe-int.
  ankiNotes.sort((a, b) => {
    const av = BigInt(a.id), bv = BigInt(b.id);
    return av < bv ? -1 : av > bv ? 1 : 0;
  });

  // Read cards
  const cardsRes = sqlite.exec('SELECT id, nid, did, ord FROM cards');
  const ankiCards: { id: string; nid: string; did: string; ord: number }[] = [];
  if (cardsRes.length) {
    for (const row of cardsRes[0].values) {
      const [id, nid, did, ord] = row as [number | bigint, number | bigint, number | bigint, number];
      ankiCards.push({ id: String(id), nid: String(nid), did: String(did), ord: Number(ord) });
    }
  }
  sqlite.close();

  // Convert
  const notesByAnkiId = new Map<string, Note>();
  const cards: Card[] = [];
  const empty = emptyCard(new Date(t));

  // Determine the deck for each note from its first card; if no cards, skip.
  const cardsByNid = new Map<string, typeof ankiCards>();
  for (const c of ankiCards) {
    let bucket = cardsByNid.get(c.nid);
    if (!bucket) { bucket = []; cardsByNid.set(c.nid, bucket); }
    bucket.push(c);
  }

  // Width of one note's "slot" in createdAt-space. 1000 leaves room for
  // sibling cards (cloze ords) without colliding with the next note's slot.
  // No real Anki note has 1000 cards.
  const SLOT = 1000;
  let noteIndex = 0;

  for (const an of ankiNotes) {
    const model = modelMap.get(an.mid);
    if (!model) continue;
    const ankiCardsForNote = cardsByNid.get(an.id);
    if (!ankiCardsForNote || ankiCardsForNote.length === 0) continue;

    // The deck of the note = the deck of its first card. (Anki cards from the same
    // note can in theory live in different decks; rare in practice; we collapse.)
    const firstCard = ankiCardsForNote[0];
    const deck = deckMap.get(firstCard.did) ?? [...deckMap.values()][0];
    if (!deck) continue;

    const fieldValues = an.flds.split(FIELD_SEPARATOR);
    const mapped = mapFields(model, fieldValues);

    // Sequential createdAt — preserves authoring order. Cards of this note
    // get adjacent slots so siblings stay together when sorted.
    const noteCreatedAt = t + noteIndex * SLOT;

    const note: Note = {
      id: ulid(),
      deckId: deck.id,
      modelId: model.type === 1 ? 'cloze' : 'basic',
      fields: mapped,
      tags: (an.tags ?? '').split(/\s+/).map(s => s.trim()).filter(Boolean),
      ankiNoteId: an.id,
      createdAt: noteCreatedAt,
      modifiedAt: noteCreatedAt,
    };
    notesByAnkiId.set(an.id, note);

    for (const ac of ankiCardsForNote) {
      cards.push({
        id: ulid(),
        noteId: note.id,
        deckId: deck.id,
        clozeOrd: model.type === 1 ? ac.ord + 1 : undefined, // 0-indexed → 1-indexed for our renderer
        ...empty,
        suspended: false,
        buried: false,
        createdAt: noteCreatedAt + ac.ord,
        modifiedAt: noteCreatedAt + ac.ord,
      });
    }

    noteIndex++;
    if (notesByAnkiId.size % 200 === 0) {
      onProgress({
        phase: 'parsing',
        message: 'Parsing notes & cards…',
        notesSeen: notesByAnkiId.size,
        cardsSeen: cards.length,
      });
    }
  }

  // Read media
  onProgress({
    phase: 'media',
    message: 'Loading media…',
    notesSeen: notesByAnkiId.size,
    cardsSeen: cards.length,
  });
  const mediaIndex = await readMediaIndex(zip, isV3);
  const media: Media[] = [];
  let mediaSeen = 0;
  for (const [numericName, filename] of Object.entries(mediaIndex)) {
    const f = zip.file(numericName);
    if (!f) continue;
    let blob: Blob;
    if (isV3) {
      // Individual media files are zstd-compressed in v3.
      const compressed = new Uint8Array(await f.async('uint8array'));
      try {
        const decompressed = zstdDecompress(compressed);
        // Copy into a fresh ArrayBuffer so the BlobPart type is concrete.
        const buf = new ArrayBuffer(decompressed.byteLength);
        new Uint8Array(buf).set(decompressed);
        blob = new Blob([buf], { type: guessMime(filename) });
      } catch {
        blob = await f.async('blob');
      }
    } else {
      blob = await f.async('blob');
    }
    // JSZip's async('blob') returns a Blob whose `.type` is often empty
    // because the apkg stores media under numeric zip entries (no
    // extension to infer from). Re-wrap with the right MIME so the Blob
    // itself carries the correct type — this is what `URL.createObjectURL`
    // serves to `<img>` tags.
    const mime = guessMime(filename);
    if (blob.type !== mime) {
      blob = new Blob([blob], { type: mime });
    }
    media.push({
      id: ulid(),
      filename,
      mimeType: mime,
      blob,
    });
    mediaSeen++;
    if (mediaSeen % 50 === 0) {
      onProgress({
        phase: 'media',
        message: 'Loading media…',
        notesSeen: notesByAnkiId.size,
        cardsSeen: cards.length,
        mediaSeen,
      });
    }
  }

  onProgress({
    phase: 'saving',
    message: 'Writing to local database…',
    notesSeen: notesByAnkiId.size,
    cardsSeen: cards.length,
    mediaSeen: media.length,
  });

  await bulkImport({
    decks: [...deckMap.values()],
    notes: [...notesByAnkiId.values()],
    cards,
    media,
  });

  // Heuristic primary deck = the one with the most cards.
  const cardCountByDeck = new Map<string, number>();
  for (const c of cards) {
    cardCountByDeck.set(c.deckId, (cardCountByDeck.get(c.deckId) ?? 0) + 1);
  }
  let primaryDeckId = [...deckMap.values()][0].id;
  let max = 0;
  for (const [d, n] of cardCountByDeck) {
    if (n > max) { max = n; primaryDeckId = d; }
  }

  onProgress({
    phase: 'done',
    message: 'Done.',
    notesSeen: notesByAnkiId.size,
    cardsSeen: cards.length,
    mediaSeen: media.length,
  });

  return {
    deckCount: deckMap.size,
    noteCount: notesByAnkiId.size,
    cardCount: cards.length,
    mediaCount: media.length,
    primaryDeckId,
  };
}

/**
 * Read the .apkg media index. v1/v2: plain JSON map of "0" → filename.
 * v3 (Anki 23.10+): zstd-compressed JSON OR a protobuf-encoded MediaEntries
 * message. We attempt zstd-decompress first, then JSON-parse, falling back
 * to a structural parse for the protobuf case.
 */
export async function readMediaIndex(zip: JSZip, isV3: boolean): Promise<Record<string, string>> {
  const f = zip.file('media');
  if (!f) return {};
  const raw = new Uint8Array(await f.async('uint8array'));

  if (!isV3) {
    return safeJsonParse(new TextDecoder().decode(raw));
  }

  // v3: try zstd-decompress, then parse.
  let decoded: Uint8Array;
  try {
    decoded = zstdDecompress(raw);
  } catch {
    decoded = raw;
  }

  // Some v3 packages still ship JSON; try that first.
  const text = new TextDecoder().decode(decoded);
  if (text.startsWith('{')) return safeJsonParse(text);

  // Fall back to a tolerant protobuf-ish scan extracting numeric-name pairs.
  return parseMediaProtobuf(decoded);
}

function safeJsonParse(s: string): Record<string, string> {
  try { return JSON.parse(s) as Record<string, string>; } catch { return {}; }
}

/**
 * Tolerant scan of Anki's protobuf-encoded MediaEntries (proto3, no schema
 * needed). Extracts the (zip-name, filename) pairs that we actually need —
 * anything else is ignored.
 */
function parseMediaProtobuf(bytes: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  let entryIdx = 0;
  let i = 0;
  while (i < bytes.length) {
    // Top-level field: tag varint.
    const [topTag, after1] = readVarint(bytes, i);
    if (after1 < 0) break;
    i = after1;
    const wireType = topTag & 7;
    if (wireType !== 2) { // we only expect length-delimited entries
      const skip = skipField(bytes, i, wireType);
      if (skip < 0) break;
      i = skip;
      continue;
    }
    const [entryLen, afterLen] = readVarint(bytes, i);
    if (afterLen < 0) break;
    const entryBytes = bytes.subarray(afterLen, afterLen + entryLen);
    i = afterLen + entryLen;

    // Inside each entry, scan for the first string-valued field as the name.
    let name: string | null = null;
    let j = 0;
    while (j < entryBytes.length) {
      const [innerTag, afterInner] = readVarint(entryBytes, j);
      if (afterInner < 0) break;
      const innerWire = innerTag & 7;
      j = afterInner;
      if (innerWire === 2) {
        const [strLen, afterStr] = readVarint(entryBytes, j);
        if (afterStr < 0) break;
        const sBytes = entryBytes.subarray(afterStr, afterStr + strLen);
        j = afterStr + strLen;
        const s = new TextDecoder().decode(sBytes);
        if (s && name === null) {
          name = s;
          break; // we treat the first string field as the filename
        }
      } else {
        const skip = skipField(entryBytes, j, innerWire);
        if (skip < 0) break;
        j = skip;
      }
    }
    if (name) out[String(entryIdx)] = name;
    entryIdx++;
  }
  return out;
}

/**
 * Reads a Protobuf varint as a regular Number. Anki's MediaEntries varints
 * (entry counts, string lengths) all fit comfortably under 2^53, so plain
 * Number arithmetic is safe and avoids BigInt's ES2020 dependency.
 */
function readVarint(bytes: Uint8Array, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  let i = offset;
  while (i < bytes.length) {
    const b = bytes[i++];
    result += (b & 0x7f) * Math.pow(2, shift);
    if ((b & 0x80) === 0) return [result, i];
    shift += 7;
    if (shift > 49) return [0, -1]; // bail before losing precision
  }
  return [0, -1];
}

function skipField(bytes: Uint8Array, offset: number, wireType: number): number {
  switch (wireType) {
    case 0: { const [, end] = readVarint(bytes, offset); return end; }
    case 1: return offset + 8;
    case 2: {
      const [len, after] = readVarint(bytes, offset);
      if (after < 0) return -1;
      return after + len;
    }
    case 5: return offset + 4;
    default: return -1;
  }
}

export function guessMime(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'svg': return 'image/svg+xml';
    case 'webp': return 'image/webp';
    case 'bmp': return 'image/bmp';
    case 'mp3': return 'audio/mpeg';
    case 'ogg': return 'audio/ogg';
    case 'wav': return 'audio/wav';
    case 'm4a': return 'audio/mp4';
    case 'mp4': return 'video/mp4';
    case 'webm': return 'video/webm';
    default: return 'application/octet-stream';
  }
}
