/**
 * Sync media index. Lists every media file the server has so the client
 * can diff and upload only what's missing. Auth: same bearer token as
 * /api/sync/snapshot. Storage layout: each media file is two files in
 *   ${CARDS_SYNC_DATA_DIR}/media/
 *     <id>.bin   — raw bytes
 *     <id>.json  — { filename, mimeType, sizeBytes }
 * Listing reads the .json sidecars (cheap), not the .bin payloads.
 */

import { NextResponse } from 'next/server';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const runtime = 'nodejs';

const DATA_DIR = process.env.CARDS_SYNC_DATA_DIR || '/data';
const MEDIA_DIR = path.join(DATA_DIR, 'media');

function authOk(req: Request): boolean {
  const expected = process.env.CARDS_SYNC_TOKEN;
  if (!expected) return false;
  const header = req.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || token.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) {
    diff |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

export async function GET(req: Request) {
  if (!authOk(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  try {
    let entries: string[];
    try {
      entries = await fs.readdir(MEDIA_DIR);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return NextResponse.json({ items: [] });
      }
      throw err;
    }
    const sidecars = entries.filter(n => n.endsWith('.json'));
    const items: Array<{ id: string; filename: string; mimeType: string; sizeBytes: number }> = [];
    // Read sidecars in parallel — small JSON files, fine.
    const reads = sidecars.map(async name => {
      try {
        const raw = await fs.readFile(path.join(MEDIA_DIR, name), 'utf8');
        const meta = JSON.parse(raw);
        const id = name.replace(/\.json$/, '');
        items.push({
          id,
          filename: String(meta.filename ?? ''),
          mimeType: String(meta.mimeType ?? 'application/octet-stream'),
          sizeBytes: Number(meta.sizeBytes ?? 0),
        });
      } catch { /* skip malformed sidecar */ }
    });
    await Promise.all(reads);
    return NextResponse.json({ items });
  } catch (err) {
    return NextResponse.json(
      { error: 'list_failed', message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
