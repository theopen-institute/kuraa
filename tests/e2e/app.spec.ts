// The parts of the app around the editor: first-run settings, settings from the
// menu, saving a named version, and reading a past version as rendered or source.
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { E2E, NOTES } from './env.js';

const MAC = process.platform === 'darwin';

async function createNotes(): Promise<string> {
  const path = `runs/app-${Date.now().toString(36)}.md`;
  const res = await fetch(`${E2E.url}/api/files`, {
    method: 'POST',
    headers: { authorization: `Bearer ${E2E.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ path, content: NOTES }),
  });
  expect(res.status).toBe(201);
  return path;
}

async function openFile(page: Page, path: string): Promise<void> {
  await page.getByTestId(`file:${path}`).click();
  await expect(page.getByTestId('editor')).toBeVisible();
  await expect(page.getByTestId('status')).toContainText('Connected');
}

test('the first run asks for settings; the menu changes them', async ({ page }) => {
  const path = await createNotes();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.getByLabel('Display name')).toBeFocused();
  await expect(page.getByLabel('Host URL')).toHaveValue(E2E.url);
  await expect(page.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
  await page.getByLabel('Display name').fill('First Run');
  await page.getByLabel('Access token').fill(E2E.token);
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByTestId('workspace-name')).toHaveText('kuraa-e2e-workspace');

  await openFile(page, path);
  await expect(page.getByTestId('peers')).toHaveText('First Run (you)');

  // A new name, from the menu, reaches the others at once (and is kept).
  await page.getByTestId('menu-button').click();
  await expect(page.getByTestId('menu').getByLabel('Display name')).toHaveValue('First Run');
  await page.getByTestId('menu').getByLabel('Display name').fill('Renamed');
  await page.getByTestId('menu').getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByTestId('menu')).toHaveCount(0);
  await expect(page.getByTestId('peers')).toHaveText('Renamed (you)');
  await page.reload();
  await openFile(page, path);
  await expect(page.getByTestId('peers')).toHaveText('Renamed (you)');
});

test('a named version is committed; a past version reads as rendered or source', async ({ page }) => {
  const path = await createNotes();
  await page.goto(`/?token=${E2E.token}&name=Versions&email=v%40example.org`);
  await openFile(page, path);
  await page.getByTestId('editor').locator('p', { hasText: 'Light rain' }).click();
  await page.keyboard.press(MAC ? 'Meta+ArrowRight' : 'End');
  await page.waitForTimeout(100);
  await page.keyboard.type(' Clearer by noon.');

  await page.getByTestId('menu-button').click();
  await page.getByTestId('menu').getByRole('button', { name: 'Save version…' }).click();
  await page.getByTestId('ask').locator('input').fill('Checkpoint');
  await page.getByTestId('ask').getByRole('button', { name: 'Save version' }).click();
  await expect(page.getByTestId('notice')).toContainText('Saved version “Checkpoint”.');
  expect(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: E2E.dir, encoding: 'utf8' }).trim()).toBe('Checkpoint');

  await page.getByTestId('menu-button').click();
  await page.getByTestId('menu').getByRole('button', { name: 'History' }).click();
  const history = page.getByTestId('history').locator('li');
  await expect(history.first()).toContainText('Checkpoint');
  await history.last().click();
  const past = page.getByTestId('past-version');
  await expect(past).toContainText('refractometer');
  await expect(past).not.toContainText('Clearer by noon.');
  await expect(past).not.toContainText('*refractometer*');
  await past.getByRole('button', { name: 'Source' }).click();
  await expect(past).toContainText('*refractometer*');
  await past.getByRole('button', { name: 'Rendered' }).click();
  await expect(past).not.toContainText('*refractometer*');
  await past.getByRole('button', { name: 'Back to live' }).click();
  await expect(past).toHaveCount(0);
  await expect(page.getByTestId('editor')).toContainText('Clearer by noon.');
});
