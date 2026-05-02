/**
 * Anki .apkg exporter. Builds a collection.anki2 SQLite database (legacy
 * schema; widely supported by Anki Desktop and most third-party tools) plus
 * the media archive in a single .apkg zip.
 *
 * Strategy: assemble notes/cards/decks/models JSON in the formats Anki
 * expects, then SQL-bulk-insert and emit the zipped database.
 *
 * For round-trip safety we map our internal schema BACK to Anki's:
 *   - basic notes → "Basic" model (Front + Back)
 *   - cloze notes → "Cloze" model (Text + Back Extra)
 *   - image-occlusion notes → "Basic" model with image filename in Front
 *     (Anki has no native equivalent of our occlusion data; preserved as a
 *     plain image card)
 */

import JSZip from 'jszip';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { db } from '@/lib/db/dexie';
import { renderPlain } from '@/lib/cloze/parser';
import { withBasePath } from '@/lib/basePath';

let _SQL: SqlJsStatic | null = null;
async function loadSql(): Promise<SqlJsStatic> {
  if (_SQL) return _SQL;
  // sql.js's locateFile resolves the .wasm URL — needs to honor basePath
  // so the file is found under /cards/sql-wasm/ in production.
  _SQL = await initSqlJs({ locateFile: (file: string) => withBasePath(`/sql-wasm/${file}`) });
  return _SQL;
}

const FIELD_SEPARATOR = '\x1f';

/** Anki schema constants. We match the V11 schema used by collection.anki2. */
const SCHEMA_SQL = `
CREATE TABLE col (
  id INTEGER PRIMARY KEY,
  crt INTEGER NOT NULL,
  mod INTEGER NOT NULL,
  scm INTEGER NOT NULL,
  ver INTEGER NOT NULL,
  dty INTEGER NOT NULL,
  usn INTEGER NOT NULL,
  ls INTEGER NOT NULL,
  conf TEXT NOT NULL,
  models TEXT NOT NULL,
  decks TEXT NOT NULL,
  dconf TEXT NOT NULL,
  tags TEXT NOT NULL
);
CREATE TABLE notes (
  id INTEGER PRIMARY KEY,
  guid TEXT NOT NULL,
  mid INTEGER NOT NULL,
  mod INTEGER NOT NULL,
  usn INTEGER NOT NULL,
  tags TEXT NOT NULL,
  flds TEXT NOT NULL,
  sfld INTEGER NOT NULL,
  csum INTEGER NOT NULL,
  flags INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE cards (
  id INTEGER PRIMARY KEY,
  nid INTEGER NOT NULL,
  did INTEGER NOT NULL,
  ord INTEGER NOT NULL,
  mod INTEGER NOT NULL,
  usn INTEGER NOT NULL,
  type INTEGER NOT NULL,
  queue INTEGER NOT NULL,
  due INTEGER NOT NULL,
  ivl INTEGER NOT NULL,
  factor INTEGER NOT NULL,
  reps INTEGER NOT NULL,
  lapses INTEGER NOT NULL,
  left INTEGER NOT NULL,
  odue INTEGER NOT NULL,
  odid INTEGER NOT NULL,
  flags INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE revlog (
  id INTEGER PRIMARY KEY,
  cid INTEGER NOT NULL,
  usn INTEGER NOT NULL,
  ease INTEGER NOT NULL,
  ivl INTEGER NOT NULL,
  lastIvl INTEGER NOT NULL,
  factor INTEGER NOT NULL,
  time INTEGER NOT NULL,
  type INTEGER NOT NULL
);
CREATE TABLE graves (usn INTEGER NOT NULL, oid INTEGER NOT NULL, type INTEGER NOT NULL);
CREATE INDEX ix_notes_usn ON notes (usn);
CREATE INDEX ix_cards_usn ON cards (usn);
CREATE INDEX ix_revlog_usn ON revlog (usn);
CREATE INDEX ix_cards_nid ON cards (nid);
CREATE INDEX ix_cards_sched ON cards (did, queue, due);
CREATE INDEX ix_revlog_cid ON revlog (cid);
CREATE INDEX ix_notes_csum ON notes (csum);
`;

const BASIC_MODEL_ID = 1607392319000;
const CLOZE_MODEL_ID = 1607392319001;

