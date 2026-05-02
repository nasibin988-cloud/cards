import { test, expect } from '@playwright/test';

async function wipe(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.evaluate(async () => {
    const databases = await indexedDB.databases();
    for (const d of databases) {
      if (d.name) await new Promise<void>((resolve, reject) => { const req = indexedDB.deleteDatabase(d.name!); req.onsuccess = () => resolve(); req.onerror = () => reject(req.error); req.onblocked = () => resolve(); });
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

async function addBasicNote(page: import('@playwright/test').Page, deckId: string, front: string, back: string) {
  await page.goto(`/note/new?deckId=${deckId}`);
  await page.locator('textarea').first().fill(front);
  await page.locator('textarea').nth(1).fill(back);
  await page.getByRole('button', { name: /save & add another/i }).click();
  await expect(page.getByText('Saved.').first()).toBeVisible({ timeout: 5000 });
}

test.describe('Deck edit', () => {
  test('renames a deck and overrides retention via the Tuning tab', async ({ page }) => {
    await wipe(page);
    const deckId = await createDeck(page, 'OldName');
    await page.goto(`/deck/${deckId}/edit`);
    await expect(page.getByRole('heading', { name: 'Edit deck' })).toBeVisible();

    // Info tab is the default — rename.
    const nameInput = page.locator('input').first();
    await nameInput.fill('NewName');

    // Switch to the Tuning tab and override retention. The slider is
    // directly interactive — no separate "click to override" toggle since
    // we moved to the direct-manipulation pattern; user-driven changes
    // auto-flip the override flag.
    await page.getByRole('button', { name: /^Tuning$/ }).click();
    const retentionRange = page.locator('input[type="range"]').first();
    await retentionRange.fill('0.85');

    await page.getByRole('button', { name: /^Save$/ }).click();
    await page.waitForURL(/\/deck\/[A-Z0-9]+$/);

    await expect(page.getByRole('heading', { name: 'NewName' })).toBeVisible();
  });

  test('rejects invalid FSRS weights JSON with an inline error', async ({ page }) => {
    await wipe(page);
    const deckId = await createDeck(page, 'Validate');
    await page.goto(`/deck/${deckId}/edit`);

    await page.getByRole('button', { name: /^Tuning$/ }).click();
    await page.getByRole('button', { name: /Show advanced/ }).click();

    const weightsBox = page.locator('textarea').first();
    await weightsBox.fill('not valid json');

    await page.getByRole('button', { name: /^Save$/ }).click();
    await expect(page.getByText(/Invalid JSON|Must be a JSON array/)).toBeVisible();
    // Should NOT have navigated away.
    await expect(page).toHaveURL(/\/edit$/);
  });

  test('delete from edit page wipes deck and returns home', async ({ page }) => {
    await wipe(page);
    const deckId = await createDeck(page, 'ToDelete');
    await page.goto(`/deck/${deckId}/edit`);
    await page.getByRole('button', { name: /^Delete deck$/ }).click();
    await page.getByRole('button', { name: /Yes, delete/ }).click();
    await page.waitForURL(/\/$/);
    await expect(page.getByText('No decks yet')).toBeVisible();
  });
});

test.describe('Reviewer extras (bury, suspend, undo, keyboard help)', () => {
  test('bury removes the card from current session', async ({ page }) => {
    await wipe(page);
    const deckId = await createDeck(page, 'BuryTest');
    await addBasicNote(page, deckId, 'A', 'a');
    await addBasicNote(page, deckId, 'B', 'b');

    await page.goto(`/study/${deckId}`);
    await expect(page.getByRole('button', { name: 'Reveal', exact: true })).toBeVisible();

    // Bury current card with B key.
    await page.keyboard.press('b');
    await expect(page.getByText('Buried until tomorrow.')).toBeVisible({ timeout: 3000 });

    // Should advance to the second card or show "Nothing due" depending on order.
    await expect(
      page.locator('text=/Reveal|Nothing due/').first(),
    ).toBeVisible({ timeout: 3000 });
  });

  test('? toggles keyboard help', async ({ page }) => {
    await wipe(page);
    const deckId = await createDeck(page, 'HelpTest');
    await addBasicNote(page, deckId, 'A', 'a');

    await page.goto(`/study/${deckId}`);
    await expect(page.getByRole('button', { name: 'Reveal', exact: true })).toBeVisible();
    await page.keyboard.press('?');
    await expect(page.getByRole('heading', { name: 'Keyboard' })).toBeVisible();

    // Click the overlay backdrop to close (KeyboardHelp closes on outer click).
    // Esc would also work but is owned by Reviewer's window handler when help is
    // up — we just want to verify a close path.
    await page.locator('button:has-text("Esc")').first().click();
    await expect(page.getByRole('heading', { name: 'Keyboard' })).not.toBeVisible();
  });

  test('undo restores prior FSRS state', async ({ page }) => {
    await wipe(page);
    const deckId = await createDeck(page, 'UndoTest');
    await addBasicNote(page, deckId, 'A', 'a');

    await page.goto(`/study/${deckId}`);
    await expect(page.getByRole('button', { name: 'Reveal', exact: true })).toBeVisible();
    await page.keyboard.press('Space');
    await expect(page.getByRole('button', { name: /Good/ })).toBeVisible();
    await page.keyboard.press('3'); // Good

    // Wait for the rate to fully apply. Empty-state title now varies by
    // reason: "Nothing due" when truly empty, "No cards due right now"
    // when learning steps are pending later. Matching either covers both
    // cases without coupling to one specific path.
    await expect(page.getByText(/Nothing due|No cards due right now/)).toBeVisible({ timeout: 5000 });

    // Undo should bring the card back.
    await page.keyboard.press('u');
    await expect(page.getByText('Undone.')).toBeVisible({ timeout: 3000 });
    await expect(page.getByRole('button', { name: 'Reveal', exact: true })).toBeVisible();
  });

  test('keyboard shortcuts are gated when typing in the AskAI textarea', async ({ page }) => {
    await wipe(page);
    // Seed a fake API key so the AskAI textarea is enabled and the test can type into it.
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
    });

    const deckId = await createDeck(page, 'AskGate');
    await addBasicNote(page, deckId, 'A', 'a');

    await page.goto(`/study/${deckId}`);
    await expect(page.getByRole('button', { name: 'Reveal', exact: true })).toBeVisible();
    await page.keyboard.press('a');
    await expect(page.getByRole('heading', { name: 'Ask' })).toBeVisible();

    const ta = page.locator('aside textarea');
    await expect(ta).toBeVisible();
    await ta.click();
    // Type a real key sequence; '1' would be a rating shortcut if the gate
    // didn't suppress it, so we expect it to land in the textarea instead.
    await page.keyboard.type('1 2 3');
    await expect(ta).toHaveValue('1 2 3');

    // Panel is still open (typing didn't trigger Reviewer's window shortcuts).
    await expect(page.getByRole('heading', { name: 'Ask' })).toBeVisible();

    // Esc closes the ask panel even with focus inside it. The panel slides
    // off-screen via translate; verify by class, not visibility.
    await page.keyboard.press('Escape');
    await expect(page.locator('aside').first()).toHaveClass(/translate-x-full/, { timeout: 3000 });
  });
});
