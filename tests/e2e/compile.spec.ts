// Order and Compile over folders (docs/decisions/0093-order-and-compile-over-folders.md):
// a folder arranged in the file tree by hand (Alt+↓, and by dragging between
// rows), kept in its .kuraa-order; a document dragged in from another folder,
// to a place; back to by name. A document left out of Compile (faded) and put
// back; Compile… on the folder's menu opens its panel. Where Podman runs: the
// folder compiled to HTML, its chapters in order, without what is left out.
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { podmanWorks } from '../../packages/env-podman/src/index.js';
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
const doc = (path: string, title: string, body = 'Text.') => api('/api/files', { method: 'POST', body: JSON.stringify({ path, content: `---\ntitle: ${title}\n---\n\n${body}\n` }) });
/** The folder's order, as its file names it. */
const orderOf = (folder: string) => () => readIn(`${folder}/.kuraa-order`).split('\n').filter((l) => l && !l.startsWith('#')).join(' ');
/** The folder's rows, top to bottom, as the tree shows them. */
const rowsIn = (page: Page, folder: string) => async () =>
  (await page.locator(`.tree [role="treeitem"][data-path^="${folder}/"]`).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.path!))).map((p) => p.slice(p.lastIndexOf('/') + 1)).join(' ');

test('a folder arranged by hand in the file tree; a document left out of Compile and put back', async ({ page }) => {
  const id = Date.now().toString(36);
  const folder = `book-${id}`;
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
  await row(`loose-${id}/tide.md`).dragTo(row(`${folder}/c.md`), { targetPosition: { x: 20, y: Math.round(box.height * 0.75) } });
  await expect.poll(orderOf(folder)).toBe('c.md tide.md b.md a.md');
  await expect(row(`${folder}/tide.md`)).toBeVisible();

  // Left out of Compile, faded; put back.
  await row(`${folder}/tide.md`).click({ button: 'right' });
  await page.getByTestId('context:compile-exclude').click();
  await expect(page.getByTestId(`mark:left-out:${folder}/tide.md`)).toBeAttached();
  await expect.poll(() => readIn(`${folder}/.kuraa-compile.yml`)).toContain('exclude:\n  - tide.md\n');
  await row(`${folder}/tide.md`).click({ button: 'right' });
  await page.getByTestId('context:compile-include').click();
  await expect(page.getByTestId(`mark:left-out:${folder}/tide.md`)).toHaveCount(0);

  // Compile… on the folder's menu: its panel, for it.
  await page.getByTestId(`folder:${folder}`).click({ button: 'right' });
  await page.getByTestId('context:compile').click();
  await expect(page.getByTestId('compile-folder')).toHaveText(`Compile ${folder}`);
  await expect(page.getByTestId('compile-title')).toHaveValue(folder);

  // Back to by name, from the folder's menu.
  await page.getByTestId(`folder:${folder}`).click({ button: 'right' });
  await page.getByTestId('context:sort-by-name').click();
  await expect.poll(rowsIn(page, folder)).toBe('a.md b.md c.md tide.md');
});

test('a folder compiled to HTML: in the tree’s order, how deep each is its heading’s level, without what is left out', async ({ page }) => {
  test.skip(!podmanWorks(), 'Podman is not installed and running');
  test.setTimeout(600_000);
  const id = Date.now().toString(36);
  const folder = `compiled-${id}`;
  expect((await doc(`${folder}/a.md`, 'Arrival', 'We came by sea.\n\n# The quay\n\nBoats.')).status).toBe(201);
  expect((await doc(`${folder}/b.md`, 'Boats', 'Small ones.')).status).toBe(201);
  expect((await doc(`${folder}/notes.md`, 'Notes', 'NOT IN THE BOOK.')).status).toBe(201);
  expect((await doc(`${folder}/North/c.md`, 'Cliffs', 'High ones.')).status).toBe(201);
  expect((await doc(`${folder}/drafts/d.md`, 'Dunes', 'Sandy ones.')).status).toBe(201);
  expect((await api('/api/order', { method: 'POST', body: JSON.stringify({ folder, names: ['b.md', 'North', 'a.md', 'drafts'] }) })).status).toBe(200);
  expect((await api('/api/features/compile/include', { method: 'POST', body: JSON.stringify({ body: { path: `${folder}/notes.md`, include: false }, by: { name: 'Writer', email: 'w@example.org', color: '#123456' } }) })).status).toBe(200);

  await page.goto(`/?token=${E2E.token}&name=Writer&email=w%40example.org`);
  // drafts: no heading, from its menu; marked so.
  await page.getByTestId(`folder:${folder}/drafts`).click({ button: 'right' });
  await page.getByTestId('context:compile-no-heading').click();
  await expect(page.getByTestId(`mark:no-heading:${folder}/drafts`)).toBeAttached();
  await page.getByTestId(`folder:${folder}`).click({ button: 'right' });
  await page.getByTestId('context:compile').click();
  await page.getByTestId('compile-title').fill('The Coast');
  await page.getByTestId('compile-format:html').check();
  const download = page.waitForEvent('download', { timeout: 590_000 });
  await page.getByTestId('compile-button').click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(`${folder}.html`);
  const html = readFileSync((await file.path())!, 'utf8');
  expect(html).toContain('The Coast');
  // Boats, North (Cliffs in it, a level down), Arrival (its own section below it), Dunes (drafts has no heading): the folder's order; Notes left out.
  const at = (text: string) => html.indexOf(text);
  expect(at('Small ones.')).toBeGreaterThan(-1);
  expect([at('Small ones.'), at('High ones.'), at('We came by sea.'), at('Sandy ones.')]).toEqual([...[at('Small ones.'), at('High ones.'), at('We came by sea.'), at('Sandy ones.')]].sort((a, b) => a - b));
  expect(html).toMatch(/<h1[^>]*>Boats<\/h1>/);
  expect(html).toMatch(/<h1[^>]*>North<\/h1>/);
  expect(html).toMatch(/<h2[^>]*>Cliffs<\/h2>/);
  expect(html).toMatch(/<h2[^>]*>The quay<\/h2>/);
  expect(html).toMatch(/<h1[^>]*>Dunes<\/h1>/);
  expect(html).not.toMatch(/<h\d[^>]*>drafts<\/h\d>/);
  expect(html).not.toContain('NOT IN THE BOOK');
  await expect(page.getByTestId('compile-saved')).toBeVisible();
  // Its title and format kept for the folder: a book by its name.
  await expect(page.getByTestId(`mark:compiled:${folder}`)).toBeAttached();
});
