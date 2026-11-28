// Importing (docs/decisions/0114-importing.md): Import… on a folder's menu, a
// Word document chosen and made into a folder of chapters, opened; a Scrivener
// project's folder chosen and made into a folder as its binder is.
import { expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pandocRenderer } from '../../packages/render-pandoc/src/index.js';
import { pandocWasm } from '../../packages/render-pandoc/src/where.js';
import { E2E } from './env.js';

test.skip(!pandocWasm(), 'pandoc has not been fetched (node scripts/fetch-render-tools.mjs)');

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${E2E.url}${path}`, { ...init, headers: { authorization: `Bearer ${E2E.token}`, 'content-type': 'application/json' } });
const readIn = (p: string) => {
  try {
    return readFileSync(join(E2E.dir, p), 'utf8');
  } catch {
    return '';
  }
};

/** A Word file, made from Markdown by the built-in pandoc. */
async function word(markdown: string): Promise<Buffer> {
  const scratch = mkdtempSync(join(tmpdir(), 'kuraa-docx-'));
  writeFileSync(join(scratch, 'in.md'), markdown);
  const r = await pandocRenderer.render({ scratch: join(scratch, 's'), workspace: scratch, read: async () => null, timeLimitMs: 60_000, signal: new AbortController().signal, log: () => {}, status: () => {} }, { input: join(scratch, 'in.md'), format: 'docx' });
  expect(r.ok).toBe(true);
  return readFileSync(join(scratch, 's', r.output!));
}

test('a Word document imported into a folder: a document for each chapter, in order, opened', async ({ page }) => {
  const id = Date.now().toString(36);
  const folder = `imports-${id}`;
  expect((await api('/api/files', { method: 'POST', body: JSON.stringify({ path: `${folder}/readme.md`, content: '# Imports\n' }) })).status).toBe(201);
  const docx = await word('---\ntitle: Harbour Book\n---\n\n# Arrival\n\nWe came by sea.\n\n# Departure\n\nWe left at dawn.\n');

  await page.goto(`/?token=${E2E.token}&name=Writer&email=w%40example.org`);
  await page.getByTestId(`folder:${folder}`).click({ button: 'right' });
  await page.getByTestId('context:import').click();
  const dialog = page.getByTestId('import-dialog');
  await expect(dialog).toContainText(`Import into “${folder}”`);
  await page.getByTestId('import-file').setInputFiles({ name: 'harbour.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: docx });
  await expect(page.getByTestId('import-chosen')).toContainText('“harbour”, a document');
  await expect(page.getByTestId('import-split')).toHaveValue('chapters');
  await page.getByTestId('import-run').click();
  await expect(page.getByTestId('import-made')).toContainText('Made “Harbour Book”: 2 documents.', { timeout: 30_000 });
  expect(readIn(`${folder}/Harbour Book/.kuraa-order`)).toMatch(/\narrival\.md\ndeparture\.md\n$/);
  await page.getByTestId('import-open').click();
  await expect(page.getByTestId('editor')).toContainText('We came by sea.');
  await expect(page.locator(`.tree [role="treeitem"][data-path="${folder}/Harbour Book/departure.md"]`)).toBeVisible();
});

test('a Scrivener project’s folder imported at the top level: its binder as folders and documents, with their details', async ({ page }) => {
  const id = Date.now().toString(36);
  const project = join(mkdtempSync(join(tmpdir(), 'kuraa-scriv-')), `Tides ${id}.scriv`);
  const rtf = (s: string) => `{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Times;}}\\f0 ${s}\\par}`;
  const put = (p: string, s: string | Buffer) => {
    mkdirSync(join(project, p, '..'), { recursive: true });
    writeFileSync(join(project, p), s);
  };
  put(`Tides ${id}.scrivx`, `<?xml version="1.0" encoding="UTF-8"?>
<ScrivenerProject Version="2.0"><Binder>
  <BinderItem UUID="D" Type="DraftFolder"><Title>Draft</Title><Children>
    <BinderItem UUID="T1" Type="Text"><Title>High water</Title><MetaData><StatusID>2</StatusID></MetaData></BinderItem>
    <BinderItem UUID="T2" Type="Text"><Title>Low water</Title></BinderItem>
  </Children></BinderItem>
</Binder>
<StatusSettings><StatusItems><Status ID="2">First Draft</Status></StatusItems></StatusSettings>
<ProjectProperties><ProjectTitle>Tides ${id}</ProjectTitle></ProjectProperties></ScrivenerProject>`);
  put('Files/Data/T1/content.rtf', rtf('The sea came in.'));
  put('Files/Data/T1/synopsis.txt', 'In it comes.');
  put('Files/Data/T2/content.rtf', rtf('The sea went out.'));
  put('Files/search.indexes', 'not sent');
  put('Snapshots/T1.snapshots/x.rtf', rtf('An old version.'));

  await page.goto(`/?token=${E2E.token}&name=Writer&email=w%40example.org`);
  // The top level's menu: ＋, right-clicked.
  await page.getByTestId('new-menu').click({ button: 'right' });
  await page.getByTestId('context:import').click();
  await expect(page.getByTestId('import-dialog')).toContainText('Import');
  await page.getByTestId('import-folder').setInputFiles(project);
  await expect(page.getByTestId('import-chosen')).toContainText(`“Tides ${id}”, a Scrivener project (4 files to send)`);
  await page.getByTestId('import-run').click();
  await expect(page.getByTestId('import-made')).toContainText(`Made “Tides ${id}”: 2 documents, 1 folder in it.`, { timeout: 30_000 });
  await expect(page.getByTestId('import-left')).toContainText('snapshots');
  expect(readIn(`Tides ${id}/Draft/high-water.md`)).toBe('---\ntitle: High water\nsynopsis: In it comes.\nstatus: First Draft\n---\n\nThe sea came in.\n');
  expect(readIn(`Tides ${id}/Draft/.kuraa-order`)).toMatch(/\nhigh-water\.md\nlow-water\.md\n$/);
});
