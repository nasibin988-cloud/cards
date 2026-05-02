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

test.describe('TTS read-aloud', () => {
  test('the speaker button appears when TTS is enabled', async ({ page }) => {
    await wipe(page);
    const deckId = await createDeck(page, 'TtsEnabledE2E');
    await addBasicNote(page, deckId, 'tts-front', 'tts-back');

    // Flip on the master switch via raw IDB so we don't have to drive Settings.
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>(res => {
        const r = indexedDB.open('cards-v1');
        r.onsuccess = () => res(r.result);
      });
      const tx = db.transaction('settings', 'readwrite');
      tx.objectStore('settings').put({ key: 'tts_enabled', value: '1' });
      await new Promise<void>(res => { tx.oncomplete = () => res(); });
      db.close();
    });

    await page.goto(`/study/${deckId}`);
    await expect(page.getByText('tts-front').first()).toBeVisible();
    // Speaker button is wired and clickable. We don't assert that the
    // Chromium runner actually plays audio — the unit suite covers the
    // text-prep contract; the runtime SpeechSynthesis API behavior in
    // headless Chrome is environment-dependent.
    const speakBtn = page.getByRole('button', { name: 'Read this side aloud' });
    await expect(speakBtn).toBeVisible();
    // Clicking should not throw. (No await on the side-effect; a thrown
    // exception from the click handler would surface as a test error.)
    await speakBtn.click();
  });

  test('the speaker button is hidden when TTS is disabled', async ({ page }) => {
    await wipe(page);
    const deckId = await createDeck(page, 'TtsHiddenE2E');
    await addBasicNote(page, deckId, 'no-tts-front', 'no-tts-back');

    await page.goto(`/study/${deckId}`);
    await expect(page.getByText('no-tts-front').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Read this side aloud' })).toHaveCount(0);
  });

  test('Settings TTS panel persists the master switch', async ({ page }) => {
    await wipe(page);
    await page.goto('/settings');

    // Find and toggle the master switch by its label text.
    const enable = page.getByLabel('Enable read-aloud');
    await expect(enable).toBeVisible();
    await enable.check();

    // Confirm the setting persisted to IDB.
    const stored = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>(res => {
        const r = indexedDB.open('cards-v1');
        r.onsuccess = () => res(r.result);
      });
      const v = await new Promise<unknown>(res => {
        db.transaction('settings', 'readonly').objectStore('settings').get('tts_enabled').onsuccess = e =>
          res((e.target as IDBRequest).result);
      });
      db.close();
      return (v as { value?: string } | undefined)?.value;
    });
    expect(stored).toBe('1');
  });
});
