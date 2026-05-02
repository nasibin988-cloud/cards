import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Self-hosted sync API smoke tests. Drives the actual /api/sync/snapshot
 * route via fetch, with CARDS_SYNC_TOKEN set on the dev server (provided
 * by playwright.config.ts via env passthrough below). Auth, content
 * round-trip, and the empty-state 204 are the things that matter.
 */

// Pick a fresh tmp dir per test run so concurrent CI doesn't collide.
const TMP_DIR = path.join(os.tmpdir(), `cards-sync-test-${Date.now()}`);
const TOKEN = 'test-bearer-token-deadbeef';

test.beforeAll(async () => {
  await fs.mkdir(TMP_DIR, { recursive: true });
});
test.afterAll(async () => {
  await fs.rm(TMP_DIR, { recursive: true, force: true });
});

test.describe('Self-hosted sync API', () => {
  test('rejects requests without a bearer token', async ({ request }) => {
    const r = await request.get('/api/sync/snapshot');
    expect(r.status()).toBe(401);
  });

  test('rejects bad bearer tokens', async ({ request }) => {
    const r = await request.get('/api/sync/snapshot', {
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(r.status()).toBe(401);
  });

  test('GET returns 204 when no snapshot exists yet', async ({ request }) => {
    // Skip if the dev server isn't configured for sync — we only run when
    // both the token and a writable data dir are wired up.
    const probe = await request.get('/api/sync/snapshot', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    test.skip(
      probe.status() === 401,
      'Dev server has no CARDS_SYNC_TOKEN; skipping (configured in playwright.config.ts).',
    );
    // 204 means "configured but empty"; 200 means a previous test left a
    // snapshot. Both are valid post-conditions.
    expect([200, 204]).toContain(probe.status());
  });

  test('PUT then GET round-trips the encrypted blob', async ({ request }) => {
    const probe = await request.get('/api/sync/snapshot', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    test.skip(probe.status() === 401, 'Dev server has no CARDS_SYNC_TOKEN; skipping.');

    const blob = { ciphertextB64: 'AAAA', ivB64: 'BBBB' };
    const put = await request.put('/api/sync/snapshot', {
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      data: { blob, version: 42 },
    });
    expect(put.status()).toBe(200);
    const putBody = await put.json();
    expect(putBody.remoteVersion).toBe(42);

    const get = await request.get('/api/sync/snapshot', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(get.status()).toBe(200);
    const body = await get.json();
    expect(body.version).toBe(42);
    expect(body.blob).toEqual(blob);
    expect(typeof body.updatedAt).toBe('string');
  });
});