function basicModel() {
  return {
    id: BASIC_MODEL_ID,
    name: 'Basic',
    type: 0,
    mod: 0,
    usn: 0,
    sortf: 0,
    did: 1,
    tmpls: [{
      name: 'Card 1', ord: 0, qfmt: '{{Front}}', afmt: '{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}',
      did: null, bqfmt: '', bafmt: '',
    }],
    flds: [
      { name: 'Front', ord: 0, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] },
      { name: 'Back',  ord: 1, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] },
    ],
    css: '.card { font-family: arial; font-size: 20px; text-align: center; color: black; background-color: white; }',
    latexPre: '', latexPost: '\\end{document}', latexsvg: false,
    req: [[0, 'any', [0]]],
    vers: [],
    tags: [],
  };
}

function clozeModel() {
  return {
    id: CLOZE_MODEL_ID,
    name: 'Cloze',
    type: 1,
    mod: 0,
    usn: 0,
    sortf: 0,
    did: 1,
    tmpls: [{
      name: 'Cloze', ord: 0,
      qfmt: '{{cloze:Text}}',
      afmt: '{{cloze:Text}}<br>\n{{Back Extra}}',
      did: null, bqfmt: '', bafmt: '',
    }],
    flds: [
      { name: 'Text',       ord: 0, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] },
      { name: 'Back Extra', ord: 1, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] },
    ],
    css: '.card { font-family: arial; font-size: 20px; text-align: center; color: black; background-color: white; }',
    latexPre: '', latexPost: '\\end{document}', latexsvg: false,
    req: [[0, 'any', [0]]],
    vers: [],
    tags: [],
  };
}

function defaultDeckConf() {
  return {
    1: {
      id: 1, name: 'Default',
      replayq: true,
      lapse: { delays: [10], leechAction: 0, leechFails: 8, minInt: 1, mult: 0 },
      rev: { perDay: 200, ease4: 1.3, fuzz: 0.05, minSpace: 1, ivlFct: 1, maxIvl: 36500, bury: false, hardFactor: 1.2 },
      timer: 0, maxTaken: 60, usn: 0, new: { perDay: 20, delays: [1, 10], separate: true, ints: [1, 4, 7], initialFactor: 2500, bury: false, order: 1 },
      mod: 0, autoplay: true, dyn: 0,
    },
  };
}

function defaultColConf() {
  return {
    activeDecks: [1],
    addToCur: true,
    collapseTime: 1200,
    curDeck: 1,
    curModel: '1607392319000',
    dueCounts: true,
    estTimes: true,
    newBury: true,
    newSpread: 0,
    nextPos: 1,
    sortBackwards: false,
    sortType: 'noteFld',
    timeLim: 0,
  };
}

