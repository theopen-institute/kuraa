// The hooks features have (0087, 0091), through the example feature (marks): a
// command with keys, bound by the core in the editor and listed on the shortcuts
// sheet; a menu item that names a command; a navigation view, with an item in
// ＋; and a layout of its own, which gives no navigation (the core's menu at the
// upper left stays).
import { expect, test, type Page } from '@playwright/test';
import { E2E } from './env.js';
import { openComponents } from './settings.js';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const api = (path: string, init: RequestInit = {}) =>
  fetch(`${E2E.url}${path}`, { ...init, headers: { authorization: `Bearer ${E2E.token}`, 'content-type': 'application/json' } });

async function marksOn(page: Page, on: boolean) {
  await openComponents(page);
  const box = page.getByTestId('feature-marks');
  await expect(box).toBeVisible();
  const saved = page.waitForResponse((r) => r.url().endsWith('/api/features/marks') && r.request().method() === 'PATCH');
  if (on) await box.check();
  else await box.uncheck();
  expect((await saved).status()).toBe(200);
  await page.getByTestId('settings-close').click();
}

test('a feature’s commands, view, item in ＋ and layout', async ({ page }) => {
  const id = Date.now().toString(36);
  const path = `hooks-${id}.md`;
  expect((await api('/api/files', { method: 'POST', body: JSON.stringify({ path, content: `---\ntitle: Hooks ${id}\n---\n\nThe tide came in.\n` }) })).status).toBe(201);
  page.on('pageerror', (e) => console.error(`page error: ${e.message}`));
  await page.goto(`/?token=${E2E.token}&name=Ada`);
  await page.getByTestId(`file:${path}`).click();
  await expect(page.getByTestId('status')).toContainText('Connected');
  await marksOn(page, true);
  await expect(page.locator('.editor-scroll[data-features="marks"]')).toBeVisible();

  // A command done in the document, by its keys (the core binds them in the editor).
  await page.getByTestId('editor').locator('p', { hasText: 'tide' }).selectText();
  await page.keyboard.press(`${MOD}+Alt+KeyY`);
  await expect(page.getByTestId('editor').locator('.example-mark')).toHaveText('The tide came in.');

  // On the sheet, under the feature's heading: the command's keys and the panel's.
  await page.keyboard.press(`${MOD}+Slash`);
  const sheet = page.getByTestId('help:Marks (example)');
  await expect(sheet).toContainText('Mark the selected text');
  await expect(sheet).toContainText('Show the marks in this document');
  await page.keyboard.press('Escape');

  // A menu item that names a command: its label and keys are the command's.
  await page.getByTestId('document-menu-button').click();
  await expect(page.getByTestId('menu-example-marks')).toContainText('Marks');
  await page.getByTestId('menu-example-marks').click();
  await expect(page.getByTestId('feature-panel-marks-marks')).toBeVisible();

  // A navigation view, in the sidebar beside the file tree; its item in ＋, a command done anywhere.
  await page.getByTestId('sidebar-view:marks:marked').click();
  await expect(page.getByTestId(`example-view:${path}`)).toHaveText(`Hooks ${id}`);
  // ＋ makes a document at once (0097); its menu, with what views add, right-clicked.
  await page.getByTestId('new-menu').click({ button: 'right' });
  await page.getByTestId('context:example-hello').click();
  await expect(page.getByTestId('notice')).toContainText('Hello from Marks (example).');

  // Its layout, where this browser names it: no navigation of its own, so the core's menu at the upper left.
  await page.evaluate(() => localStorage.setItem('kuraa:layout', 'example-bar'));
  await page.reload();
  await expect(page.getByTestId('example-layout')).toBeVisible();
  await expect(page.getByTestId('fallback-menu')).toBeVisible();
  await page.getByTestId('example-layout-view:marks:marked').click();
  await expect(page.getByTestId(`example-view:${path}`)).toBeVisible();
  await page.evaluate(() => localStorage.removeItem('kuraa:layout'));
  await page.reload();
  await expect(page.getByTestId('example-layout')).toHaveCount(0);
  await expect(page.getByTestId('fallback-menu')).toHaveCount(0);

  await marksOn(page, false);
});

// Running code is a component (0092): the code session's lines in the document's menu, and its
// Packages dialog, opened from Settings › Workspace over the Settings window, which stays beneath it.
test('Running code: the session in the document’s menu, and Packages over Settings', async ({ page }) => {
  const path = `runs/code-${Date.now().toString(36)}.Rmd`;
  expect((await api('/api/files', { method: 'POST', body: JSON.stringify({ path, content: '# Code\n\n```{r}\n1 + 1\n```\n' }) })).status).toBe(201);
  await page.goto(`/?token=${E2E.token}&name=Ada`);
  await page.getByTestId(`file:${path}`).click();
  await expect(page.getByTestId('status')).toContainText('Connected');

  await page.getByTestId('document-menu-button').click();
  await expect(page.getByTestId('r-state')).toContainText('R ');
  await expect(page.getByTestId('menu-run-all')).toBeVisible();
  await expect(page.getByTestId('menu-packages')).toHaveText('Packages…');
  await page.keyboard.press('Escape');

  await openComponents(page);
  await page.getByTestId('settings-packages').click();
  const dialog = page.getByTestId('packages');
  await expect(dialog.getByRole('heading')).toHaveText('R packages');
  await expect(page.getByTestId('settings-window')).toBeVisible();
  // Escape closes the dialog, not the window beneath it.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('settings-window')).toBeVisible();
  await page.getByTestId('settings-close').click();
});
