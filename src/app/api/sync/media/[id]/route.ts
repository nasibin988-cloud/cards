/**
 * Per-file media GET/PUT/HEAD. Storage layout matches /api/sync/media:
 *   <DATA>/media/<id>.bin   raw bytes
 *   <DATA>/media/<id>.json  { filename, mimeType, sizeBytes }
 *
 * Auth: bearer token in Authorization header (same as snapshot endpoint).
 *
 * - GET    /api/sync/media/<id>   → binary, Content-Type from sidecar
 * - PUT    /api/sync/media/<id>   → upload binary; sidecar is built from
 *                                   the X-Filename / Content-Type headers
 *                                   (or query params as fallback)
 * - HEAD   /api/sync/media/<id>   → 200 if present, 404 if not (lets the
 *                                   client check existence without fetching
 *                                   the bytes)
 *
 * The :id path segment is restricted to safe characters so a request can't
 * escape the media directory.
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

const SAFE_ID = /^[A-Za-z0-9_\-]{1,64}$/;

function paths(id: string) {
  return {
    bin: path.join(MEDIA_DIR, `${id}.bin`),
    meta: path.join(MEDIA_DIR, `${id}.json`),
  };
}

export async function HEAD(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!authOk(req)) return new NextResponse(null, { status: 401 });
  const { id } = await ctx.params;
  if (!SAFE_ID.test(id)) return new NextResponse(null, { status: 400 });
  try {
    await fs.access(paths(id).bin);
    return new NextResponse(null, { status: 200 });
  } catch {
    return new NextResponse(null, { status: 404 });
  }
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!authOk(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { id } = await ctx.params;
  if (!SAFE_ID.test(id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }
  const p = paths(id);
  try {
    const [bin, metaRaw] = await Promise.all([
      fs.readFile(p.bin),
      fs.readFile(p.meta, 'utf8').catch(() => '{}'),
    ]);
    let mimeType = 'application/octet-stream';
    let filename: string | null = null;
    try {
      const meta = JSON.parse(metaRaw);
      if (typeof meta.mimeType === 'string') mimeType = meta.mimeType;
      if (typeof meta.filename === 'string') filename = meta.filename;
    } catch { /* sidecar malformed, fall back to defaults */ }
    const headers: HeadersInit = { 'content-type': mimeType, 'cache-control': 'private, max-age=0' };
    if (filename) headers['x-filename'] = encodeURIComponent(filename);
    return new NextResponse(new Uint8Array(bin), { status: 200, headers });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json(
      { error: 'read_failed', message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!authOk(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { id } = await ctx.params;
  if (!SAFE_ID.test(id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }
  const url = new URL(req.url);
  // Mime + filename come from headers (preferred) or query params (fallback
  // for clients that can't set custom headers, e.g. <img src=…> uploads).
  const mimeHeader = req.headers.get('x-mime-type') || req.headers.get('content-type') || '';
  const mimeType = mimeHeader && mimeHeader !== 'application/octet-stream'
    ? mimeHeader
    : (url.searchParams.get('mime') || 'application/octet-stream');
  const filenameHeader = req.headers.get('x-filename');
  const filename = filenameHeader
    ? decodeURIComponent(filenameHeader)
    : (url.searchParams.get('filename') || id);

  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.length === 0) {
    return NextResponse.json({ error: 'empty_body' }, { status: 400 });
  }
  try {
    await fs.mkdir(MEDIA_DIR, { recursive: true });
    const p = paths(id);
    const tmpBin = `${p.bin}.tmp.${process.pid}.${Date.now()}`;
    const tmpMeta = `${p.meta}.tmp.${process.pid}.${Date.now()}`;
    await fs.writeFile(tmpBin, buf);
    await fs.writeFile(
      tmpMeta,
      JSON.stringify({ filename, mimeType, sizeBytes: buf.length }),
      'utf8',
    );
    await Promise.all([fs.rename(tmpBin, p.bin), fs.rename(tmpMeta, p.meta)]);
    return NextResponse.json({ id, sizeBytes: buf.length });
  } catch (err) {
    return NextResponse.json(
      { error: 'write_failed', message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
