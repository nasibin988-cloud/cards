import { test, expect } from '@playwright/test';

test.describe('Edit shortcut during study', () => {
  test('E navigates to the note editor on the front phase', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(async () => {
      const databases = await indexedDB.databases();
      for (const d of databases) {
        if (d.name) indexedDB.deleteDatabase(d.name);
      }
    });
    await page.goto('/');

    await page.getByRole('link', { name: /new deck/i }).first().click();
    await page.getByPlaceholder(/MCAT.*Persian/i).fill('EditShortcut');
    await page.getByRole('button', { name: /create deck/i }).click();
    await page.waitForURL(/\/deck\//);
    const deckId = page.url().split('/').pop()!;

    await page.goto(`/note/new?deckId=${deckId}`);
    await page.locator('textarea').first().fill('Capital of France?');
    await page.locator('textarea').nth(1).fill('Paris');
    await page.getByRole('button', { name: /save & add another/i }).click();
    await expect(page.getByText('Saved. Editing a fresh note.')).toBeVisible({ timeout: 5000 });

    await page.goto(`/study/${deckId}`);
    await expect(page.getByText('Capital of France?').first()).toBeVisible();

    // Front phase: press E. Should navigate to /note/[id].
    await page.keyboard.press('e');
    await page.waitForURL(/\/note\/[A-Z0-9]+$/, { timeout: 5000 });
    await expect(page.locator('textarea').first()).toHaveValue('Capital of France?');
  });

  test('E navigates to the note editor on the back phase too', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(async () => {
      const databases = await indexedDB.databases();
      for (const d of databases) {
        if (d.name) indexedDB.deleteDatabase(d.name);
      }
    });
    await page.goto('/');

    await page.getByRole('link', { name: /new deck/i }).first().click();
    await page.getByPlaceholder(/MCAT.*Persian/i).fill('EditShortcutBack');
    await page.getByRole('button', { name: /create deck/i }).click();
    await page.waitForURL(/\/deck\//);
    const deckId = page.url().split('/').pop()!;

    await page.goto(`/note/new?deckId=${deckId}`);
    await page.locator('textarea').first().fill('Capital of Germany?');
    await page.locator('textarea').nth(1).fill('Berlin');
    await page.getByRole('button', { name: /save & add another/i }).click();
    await expect(page.getByText('Saved. Editing a fresh note.')).toBeVisible({ timeout: 5000 });

    await page.goto(`/study/${deckId}`);
    await expect(page.getByText('Capital of Germany?').first()).toBeVisible();

    // Reveal the back, then press E.
    await page.keyboard.press('Space');
    await expect(page.getByText('Berlin').first()).toBeVisible();

    await page.keyboard.press('E');
    await page.waitForURL(/\/note\/[A-Z0-9]+$/, { timeout: 5000 });
    await expect(page.locator('textarea').first()).toHaveValue('Capital of Germany?');
  });
});

test.describe('Tooltip primitive', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(async () => {
      const databases = await indexedDB.databases();
      for (const d of databases) {
        if (d.name) indexedDB.deleteDatabase(d.name);
      }
    });
    await page.goto('/');
  });

  test('hovering the Sort dropdown shows a tooltip', async ({ page }) => {
    await page.getByRole('link', { name: /new deck/i }).first().click();
    await page.getByPlaceholder(/MCAT.*Persian/i).fill('TooltipDeck');
    await page.getByRole('button', { name: /create deck/i }).click();
    await page.waitForURL(/\/deck\//);

    // No tooltip should be present before hover.
    await expect(page.getByRole('tooltip')).toHaveCount(0);

    const sort = page.locator('select[aria-label="Sort"]');
    await sort.hover();

    const tooltip = page.getByRole('tooltip', { name: /^Sort$/ });
    await expect(tooltip).toBeVisible({ timeout: 1000 });
  });

  test('flag filter chips have per-flag tooltips', async ({ page }) => {
    await page.getByRole('link', { name: /new deck/i }).first().click();
    await page.getByPlaceholder(/MCAT.*Persian/i).fill('FlagsDeck');
    await page.getByRole('button', { name: /create deck/i }).click();
    await page.waitForURL(/\/deck\//);

    // The flag filter chips render as buttons with the flag name visible.
    // Hover the "broken" chip and verify the tooltip contains 'Broken'.
    const brokenChip = page.getByRole('button', { name: /broken/i }).first();
    await brokenChip.hover();
    await expect(page.getByRole('tooltip', { name: 'Broken' })).toBeVisible({ timeout: 1000 });
  });
});
