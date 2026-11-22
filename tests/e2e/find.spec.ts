// Finding your way in a document: ⌘F finds and replaces (replacing is ordinary
// editing, so the other person sees it), ⌥⌘O shows the outline, following the
// document, and a file's conflict count opens it at its first conflict.
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E } from './env.js';

const MAC = process.platform === 'darwin';
const MOD = MAC ? 'Meta' : 'Control';

const create = async (path: string, content: string) => {
  const res = await fetch(`${E2E.url}/api/files`, {
    method: 'POST',
    headers: { authorization: `Bearer ${E2E.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ path, content }),
  });
  expect(res.status).toBe(201);
};

test('find and replace in the document, seen by everyone', async ({ browser }) => {
  const path = `find-${Date.now().toString(36)}.md`;
  await create(path, '# Tides\n\nThe tide came in. The Tide went out.\n\nNo tide today.\n');
  const open = async (name: string) => {
    const page = await (await browser.newContext()).newPage();
    page.on('pageerror', (e) => console.error(`page error: ${e.message}`));
    await page.goto(`/?token=${E2E.token}&name=${name}`);
    await page.getByTestId(`file:${path}`).click();
    await expect(page.getByTestId('status')).toContainText('Connected');
    return page;
  };
  const ada = await open('Ada');
  const bo = await open('Bo');
  await ada.getByTestId('editor').locator('p').first().click();
  await ada.keyboard.press(`${MOD}+f`);
  const bar = ada.getByTestId('find-bar');
  await expect(bar).toBeVisible();
  await ada.getByTestId('find-input').fill('tide');
  await expect(ada.getByTestId('find-count')).toHaveText('1 of 4');
  await expect(ada.getByTestId('editor').locator('.find-match')).toHaveCount(4);
  await ada.getByTestId('find-case').click();
  await expect(ada.getByTestId('find-count')).toHaveText(/of 2$/);
  await ada.getByTestId('find-case').click();
  await ada.keyboard.press('Enter');
  await expect(ada.getByTestId('find-count')).toHaveText('2 of 4');
  await ada.keyboard.press('Shift+Enter');
  await expect(ada.getByTestId('find-count')).toHaveText('1 of 4');

  await ada.getByTestId('find-toggle-replace').click();
  await ada.getByTestId('replace-input').fill('sea');
  await ada.getByTestId('replace-one').click(); // the match the cursor is on
  await expect(ada.getByTestId('find-count')).toHaveText(/of 3$/);
  await ada.getByTestId('replace-all').click();
  await expect(ada.getByTestId('find-count')).toHaveText('None');
  await expect(bo.getByTestId('editor')).toContainText('The sea came in. The sea went out.');
  await expect(bo.getByTestId('editor')).toContainText('No sea today.');
  await ada.keyboard.press('Escape');
  await expect(bar).toBeHidden();
  await expect(ada.getByTestId('editor').locator('.find-match')).toHaveCount(0);

  const file = join(E2E.dir, path);
  await expect.poll(() => readFileSync(file, 'utf8'), { timeout: 10_000 }).toContain('No sea today.');
  expect(readFileSync(file, 'utf8')).toContain('# seas\n');
});

test('the outline lists the headings, follows the document and goes to them', async ({ page }) => {
  const path = `outline-${Date.now().toString(36)}.md`;
  await create(path, `# Introduction\n\n${'Words. '.repeat(400)}\n\n## Methods\n\n${'More words. '.repeat(400)}\n\n## Results\n\nSome.\n`);
  await page.goto(`/?token=${E2E.token}&name=Outliner`);
  await page.getByTestId(`file:${path}`).click();
  await expect(page.getByTestId('status')).toContainText('Connected');
  const editor = page.getByTestId('editor');
  await editor.locator('h1:not(.doc-title)').click();
  await page.keyboard.press(`${MOD}+Alt+o`);
  const outline = page.getByTestId('outline');
  await expect(outline.locator('button.outline-entry')).toHaveText(['Introduction', 'Methods', 'Results']);
  await outline.getByTestId('outline:Results').click();
  await expect(editor.locator('h2', { hasText: 'Results' })).toBeInViewport();
  await page.keyboard.type(' and discussion');
  await expect(outline.getByTestId('outline:Results and discussion')).toHaveClass(/current/);
  await page.keyboard.press(`${MOD}+Alt+o`);
  await expect(outline).toBeHidden();

  // From the menu too.
  await page.getByTestId('document-menu-button').click();
  await page.getByTestId('menu-outline').click();
  await expect(outline).toBeVisible();
});

test('a file’s conflict count opens it at the first conflict, labelled by who and when', async ({ page }) => {
  const head = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: E2E.dir, encoding: 'utf8' }).trim();
  const version = (by: string, text: string) => `::: {.version by="${by}" commit="${head}"}\n${text}\n:::`;
  const conflict = (a: string, b: string) => `:::: {.conflict}\n${version('Ada', a)}\n\n${version('Bo', b)}\n::::`;
  const path = `conflicted-${Date.now().toString(36)}.md`;
  await create(path, `# Notes\n\n${'Filler. '.repeat(500)}\n\n${conflict('First A.', 'First B.')}\n\n${'Filler. '.repeat(500)}\n\n${conflict('Second A.', 'Second B.')}\n`);
  await page.goto(`/?token=${E2E.token}&name=Navigator`);
  await page.getByTestId(`conflicts:${path}`).click();
  const editor = page.getByTestId('editor');
  await expect(page.getByTestId('status')).toContainText('Connected');
  const conflicts = editor.getByTestId('conflict');
  await expect(conflicts.first()).toBeInViewport();
  await expect(conflicts.first().getByTestId('conflict-by').first()).toHaveText(/^Ada, .+ at .+/);
  // The next one, and round to the first again.
  await page.keyboard.press(`${MOD}+Alt+n`);
  await expect(conflicts.nth(1)).toBeInViewport();
  await page.keyboard.press(`${MOD}+Alt+n`);
  await expect(conflicts.first()).toBeInViewport();
});
