/**
 * Visual review pass: walks every screen and saves a screenshot. Run with:
 *   npx playwright test tests/e2e/99-screenshots.spec.ts
 * The screenshots land in tests/screenshots/ for manual review.
 */

import { test } from '@playwright/test';
import path from 'path';
import fs from 'fs';

const SHOTS = path.resolve(__dirname, '../screenshots');

async function shot(page: import('@playwright/test').Page, name: string) {
  if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

test('walk every screen, take screenshots', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.goto('/');
  await page.evaluate(async () => {
    const databases = await indexedDB.databases();
    for (const d of databases) {
      if (d.name) await new Promise<void>((resolve, reject) => { const req = indexedDB.deleteDatabase(d.name!); req.onsuccess = () => resolve(); req.onerror = () => reject(req.error); req.onblocked = () => resolve(); });
    }
  });
  await page.goto('/');
  await shot(page, '01-home-empty');

  await page.goto('/decks/new');
  await shot(page, '02-new-deck');
  await page.getByPlaceholder(/MCAT.*Persian/i).fill('Demo Deck');
  await page.getByRole('button', { name: /create deck/i }).click();
  await page.waitForURL(/\/deck\//);
  const deckId = page.url().split('/').pop()!;
  await shot(page, '03-deck-empty');

  await page.goto(`/note/new?deckId=${deckId}`);
  await shot(page, '04-note-editor-empty');
  await page.locator('textarea').first().fill('The capital of {{c1::France}} is {{c2::Paris}}.');
  await page.locator('textarea').nth(1).fill('Geography fact.');
  await shot(page, '05-note-editor-cloze-preview');
  await page.getByRole('button', { name: /save & add another/i }).click();
  await page.waitForTimeout(1000);

  await page.locator('textarea').first().fill('What does Dexie wrap?');
  await page.locator('textarea').nth(1).fill('IndexedDB.');
  await page.getByRole('button', { name: /save & add another/i }).click();
  await page.waitForTimeout(1000);

  await page.goto('/');
  await shot(page, '06-home-with-deck');

  await page.goto(`/deck/${deckId}`);
  await shot(page, '07-deck-with-notes');

  await page.goto(`/deck/${deckId}/edit`);
  await shot(page, '08-deck-edit');

  await page.goto(`/study/${deckId}`);
  // Wait for front
  await page.waitForSelector('button:has-text("Reveal")');
  await shot(page, '09-study-front');

  await page.keyboard.press('Space');
  await page.waitForSelector('button:has-text("Good")');
  await shot(page, '10-study-back');

  await page.keyboard.press('?');
  await page.waitForSelector('h2:has-text("Keyboard")');
  // Let the fade-in finish so the overlay is fully opaque in the screenshot.
  await page.waitForTimeout(600);
  await shot(page, '11-keyboard-help');
  await page.keyboard.press('Escape');

  await page.goto('/import');
  // ApkgDropzone is dynamic({ssr:false}); wait for it to mount.
  await page.waitForSelector('text=Drop an .apkg here');
  await shot(page, '12-import');

  await page.goto('/settings');
  await page.waitForSelector('text=Claude API');
  await shot(page, '13-settings');

  await page.goto('/stats');
  // StatsView is dynamic({ssr:false}); wait for the first stat card.
  await page.waitForSelector('text=Reviews today');
  await page.waitForTimeout(500); // let queries finish
  await shot(page, '14-stats');

  // ─── Anki-parity additions ───────────────────────────────────
  // Tuning tab on the deck edit page.
  await page.goto(`/deck/${deckId}/edit`);
  await page.getByRole('button', { name: /^Tuning$/ }).click();
  await page.waitForTimeout(300);
  await shot(page, '15-deck-tuning');
  await page.getByRole('button', { name: /Show advanced/ }).click();
  await page.waitForTimeout(300);
  await shot(page, '15a-deck-tuning-advanced');

  // Find & replace sheet.
  await page.goto(`/deck/${deckId}`);
  await page.getByRole('button', { name: /^Find$/ }).click();
  await page.waitForSelector('h2:has-text("Find & replace")');
  await page.getByPlaceholder(/^Find…$/).fill('Paris');
  await page.waitForTimeout(400);
  await shot(page, '16-find-replace');
  await page.keyboard.press('Escape');

  // Convert note type modal — open the first actual note row by its content.
  // (The deck header has an Add-note link that ALSO matches /note/, so we
  // target the visible note text instead of an href prefix selector.)
  await page.goto(`/deck/${deckId}`);
  await page.getByText('What does Dexie wrap').first().click();
  await page.waitForSelector('h2:has-text("Card actions")');
  await shot(page, '17-note-edit-with-actions');
  await page.getByRole('button', { name: /Convert: basic → cloze/ }).click();
  await page.waitForSelector('h2:has-text("Convert")');
  await shot(page, '18-convert-note-type');
  await page.keyboard.press('Escape');

  // Practice queries page.
  await page.goto('/practice');
  await page.waitForSelector('h1:has-text("Practice")');
  await shot(page, '19-practice');

  // Bulk action bar — go back to deck and select a note.
  await page.goto(`/deck/${deckId}`);
  await page.getByRole('button', { name: /select note/i }).first().click();
  await page.waitForTimeout(200);
  await shot(page, '20-bulk-action-bar');
  await page.keyboard.press('Escape');

  // ─── Round-3 additions ───────────────────────────────────────
  // Tags page.
  await page.goto('/tags');
  await page.waitForSelector('h1:has-text("Tags")');
  await page.waitForTimeout(300);
  await shot(page, '21-tags');

  // Sessions unified surface.
  await page.goto('/sessions');
  await page.waitForSelector('h1:has-text("Sessions")');
  await page.waitForTimeout(300);
  await shot(page, '22-sessions');

  // Audit page.
  await page.goto('/audit');
  await page.waitForSelector('h1:has-text("Audit")');
  await page.waitForTimeout(500);
  await shot(page, '23-audit');

  // Card actions on note edit (now with history button).
  await page.goto(`/deck/${deckId}`);
  await page.getByText('What does Dexie wrap').first().click();
  await page.waitForSelector('h2:has-text("Card actions")');
  await page.waitForSelector('h2:has-text("Suggested links")');
  await shot(page, '24-note-edit-with-xlinks-and-history');

  // Generate page with Cloze-a-passage mode.
  await page.goto('/generate');
  await page.waitForSelector('text=Cloze a passage');
  await page.getByRole('button', { name: /Cloze a passage/ }).click();
  await page.waitForTimeout(200);
  await shot(page, '25-generate-cloze-place');

  // Stats now also shows the hour-of-week heatmap (only renders when there
  // are reviews; we just hit the page so the screenshot captures whatever
  // state exists).
  await page.goto('/stats');
  await page.waitForSelector('text=Reviews today');
  await page.waitForTimeout(500);
  await shot(page, '26-stats-with-heatmap');

  console.log(`\nScreenshots saved to: ${SHOTS}`);
});
