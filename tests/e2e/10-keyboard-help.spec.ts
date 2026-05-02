import { test, expect } from '@playwright/test';

test.describe('Keyboard help', () => {
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

  test('? opens the global keyboard help panel from any page', async ({ page }) => {
    // From the home page (no Reviewer mounted) the panel should still open.
    await page.keyboard.press('Shift+Slash');
    await expect(page.getByRole('heading', { name: 'Keyboard' })).toBeVisible();
    // It includes the new global-only sections (slash commands).
    await expect(page.getByText(/Slash commands/i)).toBeVisible();

    // Esc closes it.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: 'Keyboard' })).not.toBeVisible();
  });

  test('? does NOT open the panel while typing in an input', async ({ page }) => {
    // Navigate to settings where there's a text input we can focus.
    await page.goto('/settings');
    const apiKeyInput = page.locator('input[placeholder*="sk-ant"]');
    await apiKeyInput.click();
    // Press `?` while focused. It should land in the input, not toggle help.
    await page.keyboard.press('Shift+Slash');
    await expect(page.getByRole('heading', { name: 'Keyboard' })).not.toBeVisible();
    await expect(apiKeyInput).toHaveValue('?');
  });
});
