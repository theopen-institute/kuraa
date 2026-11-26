// The manuscript (docs/decisions/0088-a-manuscript-is-a-quarto-book.md, 0090):
// turned on for the workspace, a folder made one from its menu (a Quarto
// profile's book at the top), shown as a view beside the file tree, reordered
// (Alt+↓, and by dragging), a document taken out and added again, a new chapter
// made in place, and a document in a second manuscript too.
import { expect, test } from '@playwright/test';
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

test('a manuscript made, reordered and changed from its view; a chapter made in place; a document in two', async ({ page }) => {
  const id = Date.now().toString(36);
  const folder = `book-${id}`;
  const doc = (name: string, title: string) => api('/api/files', { method: 'POST', body: JSON.stringify({ path: `${folder}/${name}`, content: `---\ntitle: ${title}\n---\n\nText.\n` }) });
  for (const [name, title] of [['a.md', 'Arrival'], ['b.md', 'Boats'], ['c.md', 'Coast']] as const) expect((await doc(name, title)).status).toBe(201);
  const file = `_quarto-${folder}.yml`;
  const book = () => readIn(file);

  expect((await turn('manuscript', true)).status).toBe(200);
  try {
    await page.goto(`/?token=${E2E.token}&name=Writer&email=w%40example.org`);
    // Two views now: a row of their names.
    await expect(page.getByTestId('sidebar-view:files:files')).toBeVisible();
    // Made from the folder's menu: a profile's book at the top, its chapters the folder's documents.
    await page.getByTestId(`folder:${folder}`).click({ button: 'right' });
    await page.getByTestId('context:manuscript-make').click();
    await expect.poll(book).toContain(`chapters:\n    - ${folder}/a.md\n    - ${folder}/b.md\n    - ${folder}/c.md\n`);
    expect(readIn('_quarto.yml')).toContain(`[ ${folder} ]`);

    await page.getByTestId('sidebar-view:manuscript:manuscript').click();
    const view = page.getByTestId('manuscript');
    const row = (name: string) => view.getByTestId(`manuscript:${folder}/${name}`);
    await expect(row('a.md')).toHaveText('Arrival');

    // Alt+↓: Arrival after Boats.
    await row('a.md').focus();
    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(book).toContain(`chapters:\n    - ${folder}/b.md\n    - ${folder}/a.md\n    - ${folder}/c.md\n`);

    // Dragged: Coast to the top.
    await row('c.md').dragTo(row('b.md'));
    await expect.poll(book).toContain(`chapters:\n    - ${folder}/c.md\n    - ${folder}/b.md\n    - ${folder}/a.md\n`);

    // Taken out from the file's menu: below, not in the manuscript; added back from there.
    await row('b.md').click({ button: 'right' });
    await page.getByTestId('context:manuscript-remove').click();
    await expect(view.getByTestId(`manuscript-out:${folder}/b.md`)).toHaveText('Boats');
    await expect.poll(book).not.toContain('b.md');
    await view.getByTestId(`manuscript-out:${folder}/b.md`).click({ button: 'right' });
    await page.getByTestId('context:manuscript-add').click();
    await expect.poll(book).toContain(`    - ${folder}/b.md\n`);

    // New chapter, with Coast open: made in its home folder, right after Coast, opened to type its title.
    await row('c.md').click();
    await expect(page.getByTestId('editor')).toContainText('Text.');
    await view.getByTestId('manuscript-new-chapter').click();
    await expect.poll(book).toMatch(new RegExp(`- ${folder}/c\\.md\\n    - ${folder}/untitled-[a-z0-9]{5}\\.md\\n    - ${folder}/a\\.md\\n    - ${folder}/b\\.md`));

    // A second manuscript, by its title; a chapter of the first added to it too, and marked so.
    await view.getByTestId('manuscript-new').click();
    await page.getByTestId('ask').locator('input').fill(`Paper ${id}`);
    await page.getByTestId('ask').getByRole('button', { name: 'Create' }).click();
    const paper = `_quarto-paper-${id}.yml`;
    await expect.poll(() => readIn(paper)).toContain(`title: "Paper ${id}"`);
    await expect(view.getByTestId('manuscript-choose')).toBeVisible();
    await view.getByTestId('manuscript-scope-all').click();
    await view.getByTestId(`manuscript-out:${folder}/a.md`).click({ button: 'right' });
    await page.getByTestId(`context:manuscript-add:${paper}`).click();
    await expect.poll(() => readIn(paper)).toContain(`    - ${folder}/a.md\n`);
    expect(book()).toContain(`${folder}/a.md`);
    await view.getByTestId('manuscript-choose').selectOption({ value: file });
    await expect(view.getByTestId(`manuscript:${folder}/a.md`).getByTestId('manuscript-also')).toHaveText('+1');
  } finally {
    expect((await turn('manuscript', false)).status).toBe(200);
  }
});
