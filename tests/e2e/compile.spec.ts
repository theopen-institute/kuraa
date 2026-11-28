// Order and Compile over folders (docs/decisions/0093-order-and-compile-over-folders.md):
// a folder arranged in the file tree by hand (Alt+↓, and by dragging between
// rows), kept in its .kuraa-order; a document dragged in from another folder,
// to a place; back to by name. A document left out of Compile (faded) and put
// back; Compile… on the folder's menu opens its panel. Where Podman runs: the
// folder compiled to HTML, its chapters in order, without what is left out;
// and to EPUB with a book's own settings (0106): its author, a cover, a table
// of contents, chapters numbered, scenes without titles and a separator.
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { podmanWorks } from '../../packages/env-podman/src/index.js';
import { pandocWasm, typstParts } from '../../packages/render-pandoc/src/where.js';
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
  // Beside the book in the tree (book-<id>-loose sorts after book-<id>): both in view, a drag between them never scrolls.
  expect((await doc(`${folder}-loose/tide.md`, 'Tide')).status).toBe(201);
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
  // The tree drawn in that order before the next drag: dragged onto rows still moving, it lands elsewhere.
  await expect.poll(rowsIn(page, folder)).toBe('c.md b.md a.md');

  // From another folder, onto the lower half of Coast: moved there, after it.
  await row(`${folder}-loose/tide.md`).dragTo(row(`${folder}/c.md`), { targetPosition: { x: 20, y: Math.round(box.height * 0.75) } });
  await expect.poll(orderOf(folder)).toBe('c.md tide.md b.md a.md');
  await expect(row(`${folder}/tide.md`)).toBeVisible();

  // Compile… on the folder's menu: its panel, for it, with its outline in the tree's order.
  await page.getByTestId(`folder:${folder}`).click({ button: 'right' });
  await page.getByTestId('context:compile').click();
  await expect(page.getByTestId('compile-folder')).toHaveText(`Compile “${folder}”`);
  await expect(page.getByTestId('compile-title')).toHaveValue(folder);
  const outline = page.getByTestId('compile-outline');
  await expect(outline.locator('.compile-name')).toHaveText(['Coast', 'Tide', 'Boats', 'Arrival']);

  // Left out from the outline: unticked, faded in the file tree too; put back.
  await page.getByTestId(`compile-include:${folder}/tide.md`).uncheck();
  await expect(page.getByTestId(`mark:left-out:${folder}/tide.md`)).toBeAttached();
  await expect.poll(() => readIn(`${folder}/.kuraa-compile.yml`)).toContain('exclude:\n  - tide.md\n');
  await expect(page.getByTestId(`compile-row:${folder}/tide.md`)).toHaveClass(/\bout\b/);
  await page.getByTestId(`compile-include:${folder}/tide.md`).check();
  await expect(page.getByTestId(`mark:left-out:${folder}/tide.md`)).toHaveCount(0);

  // Back to by name, from the folder's menu.
  await page.getByTestId(`folder:${folder}`).click({ button: 'right' });
  await page.getByTestId('context:sort-by-name').click();
  await expect.poll(rowsIn(page, folder)).toBe('a.md b.md c.md tide.md');
});

