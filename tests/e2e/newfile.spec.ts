// New files: a document is made from its title (its filename from that), other
// files by name. Renaming a document changes its title and its filename. The
// sidebar: folders, moving by dragging, renaming folders.
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E } from './env.js';

async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${E2E.token}&name=Maker&email=make%40example.org`);
  await expect(page.getByRole('button', { name: 'New file', exact: true })).toBeVisible();
}

const dialog = (page: Page) => page.getByTestId('ask');

test('a new document is made from its title, its filename from that; other files by name', async ({ page }) => {
  await openApp(page);
  const stamp = Date.now().toString(36);
  const newFile = page.getByTestId('new-file');
  const type = newFile.getByLabel('File type');
  const savedAs = newFile.getByTestId('new-file-path');

  // Default: Markdown, asked for a title.
  await page.getByRole('button', { name: 'New file', exact: true }).click();
  await expect(type).toHaveValue('pandoc-markdown');
  await expect(type.locator('optgroup')).toHaveCount(2);
  await expect(type.locator('option')).toHaveText(['Pandoc markdown (.md)', 'R Markdown (.Rmd)', 'Text file (.txt)']);
  await expect(savedAs).toHaveText(/untitled\.md$/);
  // No title, no document.
  await newFile.getByRole('button', { name: 'Create' }).click();
  await expect(newFile.getByRole('alert')).toHaveText('A document needs a title.');

  // The filename is made from the title, and the type's extension.
  await newFile.getByLabel('Title').fill(`Tidal notes: Café ${stamp}`);
  await expect(savedAs).toHaveText(new RegExp(`tidal-notes-cafe-${stamp}\\.md$`));
  await type.selectOption('rmarkdown');
  const path = `tidal-notes-cafe-${stamp}.Rmd`;
  await expect(savedAs).toHaveText(new RegExp(`${path.replace('.', '\\.')}$`));
  await newFile.getByRole('button', { name: 'Create' }).click();

  // Shown by its title; the file has it in its header.
  await expect(page.getByTestId(`file:${path}`)).toContainText(`Tidal notes: Café ${stamp}`);
  await expect(page.getByTestId('editor')).toBeVisible();
  expect(readFileSync(join(E2E.dir, path), 'utf8')).toBe(`---\ntitle: "Tidal notes: Café ${stamp}"\n---\n`);

  // The same title again: a numbered filename, whatever the extension.
  await page.getByRole('button', { name: 'New file', exact: true }).click();
  await newFile.getByLabel('Title').fill(`Tidal notes: Café ${stamp}`);
  await expect(savedAs).toHaveText(new RegExp(`tidal-notes-cafe-${stamp}-2\\.md$`));

  // A text file is made by name: its extension and type follow each other.
  await type.selectOption('text');
  const name = newFile.getByLabel('Name');
  await expect(name).toHaveValue(/untitled\.txt$/);
  await name.fill(`runs/new-${stamp}.py`);
  await expect(type).toHaveValue('text');
  await name.fill(`runs/data-${stamp}`);
  await newFile.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByTestId(`file:runs/data-${stamp}.txt`)).toContainText(`data-${stamp}.txt`);

  // Escape cancels.
  await page.getByRole('button', { name: 'New file', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(newFile).toHaveCount(0);
});

test('renaming a document changes its title, and its filename with it or apart', async ({ page }) => {
  const stamp = Date.now().toString(36);
  const call = (method: string, body: object) => fetch(`${E2E.url}/api/files`, {
    method,
    headers: { authorization: `Bearer ${E2E.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const from = `runs/name-${stamp}.md`;
  expect((await call('POST', { path: from, content: `---\ntitle: Old name ${stamp}\nauthor: Ada\n---\n\nBody.\n` })).status).toBe(201);
  await openApp(page);
  await expect(page.getByTestId(`file:${from}`)).toContainText(`Old name ${stamp}`);
  const rename = page.getByTestId('rename');
  const filename = rename.getByLabel('Filename');

  // A filename not made from the title stays as it is, unless asked to match.
  await page.getByTestId(`file:${from}`).click({ button: 'right' });
  await page.getByTestId('context:rename').click();
  await expect(rename.getByLabel('Title')).toHaveValue(`Old name ${stamp}`);
  await expect(filename).toHaveValue(`name-${stamp}.md`);
  await rename.getByLabel('Title').fill(`New name ${stamp}`);
  await expect(filename).toHaveValue(`name-${stamp}.md`);
  await rename.getByTestId('rename-match').click();
  await expect(filename).toHaveValue(`new-name-${stamp}.md`);
  // Now it follows the title.
  await rename.getByLabel('Title').fill(`Newer name ${stamp}`);
  await expect(filename).toHaveValue(`newer-name-${stamp}.md`);
  await rename.getByRole('button', { name: 'Rename' }).click();

  const to = `runs/newer-name-${stamp}.md`;
  await expect(page.getByTestId(`file:${to}`)).toContainText(`Newer name ${stamp}`);
  expect(readFileSync(join(E2E.dir, to), 'utf8')).toBe(`---\ntitle: Newer name ${stamp}\nauthor: Ada\n---\n\nBody.\n`);
  expect(existsSync(join(E2E.dir, from))).toBe(false);
  expect(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: E2E.dir, encoding: 'utf8' }).trim()).toBe(`Rename ${from} to ${to}`);

  // Only the title: the filename typed stays.
  await page.getByTestId(`file:${to}`).click({ button: 'right' });
  await page.getByTestId('context:rename').click();
  await filename.fill(`kept-${stamp}.md`);
  await rename.getByLabel('Title').fill(`Final ${stamp}`);
  await expect(filename).toHaveValue(`kept-${stamp}.md`);
  await rename.getByRole('button', { name: 'Rename' }).click();
  await expect(page.getByTestId(`file:runs/kept-${stamp}.md`)).toContainText(`Final ${stamp}`);
});

