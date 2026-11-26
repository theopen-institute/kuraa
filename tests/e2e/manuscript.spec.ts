// Order and manuscripts over folders (docs/decisions/0091-order-and-manuscripts-over-folders.md):
// a folder arranged in the file tree by hand (Alt+↓, and by dragging between
// rows), kept in its .kuraa-order; a document dragged in from another folder,
// to a place; back to by name. The manuscript turned on: the folder made one
// from its menu, marked with a book; a document left out (faded) and put back.
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E } from './env.js';

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${E2E.url}${path}`, { ...init, headers: { authorization: `Bearer ${E2E.token}`, 'content-type': 'application/json' } });
const turn = (id: string, on: boolean) => api(`/api/features/${id}`, { method: 'PATCH', body: JSON.stringify({ on, by: { name: 'Writer', email: 'w@example.org', color: '#123456' } }) });
const readIn = (p: string) => {
  try {
    return readFileSync(join(E2E.dir, p), 'utf8');
  } catch {
    return '';
  }
};
/** The folder's order, as its file names it. */
const orderOf = (folder: string) => () => readIn(`${folder}/.kuraa-order`).split('\n').filter((l) => l && !l.startsWith('#')).join(' ');
/** The folder's rows, top to bottom, as the tree shows them. */
const rowsIn = (page: Page, folder: string) => async () =>
  (await page.locator(`.tree [role="treeitem"][data-path^="${folder}/"]`).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.path!))).map((p) => p.slice(p.lastIndexOf('/') + 1)).join(' ');

test('a folder arranged by hand in the file tree, and made a manuscript that leaves a document out', async ({ page }) => {
  const id = Date.now().toString(36);
  const folder = `book-${id}`;
  const doc = (path: string, title: string) => api('/api/files', { method: 'POST', body: JSON.stringify({ path, content: `---\ntitle: ${title}\n---\n\nText.\n` }) });
  for (const [name, title] of [['a.md', 'Arrival'], ['b.md', 'Boats'], ['c.md', 'Coast']] as const) expect((await doc(`${folder}/${name}`, title)).status).toBe(201);
  expect((await doc(`loose-${id}/tide.md`, 'Tide')).status).toBe(201);
  const row = (path: string) => page.getByTestId(`file:${path}`);

  await page.goto(`/?token=${E2E.token}&name=Writer&email=w%40example.org`);
  // By name at first.
  await expect.poll(rowsIn(page, folder)).toBe('a.md b.md c.md');

  // Alt+↓: Arrival after Boats, kept in the folder's order.
  await page.locator(`[role="treeitem"][data-path="${folder}/a.md"]`).focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect.poll(orderOf(folder)).toBe('b.md a.md c.md');
  await expect.poll(rowsIn(page, folder)).toBe('b.md a.md c.md');

  // Dragged onto the upper half of Boats: Coast first.
  const target = row(`${folder}/b.md`);
  const box = (await target.boundingBox())!;
  await row(`${folder}/c.md`).dragTo(target, { targetPosition: { x: 20, y: 2 } });
  await expect.poll(orderOf(folder)).toBe('c.md b.md a.md');

  // From another folder, onto the lower half of Coast: moved there, after it.
  await row(`loose-${id}/tide.md`).dragTo(row(`${folder}/c.md`), { targetPosition: { x: 20, y: box.height - 2 } });
  await expect.poll(orderOf(folder)).toBe('c.md tide.md b.md a.md');
  await expect(row(`${folder}/tide.md`)).toBeVisible();

  // The manuscript: the folder made one, marked; a document left out, faded, and put back.
  expect((await turn('manuscript', true)).status).toBe(200);
  try {
    // Turned on from elsewhere: the page learns of it when it is loaded again.
    await page.reload();
    await page.getByTestId(`folder:${folder}`).click({ button: 'right' });
    await page.getByTestId('context:manuscript-make').click();
    await expect(page.getByTestId(`mark:manuscript:${folder}/`)).toBeVisible();
    expect(readIn(`${folder}/.kuraa-manuscript.yml`)).toMatch(/^# This folder is a manuscript/);

    await row(`${folder}/tide.md`).click({ button: 'right' });
    await page.getByTestId('context:manuscript-exclude').click();
    await expect(page.getByTestId(`mark:left-out:${folder}/tide.md`)).toBeAttached();
    await expect.poll(() => readIn(`${folder}/.kuraa-manuscript.yml`)).toContain('exclude:\n  - tide.md\n');
    await row(`${folder}/tide.md`).click({ button: 'right' });
    await page.getByTestId('context:manuscript-include').click();
    await expect(page.getByTestId(`mark:left-out:${folder}/tide.md`)).toHaveCount(0);

    // Back to by name, from the folder's menu.
    await page.getByTestId(`folder:${folder}`).click({ button: 'right' });
    await page.getByTestId('context:sort-by-name').click();
    await expect.poll(rowsIn(page, folder)).toBe('a.md b.md c.md tide.md');

    await page.getByTestId(`folder:${folder}`).click({ button: 'right' });
    await page.getByTestId('context:manuscript-unmake').click();
    await expect(page.getByTestId(`mark:manuscript:${folder}/`)).toHaveCount(0);
  } finally {
    await turn('manuscript', false);
  }
});
