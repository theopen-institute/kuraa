// New files: an untitled document, its title typed in the page and its filename
// made from that. Renaming a document changes its title and its filename, and
// any file's kind. The sidebar: folders, moving by dragging, renaming folders.
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E } from './env.js';

async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${E2E.token}&name=Maker&email=make%40example.org`);
  await expect(page.getByRole('button', { name: 'New file or folder', exact: true })).toBeVisible();
}

const dialog = (page: Page) => page.getByTestId('ask');

test('New file makes an untitled document at once: its title is typed in the page, and its filename follows; Rename changes its kind', async ({ page }) => {
  const stamp = Date.now().toString(36);
  const other = `runs/other-${stamp}.md`;
  expect((await fetch(`${E2E.url}/api/files`, {
    method: 'POST',
    headers: { authorization: `Bearer ${E2E.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ path: other, content: '# Other\n' }),
  })).status).toBe(201);
  await openApp(page);

  // No dialog: an untitled Markdown document, open, with the cursor in its title.
  await page.getByRole('button', { name: 'New file or folder', exact: true }).click();
  await page.getByTestId('context:new-file').click();
  const current = page.locator('[role="treeitem"][aria-current="page"]');
  await expect(current).toHaveAttribute('data-path', /^untitled-[a-z0-9]{5}(-\d+)?\.md$/);
  const untitled = (await current.getAttribute('data-path'))!;
  expect(readFileSync(join(E2E.dir, untitled), 'utf8')).toBe('');
  const title = page.getByTestId('editor').locator('h1.doc-title');
  await expect(title).toBeFocused();

  // The title, typed in the page: the header has it, and the sidebar shows it.
  await page.keyboard.type(`Tidal notes: Café ${stamp}`);
  await expect(page.getByTestId(`file:${untitled}`)).toContainText(`Tidal notes: Café ${stamp}`);
  await expect.poll(() => readFileSync(join(E2E.dir, untitled), 'utf8')).toContain(`title: "Tidal notes: Café ${stamp}"`);
  await page.keyboard.press('Enter');
  await page.keyboard.type('Body.');
  await expect.poll(() => readFileSync(join(E2E.dir, untitled), 'utf8')).toContain('Body.');

  // Left for another file: its filename is made from its title.
  await page.getByTestId(`file:${other}`).click();
  const named = `tidal-notes-cafe-${stamp}.md`;
  await expect(page.getByTestId(`file:${named}`)).toContainText(`Tidal notes: Café ${stamp}`);
  expect(existsSync(join(E2E.dir, untitled))).toBe(false);
  expect(readFileSync(join(E2E.dir, named), 'utf8')).toBe(`---\ntitle: "Tidal notes: Café ${stamp}"\n---\n\nBody.\n`);

  // Rename… has the file's kind: another kind changes the extension.
  const rename = page.getByTestId('rename');
  const type = rename.getByLabel('File type');
  const filename = rename.getByLabel('Filename');
  await page.getByTestId(`file:${named}`).click({ button: 'right' });
  await page.getByTestId('context:rename').click();
  await expect(type).toHaveValue('pandoc-markdown');
  await expect(type.locator('optgroup')).toHaveCount(2);
  await expect(type.locator('option')).toHaveText(['Pandoc markdown (.md)', 'R Markdown (.Rmd)', 'Text file (.txt)']);
  await type.selectOption('rmarkdown');
  await expect(filename).toHaveValue(`tidal-notes-cafe-${stamp}.Rmd`);
  await rename.getByRole('button', { name: 'Rename' }).click();
  const rmd = `tidal-notes-cafe-${stamp}.Rmd`;
  await expect(page.getByTestId(`file:${rmd}`)).toContainText(`Tidal notes: Café ${stamp}`);

  // A text file has no title: only its name.
  await page.getByTestId(`file:${rmd}`).click({ button: 'right' });
  await page.getByTestId('context:rename').click();
  await type.selectOption('text');
  await expect(rename.getByLabel('Title')).toHaveCount(0);
  await expect(filename).toHaveValue(`tidal-notes-cafe-${stamp}.txt`);
  await rename.getByRole('button', { name: 'Rename' }).click();
  const txt = `tidal-notes-cafe-${stamp}.txt`;
  await expect(page.getByTestId(`file:${txt}`)).toContainText(txt);

  // And back to a document, given a title: the header (kept in the text, as text) gets it, its quoting as it was.
  await page.getByTestId(`file:${txt}`).click({ button: 'right' });
  await page.getByTestId('context:rename').click();
  await type.selectOption('pandoc-markdown');
  await rename.getByLabel('Title').fill(`Tides again ${stamp}`);
  await filename.fill(`tides-${stamp}.md`);
  await expect(type).toHaveValue('pandoc-markdown');
  await rename.getByRole('button', { name: 'Rename' }).click();
  await expect(page.getByTestId(`file:tides-${stamp}.md`)).toContainText(`Tides again ${stamp}`);
  expect(readFileSync(join(E2E.dir, `tides-${stamp}.md`), 'utf8')).toBe(`---\ntitle: "Tides again ${stamp}"\n---\n\nBody.\n`);
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
  // ＋ in the header is a menu (decision 0084): a new file or a new folder, at the top level.
  // A second click closes it, as does Escape.
  const plus = page.getByRole('button', { name: 'New file or folder', exact: true });
  const menu = page.getByTestId('context-menu');
  await plus.click();
  await expect(menu.getByRole('menuitem')).toHaveText(['New file', 'New folder…']);
  await expect(plus).toHaveAttribute('aria-expanded', 'true');
  await plus.click();
  await expect(menu).toHaveCount(0);
  await plus.click();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(plus).toBeFocused();
  // The space below the files has the same menu, by right-click.
  const space = page.getByTestId('tree-space');
  await space.scrollIntoViewIfNeeded();
  await space.click({ button: 'right' });
  await expect(menu.getByRole('menuitem')).toHaveText(['New file', 'New folder…']);
  await page.keyboard.press('Escape');
  await plus.click();
  await page.getByTestId('context:new-folder').click();
  await expect(page.getByTestId('ask').locator('input')).toHaveValue('new-folder');
  await page.getByTestId('ask').locator('input').fill(folder);
  await page.getByTestId('ask').getByRole('button', { name: 'Create' }).click();
  const row = page.locator('.tree-dir-row', { hasText: folder.split('/')[1]! });
  await expect(row).toBeVisible();
  expect(existsSync(join(E2E.dir, folder, '.gitkeep'))).toBe(true);
  await expect(page.locator('[data-testid$="/.gitkeep"]')).toHaveCount(0);
  await row.hover();
  await row.getByRole('button', { name: /^New file in/ }).click();
  await expect(page.locator('[role="treeitem"][aria-current="page"]')).toHaveAttribute('data-path', new RegExp(`^${folder}/untitled-[a-z0-9]{5}\\.md$`));

  // ⌘, (Ctrl+, elsewhere) opens Settings, at the open document (decision 0065); Escape closes it.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Comma' : 'Control+Comma');
  await expect(page.getByTestId('settings-tab-document')).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('settings-window')).toHaveCount(0);
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
  await expect.poll(() => execFileSync('git', ['log', '-1', '--format=%s'], { cwd: E2E.dir, encoding: 'utf8' }).trim()).toBe(`Move ${file} to ${folder}/`);
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
  // The open file's room is closed as the rename starts, so the app may show the new names a moment before its commit is made.
  await expect.poll(() => execFileSync('git', ['log', '-1', '--format=%s'], { cwd: E2E.dir, encoding: 'utf8' }).trim()).toBe(`Rename ${folder} to ${folder}-renamed`);
  await expect(page.locator('.tree-file.selected')).toContainText('inside.md');
  await expect(page.getByTestId('editor')).toContainText('Inside');
});
