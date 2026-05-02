import { test, expect } from '@playwright/test';

test.describe('Quick capture', () => {
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

  test('Alt+Shift+C opens modal and saves to Inbox deck', async ({ page }) => {
    // Open the modal via the global hotkey. Alt+Shift+C is used because
    // Cmd+Shift+C and Ctrl+Shift+C are reserved by Chrome devtools.
    await page.keyboard.press('Alt+Shift+KeyC');
    await expect(page.getByRole('heading', { name: 'Quick capture' })).toBeVisible();

    // Type a two-line capture; first line front, second line back.
    const textarea = page.locator('textarea').first();
    await textarea.fill('Mitochondria\nProduce ATP via oxidative phosphorylation.');
    await page.getByRole('button', { name: /^Save$/ }).click();

    // The "Saved → open note" link should appear.
    await expect(page.getByRole('link', { name: /Saved → open note/ })).toBeVisible({ timeout: 4000 });

    // Close, navigate to home, and confirm an "Inbox" deck exists.
    await page.keyboard.press('Escape');
    await page.goto('/');
    await expect(page.getByRole('link', { name: /Inbox/ }).first()).toBeVisible({ timeout: 4000 });
  });
});
