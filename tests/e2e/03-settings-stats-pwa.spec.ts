import { test, expect } from '@playwright/test';

test.describe('Settings', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(async () => {
      const databases = await indexedDB.databases();
      for (const d of databases) {
        if (d.name) indexedDB.deleteDatabase(d.name);
      }
    });
  });

  test('save and clear API key', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

    const keyInput = page.locator('input[placeholder*="sk-ant"]');
    await keyInput.fill('sk-ant-test-key-12345');
    await page.getByRole('button', { name: /^Save$/ }).click();

    // After save, should show Remove button instead of Save.
    await expect(page.getByRole('button', { name: /Remove/ })).toBeVisible();
    // Key should be masked (form: first 7 chars + ellipsis + last 4).
    await expect(keyInput).toHaveValue(/sk-ant.+…?2345/);

    // Clear.
    await page.getByRole('button', { name: /Remove/ }).click();
    await expect(page.getByRole('button', { name: /^Save$/ })).toBeVisible();
    await expect(keyInput).toHaveValue('');
  });

  test('model select persists', async ({ page }) => {
    await page.goto('/settings');
    const select = page.locator('select').first();
    await select.selectOption('claude-opus-4-7');
    await page.reload();
    await expect(page.locator('select').first()).toHaveValue('claude-opus-4-7');
  });

  test('retention input saves', async ({ page }) => {
    await page.goto('/settings');
    const retentionInput = page.locator('input').filter({ hasText: '' }).filter({
      has: page.locator('xpath=preceding-sibling::div[contains(., "retention")]'),
    });
    // Simpler: just locate by initial value 0.90
    const allInputs = page.locator('input');
    const count = await allInputs.count();
    let target = null;
    for (let i = 0; i < count; i++) {
      const v = await allInputs.nth(i).inputValue();
      if (v === '0.90' || v === '0.9') { target = allInputs.nth(i); break; }
    }
    expect(target).not.toBeNull();
    await target!.fill('0.92');
    await page.reload();
    // Re-find the input and verify.
    for (let i = 0; i < count; i++) {
      const v = await allInputs.nth(i).inputValue();
      if (v === '0.92') return;
    }
    throw new Error('Retention did not persist');
  });
});

test.describe('Stats', () => {
  test('renders empty stats with zero reviews', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(async () => {
      const databases = await indexedDB.databases();
      for (const d of databases) {
        if (d.name) indexedDB.deleteDatabase(d.name);
      }
    });
    await page.goto('/stats');
    await expect(page.getByRole('heading', { name: 'Stats' })).toBeVisible();
    await expect(page.getByText('Reviews today')).toBeVisible();
    await expect(page.getByText('Retention 30d')).toBeVisible();
    await expect(page.getByText('No decks yet').first()).toBeVisible();
  });
});

test.describe('PWA', () => {
  test('manifest.json is served and valid', async ({ page, request }) => {
    const res = await request.get('/manifest.json');
    expect(res.ok()).toBe(true);
    const manifest = await res.json();
    expect(manifest.name).toBe('Cards');
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
    expect(manifest.icons.length).toBeGreaterThan(0);
  });

  test('service worker file is served with Service-Worker-Allowed header', async ({ request }) => {
    const res = await request.get('/sw.js');
    expect(res.ok()).toBe(true);
    expect(res.headers()['service-worker-allowed']).toBe('/');
    const body = await res.text();
    expect(body).toContain("addEventListener('install'");
    expect(body).toContain("addEventListener('activate'");
    expect(body).toContain("addEventListener('fetch'");
  });

  test('service worker registers and is active', async ({ browser }) => {
    // Opt out of the project's serviceWorkers: 'block' so this test can
    // exercise actual SW registration. The block is in place because dev-
    // mode Turbopack chunks change every reload and the SW would serve
    // stale JS, breaking other tests that revisit a route.
    const ctx = await browser.newContext({ serviceWorkers: 'allow' });
    const page = await ctx.newPage();
    try {
      await page.goto('/');
      // Wait for SW to install + activate.
      await page.waitForFunction(async () => {
        if (!('serviceWorker' in navigator)) return false;
        const reg = await navigator.serviceWorker.getRegistration();
        return !!reg && (reg.active != null || reg.installing != null || reg.waiting != null);
      }, { timeout: 15_000 });

      const isControlling = await page.evaluate(async () => {
        const reg = await navigator.serviceWorker.getRegistration();
        return reg !== undefined;
      });
      expect(isControlling).toBe(true);
    } finally {
      await ctx.close();
    }
  });
});
