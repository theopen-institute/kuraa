// The corkboard and the outline (docs/decisions/0095-corkboard-and-outline.md):
// a folder shown in the main area from its menu, as cards in the file tree's
// order; a synopsis written on a card, into the document's header; a card
// dragged before another, the folder's order following; the outline, a status
// changed in its row; a document opened from it, in place of the view.
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E } from './env.js';

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${E2E.url}${path}`, { ...init, headers: { authorization: `Bearer ${E2E.token}`, 'content-type': 'application/json' } });
const readIn = (p: string) => {
  try {
    return readFileSync(join(E2E.dir, p), 'utf8');
  } catch {
    return '';
  }
};
const doc = (path: string, header: string, body: string) => api('/api/files', { method: 'POST', body: JSON.stringify({ path, content: `---\n${header}\n---\n\n${body}\n` }) });
const orderOf = (folder: string) => () => readIn(`${folder}/.kuraa-order`).split('\n').filter((l) => l && !l.startsWith('#')).join(' ');
/** The cards, left to right, by file name. */
const cardsIn = (page: Page) => async () =>
  (await page.locator('[data-testid^="card:"]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.testid!.slice(5)))).map((p) => p.slice(p.lastIndexOf('/') + 1)).join(' ');

test('a folder as a corkboard and as an outline: synopses and statuses edited in place, cards arranged', async ({ page }) => {
  const id = Date.now().toString(36);
  const folder = `cork-${id}`;
  expect((await doc(`${folder}/a.md`, 'title: Arrival\nlabel: Chapter\nstatus: First draft', 'We came by sea.')).status).toBe(201);
  expect((await doc(`${folder}/b.md`, 'title: Boats\nsynopsis: Small ones.', 'Little boats in the harbour.')).status).toBe(201);
  expect((await doc(`${folder}/coast/c.md`, 'title: Cliffs', 'High.')).status).toBe(201);

  await page.goto(`/?token=${E2E.token}&name=Writer&email=w%40example.org`);
  // The folder clicked in the tree: its corkboard, in the main area, in the tree's order (folders first, by name); marked in the tree.
  await page.evaluate(() => localStorage.removeItem('kuraa:folder-view'));
  await page.getByTestId(`folder:${folder}`).click();
  await expect(page.getByTestId('cork-title')).toHaveText(folder);
  await expect(page.locator(`[role="treeitem"][data-path="${folder}"]`)).toHaveClass(/\bshown\b/);
  // Its icon opens and closes it, and nothing else.
  await page.getByTestId(`fold:${folder}`).click();
  await expect(page.getByTestId(`file:${folder}/a.md`)).toHaveCount(0);
  await expect(page.getByTestId('cork-title')).toHaveText(folder);
  await page.getByTestId(`fold:${folder}`).click();
  await expect(page.getByTestId(`file:${folder}/a.md`)).toBeVisible();
  await expect.poll(cardsIn(page)).toBe('coast a.md b.md');
  await expect(page.getByTestId(`card:${folder}/coast`)).toContainText('1 document');
  await expect(page.getByTestId(`card-synopsis:${folder}/b.md`)).toHaveText('Small ones.');
  await expect(page.getByTestId(`card:${folder}/a.md`)).toContainText('First draft');
  await expect(page.getByTestId(`card:${folder}/a.md`)).toContainText('4 words');

  // Down into a folder by its card, and up again by the folders above it: to the folder, and to the whole workspace.
  await page.getByTestId(`card-open:${folder}/coast`).click();
  await expect(page.getByTestId('cork-title')).toHaveText('coast');
  await expect(page.getByTestId(`card:${folder}/coast/c.md`)).toBeVisible();
  await page.getByTestId(`cork-crumb:${folder}`).click();
  await expect(page.getByTestId('cork-title')).toHaveText(folder);
  await page.getByTestId('cork-crumb:').click();
  await expect(page.getByTestId('cork-title')).toHaveText('kuraa-e2e-workspace');
  await expect(page.getByTestId(`card:${folder}`)).toBeVisible();
  await page.getByTestId(`card-open:${folder}`).click();
  await expect(page.getByTestId('cork-title')).toHaveText(folder);

  // A synopsis written on a card: into the document's header.
  await page.getByTestId(`card-synopsis:${folder}/a.md`).click();
  await page.getByTestId(`card-synopsis-edit:${folder}/a.md`).fill('They arrive at night.');
  await page.getByTestId(`card-synopsis-edit:${folder}/a.md`).press('Enter');
  await expect(page.getByTestId(`card-synopsis:${folder}/a.md`)).toHaveText('They arrive at night.');
  await expect.poll(() => readIn(`${folder}/a.md`)).toContain('synopsis: They arrive at night.\n');

  // Boats dragged before Arrival (onto its left half): the folder's order, and the file tree's.
  const arrival = page.getByTestId(`card:${folder}/a.md`);
  await page.getByTestId(`card:${folder}/b.md`).dragTo(arrival, { targetPosition: { x: 8, y: 40 } });
  await expect.poll(orderOf(folder)).toBe('coast b.md a.md');
  await expect.poll(cardsIn(page)).toBe('coast b.md a.md');

  // The outline: a status changed in its row.
  await page.getByTestId('cork-view:corkboard:outline').click();
  await expect(page.getByTestId(`row:${folder}/a.md`)).toBeVisible();
  await page.getByTestId(`row-status:${folder}/a.md`).fill('Revised draft');
  await page.getByTestId(`row-status:${folder}/a.md`).press('Enter');
  await expect.poll(() => readIn(`${folder}/a.md`)).toContain('status: Revised draft\n');
  await expect(page.getByTestId(`row-words:${folder}/b.md`)).toHaveText('5');

  // A document opened from it: the editor, in place of the view.
  await page.getByTestId(`row-open:${folder}/b.md`).click();
  await expect(page.getByTestId('editor')).toBeVisible();
  await expect(page.getByTestId('folder-view')).toHaveCount(0);

  // The folder clicked again: in the view last shown, the outline.
  await page.getByTestId(`folder:${folder}`).click();
  await expect(page.getByTestId(`row:${folder}/a.md`)).toBeVisible();
});
