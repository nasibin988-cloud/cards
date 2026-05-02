/**
 * Self-hosted sync endpoint. Stores ONE encrypted snapshot per deployment
 * — single-user, multi-device. Authentication is a static bearer token
 * (`CARDS_SYNC_TOKEN`), defense in depth on top of the end-to-end
 * encryption. Without the token the server returns 401; without the
 * passphrase the blob is opaque ciphertext anyway.
 *
 * Storage is a single JSON file at `${CARDS_SYNC_DATA_DIR}/snapshot.json`
 * (default `/data`, mounted as a Docker volume). On PUT we write atomically
 * via temp + rename so a crash mid-write can't truncate the snapshot.
 *
 * The blob shape mirrors what the SupabaseAdapter stores:
 *   { blob: EncryptedBlob, version: number, updatedAt: ISO string }
 */

import { NextResponse } from 'next/server';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const runtime = 'nodejs';

const DATA_DIR = process.env.CARDS_SYNC_DATA_DIR || '/data';
const SNAPSHOT_PATH = path.join(DATA_DIR, 'snapshot.json');

function authOk(req: Request): boolean {
  const expected = process.env.CARDS_SYNC_TOKEN;
  if (!expected) return false; // sync disabled when no token is configured
  const header = req.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || token.length !== expected.length) return false;
  // Constant-time comparison to avoid leaking length match info via timing.
  let diff = 0;
  for (let i = 0; i < token.length; i++) {
    diff |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

async function readSnapshot(): Promise<unknown | null> {
  try {
    const raw = await fs.readFile(SNAPSHOT_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function writeSnapshot(payload: unknown): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${SNAPSHOT_PATH}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(payload), 'utf8');
  await fs.rename(tmp, SNAPSHOT_PATH);
}

export async function GET(req: Request) {
  if (!authOk(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  try {
    const snap = await readSnapshot();
    if (snap === null) {
      // Empty body — client treats this as "no remote snapshot yet."
      return new NextResponse(null, { status: 204 });
    }
    return NextResponse.json(snap);
  } catch (err) {
    return NextResponse.json(
      { error: 'read_failed', message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function PUT(req: Request) {
  if (!authOk(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  let body: { blob?: unknown; version?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || !body.blob || typeof body.version !== 'number') {
    return NextResponse.json({ error: 'invalid_payload' }, { status: 400 });
  }
  const payload = {
    blob: body.blob,
    version: body.version,
    updatedAt: new Date().toISOString(),
  };
  try {
    await writeSnapshot(payload);
    return NextResponse.json({ remoteVersion: payload.version, updatedAt: payload.updatedAt });
  } catch (err) {
    return NextResponse.json(
      { error: 'write_failed', message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
