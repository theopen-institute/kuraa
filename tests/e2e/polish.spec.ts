// Teaching and feedback, and the keyboard (decision 0044): an empty document
// says how to start, ⌘/ lists what can be typed and pressed, losing the
// connection shows a banner with what is not yet sent, the file list is a tree
// for the keyboard, and dialogs keep focus while open and give it back.
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E } from './env.js';

const MAC = process.platform === 'darwin';
const MOD = MAC ? 'Meta' : 'Control';
const key = (mac: string, other: string) => (MAC ? mac : other);

async function create(path: string, content: string): Promise<void> {
  const res = await fetch(`${E2E.url}/api/files`, {
    method: 'POST',
    headers: { authorization: `Bearer ${E2E.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ path, content }),
  });
  expect(res.status).toBe(201);
}

async function openApp(page: Page, name = 'Polisher'): Promise<void> {
  page.on('pageerror', (e) => console.error(`page error: ${e.message}`));
  await page.goto(`/?token=${E2E.token}&name=${name}&email=polish%40example.org`);
  await expect(page.getByRole('button', { name: 'New file or folder', exact: true })).toBeVisible();
}

async function openFile(page: Page, path: string): Promise<void> {
  await page.getByTestId(`file:${path}`).click();
  await expect(page.getByTestId('editor')).toBeVisible();
  await expect(page.getByTestId('status')).toContainText('Connected');
}

/** Where focus is: the path of the tree row that has it, or a test id near it. */
const focusedPath = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.path ?? null);

test('an empty document says how to start; ⌘/ lists the cues and keys, from the menu too', async ({ page }) => {
  const path = `runs/empty-${Date.now().toString(36)}.md`;
  await create(path, '');
  await openApp(page);

  // Nothing open: the empty state offers a new document and the shortcuts.
  await expect(page.getByTestId('no-document')).toContainText('Nothing open yet');
  await page.getByTestId('new-document').click();
  await expect(page.getByTestId('editor').locator('h1.doc-title')).toBeFocused();

  await openFile(page, path);
  const placeholder = page.getByTestId('editor').locator('.empty-placeholder');
  await expect(placeholder).toHaveAttribute('data-placeholder', 'Start writing…');
  await placeholder.click();
  await page.keyboard.type('Now there is text.');
  await expect(placeholder).toHaveCount(0);

  // ⌘/ (Ctrl+/): the sheet, for this system's keys, from the editor modules' own lists.
  await page.keyboard.press(`${MOD}+Slash`);
  const sheet = page.getByRole('dialog', { name: 'Markdown and shortcuts' });
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText('**bold**');
  await expect(sheet).toContainText('Cite: choose from the bibliography');
  await expect(sheet.getByTestId('help:Keys')).toContainText(key('⌘B', 'Ctrl+B'));
  await expect(sheet).toContainText(key('⇧⌘F', 'Ctrl+Shift+F'));
  await expect(sheet).toContainText(key('⌥⌘O', 'Ctrl+Alt+O'));
  await expect(sheet).toContainText(key('⇧⌘↩', 'Ctrl+Shift+Enter'));
  await expect(sheet).toContainText('R Markdown');
  // Escape closes it, and focus goes back to the document.
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId('editor')).toBeFocused();

  // From the menu.
  await page.getByTestId('document-menu-button').click();
  await page.getByTestId('menu-help').click();
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(sheet).toHaveCount(0);
});

test('a file shows at once from disk while its room connects; then it can be typed in', async ({ page }) => {
  const path = `runs/preview-${Date.now().toString(36)}.md`;
  await create(path, '# Preview\n\nRead before the room is ready.\n');
  await openApp(page);
  // The host is slow to give the room (busy with other work): held back here until released.
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  await page.route('**/api/rooms?**', async (route) => {
    await held;
    await route.continue();
  });
  await page.getByTestId(`file:${path}`).click();
  const previewed = page.getByTestId('editor-preview');
  await expect(previewed).toContainText('Read before the room is ready.');
  await expect(page.getByText('Opening')).toHaveCount(0);
  await expect(page.getByTestId('editor')).toBeHidden();
  release();
  await expect(page.getByTestId('editor')).toBeVisible();
  await expect(previewed).toHaveCount(0);
  await page.getByTestId('editor').getByText('Read before').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Typed.');
  await expect.poll(() => readFileSync(join(E2E.dir, path), 'utf8'), { timeout: 10_000 }).toContain('Read before the room is ready. Typed.');
});

test('bullets inside a numbered item: Enter, Tab, "- "; ⌘⇧7 makes them numbers', async ({ page }) => {
  const path = `runs/lists-${Date.now().toString(36)}.md`;
  await create(path, '---\ntitle: Lists\n---\n\n1. First\n2. Second\n');
  await openApp(page);
  await openFile(page, path);
  await page.getByTestId('editor').getByText('First').click();
  await page.keyboard.press(key('Meta+ArrowRight', 'End'));
  // The editor takes the moved cursor from the page's selectionchange, a moment later.
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.type('- a');
  await page.keyboard.press('Enter');
  await page.keyboard.type('b');
  const saved = () => readFileSync(join(E2E.dir, path), 'utf8');
  await expect.poll(saved, { timeout: 10_000 }).toContain('1. First\n   - a\n   - b\n2. Second\n');
  await page.keyboard.press(`${MOD}+Shift+7`);
  await expect.poll(saved, { timeout: 10_000 }).toContain('1. First\n   1. a\n   2. b\n2. Second\n');
});

test('offline: a banner says what is kept and not yet sent, and Try again reconnects', async ({ page }) => {
  const path = `runs/offline-${Date.now().toString(36)}.md`;
  await create(path, '# Offline\n\nBefore the outage.\n');
  // The connection to the host's live editing, cut and restored at will.
  let offline = false;
  const sockets = new Set<{ close(): Promise<void> }>();
  await page.routeWebSocket(/\/collab/, (ws) => {
    if (offline) {
      void ws.close();
      return;
    }
    ws.connectToServer();
    sockets.add(ws);
  });
  await openApp(page);
  await openFile(page, path);
  await expect(page.getByTestId('offline-banner')).toHaveCount(0);

  offline = true;
  for (const ws of sockets) await ws.close();
  sockets.clear();
  const banner = page.getByTestId('offline-banner');
  await expect(banner).toBeVisible({ timeout: 10_000 });
  await expect(banner).toContainText('Your changes are kept and will be sent when the connection returns.');
  await expect(page.getByTestId('status')).toHaveText('Offline');

  // What is typed meanwhile is counted as not yet sent.
  await page.getByTestId('editor').locator('p', { hasText: 'Before the outage.' }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Typed while offline.');
  await expect(page.getByTestId('offline-unsent')).toContainText(/not yet sent/);

  offline = false;
  await banner.getByRole('button', { name: 'Try again now' }).click();
  await expect(banner).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId('status')).toHaveText('Connected');
  await expect.poll(() => readFileSync(join(E2E.dir, path), 'utf8'), { timeout: 10_000 }).toContain('Typed while offline.');
});

test('the file list is a tree for the keyboard: arrows, Enter, F2 and Shift+F10', async ({ page }) => {
  const dir = `kb-${Date.now().toString(36)}`;
  await create(`${dir}/a.md`, '---\ntitle: Alpha\n---\n\nAlpha body.\n');
  await create(`${dir}/b.md`, '---\ntitle: Beta\n---\n\nBeta body.\n');
  await create(`${dir}/inner/c.md`, '---\ntitle: Gamma\n---\n\nGamma body.\n');
  await create(`${dir}/zz.unknownkind`, 'not a document kuraa opens\n');
  await openApp(page);

  const tree = page.getByRole('tree');
  await expect(tree).toBeVisible();
  const row = (p: string) => tree.locator(`[role="treeitem"][data-path="${p}"]`);
  // One row is in the Tab order; the open file is marked as current.
  await openFile(page, `${dir}/a.md`);
  await expect(row(`${dir}/a.md`)).toHaveAttribute('aria-current', 'page');
  await row(`${dir}/a.md`).focus();
  await expect(row(`${dir}/a.md`)).toHaveAttribute('tabindex', '0');

  // Folders first (inner, open, with Gamma), then files by title: Alpha, Beta, then the file of no kind.
  await page.keyboard.press('ArrowDown');
  expect(await focusedPath(page)).toBe(`${dir}/b.md`);
  await page.keyboard.press('ArrowDown');
  expect(await focusedPath(page)).toBe(`${dir}/zz.unknownkind`);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  expect(await focusedPath(page)).toBe(`${dir}/inner/c.md`);
  // ← goes up to the folder; ← again closes it, → opens it.
  await page.keyboard.press('ArrowLeft');
  expect(await focusedPath(page)).toBe(`${dir}/inner`);
  await page.keyboard.press('ArrowLeft');
  await expect(row(`${dir}/inner`)).toHaveAttribute('aria-expanded', 'false');
  await expect(row(`${dir}/inner/c.md`)).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  await expect(row(`${dir}/inner`)).toHaveAttribute('aria-expanded', 'true');
  await expect(row(`${dir}/inner/c.md`)).toBeVisible();

  // Enter opens a file.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  expect(await focusedPath(page)).toBe(`${dir}/b.md`);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('editor')).toContainText('Beta body.');
  await expect(row(`${dir}/b.md`)).toHaveAttribute('aria-current', 'page');

  // F2 renames; Escape gives focus back to the row.
  await row(`${dir}/b.md`).focus();
  await page.keyboard.press('F2');
  await expect(page.getByRole('dialog', { name: 'Rename' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(row(`${dir}/b.md`)).toBeFocused();

  // A file no kind of document opens is in the tree too, and can be renamed.
  await page.keyboard.press('ArrowDown');
  expect(await focusedPath(page)).toBe(`${dir}/zz.unknownkind`);
  await page.keyboard.press('F2');
  await expect(page.getByTestId('ask')).toContainText('Rename to');
  await page.keyboard.press('Escape');
  await expect(row(`${dir}/zz.unknownkind`)).toBeFocused();

  // Shift+F10 is the right-click menu. A file's has what is done to the file:
  // its settings, renaming and deleting (new files go in folders).
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Shift+F10');
  const menu = page.getByTestId('context-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveText(['Document settings…', 'Rename…', 'Delete…']);
  for (let i = 0; i < 10 && !(await menu.getByTestId('context:document-settings').evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  // Settings, at the document's section, with its header (decision 0064).
  await expect(page.getByTestId('settings-window')).toHaveAccessibleName('Settings');
  await expect(page.getByTestId('settings-tab-document')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('header').getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Beta');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('settings-window')).toBeHidden();
  // A folder's menu has what goes in it.
  await row(`${dir}/inner`).focus();
  await page.keyboard.press('Shift+F10');
  await expect(menu.getByRole('menuitem')).toHaveText(['New file in inner', 'New folder in inner…', 'Rename…']);
  await page.keyboard.press('Escape');
});

test('dialogs keep focus while open, close on Escape, and give focus back; the menu takes focus', async ({ page }) => {
  const path = `runs/dialogs-${Date.now().toString(36)}.md`;
  await create(path, '# Dialogs\n\nThe text behind.\n');
  await openApp(page);
  await openFile(page, path);
  const editor = page.getByTestId('editor');
  await editor.locator('p', { hasText: 'The text behind.' }).click();
  await expect(editor).toBeFocused();

  // ⌘, opens Settings with focus inside it: typing does not reach the document behind.
  await page.keyboard.press(`${MOD}+Comma`);
  const menu = page.getByRole('dialog', { name: 'Settings' });
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAttribute('aria-modal', 'true');
  expect(await menu.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.type('zzz');
  await expect(editor).not.toContainText('zzz');
  // Tab goes round inside it.
  for (let i = 0; i < 40; i++) await page.keyboard.press('Tab');
  expect(await menu.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+Tab');
  expect(await menu.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  // Escape closes it, and the document has focus again.
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(editor).toBeFocused();

  // A dialog from the sidebar gives focus back to what opened it.
  const row = page.locator(`[role="treeitem"][data-path="${path}"]`);
  await row.focus();
  await page.keyboard.press('F2');
  const dialog = page.getByRole('dialog', { name: 'Rename' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Title')).toBeFocused();
  for (let i = 0; i < 8; i++) await page.keyboard.press('Tab');
  expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(row).toBeFocused();

  // A question (ask.ts) is a dialog on the same stack: Escape closes it.
  await page.getByTestId('document-menu-button').click();
  const theMenu = page.getByRole('menu', { name: /^Document/ });
  await expect(theMenu).toBeVisible();
  await theMenu.getByRole('menuitem', { name: 'Save version…' }).click();
  const ask = page.getByRole('dialog', { name: 'Name this version' });
  await expect(ask).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(ask).toHaveCount(0);
});
