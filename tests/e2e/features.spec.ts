// Features (docs/decisions/0082-annotations.md), in the app, through the example
// feature (marks), which the tests' build and host have: off until the workspace
// turns it on; then in the document (Mark beside a selection, the marks shown in
// the text and the margin, kept beside the document and never in it), in its
// panel from the document's menu, in a file's menu, on the shortcuts sheet, in
// Settings (the workspace's switch and its settings, and hiding it for yourself),
// and off again, leaving what it made.
import { expect, test, type Page } from '@playwright/test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E } from './env.js';
import { openSettings } from './settings.js';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const api = (path: string, init: RequestInit = {}) =>
  fetch(`${E2E.url}${path}`, { ...init, headers: { authorization: `Bearer ${E2E.token}`, 'content-type': 'application/json' } });
/** Everyone's marks beside a document: each person's own file, in the folder beside it (0082). */
const marksIn = (path: string): { quote: string }[] => {
  const folder = join(E2E.dir, `${path}.marks`);
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter((n) => /^@[0-9a-f]{64}\.json$/.test(n)).flatMap((n) => (JSON.parse(readFileSync(join(folder, n), 'utf8')) as { marks: { quote: string }[] }).marks);
};

async function workspaceFeature(page: Page, on: boolean) {
  await openSettings(page);
  const box = page.getByTestId('feature-marks');
  await expect(box).toBeVisible();
  // Saved in the workspace (committed) before it says so.
  const saved = page.waitForResponse((r) => r.url().endsWith('/api/features/marks') && r.request().method() === 'PATCH');
  if (on) await box.check();
  else await box.uncheck();
  expect((await saved).status()).toBe(200);
  await expect(box).toBeChecked({ checked: on });
  await page.getByTestId('settings-close').click();
}

test('a feature: on for the workspace, in the document, its panel, menus and settings, and off again', async ({ page }) => {
  const path = `marks-${Date.now().toString(36)}.md`;
  const TEXT = '# Marks\n\nThe tide came in before dawn.\n';
  expect((await api('/api/files', { method: 'POST', body: JSON.stringify({ path, content: TEXT }) })).status).toBe(201);
  page.on('pageerror', (e) => console.error(`page error: ${e.message}`));
  await page.goto(`/?token=${E2E.token}&name=Ada`);

  // Off for the workspace: nothing of it in the document.
  await page.getByTestId(`file:${path}`).click();
  await expect(page.getByTestId('status')).toContainText('Connected');
  const para = page.getByTestId('editor').locator('p', { hasText: 'tide' });
  await para.selectText();
  await expect(page.getByTestId('selection-actions')).toHaveCount(0);

  // On for the workspace (saved in it, for everyone): the document opens again with it; Mark beside a selection.
  await workspaceFeature(page, true);
  await expect(page.locator('.editor-scroll[data-features="marks"]')).toBeVisible();
  await expect(page.getByTestId('status')).toContainText('Connected');
  await para.selectText();
  await page.getByTestId('example-mark-selection').click();
  await expect(page.getByTestId('editor').locator('.example-mark')).toHaveText('The tide came in before dawn.');
  await expect(page.getByTestId('feature-mark')).toHaveCount(1);
  // Kept beside the document, never in it; the file list shows it with its document, not apart.
  await expect.poll(() => marksIn(path).map((m) => m.quote)).toEqual(['The tide came in before dawn.']);
  expect(readFileSync(join(E2E.dir, path), 'utf8')).toBe(TEXT);
  await expect(page.locator(`[data-testid^="file:${path}.marks/"]`)).toHaveCount(0);

  // An item of its own in the file's menu.
  await page.getByTestId(`file:${path}`).click({ button: 'right' });
  await expect(page.getByTestId('context:example-clear-marks')).toBeVisible();
  await page.keyboard.press('Escape');

  // Its panel, from the document's menu: the mark, and removing it.
  await page.getByTestId('document-menu-button').click();
  await page.getByTestId('menu-example-marks').click();
  const panel = page.getByTestId('feature-panel-marks-marks');
  await expect(panel.getByTestId('example-mark-row')).toHaveCount(1);
  // Its keys close it again, and open it.
  await page.keyboard.press(`${MOD}+Alt+m`);
  await expect(panel).toHaveCount(0);
  await page.keyboard.press(`${MOD}+Alt+m`);
  await expect(panel.getByTestId('example-mark-row')).toHaveCount(1);

  // Its line on the shortcuts sheet.
  await page.keyboard.press(`${MOD}+/`);
  await expect(page.getByTestId('help')).toContainText('Show the marks in this document');
  await page.keyboard.press('Escape');

  // Hidden for you (in this browser): gone from the page, on for everyone else.
  await openSettings(page);
  await page.getByTestId('settings-tab-you').click();
  await page.getByTestId('feature-shown-marks').uncheck();
  await page.getByTestId('settings-close').click();
  await expect(page.getByTestId('feature-mark')).toHaveCount(0);
  await expect(page.getByTestId('editor').locator('.example-mark')).toHaveCount(0);
  expect(marksIn(path)).toHaveLength(1);
  await openSettings(page);
  await page.getByTestId('settings-tab-you').click();
  await page.getByTestId('feature-shown-marks').check();
  await page.getByTestId('settings-close').click();
  await expect(page.getByTestId('feature-mark')).toHaveCount(1);

  // Its settings for the workspace, drawn by it in Settings › Workspace.
  await openSettings(page);
  await page.getByTestId('open-feature-marks').click();
  await page.getByTestId('example-marks-label').fill('✱');
  await page.getByTestId('example-marks-save').click();
  await page.getByTestId('settings-close').click();
  await expect(page.getByTestId('feature-mark')).toHaveText('✱');
  await expect.poll(() => JSON.parse(readFileSync(join(E2E.dir, '.kuraa/features.json'), 'utf8')).marks?.label).toBe('✱');

  // Removed in its panel (still open: it stays while the document does): no marks left, so nothing is kept beside the document.
  await expect(panel).toBeVisible();
  await panel.getByTestId('example-mark-remove').click();
  await expect(page.getByTestId('feature-mark')).toHaveCount(0);
  await expect.poll(() => marksIn(path)).toEqual([]);

  // Off for the workspace again: nothing of it shown, the document as it was.
  await workspaceFeature(page, false);
  await expect(page.getByTestId('status')).toContainText('Connected');
  await expect(page.getByTestId('document-menu-button')).toBeVisible();
  await page.getByTestId('document-menu-button').click();
  await expect(page.getByTestId('menu-example-marks')).toHaveCount(0);
  await page.keyboard.press('Escape');
  expect(readFileSync(join(E2E.dir, path), 'utf8')).toBe(TEXT);
  await api(`/api/files?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
});
