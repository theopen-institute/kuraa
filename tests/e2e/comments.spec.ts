// Comments (docs/decisions/0082-annotations.md, step 2), in the app: turned on for the workspace, a
// passage selected and commented on, the comment kept in the commenter's own file beside the document
// (a W3C AnnotationPage), never in the document; replied to, edited, a comment on the whole document,
// the workspace's newest, and taken away again.
import { expect, test, type Page } from '@playwright/test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E } from './env.js';
import { openSettings } from './settings.js';

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${E2E.url}${path}`, { ...init, headers: { authorization: `Bearer ${E2E.token}`, 'content-type': 'application/json' } });
/** Everyone's annotations beside a document, from their own files. */
const annotations = (path: string): { motivation: string; body: { value: string }; target: unknown }[] => {
  const folder = join(E2E.dir, `${path}.annotations`);
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter((n) => /^@[0-9a-f]{64}\.jsonld$/.test(n)).flatMap((n) => JSON.parse(readFileSync(join(folder, n), 'utf8')).items);
};

async function annotationsOn(page: Page, on: boolean) {
  await openSettings(page);
  const box = page.getByTestId('feature-annotations');
  const saved = page.waitForResponse((r) => r.url().endsWith('/api/features/annotations') && r.request().method() === 'PATCH');
  if (on) await box.check();
  else await box.uncheck();
  expect((await saved).status()).toBe(200);
  await page.getByTestId('settings-close').click();
}

test('comments: on a passage and on the document, replied to, edited, kept beside the document, never in it', async ({ page }) => {
  const path = `comments-${Date.now().toString(36)}.md`;
  const TEXT = '# Interview\n\nAfter the flood, I never trusted the council.\n\nNobody came for us.\n';
  expect((await api('/api/files', { method: 'POST', body: JSON.stringify({ path, content: TEXT }) })).status).toBe(201);
  page.on('pageerror', (e) => console.error(`page error: ${e.message}`));
  await page.goto(`/?token=${E2E.token}&name=Ada`);
  await page.getByTestId(`file:${path}`).click();
  await expect(page.getByTestId('status')).toContainText('Connected');

  await annotationsOn(page, true);
  await expect(page.locator('.editor-scroll[data-features~="annotations"]')).toBeVisible();

  // A passage selected, then Comment: the panel opens with it, to write in.
  await page.getByTestId('editor').locator('p', { hasText: 'council' }).selectText();
  await page.getByTestId('annotations-comment').click();
  const panel = page.getByTestId('feature-panel-annotations-comments');
  await panel.getByTestId('annotations-text-new').fill('Which council: the old one or the new?');
  await panel.getByTestId('annotations-save').click();
  const thread = panel.getByTestId('annotations-thread');
  await expect(thread).toHaveCount(1);
  await expect(thread).toContainText('Which council');
  // About its passage (quoted, to go to), not the document.
  await expect(thread.getByTestId('annotations-quote')).toHaveText('“After the flood, I never trusted the council.”');
  // Typing in the panel, nothing is offered beside the selection.
  await expect(page.getByTestId('selection-actions')).toHaveCount(0);
  await expect(page.getByTestId('editor').locator('.kuraa-commented')).toHaveText('After the flood, I never trusted the council.');
  await expect(page.getByTestId('feature-mark')).toHaveText('💬');
  // Kept in the commenter's own file, as a W3C annotation; the document as it was.
  await expect.poll(() => annotations(path).map((a) => a.body.value)).toEqual(['Which council: the old one or the new?']);
  expect(annotations(path)[0]!.motivation).toBe('commenting');
  expect(readFileSync(join(E2E.dir, path), 'utf8')).toBe(TEXT);
  await expect(page.locator(`[data-testid^="file:${path}.annotations/"]`)).toHaveCount(0);

  // A reply, then the comment edited.
  await thread.getByTestId('annotations-reply-button').click();
  await panel.getByTestId('annotations-text-reply').fill('The new one, she said later.');
  await panel.getByTestId('annotations-save').click();
  await expect(thread.getByTestId('annotations-reply')).toContainText('The new one');
  await thread.getByTestId('annotations-comment-row').getByTestId('annotations-edit').click();
  await panel.getByTestId('annotations-text-edit').fill('Which council, exactly?');
  await panel.getByTestId('annotations-save').click();
  await expect(thread.getByTestId('annotations-comment-row')).toContainText('Which council, exactly?');
  await expect(thread.getByTestId('annotations-comment-row')).toContainText('edited');

  // On the document as a whole.
  await panel.getByTestId('annotations-on-document').click();
  await panel.getByTestId('annotations-text-new').fill('A short interview: ask for more.');
  await panel.getByTestId('annotations-save').click();
  await expect(panel.getByTestId('annotations-thread')).toHaveCount(2);
  await expect(panel.getByTestId('annotations-thread').first()).toContainText('On the document');
  await expect.poll(() => annotations(path).length).toBe(3);

  // The workspace's newest, from the document's menu.
  await page.getByTestId('document-menu-button').click();
  await page.getByTestId('menu-recent-comments').click();
  const recent = page.getByTestId('feature-panel-annotations-recent');
  await expect(recent.getByTestId('annotations-recent-row').first()).toBeVisible();
  await expect(recent).toContainText('A short interview');

  // The comments again (⌥⌘K), and one taken away: its reply stays, no longer found with it gone.
  await page.getByTestId('editor').locator('p', { hasText: 'Nobody' }).click();
  await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+Alt+k`);
  await expect(panel).toBeVisible();
  await panel.getByTestId('annotations-thread').nth(1).getByTestId('annotations-comment-row').getByTestId('annotations-delete').click();
  await expect(panel.getByTestId('annotations-thread')).toHaveCount(1);
  await expect(panel.getByTestId('annotations-lost')).toContainText('No longer found (1)');
  await expect.poll(() => annotations(path).length).toBe(2);

  // Off for the workspace: nothing of it shown, what was made kept.
  await annotationsOn(page, false);
  await expect(page.getByTestId('feature-mark')).toHaveCount(0);
  expect(annotations(path)).toHaveLength(2);
  expect(readFileSync(join(E2E.dir, path), 'utf8')).toBe(TEXT);
  await api(`/api/files?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
});
