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
const HISTORY_DIR = path.join(DATA_DIR, 'rolling');
const HISTORY_KEEP = 5;

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

async function rotateSnapshotHistory(): Promise<void> {
  // Move the current snapshot (if any) into rolling/<ISO>.json before
  // overwriting. Keeps the last HISTORY_KEEP files; older ones are
  // unlinked. Cheap insurance against a bad push wiping good data.
  // Best-effort: any failure here is non-fatal — the new write still
  // proceeds because the user's current data is already what they want
  // up there.
  try {
    await fs.access(SNAPSHOT_PATH);
  } catch {
    return; // No existing snapshot to rotate.
  }
  try {
    await fs.mkdir(HISTORY_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archived = path.join(HISTORY_DIR, `snapshot-${stamp}.json`);
    await fs.copyFile(SNAPSHOT_PATH, archived);
    const entries = (await fs.readdir(HISTORY_DIR))
      .filter(n => n.startsWith('snapshot-') && n.endsWith('.json'))
      .sort()
      .reverse(); // newest first
    for (const stale of entries.slice(HISTORY_KEEP)) {
      await fs.unlink(path.join(HISTORY_DIR, stale)).catch(() => { /* skip */ });
    }
  } catch { /* rotation is best-effort; current write continues. */ }
}

async function writeSnapshot(payload: unknown): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await rotateSnapshotHistory();
  const tmp = `${SNAPSHOT_PATH}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(payload), 'utf8');
  await fs.rename(tmp, SNAPSHOT_PATH);
}

export async function GET(req: Request) {
  if (!authOk(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  // `?meta=1` returns just the version + updatedAt without the blob, so
  // status checks don't have to download the full snapshot. Snapshots
  // grow large fast (media is base64'd inline); a 100MB roundtrip on
  // every page load was knocking out the iPad.
  const url = new URL(req.url);
  const metaOnly = url.searchParams.get('meta') === '1';
  try {
    const snap = await readSnapshot();
    if (snap === null) {
      return new NextResponse(null, { status: 204 });
    }
    if (metaOnly && typeof snap === 'object' && snap !== null) {
      const s = snap as { version?: number; updatedAt?: string };
      return NextResponse.json({ version: s.version, updatedAt: s.updatedAt });
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
  let body: { blob?: unknown; version?: unknown; salt?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || !body.blob || typeof body.version !== 'number') {
    return NextResponse.json({ error: 'invalid_payload' }, { status: 400 });
  }
  const payload: {
    blob: unknown;
    version: number;
    updatedAt: string;
    salt?: string;
  } = {
    blob: body.blob,
    version: body.version,
    updatedAt: new Date().toISOString(),
  };
  if (typeof body.salt === 'string') payload.salt = body.salt;
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
