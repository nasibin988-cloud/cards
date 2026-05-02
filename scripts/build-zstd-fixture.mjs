#!/usr/bin/env node
/**
 * Build a tiny v3 (Anki 23.10+) .apkg fixture for testing the zstd import path.
 *
 * Output: tests/fixtures/synthetic-v3.apkg
 *
 * Strategy: take an existing .anki2 (raw SQLite) collection from one of our
 * fixtures, rename the entry to collection.anki21b, zstd-compress it, and
 * pack into a fresh zip alongside an empty media file.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures');

const SOURCE = path.join(FIXTURES, 'zoroastrian.apkg');
const OUT = path.join(FIXTURES, 'synthetic-v3.apkg');

if (!fs.existsSync(SOURCE)) {
  console.error('Missing source fixture:', SOURCE);
  process.exit(1);
}

async function main() {
  const sourceBytes = fs.readFileSync(SOURCE);
  const sourceZip = await JSZip.loadAsync(sourceBytes);
  const dbFile = sourceZip.file('collection.anki2') ?? sourceZip.file('collection.anki21');
  if (!dbFile) throw new Error('source has no collection.anki2 / .anki21');
  const dbBytes = await dbFile.async('uint8array');

  // Compress with zstd CLI.
  const tmpIn = path.join(FIXTURES, '_tmp.sqlite');
  const tmpOut = path.join(FIXTURES, '_tmp.sqlite.zst');
  fs.writeFileSync(tmpIn, dbBytes);
  execFileSync('zstd', ['-f', '-q', '-19', tmpIn, '-o', tmpOut]);
  const compressedDb = fs.readFileSync(tmpOut);
  fs.unlinkSync(tmpIn);
  fs.unlinkSync(tmpOut);

  // Build an empty (but valid v3) media file: zstd-compressed JSON "{}".
  const emptyMediaJson = Buffer.from('{}', 'utf8');
  const tmpMediaIn = path.join(FIXTURES, '_media.json');
  const tmpMediaOut = path.join(FIXTURES, '_media.json.zst');
  fs.writeFileSync(tmpMediaIn, emptyMediaJson);
  execFileSync('zstd', ['-f', '-q', '-19', tmpMediaIn, '-o', tmpMediaOut]);
  const compressedMedia = fs.readFileSync(tmpMediaOut);
  fs.unlinkSync(tmpMediaIn);
  fs.unlinkSync(tmpMediaOut);

  // Re-pack as v3 .apkg.
  const out = new JSZip();
  out.file('collection.anki21b', compressedDb);
  out.file('media', compressedMedia);
  out.file('meta', JSON.stringify({ version: 3 }));
  const buffer = await out.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
  fs.writeFileSync(OUT, buffer);
  console.log(`wrote ${OUT} (${buffer.length} bytes; ${compressedDb.length} bytes compressed db)`);
}

main().catch(err => { console.error(err); process.exit(1); });
