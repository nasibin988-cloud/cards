import { test, expect } from '@playwright/test';

async function wipe(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.evaluate(async () => {
    const databases = await indexedDB.databases();
    for (const d of databases) {
      if (d.name) {
        await new Promise<void>(resolve => {
          const req = indexedDB.deleteDatabase(d.name!);
          req.onsuccess = () => resolve();
          req.onerror = () => resolve();
          req.onblocked = () => resolve();
        });
      }
    }
  });
  await page.goto('/');
}

async function createDeck(page: import('@playwright/test').Page, name: string): Promise<string> {
  await page.getByRole('link', { name: /new deck/i }).first().click();
  await page.getByPlaceholder(/MCAT.*Persian/i).fill(name);
  await page.getByRole('button', { name: /create deck/i }).click();
  await page.waitForURL(/\/deck\//);
  return page.url().split('/').pop()!;
}

async function addBasicNote(
  page: import('@playwright/test').Page,
  deckId: string,
  front: string,
  back: string,
) {
  await page.goto(`/note/new?deckId=${deckId}`);
  await page.locator('textarea').first().fill(front);
  await page.locator('textarea').nth(1).fill(back);
  await page.getByRole('button', { name: /save & add another/i }).click();
  await expect(page.getByText('Saved. Editing a fresh note.')).toBeVisible({ timeout: 5000 });
}

test.describe('Feynman mode (T)', () => {
  test('T enters teach-back; submit grades; rate writes a feynmanLog with multiplier', async ({ page }) => {
    await wipe(page);
    const deckId = await createDeck(page, 'FeynmanE2E');
    await addBasicNote(page, deckId, 'What is the work-energy theorem?', 'W = ΔKE');

    // Stub the network so we don't hit real Claude. The feynman library
    // calls `client.messages.create({ model, max_tokens, system, messages })`
    // through the lazy SDK; we intercept the SDK's HTTP request via Playwright
    // route. The `dangerouslyAllowBrowser` SDK posts to anthropic.com.
    await page.route('https://api.anthropic.com/**', route => {
      const body = JSON.stringify({
        id: 'test', type: 'message', role: 'assistant', model: 'test',
        content: [{ type: 'text', text: JSON.stringify({
          covered: ['the formula W = ΔKE'],
          missed: ['the assumption: net force only'],
          vague: [],
          completeness: 0.85,
          rationale: 'You hit the headline; missed the net-force qualifier.',
        }) }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 50 },
      });
      route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body,
      });
    });

    // Seed a Claude API key so the AI grader doesn't bail with "Add your key".
    await page.evaluate(async () => {
      const open = (name: string) => new Promise<IDBDatabase>((res, rej) => {
        const r = indexedDB.open(name);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const db = await open('cards-v1');
      const tx = db.transaction('settings', 'readwrite');
      tx.objectStore('settings').put({ key: 'claude_api_key', value: 'sk-ant-test' });
      await new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
      db.close();
    });

    await page.goto(`/study/${deckId}`);
    await expect(page.getByText('What is the work-energy theorem?').first()).toBeVisible();

    // Press T to enter Feynman mode.
    await page.keyboard.press('t');
    await expect(page.getByText(/Feynman mode/)).toBeVisible({ timeout: 4000 });

    // Type an explanation and submit.
    const textarea = page.locator('textarea').first();
    await textarea.fill('The work done by the net force on an object equals the change in its kinetic energy. So W = ΔKE.');
    await page.getByRole('button', { name: /Submit/ }).click();

    // The mocked grade renders.
    await expect(page.getByText(/Solid|hit the headline|formula/i).first()).toBeVisible({ timeout: 6000 });
    await expect(page.getByText(/85%/)).toBeVisible();

    // Rate Good. The Reviewer should advance and a feynmanLog should exist
    // with the right scheduleMultiplier.
    await page.getByRole('button', { name: /^Good$/ }).click();

    // Expect either the empty state or another card. Either is fine.
    await page.waitForTimeout(500);
    const log = await page.evaluate(async () => {
      const open = (name: string) => new Promise<IDBDatabase>((res, rej) => {
        const r = indexedDB.open(name);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const db = await open('cards-v1');
      const tx = db.transaction('feynmanLogs', 'readonly');
      const all = await new Promise<unknown[]>(res => {
        tx.objectStore('feynmanLogs').getAll().onsuccess = e =>
          res((e.target as IDBRequest).result as unknown[]);
      });
      db.close();
      return all;
    });
    expect(log.length).toBe(1);
    const entry = log[0] as {
      grade?: { completeness: number };
      rating?: number;
      scheduleMultiplier?: number;
      inputMode?: string;
    };
    expect(entry.grade?.completeness).toBeCloseTo(0.85);
    expect(entry.rating).toBe(3);
    // Bonus on Good with completeness 0.85 → linear 0.6..1.0 → 1.0..1.5;
    // so 0.85 → 1.0 + (0.25/0.4)*0.5 = 1.3125
    expect(entry.scheduleMultiplier).toBeCloseTo(1.3125, 3);
    expect(entry.inputMode).toBe('text');
  });

  test('Esc cancels Feynman mode without recording an attempt', async ({ page }) => {
    await wipe(page);
    const deckId = await createDeck(page, 'FeynmanCancel');
    await addBasicNote(page, deckId, 'cancel-front', 'cancel-back');

    await page.goto(`/study/${deckId}`);
    // Wait for the card to actually render before pressing T — the hotkey
    // requires phase === 'front', which is set by fetchNext after mount.
    await expect(page.getByText('cancel-front').first()).toBeVisible({ timeout: 4000 });
    await page.keyboard.press('t');
    await expect(page.getByText(/Feynman mode/)).toBeVisible({ timeout: 4000 });

    // Click the explicit Exit button (Esc would also work but the global ESC
    // handler navigates back to /; the panel-level Exit is what matters here).
    await page.getByRole('button', { name: /Exit/ }).click();
    await expect(page.getByText(/Feynman mode/)).not.toBeVisible({ timeout: 2000 });

    // No feynmanLog rows should exist.
    const count = await page.evaluate(async () => {
      const open = (name: string) => new Promise<IDBDatabase>((res, rej) => {
        const r = indexedDB.open(name);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const db = await open('cards-v1');
      const tx = db.transaction('feynmanLogs', 'readonly');
      const c = await new Promise<number>(res => {
        tx.objectStore('feynmanLogs').count().onsuccess = e =>
          res((e.target as IDBRequest).result as number);
      });
      db.close();
      return c;
    });
    expect(count).toBe(0);
  });
});
