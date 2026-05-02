import { test, expect } from '@playwright/test';

test('export → import round trip via Settings & Import pages', async ({ page }) => {
  test.setTimeout(180_000);

  // 1. Wipe and seed a small deck.
  await page.goto('/');
  await page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    for (const d of dbs) if (d.name) indexedDB.deleteDatabase(d.name);
  });
  await page.goto('/');

  await page.getByRole('link', { name: /new deck/i }).first().click();
  await page.getByPlaceholder(/MCAT.*Persian/i).fill('RoundTrip');
  await page.getByRole('button', { name: /create deck/i }).click();
  await page.waitForURL(/\/deck\//);
  const deckId = page.url().split('/').pop()!;

  await page.goto(`/note/new?deckId=${deckId}`);
  await page.locator('textarea').first().fill('What is {{c1::ATP}}?');
  await page.locator('textarea').nth(1).fill('Adenosine triphosphate.');
  await page.getByRole('button', { name: /save & add another/i }).click();
  await expect(page.getByText('Saved.').first()).toBeVisible({ timeout: 5000 });

  // 2. Export .apkg via Settings → BackupPanel.
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await page.getByText('Export .apkg').click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).toBeTruthy();

  // 3. Wipe and re-import the file.
  await page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    for (const d of dbs) if (d.name) indexedDB.deleteDatabase(d.name);
  });
  await page.goto('/import');
  await page.locator('input[type="file"]').setInputFiles(path!);

  await expect(page.getByText(/^Imported\.$/)).toBeVisible({ timeout: 60_000 });

  const counts = await page.evaluate(async () => {
    const req = indexedDB.open('cards-v1');
    return new Promise<{ notes: number; cards: number }>((resolve, reject) => {
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['notes', 'cards'], 'readonly');
        const out: any = { notes: 0, cards: 0 };
        tx.objectStore('notes').count().onsuccess = (e: any) => { out.notes = e.target.result; };
        tx.objectStore('cards').count().onsuccess = (e: any) => { out.cards = e.target.result; };
        tx.oncomplete = () => resolve(out);
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
  });

  // We exported 2 notes (1 cloze + 1 basic) and 3 cards (cloze c1 + basic = wait, no).
  // Actually the test created 1 cloze with 1 ord. So 1 note, 1 card.
  expect(counts.notes).toBeGreaterThanOrEqual(1);
  expect(counts.cards).toBeGreaterThanOrEqual(1);
});
