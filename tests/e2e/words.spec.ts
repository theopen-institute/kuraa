// Word counts and document details (docs/decisions/0094-word-counts-and-document-details.md):
// the open document's words along its foot, counted as it is typed, and the
// day's; a target for it set in the Words panel, kept in its header; its
// details set in the Details panel, kept in its header, its label's colour by
// it in the file tree; its folder's words in Compile, against a book target.
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E } from './env.js';

const MAC = process.platform === 'darwin';
const api = (path: string, init: RequestInit = {}) =>
  fetch(`${E2E.url}${path}`, { ...init, headers: { authorization: `Bearer ${E2E.token}`, 'content-type': 'application/json' } });
const readIn = (p: string) => {
  try {
    return readFileSync(join(E2E.dir, p), 'utf8');
  } catch {
    return '';
  }
};

test('words counted as typed, a document’s target and details kept in its header, a folder’s words in Compile', async ({ page }) => {
  const id = Date.now().toString(36);
  const folder = `words-${id}`;
  const path = `${folder}/a.md`;
  expect((await api('/api/files', { method: 'POST', body: JSON.stringify({ path, content: '---\ntitle: Arrival\n---\n\nOne two three four five.\n' }) })).status).toBe(201);
  expect((await api('/api/files', { method: 'POST', body: JSON.stringify({ path: `${folder}/b.md`, content: '---\ntitle: Boats\n---\n\nSmall ones.\n' }) })).status).toBe(201);

  await page.goto(`/?token=${E2E.token}&name=Counter&email=c%40example.org`);
  await page.getByTestId(`file:${path}`).click();
  await expect(page.getByTestId('status')).toContainText('Connected');

  // Along its foot: its words (not its header's).
  await expect(page.getByTestId('words-count')).toHaveText('5 words');
  await page.getByTestId('editor').locator('p', { hasText: 'One two' }).click();
  await page.keyboard.press(MAC ? 'Meta+ArrowRight' : 'End');
  await page.keyboard.type(' Six seven.');
  await expect(page.getByTestId('words-count')).toHaveText('7 words');
  await expect(page.getByTestId('words-today')).toContainText('+2 today');

  // A target for it, from the Words panel: kept in its header, shown along its foot.
  await page.getByTestId('words-status').click();
  await expect(page.getByTestId('words-panel')).toBeVisible();
  await page.getByTestId('words-document-target').fill('1,000');
  await page.getByTestId('words-document-target').press('Enter');
  await expect(page.getByTestId('words-count')).toHaveText('7 / 1,000 words');
  await expect.poll(() => readIn(path), { timeout: 10_000 }).toContain('target-words: 1000\n');

  // Its details, from the Details panel (the ⋯ menu): kept in its header; its label's colour by it in the tree.
  await page.getByTestId('document-menu-button').click();
  await page.getByTestId('menu-details').click();
  await expect(page.getByTestId('details-panel')).toBeVisible();
  await page.getByTestId('details-synopsis').fill('They come by sea.');
  await page.getByTestId('details-label').click();
  await page.getByTestId('details-label').fill('Chapter');
  await page.getByTestId('details-label').press('Enter');
  await page.getByTestId('details-status').selectOption('First draft');
  await page.getByTestId('details-keywords').fill('sea, arrival');
  await page.getByTestId('details-keywords').press('Enter');
  await expect(page.getByTestId(`mark:label:${path}`)).toBeAttached();
  await expect.poll(() => readIn(path), { timeout: 10_000 }).toMatch(/synopsis: They come by sea\.\n[\s\S]*label: Chapter\n[\s\S]*status: First draft\n[\s\S]*keywords:\n {2}- sea\n {2}- arrival\n/);
  // Still the document's words: details are in its header, not its text.
  await expect(page.getByTestId('words-count')).toHaveText('7 / 1,000 words');

  // Its folder's words in Compile: each document's, and the book's against a target.
  await page.getByTestId(`folder:${folder}`).click({ button: 'right' });
  await page.getByTestId('context:compile').click();
  await expect(page.getByTestId(`compile-words:${path}`)).toHaveText('7');
  await expect(page.getByTestId('compile-total')).toHaveText('9 words');
  await page.getByTestId('compile-target').fill('50000');
  await page.getByTestId('compile-target').press('Enter');
  await expect(page.getByTestId('compile-total')).toHaveText('9 / 50,000 words');
  await expect.poll(() => readIn(`${folder}/.kuraa-compile.yml`)).toContain('target-words: 50000\n');
});
