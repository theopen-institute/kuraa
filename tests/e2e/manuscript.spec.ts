// The manuscript (docs/decisions/0088-a-manuscript-is-a-quarto-book.md): turned
// on for the workspace, a folder made one from its menu, shown as a view beside
// the file tree, reordered (Alt+↓, and by dragging), a document taken out and
// added again, each written to the folder's _quarto.yml.
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E } from './env.js';

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${E2E.url}${path}`, { ...init, headers: { authorization: `Bearer ${E2E.token}`, 'content-type': 'application/json' } });
const turn = (id: string, on: boolean) => api(`/api/features/${id}`, { method: 'PATCH', body: JSON.stringify({ on, by: { name: 'Writer', email: 'w@example.org', color: '#123456' } }) });

test('a folder made a manuscript, reordered and changed from its view', async ({ page }) => {
  const id = Date.now().toString(36);
  const folder = `book-${id}`;
  const doc = (name: string, title: string) => api('/api/files', { method: 'POST', body: JSON.stringify({ path: `${folder}/${name}`, content: `---\ntitle: ${title}\n---\n\nText.\n` }) });
  for (const [name, title] of [['a.md', 'Arrival'], ['b.md', 'Boats'], ['c.md', 'Coast']] as const) expect((await doc(name, title)).status).toBe(201);
  const book = () => readFileSync(join(E2E.dir, folder, '_quarto.yml'), 'utf8');

  expect((await turn('manuscript', true)).status).toBe(200);
  try {
    await page.goto(`/?token=${E2E.token}&name=Writer&email=w%40example.org`);
    // Two views now: a row of their names.
    await expect(page.getByTestId('sidebar-view:files:files')).toBeVisible();
    // Made from the folder's menu.
    await page.getByTestId(`folder:${folder}`).click({ button: 'right' });
    await page.getByTestId('context:manuscript-make').click();
    await expect.poll(() => { try { return book(); } catch { return ''; } }).toContain('chapters:\n    - a.md\n    - b.md\n    - c.md\n');

    await page.getByTestId('sidebar-view:manuscript:manuscript').click();
    const view = page.getByTestId('manuscript');
    // Where the workspace has several, this one chosen.
    if (await view.getByTestId('manuscript-choose').count()) await view.getByTestId('manuscript-choose').selectOption({ label: folder });
    const row = (name: string) => view.getByTestId(`manuscript:${folder}/${name}`);
    await expect(row('a.md')).toHaveText('Arrival');
    // No title above its chapters, and nothing said of Quarto's index file (0088, revised).
    await expect(view.locator('.manuscript-head')).toHaveCount(0);

    // Alt+↓: Arrival after Boats.
    await row('a.md').focus();
    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(book).toContain('chapters:\n    - b.md\n    - a.md\n    - c.md\n');
    await expect(view.locator('.manuscript-list').first().locator('.manuscript-name')).toHaveText(['Boats', 'Arrival', 'Coast']);

    // Dragged: Coast to the top.
    await row('c.md').dragTo(row('b.md'));
    await expect.poll(book).toContain('chapters:\n    - c.md\n    - b.md\n    - a.md\n');

    // Taken out from the file's menu: below, not in the manuscript; added back from there.
    await row('b.md').click({ button: 'right' });
    await page.getByTestId('context:manuscript-remove').click();
    await expect(view.getByTestId(`manuscript-out:${folder}/b.md`)).toHaveText('Boats');
    await expect.poll(book).not.toContain('b.md');
    await view.getByTestId(`manuscript-out:${folder}/b.md`).click({ button: 'right' });
    await page.getByTestId('context:manuscript-add').click();
    await expect.poll(book).toContain('    - b.md\n');

    // Clicking a chapter opens it.
    await row('a.md').click();
    await expect(page.getByTestId('editor')).toContainText('Text.');
  } finally {
    expect((await turn('manuscript', false)).status).toBe(200);
  }
});
