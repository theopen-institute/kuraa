// The parts of the app around the editor: the first run's welcome, settings from
// the menu, saving a named version, and reading a past version as rendered or source.
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

test('the first run welcomes you and asks your name; the menu changes it', async ({ page }) => {
  const path = await createNotes();
  await page.goto('/');
  await expect(page.getByRole('dialog', { name: 'Welcome to kuraa' })).toBeVisible();
  await expect(page.getByText('What should we call you?')).toBeVisible();
  await expect(page.getByLabel('Your name')).toBeFocused();
  // No link brought the server's address and access code, so they are asked for too.
  await expect(page.getByLabel('Server address')).toHaveValue(E2E.url);
  await expect(page.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
  await page.getByLabel('Your name').fill('First Run');
  await page.getByLabel('Access code').fill(E2E.token);
  await page.getByRole('button', { name: 'Start writing' }).click();
  await expect(page.getByTestId('workspace-name')).toHaveText('kuraa-e2e-workspace');

  await openFile(page, path);
  await expect(page.getByTestId('peers')).toHaveText('First Run (you)');

  // A new name, from Settings (⌘,: at the open document, decision 0065), reaches the others at once (and is kept).
  await page.keyboard.press('ControlOrMeta+,');
  await expect(page.getByTestId('settings-tab-document')).toHaveAttribute('aria-current', 'page');
  await page.getByTestId('settings-tab-you').click();
  const settings = page.getByTestId('settings-window');
  // The server and its access code are there too, with a button of their own.
  await expect(settings.getByTestId('settings-connection').getByLabel('Server address')).toHaveValue(E2E.url);
  await expect(settings.getByTestId('settings-connection').getByLabel('Access code')).toHaveValue(E2E.token);
  await expect(settings.getByTestId('settings-you').getByLabel('Your name')).toHaveValue('First Run');
  // Saved as it is changed: there is no save button, and the window stays open.
  await expect(settings.getByRole('button', { name: 'Save settings' })).toHaveCount(0);
  await settings.getByLabel('Your name').fill('Renamed');
  await settings.getByLabel('Your name').press('Enter');
  await expect(page.getByTestId('peers')).toHaveText('Renamed (you)');
  await expect(settings).toBeVisible();
  // A name emptied goes back to the one saved.
  await settings.getByLabel('Your name').fill('');
  await settings.getByLabel('Your name').press('Tab');
  await expect(settings.getByLabel('Your name')).toHaveValue('Renamed');
  // Still being typed when the window closes: kept.
  await settings.getByLabel('Your name').fill('Renamed Again');
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  await expect(page.getByTestId('peers')).toHaveText('Renamed Again (you)');
  await page.reload();
  await openFile(page, path);
  await expect(page.getByTestId('peers')).toHaveText('Renamed Again (you)');
});

test('a named version is committed; a past version reads as rendered or source', async ({ page }) => {
  const path = await createNotes();
  await page.goto(`/?token=${E2E.token}&name=Versions&email=v%40example.org`);
  await openFile(page, path);
  await page.getByTestId('editor').locator('p', { hasText: 'Light rain' }).click();
  await page.keyboard.press(MAC ? 'Meta+ArrowRight' : 'End');
  await page.waitForTimeout(100);
  await page.keyboard.type(' Clearer by noon.');

  await page.getByTestId('document-menu-button').click();
  await page.getByTestId('document-menu').getByRole('menuitem', { name: 'Save version…' }).click();
  await page.getByTestId('ask').locator('input').fill('Checkpoint');
  await page.getByTestId('ask').getByRole('button', { name: 'Save version' }).click();
  await expect(page.getByTestId('notice')).toContainText('Saved version “Checkpoint”.');
  expect(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: E2E.dir, encoding: 'utf8' }).trim()).toBe('Checkpoint');

  await page.getByTestId('document-menu-button').click();
  await page.getByTestId('document-menu').getByRole('menuitemcheckbox', { name: 'History' }).click();
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
