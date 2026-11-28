// Comments (docs/decisions/0082-annotations.md, step 2 and "Comments where the text is"), in the app:
// turned on for the workspace, a passage selected and commented on in a box beside it, the comment kept
// in the commenter's own file beside the document (a W3C AnnotationPage), never in the document; its
// thread opened from its 💬, replied to and edited there; the panel; a comment on the whole document;
// the workspace's newest; comments turned off and on again on their own; taken away again.
import { expect, test, type Page } from '@playwright/test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E } from './env.js';
import { openComponents } from './settings.js';

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${E2E.url}${path}`, { ...init, headers: { authorization: `Bearer ${E2E.token}`, 'content-type': 'application/json' } });
/** Everyone's annotations beside a document, from their own files. */
const annotations = (path: string): { motivation: string; body: { value: string }; target: unknown }[] => {
  const folder = join(E2E.dir, `${path}.annotations`);
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter((n) => /^@[0-9a-f]{64}\.jsonld$/.test(n)).flatMap((n) => JSON.parse(readFileSync(join(folder, n), 'utf8')).items);
};

async function annotationsOn(page: Page, on: boolean) {
  await openComponents(page);
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

  const editor = page.getByTestId('editor');
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

  // A passage selected, then Comment: a box just below it, the passage shown meanwhile; Enter saves.
  await editor.locator('p', { hasText: 'council' }).selectText();
  await page.getByTestId('annotations-comment').click();
  const box = page.getByTestId('comment-box');
  await expect(box).toBeVisible();
  await expect(editor.locator('.kuraa-now')).toHaveText('After the flood, I never trusted the council.');
  await page.keyboard.type('Which council: the old one or the new?');
  await page.keyboard.press('Enter');
  await expect(box).toHaveCount(0);
  await expect(editor.locator('.kuraa-commented')).toHaveText('After the flood, I never trusted the council.');
  // Its mark: a speech bubble drawn as line art (0129), in the commenter's colour.
  await expect(page.getByTestId('feature-mark').locator('svg path')).toHaveCount(1);
  await expect(page.getByTestId('feature-mark')).toHaveText('');
  // Kept in the commenter's own file, as a W3C annotation; the document as it was.
  await expect.poll(() => annotations(path).map((a) => a.body.value)).toEqual(['Which council: the old one or the new?']);
  expect(annotations(path)[0]!.motivation).toBe('commenting');
  expect(readFileSync(join(E2E.dir, path), 'utf8')).toBe(TEXT);
  await expect(page.locator(`[data-testid^="file:${path}.annotations/"]`)).toHaveCount(0);

  // Its 💬: the thread, below the passage, to reply to at once; then the comment edited there.
  await page.getByTestId('feature-mark').click();
  const card = page.getByTestId('comment-thread');
  await expect(card.getByTestId('thread-comment')).toContainText('Which council: the old one or the new?');
  await page.keyboard.type('The new one, she said later.');
  await page.keyboard.press('Enter');
  await expect(card.getByTestId('thread-reply')).toContainText('The new one');
  await expect(card.getByTestId('thread-reply-text')).toHaveValue('');
  await card.getByTestId('thread-comment').getByTestId('thread-edit-button').click();
  await card.getByTestId('thread-edit').fill('Which council, exactly?');
  await card.getByTestId('thread-edit').press('Enter');
  await expect(card.getByTestId('thread-comment')).toContainText('Which council, exactly?');
  await expect(card.getByTestId('thread-comment')).toContainText('edited');
  await expect.poll(() => annotations(path).length).toBe(2);
  // Esc closes it.
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);

  // A comment begun (⌥⌘M) and clicked away from: kept open while something is typed in it; Esc drops it.
  await editor.locator('p', { hasText: 'Nobody' }).selectText();
  await page.keyboard.press(`${mod}+Alt+m`);
  await expect(box).toBeVisible();
  await page.keyboard.type('Half a thought');
  await editor.locator('h1', { hasText: 'Interview' }).click();
  await expect(box).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(box).toHaveCount(0);
  await expect(page.getByTestId('feature-mark')).toHaveCount(1);

  // The panel (⌥⌘K): the thread, its passage quoted, its reply.
  await editor.locator('p', { hasText: 'Nobody' }).click();
  await page.keyboard.press(`${mod}+Alt+k`);
  const panel = page.getByTestId('feature-panel-annotations-comments');
  const thread = panel.getByTestId('annotations-thread');
  await expect(thread).toHaveCount(1);
  await expect(thread.getByTestId('annotations-quote')).toHaveText('“After the flood, I never trusted the council.”');
  await expect(thread.getByTestId('annotations-reply')).toContainText('The new one');

  // On the document as a whole.
  await panel.getByTestId('annotations-on-document').click();
  await panel.getByTestId('annotations-text-new').fill('A short interview: ask for more.');
  await panel.getByTestId('annotations-save').click();
  await expect(panel.getByTestId('annotations-thread')).toHaveCount(2);
  await expect(panel.getByTestId('annotations-thread').first()).toContainText('On the document');
  await expect.poll(() => annotations(path).length).toBe(3);

  // The workspace's newest, from the link at the top of the document's comments; and back.
  await page.getByTestId('annotations-to-recent').click();
  const recent = page.getByTestId('feature-panel-annotations-recent');
  await expect(recent.getByTestId('annotations-recent-row').first()).toBeVisible();
  await expect(recent).toContainText('A short interview');
  await recent.getByTestId('annotations-to-comments').click();
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Close Comments' }).click();
  await expect(panel).toHaveCount(0);

  // Comments off on their own (under Annotations, in the list of features): nothing of them shown, coding's switch beside it.
  await openComponents(page);
  await expect(page.getByTestId('annotations-coding')).toBeVisible();
  let saved = page.waitForResponse((r) => r.url().endsWith('/api/features/annotations') && r.request().method() === 'PATCH');
  await page.getByTestId('annotations-comments').uncheck();
  expect((await saved).status()).toBe(200);
  await page.getByTestId('settings-close').click();
  await expect(page.getByTestId('feature-mark')).toHaveCount(0);
  await expect(editor.locator('.kuraa-commented')).toHaveCount(0);
  await editor.locator('p', { hasText: 'council' }).selectText();
  // Nothing beside the selection: coding is off here too.
  await expect(page.getByTestId('selection-actions')).toHaveCount(0);
  await openComponents(page);
  saved = page.waitForResponse((r) => r.url().endsWith('/api/features/annotations') && r.request().method() === 'PATCH');
  await page.getByTestId('annotations-comments').check();
  expect((await saved).status()).toBe(200);
  await page.getByTestId('settings-close').click();
  await expect(page.getByTestId('feature-mark')).toHaveCount(1);

  // The comments again (⌥⌘K), and one taken away: its reply stays, no longer found with it gone.
  await editor.locator('p', { hasText: 'Nobody' }).click();
  await page.keyboard.press(`${mod}+Alt+k`);
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
