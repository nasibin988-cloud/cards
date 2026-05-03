import { test, expect } from '@playwright/test';

async function wipeAndSeed(page: import('@playwright/test').Page) {
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
    try { localStorage.clear(); } catch {}
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

async function addBasicNote(page: import('@playwright/test').Page, deckId: string, front: string, back: string) {
  await page.goto(`/note/new?deckId=${deckId}`);
  await page.locator('textarea').first().fill(front);
  await page.locator('textarea').nth(1).fill(back);
  await page.getByRole('button', { name: /save & add another/i }).click();
  await expect(page.getByText('Saved.')).toBeVisible({ timeout: 5000 });
}

async function enablePomodoro(page: import('@playwright/test').Page, workMin: number, breakMin: number) {
  await page.evaluate(async ({ work, brk }) => {
    const open = indexedDB.open('cards-v1');
    const dbi = await new Promise<IDBDatabase>(res => { open.onsuccess = () => res(open.result); });
    const tx = dbi.transaction('settings', 'readwrite');
    const store = tx.objectStore('settings');
    await new Promise<void>(res => {
      const r1 = store.put({ key: 'pomodoro_enabled', value: JSON.stringify(true) });
      r1.onsuccess = () => res();
    });
    await new Promise<void>(res => {
      const r2 = store.put({ key: 'pomodoro_work_minutes', value: JSON.stringify(work) });
      r2.onsuccess = () => res();
    });
    await new Promise<void>(res => {
      const r3 = store.put({ key: 'pomodoro_break_minutes', value: JSON.stringify(brk) });
      r3.onsuccess = () => res();
    });
    dbi.close();
  }, { work: workMin, brk: breakMin });
}

test.describe('Pomodoro', () => {
  test('disabled by default — no break overlay during study', async ({ page }) => {
    await wipeAndSeed(page);
    const deckId = await createDeck(page, 'NoPomo');
    await addBasicNote(page, deckId, 'card-A', 'a');

    await page.goto(`/study/${deckId}`);
    await expect(page.getByText('card-A').first()).toBeVisible();
    // No break overlay
    await expect(page.getByText(/Step away/)).not.toBeVisible();
    // No "End work" button
    await expect(page.getByRole('button', { name: /^End work$/ })).not.toBeVisible();
  });

  test('manual "End work" skips to break; "End break early" returns to work', async ({ page }) => {
    await wipeAndSeed(page);
    const deckId = await createDeck(page, 'PomoSkip');
    await addBasicNote(page, deckId, 'card-A', 'a');
    await addBasicNote(page, deckId, 'card-B', 'b');
    // Long enough that the test won't accidentally race the timer.
    await enablePomodoro(page, 30, 30);

    await page.goto(`/study/${deckId}`);
    await expect(page.getByText('card-A').first()).toBeVisible();

    // End work early → break overlay appears, card hidden.
    await page.getByRole('button', { name: /^End work$/ }).click();
    await expect(page.getByText(/Step away/)).toBeVisible({ timeout: 4000 });
    await expect(page.getByText('card-A')).not.toBeVisible();

    // End break early → card comes back.
    await page.getByRole('button', { name: /End break early/i }).click();
    await expect(page.getByText('card-A').first()).toBeVisible({ timeout: 4000 });
    await expect(page.getByText(/Step away/)).not.toBeVisible();
  });

  test('rating keys are no-ops while in break', async ({ page }) => {
    await wipeAndSeed(page);
    const deckId = await createDeck(page, 'PomoRateBlock');
    await addBasicNote(page, deckId, 'card-A', 'a');
    await addBasicNote(page, deckId, 'card-B', 'b');
    await enablePomodoro(page, 30, 30);

    await page.goto(`/study/${deckId}`);
    await expect(page.getByText('card-A').first()).toBeVisible();
    // Reveal first so the back-phase rate buttons would normally be live.
    await page.keyboard.press('Space');
    await expect(page.getByRole('button', { name: /Good/i })).toBeVisible();

    // Skip to break.
    await page.getByRole('button', { name: /^End work$/ }).click();
    await expect(page.getByText(/Step away/)).toBeVisible({ timeout: 4000 });

    // Press "3" — should NOT advance the card. card-A stays the current one
    // when we leave the break.
    await page.keyboard.press('3');
    await page.waitForTimeout(300);
    // Still in break.
    await expect(page.getByText(/Step away/)).toBeVisible();

    // End break — card-A is still the active card (rate was suppressed).
    // The card preserves its back-phase across the break, so we look for
    // the back text "a" + the rating buttons rather than the front text.
    await page.getByRole('button', { name: /End break early/i }).click();
    await expect(page.getByRole('button', { name: /Good/i })).toBeVisible({ timeout: 4000 });
    await expect(page.getByText(/Step away/)).not.toBeVisible();
  });
});