test('a folder compiled to HTML: in the tree’s order, how deep each is its heading’s level, without what is left out', async ({ page }) => {
  test.skip(!pandocWasm(), 'pandoc has not been fetched');
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
  await page.getByTestId(`folder:${folder}`).click({ button: 'right' });
  await page.getByTestId('context:compile').click();
  // The outline: each row at its heading's level; drafts given no heading there (Dunes up a level), marked so in the tree.
  const level = (path: string) => page.getByTestId(`compile-row:${folder}/${path}`).locator('.compile-level');
  await expect(level('North/c.md')).toHaveText('##');
  await expect(level('drafts/d.md')).toHaveText('##');
  await page.getByTestId(`compile-heading:${folder}/drafts`).uncheck();
  await expect(level('drafts/d.md')).toHaveText('#');
  await expect(level('drafts')).toHaveText('–');
  await expect(page.getByTestId(`mark:no-heading:${folder}/drafts`)).toBeAttached();
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

test('a folder compiled to EPUB with its own settings: author, cover, contents, chapters, scenes run on with a separator (0106)', async ({ page }) => {
  test.skip(!pandocWasm(), 'pandoc has not been fetched');
  test.setTimeout(600_000);
  const id = Date.now().toString(36);
  const folder = `epub-${id}`;
  expect((await doc(`${folder}/Arrival/a.md`, 'Boat', 'The boat came in.')).status).toBe(201);
  expect((await doc(`${folder}/Arrival/b.md`, 'Quay', 'The quay was empty.')).status).toBe(201);
  expect((await doc(`${folder}/Departure/c.md`, 'Tide', 'The tide went out.')).status).toBe(201);
  // A cover: an image in the workspace (a pixel).
  mkdirSync(join(E2E.dir, folder, 'art'), { recursive: true });
  writeFileSync(join(E2E.dir, folder, 'art', 'cover.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));

  await page.goto(`/?token=${E2E.token}&name=Writer&email=w%40example.org`);
  await page.getByTestId(`folder:${folder}`).click({ button: 'right' });
  await page.getByTestId('context:compile').click();
  await page.getByTestId('compile-title').fill('The Coast');
  await page.getByTestId('compile-subtitle').fill('A novel');
  await page.getByTestId('compile-author').fill('Ada Byron');
  await page.getByTestId('compile-author').press('Tab');
  await page.getByTestId('compile-format:epub').check();
  // The Word template is for Word only; the cover, for EPUB.
  await expect(page.getByTestId('compile-template')).toHaveCount(0);
  await page.getByTestId('compile-cover').selectOption(`${folder}/art/cover.png`);
  await page.getByTestId('compile-toc').check();
  await page.getByTestId('compile-numbering').selectOption('chapters');
  await page.getByTestId('compile-separator').fill('#');
  await page.getByTestId('compile-separator').press('Tab');
  // Arrival's scenes without titles: no heading of their own in the outline.
  const level = (path: string) => page.getByTestId(`compile-row:${folder}/${path}`).locator('.compile-level');
  await expect(level('Arrival/a.md')).toHaveText('##');
  await page.getByTestId(`compile-titles:${folder}/Arrival`).uncheck();
  await expect(level('Arrival/a.md')).toHaveText('–');
  await expect(level('Departure/c.md')).toHaveText('##');
  // All kept in the folder's Compile file, as each was changed.
  await expect.poll(() => readIn(`${folder}/.kuraa-compile.yml`)).toContain('author: Ada Byron');
  const kept = readIn(`${folder}/.kuraa-compile.yml`);
  for (const line of ['subtitle: A novel', 'toc: true', 'numbering: chapters', 'separator: "#"', `cover-image: ${folder}/art/cover.png`]) expect(kept).toContain(line);
  await expect.poll(() => readIn(`${folder}/Arrival/.kuraa-compile.yml`)).toContain('titles: false');

  const download = page.waitForEvent('download', { timeout: 590_000 });
  await page.getByTestId('compile-button').click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(`${folder}.epub`);
  const epub = (await file.path())!;
  const entries = execFileSync('unzip', ['-Z1', epub], { encoding: 'utf8' }).split('\n').filter(Boolean);
  expect(entries).toContain('mimetype');
  // The cover: its page, and the image (pandoc names it).
  expect(entries.some((e) => /cover\.xhtml$/.test(e))).toBe(true);
  expect(entries.some((e) => /^EPUB\/media\/.*\.png$/.test(e))).toBe(true);
  const read = (pattern: RegExp) => entries.filter((e) => pattern.test(e)).map((e) => execFileSync('unzip', ['-p', epub, e], { encoding: 'utf8' })).join('\n');
  expect(read(/\.opf$/)).toContain('Ada Byron');
  const text = read(/\.xhtml$/);
  expect(text).toContain('Chapter 1: Arrival');
  expect(text).toContain('Chapter 2: Departure');
  // The scenes run on under their chapter, the separator between them; Tide keeps its title.
  expect(text).not.toMatch(/<h\d[^>]*>Boat<\/h\d>/);
  expect(text).toMatch(/The boat came in\.[\s\S]*class="scene-break"[\s\S]*#[\s\S]*The quay was empty\./);
  expect(text).toMatch(/<h2[^>]*>Tide<\/h2>/);
  await expect(page.getByTestId('compile-saved')).toBeVisible();
});

test('a folder compiled to Word with a template from the workspace, and to PDF with contents and every heading numbered (0106)', async ({ page }) => {
  test.skip(!pandocWasm() || !typstParts(), 'pandoc and Typst have not been fetched');
  test.setTimeout(600_000);
  const id = Date.now().toString(36);
  const folder = `word-${id}`;
  expect((await doc(`${folder}/a.md`, 'Arrival', 'We came by sea.')).status).toBe(201);
  expect((await doc(`${folder}/b.md`, 'Boats', 'Small ones.')).status).toBe(201);
  const renderLog = async (format: string) => ((await (await api(`/api/renders?path=${encodeURIComponent(`${folder}/`)}`)).json()) as { renders: { format: string; log: string }[] }).renders.find((r) => r.format === format)?.log ?? '';

  await page.goto(`/?token=${E2E.token}&name=Writer&email=w%40example.org`);
  await page.getByTestId(`folder:${folder}`).click({ button: 'right' });
  await page.getByTestId('context:compile').click();
  await page.getByTestId('compile-numbering').selectOption('chapters');
  // Word, first without a template: what it makes becomes one, in the workspace.
  await page.getByTestId('compile-format:docx').check();
  let download = page.waitForEvent('download', { timeout: 590_000 });
  await page.getByTestId('compile-button').click();
  const first = await download;
  expect(first.suggestedFilename()).toBe(`${folder}.docx`);
  const docx = (await first.path())!;
  expect(execFileSync('unzip', ['-p', docx, 'word/document.xml'], { encoding: 'utf8' })).toContain('Chapter 1: Arrival');
  mkdirSync(join(E2E.dir, folder, 'templates'), { recursive: true });
  writeFileSync(join(E2E.dir, folder, 'templates', 'house.docx'), readFileSync(docx));

  // Compile… again: the template to choose, kept for the folder, given to pandoc.
  await page.getByTestId(`folder:${folder}`).click({ button: 'right' });
  await page.getByTestId('context:compile').click();
  await page.getByTestId('compile-template').selectOption(`${folder}/templates/house.docx`);
  await expect.poll(() => readIn(`${folder}/.kuraa-compile.yml`)).toContain(`reference-doc: ${folder}/templates/house.docx`);
  download = page.waitForEvent('download', { timeout: 590_000 });
  await page.getByTestId('compile-button').click();
  await download;
  expect(await renderLog('docx')).toMatch(/--reference-doc=\S*reference\.docx/);

  // PDF: a table of contents, every heading numbered.
  await page.getByTestId('compile-format:pdf').check();
  await expect(page.getByTestId('compile-template')).toHaveCount(0);
  await page.getByTestId('compile-toc').check();
  await page.getByTestId('compile-numbering').selectOption('sections');
  download = page.waitForEvent('download', { timeout: 590_000 });
  await page.getByTestId('compile-button').click();
  const pdf = await download;
  expect(readFileSync((await pdf.path())!).subarray(0, 5).toString()).toBe('%PDF-');
  expect(await renderLog('pdf')).toMatch(/--toc --number-sections/);
});

test('a single document rendered to EPUB too, Markdown and R Markdown (0106)', async () => {
  test.skip(!podmanWorks(), 'Podman is not installed and running');
  test.setTimeout(600_000);
  const id = Date.now().toString(36);
  expect((await doc(`single-${id}/a.md`, 'Harbour', 'Gulls.')).status).toBe(201);
  expect((await api('/api/files', { method: 'POST', body: JSON.stringify({ path: `single-${id}/b.Rmd`, content: '---\ntitle: Tides\n---\n\n```{r}\n1 + 1\n```\n' }) })).status).toBe(201);
  const by = { name: 'Writer', email: 'w@example.org', color: '#123456' };
  for (const [path, words] of [[`single-${id}/a.md`, 'Gulls.'], [`single-${id}/b.Rmd`, '## [1] 2']] as const) {
    const started = await api('/api/renders', { method: 'POST', body: JSON.stringify({ path, format: 'epub', by }) });
    expect(started.status).toBe(202);
    await expect.poll(async () => ((await (await api(`/api/renders?path=${encodeURIComponent(path)}`)).json()) as { renders: { format: string; state: string; message: string }[] }).renders.find((r) => r.format === 'epub')?.state, { timeout: 590_000, intervals: [1000] }).toBe('done');
    const out = await api(`/api/renders/file?path=${encodeURIComponent(path)}&format=epub`);
    expect(out.headers.get('content-type')).toBe('application/epub+zip');
    const at = join(E2E.dir, '..', `single-${id}-${path.endsWith('md') ? 'md' : 'rmd'}.epub`);
    writeFileSync(at, Buffer.from(await out.arrayBuffer()));
    const text = execFileSync('unzip', ['-p', at, 'EPUB/text/*.xhtml'], { encoding: 'utf8' });
    expect(text).toContain(words);
  }
});

test('a move is shown at once, before the host has made it; one the host refuses goes back', async ({ page }) => {
  const id = Date.now().toString(36);
  const folder = `at-once-${id}`;
  expect((await doc(`${folder}/a.md`, 'Arrival')).status).toBe(201);
  expect((await doc(`${folder}/b.md`, 'Boats')).status).toBe(201);
  expect((await doc(`${folder}-from/tide.md`, 'Tide')).status).toBe(201);
  expect((await doc(`${folder}-from/a.md`, 'Another arrival')).status).toBe(201);
  await page.goto(`/?token=${E2E.token}&name=Writer&email=w%40example.org`);
  await expect.poll(rowsIn(page, folder)).toBe('a.md b.md');

  // The host slow to move it: the file is in its new place in the tree long before.
  await page.route('**/api/files', async (route) => {
    if (route.request().method() === 'PATCH') await new Promise((r) => setTimeout(r, 2000));
    await route.continue();
  });
  const row = (path: string) => page.getByTestId(`file:${path}`);
  const box = (await row(`${folder}/a.md`).boundingBox())!;
  await row(`${folder}-from/tide.md`).dragTo(row(`${folder}/a.md`), { targetPosition: { x: 20, y: Math.round(box.height * 0.75) } });
  await expect.poll(rowsIn(page, folder), { timeout: 1000 }).toBe('a.md tide.md b.md');
  await expect.poll(() => readIn(`${folder}/tide.md`), { timeout: 10_000 }).toContain('Tide');
  await expect.poll(orderOf(folder), { timeout: 10_000 }).toBe('a.md tide.md b.md');

  // Onto a name the folder has already: shown there at once, then back where it was, saying why.
  await row(`${folder}-from/a.md`).dragTo(row(`${folder}/b.md`), { targetPosition: { x: 20, y: Math.round(box.height * 0.75) } });
  await expect(row(`${folder}-from/a.md`)).toHaveCount(0, { timeout: 1000 });
  await expect(row(`${folder}-from/a.md`)).toBeVisible({ timeout: 10_000 });
  await expect.poll(rowsIn(page, folder)).toBe('a.md tide.md b.md');
});