test('the sidebar shows the workspace name, makes folders, and opens the menu', async ({ page }) => {
  await openApp(page);
  await expect(page.getByTestId('workspace-name')).toHaveText('kuraa-e2e-workspace');
  await expect(page.locator('footer.status')).toHaveCount(0);

  // A new folder: committed (with a placeholder git keeps), shown, and a place for new files.
  const folder = `runs/folder-${Date.now().toString(36)}`;
  // Not in the header (only a new file is): right-click the space below the files.
  await expect(page.getByRole('button', { name: 'New folder', exact: true })).toHaveCount(0);
  const tree = (await page.locator('ul.tree').boundingBox())!;
  await page.mouse.click(tree.x + 20, tree.y + tree.height - 10, { button: 'right' });
  await page.getByTestId('context:new-folder').click();
  await page.getByTestId('ask').locator('input').fill(folder);
  await page.getByTestId('ask').getByRole('button', { name: 'Create' }).click();
  const row = page.locator('.tree-dir-row', { hasText: folder.split('/')[1]! });
  await expect(row).toBeVisible();
  expect(existsSync(join(E2E.dir, folder, '.gitkeep'))).toBe(true);
  await expect(page.locator('[data-testid$="/.gitkeep"]')).toHaveCount(0);
  await row.hover();
  await row.getByRole('button', { name: /^New file in/ }).click();
  await expect(page.getByTestId('new-file-path')).toHaveText(new RegExp(`${folder}/untitled\\.md$`));
  await page.keyboard.press('Escape');

  // ⌘, (Ctrl+, elsewhere) opens and closes the menu.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Comma' : 'Control+Comma');
  await expect(page.getByTestId('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('menu')).toHaveCount(0);
});


test('dragging moves files into folders, and folders to the top level', async ({ page }) => {
  const stamp = Date.now().toString(36);
  const file = `runs/drag-${stamp}.md`;
  const folder = `runs/drag-${stamp}-dir`;
  const call = (path: string, body: object) => fetch(`${E2E.url}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${E2E.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect((await call('/api/files', { path: file, content: '# Dragged\n' })).status).toBe(201);
  expect((await call('/api/folders', { path: folder })).status).toBe(201);
  await openApp(page);
  await page.getByTestId(`file:${file}`).click();
  await expect(page.getByTestId('editor')).toContainText('Dragged');

  // The open file, into the folder: moved on disk, committed as a move, still open.
  await page.getByTestId(`file:${file}`).dragTo(page.getByTestId(`folder:${folder}`));
  const moved = `${folder}/drag-${stamp}.md`;
  await expect(page.getByTestId(`file:${moved}`)).toBeVisible();
  await expect(page.getByTestId(`file:${file}`)).toHaveCount(0);
  expect(existsSync(join(E2E.dir, moved))).toBe(true);
  expect(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: E2E.dir, encoding: 'utf8' }).trim()).toBe(`Move ${file} to ${folder}/`);
  await expect(page.locator('.tree-file.selected')).toContainText(`drag-${stamp}.md`);
  await expect(page.getByTestId('editor')).toContainText('Dragged');

  // The folder, onto the workspace name: to the top level, with what is in it.
  await page.getByTestId(`folder:${folder}`).dragTo(page.getByTestId('workspace-name'));
  const top = `drag-${stamp}-dir/drag-${stamp}.md`;
  await expect(page.getByTestId(`file:${top}`)).toBeVisible();
  expect(existsSync(join(E2E.dir, top))).toBe(true);
  expect(existsSync(join(E2E.dir, folder))).toBe(false);
});

test('right-clicking a folder renames it, with what is in it', async ({ page }) => {
  const stamp = Date.now().toString(36);
  const folder = `ren-${stamp}`;
  const file = `${folder}/inside.md`;
  const res = await fetch(`${E2E.url}/api/files`, {
    method: 'POST',
    headers: { authorization: `Bearer ${E2E.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ path: file, content: '# Inside\n' }),
  });
  expect(res.status).toBe(201);
  await openApp(page);
  await page.getByTestId(`file:${file}`).click();
  await expect(page.getByTestId('editor')).toContainText('Inside');

  await page.getByTestId(`folder:${folder}`).click({ button: 'right' });
  await page.getByTestId('context:rename-folder').click();
  await dialog(page).getByRole('textbox').fill(`${folder}-renamed`);
  await dialog(page).getByRole('button', { name: 'Rename' }).click();

  // Renamed on disk and committed; the open file follows.
  const moved = `${folder}-renamed/inside.md`;
  await expect(page.getByTestId(`file:${moved}`)).toBeVisible();
  await expect(page.getByTestId(`folder:${folder}`)).toHaveCount(0);
  expect(existsSync(join(E2E.dir, moved))).toBe(true);
  expect(existsSync(join(E2E.dir, folder))).toBe(false);
  expect(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: E2E.dir, encoding: 'utf8' }).trim()).toBe(`Rename ${folder} to ${folder}-renamed`);
  await expect(page.locator('.tree-file.selected')).toContainText('inside.md');
  await expect(page.getByTestId('editor')).toContainText('Inside');
});
