/**
 * Mobile-viewport screenshot pass. Catches header overflow, bulk bar
 * sizing, sheet width, etc. on a 390-wide viewport.
 */

import { test } from '@playwright/test';
import path from 'path';
import fs from 'fs';

const SHOTS = path.resolve(__dirname, '../screenshots/mobile');

async function shot(page: import('@playwright/test').Page, name: string) {
  if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

test('mobile screen walk', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 800 });

  await page.goto('/');
  await page.evaluate(async () => {
    const databases = await indexedDB.databases();
    for (const d of databases) {
      if (d.name) await new Promise<void>((resolve, reject) => { const req = indexedDB.deleteDatabase(d.name!); req.onsuccess = () => resolve(); req.onerror = () => reject(req.error); req.onblocked = () => resolve(); });
    }
  });
  await page.goto('/');
  await shot(page, 'm01-home-empty');

  await page.goto('/decks/new');
  await page.getByPlaceholder(/MCAT.*Persian/i).fill('Mobile Demo');
  await page.getByRole('button', { name: /create deck/i }).click();
  await page.waitForURL(/\/deck\//);
  const deckId = page.url().split('/').pop()!;

  await page.goto(`/note/new?deckId=${deckId}`);
  await page.locator('textarea').first().fill('What is the {{c1::cell}} membrane?');
  await page.locator('textarea').nth(1).fill('Phospholipid bilayer');
  await page.getByRole('button', { name: /save & add another/i }).click();
  await page.waitForTimeout(800);

  await page.goto('/');
  await shot(page, 'm02-home-with-deck');

  await page.goto(`/deck/${deckId}`);
  await shot(page, 'm03-deck');

  // Bulk action bar with one selected.
  await page.getByRole('button', { name: /select note/i }).first().click();
  await page.waitForTimeout(200);
  await shot(page, 'm04-deck-bulk-bar');
  await page.keyboard.press('Escape');

  // Find sheet on mobile.
  await page.getByRole('button', { name: /^Find$/ }).click();
  await page.waitForTimeout(200);
  await shot(page, 'm05-find-replace');
  await page.keyboard.press('Escape');

  // Study mode header on mobile.
  await page.goto(`/study/${deckId}`);
  await page.waitForSelector('button:has-text("Reveal")');
  await shot(page, 'm06-study-front');
  await page.keyboard.press('Space');
  await page.waitForSelector('button:has-text("Good")');
  await shot(page, 'm07-study-back');

  // Sessions, Tags, Audit pages.
  await page.goto('/sessions');
  await page.waitForSelector('h1:has-text("Sessions")');
  await shot(page, 'm08-sessions');

  await page.goto('/tags');
  await page.waitForSelector('h1:has-text("Tags")');
  await shot(page, 'm09-tags');

  await page.goto('/audit');
  await page.waitForSelector('h1:has-text("Audit")');
  await shot(page, 'm10-audit');

  await page.goto('/stats');
  await page.waitForSelector('text=Reviews today');
  await page.waitForTimeout(400);
  await shot(page, 'm11-stats');

  console.log(`\nMobile screenshots saved to: ${SHOTS}`);
});
