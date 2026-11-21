// The Source view is editable: edits there reach the live document, character by
// character, and edits made elsewhere (another person, in the rich view) appear
// in it as they happen.
import { expect, test, type Browser, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E } from './env.js';

async function create(content: string): Promise<string> {
  const path = `runs/source-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.md`;
  const res = await fetch(`${E2E.url}/api/files`, {
    method: 'POST',
    headers: { authorization: `Bearer ${E2E.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ path, content }),
  });
  expect(res.status).toBe(201);
  return path;
}

async function open(browser: Browser, name: string, path: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  page.on('pageerror', (e) => console.error(`[${name}] page error: ${e.message}`));
  await page.goto(`/?token=${E2E.token}&name=${name}&email=${name.toLowerCase()}%40example.org`);
  await page.getByTestId(`file:${path}`).click();
  await expect(page.getByTestId('peers')).toContainText(name);
  return page;
}

const source = (page: Page) => page.getByTestId('source-editor');
const onDisk = (path: string) => readFileSync(join(E2E.dir, path), 'utf8');

/** Put the source cursor at the start or end of the line containing `text`. */
async function sourceLine(page: Page, text: string, where: 'start' | 'end'): Promise<void> {
  await source(page).locator('.cm-line', { hasText: text }).click();
  await page.keyboard.press(where === 'start' ? 'Home' : 'End');
}

test('edits in the source view reach the document and the file', async ({ browser }) => {
  const path = await create('# Notes\n\nThe tide was out.\n\nLight rain all morning.\n');
  const page = await open(browser, 'Sam', path);
  await page.getByTestId('menu-button').click();
  await page.getByTestId('menu-document').click();
  await page.getByTestId('toggle-source').click();
  await expect(source(page)).toContainText('The tide was out.');

  await sourceLine(page, 'Light rain', 'end');
  await page.keyboard.type(' It cleared by noon.\n\n## Afternoon\n\nCores were **deep**.', { delay: 5 });
  await expect.poll(() => onDisk(path), { timeout: 10_000 }).toContain('Cores were **deep**.');
  expect(onDisk(path)).toBe('# Notes\n\nThe tide was out.\n\nLight rain all morning. It cleared by noon.\n\n## Afternoon\n\nCores were **deep**.\n');

  // The rich view has the same, with structure.
  await page.getByTestId('menu-button').click();
  await page.getByTestId('menu-document').click();
  await page.getByTestId('toggle-source').click();
  const editor = page.getByTestId('editor');
  await expect(editor.locator('h2')).toHaveText('Afternoon');
  await expect(editor.locator('strong')).toHaveText('deep');
});

test('one person in the source view and one in the rich view, in the same paragraph, both keep their text', async ({ browser }) => {
  const path = await create('# Notes\n\nThe tide was out.\n\nLight rain all morning.\n');
  const ada = await open(browser, 'Ada', path);
  const bo = await open(browser, 'Bo', path);
  await ada.getByTestId('menu-button').click();
  await ada.getByTestId('menu-document').click();
  await ada.getByTestId('toggle-source').click();
  await expect(source(ada)).toContainText('The tide was out.');

  // Ada at the start of the paragraph, in the source; Bo at its end, in the rich view.
  await sourceLine(ada, 'The tide', 'start');
  await bo.getByTestId('editor').locator('p', { hasText: 'The tide' }).click();
  await bo.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
  await bo.waitForTimeout(100);
  await Promise.all([
    ada.keyboard.type('Early on, ', { delay: 40 }),
    bo.keyboard.type(' Then rain came.', { delay: 40 }),
  ]);

  const expected = 'Early on, The tide was out. Then rain came.';
  await expect(source(ada)).toContainText(expected, { timeout: 10_000 });
  await expect(bo.getByTestId('editor').locator('p', { hasText: 'The tide' })).toHaveText(expected);
  await expect.poll(() => onDisk(path), { timeout: 10_000 }).toBe(`# Notes\n\n${expected}\n\nLight rain all morning.\n`);
});