function fieldChecksum(s: string): number {
  // Anki uses a SHA-1 truncated to 8 hex chars. We approximate with a simple
  // 31-bit hash; Anki accepts any integer; the `csum` field is non-load-bearing
  // for round-trip imports.
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export interface ExportProgress {
  phase: 'building' | 'saving' | 'done';
  message: string;
}

/**
 * Export a deck (or all decks if `deckId` is undefined) as an .apkg blob.
 * Preserves card scheduling state in `data` JSON (unsupported by stock Anki
 * but used by FSRS-aware Anki forks; otherwise a fresh import).
 */
export async function exportApkg(
  deckId?: string,
  onProgress: (p: ExportProgress) => void = () => {},
): Promise<Blob> {
  onProgress({ phase: 'building', message: 'Reading data…' });

  const dbi = db();
  const allDecks = await dbi.decks.toArray();
  const exportedDecks = deckId ? allDecks.filter(d => d.id === deckId) : allDecks;

  const exportedDeckIds = new Set(exportedDecks.map(d => d.id));
  const allNotes = (await dbi.notes.toArray()).filter(n => exportedDeckIds.has(n.deckId));
  const noteIds = new Set(allNotes.map(n => n.id));
  const allCards = (await dbi.cards.toArray()).filter(c => noteIds.has(c.noteId));
  const allMedia = await dbi.media.toArray();

  const SQL = await loadSql();
  const sqlite: Database = new SQL.Database();
  sqlite.run(SCHEMA_SQL);

  // Decks JSON: numeric ids; reserve 1 for Default.
  const deckIdMap = new Map<string, number>();
  const decksJson: Record<string, unknown> = {
    1: { id: 1, name: 'Default', mod: 0, usn: 0, lrnToday: [0, 0], revToday: [0, 0], newToday: [0, 0], timeToday: [0, 0], collapsed: false, browserCollapsed: false, desc: '', dyn: 0, conf: 1, extendNew: 10, extendRev: 50 },
  };
  let nextDeckId = 1000;
  for (const d of exportedDecks) {
    const n = nextDeckId++;
    deckIdMap.set(d.id, n);
    decksJson[n] = {
      id: n, name: d.name, mod: 0, usn: 0,
      lrnToday: [0, 0], revToday: [0, 0], newToday: [0, 0], timeToday: [0, 0],
      collapsed: false, browserCollapsed: false,
      desc: d.description ?? '',
      dyn: 0, conf: 1, extendNew: 10, extendRev: 50,
    };
  }

  const modelsJson = {
    [BASIC_MODEL_ID]: basicModel(),
    [CLOZE_MODEL_ID]: clozeModel(),
  };

  const now = Math.floor(Date.now() / 1000);
  sqlite.run(
    `INSERT INTO col (id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags) VALUES (1, ?, ?, ?, 11, 0, 0, 0, ?, ?, ?, ?, ?)`,
    [
      now, now, now * 1000,
      JSON.stringify(defaultColConf()),
      JSON.stringify(modelsJson),
      JSON.stringify(decksJson),
      JSON.stringify(defaultDeckConf()),
      JSON.stringify({}),
    ],
  );

  // Insert notes & cards.
  let noteSeq = Date.now();
  let cardSeq = Date.now();
  const noteIdMap = new Map<string, number>();
  for (const n of allNotes) {
    noteSeq++;
    const ankiNoteId = noteSeq;
    noteIdMap.set(n.id, ankiNoteId);
    const isCloze = n.modelId === 'cloze';
    const isOcclusion = n.modelId === 'image-occlusion';
    const mid = isCloze ? CLOZE_MODEL_ID : BASIC_MODEL_ID;
    let front = n.fields.front;
    const back = n.fields.back ?? '';
    const extra = [n.fields.extra, n.fields.mnemonic, n.fields.context, n.fields.source]
      .filter(Boolean).join('\n\n');

    if (isOcclusion && n.fields.image) {
      // Stand-in: render the image as the front; Anki has no occlusion model.
      front = `<img src="${n.fields.image}">`;
    }

    let flds: string;
    if (isCloze) {
      flds = `${front}${FIELD_SEPARATOR}${[back, extra].filter(Boolean).join('\n\n')}`;
    } else {
      flds = `${front}${FIELD_SEPARATOR}${[back, extra].filter(Boolean).join('\n\n')}`;
    }

    const sfld = renderPlain(front).slice(0, 200);
    sqlite.run(
      `INSERT INTO notes (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, 0, '')`,
      [
        ankiNoteId,
        n.id.slice(0, 10),
        mid,
        Math.floor(n.modifiedAt / 1000),
        n.tags.length ? ' ' + n.tags.join(' ') + ' ' : '',
        flds,
        sfld,
        fieldChecksum(sfld),
      ],
    );
  }

  for (const c of allCards) {
    cardSeq++;
    const did = deckIdMap.get(c.deckId) ?? 1;
    const nid = noteIdMap.get(c.noteId);
    if (!nid) continue;
    const queue = c.suspended ? -1 : c.buried ? -2 : c.state === 'new' ? 0 : c.state === 'learning' || c.state === 'relearning' ? 1 : 2;
    const type = c.state === 'new' ? 0 : c.state === 'learning' || c.state === 'relearning' ? 1 : 2;
    const ivl = Math.max(0, Math.round(c.scheduledDays));
    sqlite.run(
      `INSERT INTO cards (id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 2500, ?, ?, 0, 0, 0, 0, ?)`,
      [
        cardSeq,
        nid,
        did,
        (c.clozeOrd ?? 1) - 1,
        Math.floor(c.modifiedAt / 1000),
        type,
        queue,
        Math.floor(c.due / 1000),
        ivl,
        c.reps,
        c.lapses,
        // Preserve FSRS state for tools that read it.
        JSON.stringify({
          stability: c.stability,
          difficulty: c.difficulty,
          source: 'cards-app',
        }),
      ],
    );
  }

  onProgress({ phase: 'saving', message: 'Writing zip…' });
  const dbBytes = sqlite.export();
  sqlite.close();

  // Build the .apkg zip.
  const zip = new JSZip();
  zip.file('collection.anki2', dbBytes);
  // Anki media file: { "0": "filename.png", ... }
  const mediaMap: Record<string, string> = {};
  let idx = 0;
  for (const m of allMedia) {
    const key = String(idx++);
    mediaMap[key] = m.filename;
    const arr = await m.blob.arrayBuffer();
    zip.file(key, arr);
  }
  zip.file('media', JSON.stringify(mediaMap));

  const blob = await zip.generateAsync({ type: 'blob' });
  onProgress({ phase: 'done', message: 'Done.' });
  return blob;
}
