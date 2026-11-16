// Source files open as numbered, highlighted lines in ProseMirror. Editing keeps
// indentation and each line's terminator, and the file on disk changes only
// where it was edited.
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E } from './env.js';

const MAC = process.platform === 'darwin';
const SCRIPT = [
  '# Summarise the survey',
  'library(dplyr)',
  '',
  'summarise_wb <- function(df) {',
  '  df |> summarise(mean = mean(wb_total, na.rm = TRUE), n = n())',
  '}',
  '',
].join('\r\n');

async function create(path: string, content: string): Promise<void> {
  const res = await fetch(`${E2E.url}/api/files`, {
    method: 'POST',
    headers: { authorization: `Bearer ${E2E.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ path, content }),
  });
  expect(res.status).toBe(201);
}

async function open(page: Page, path: string): Promise<void> {
  await page.goto(`/?token=${E2E.token}&name=Line%20Editor&email=lines%40example.org`);
  await page.getByTestId(`file:${path}`).click();
  await expect(page.getByTestId('status')).toContainText('Connected');
  await expect(page.getByTestId('peers')).toContainText('Line Editor');
}

/** Put the caret at the end of the line whose text is exactly `text`. */
async function endOf(page: Page, text: string): Promise<void> {
  await page.getByTestId('editor').locator('.line', { hasText: text }).first().click();
  await page.keyboard.press(MAC ? 'Meta+ArrowRight' : 'End');
  await page.waitForTimeout(100); // ProseMirror reads the moved caret from selectionchange
}

test('an R script is highlighted, edits keep indentation and CRLF, and paste splits lines', async ({ page }) => {
  const path = `runs/summary-${Date.now().toString(36)}.R`;
  await create(path, SCRIPT);
  page.on('pageerror', (e) => console.error(`page error: ${e.message}`));
  await open(page, path);
  const editor = page.getByTestId('editor');

  // One numbered line per line of the file (the CRLF after the last line leaves an empty one).
  await expect(editor.locator('.line')).toHaveCount(7);
  await expect(editor).toHaveClass(/lines-doc/);
  // Highlighted by the R mode.
  await expect(editor.locator('.tok-comment').first()).toHaveText('# Summarise the survey');
  await expect(editor.locator('.tok-keyword', { hasText: 'function' })).toHaveCount(1);
  await expect(editor.locator('.tok-atom', { hasText: 'TRUE' })).toHaveCount(1);
  // No markdown machinery: no Source toggle, and markdown cues stay literal.
  await expect(page.getByTestId('toggle-source')).toHaveCount(0);

  // Enter keeps the indentation of the line it splits.
  await endOf(page, 'n = n())');
  await page.keyboard.press('Enter');
  await page.keyboard.type('# **not bold**', { delay: 10 });
  await expect(editor.locator('.line').nth(5)).toHaveText('  # **not bold**');
  await expect(editor.locator('strong')).toHaveCount(0);

  // Tab indents by the file's unit (two spaces here).
  await endOf(page, 'library(dplyr)');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.type('x <- 1', { delay: 10 });
  await expect(editor.locator('.line').nth(2)).toHaveText('  x <- 1');

  // Pasting several lines makes several lines.
  await endOf(page, 'x <- 1');
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text/plain', '\ny <- 2\nz <- 3');
    document.querySelector('[data-testid=editor]')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(editor.locator('.line').nth(3)).toHaveText('y <- 2');
  await expect(editor.locator('.line').nth(4)).toHaveText('z <- 3');

  const expected = [
    '# Summarise the survey',
    'library(dplyr)',
    '  x <- 1',
    'y <- 2',
    'z <- 3',
    '',
    'summarise_wb <- function(df) {',
    '  df |> summarise(mean = mean(wb_total, na.rm = TRUE), n = n())',
    '  # **not bold**',
    '}',
    '',
  ];
  const file = join(E2E.dir, path);
  await expect.poll(() => readFileSync(file, 'utf8'), { timeout: 10_000 }).toContain('z <- 3');
  const onDisk = readFileSync(file, 'utf8');
  // Every original line kept its CRLF; new lines got the file's usual ending, CRLF.
  expect(onDisk).toBe(expected.join('\r\n'));
});

test('BibTeX and YAML files are highlighted', async ({ page }) => {
  const bib = `runs/refs-${Date.now().toString(36)}.bib`;
  await create(bib, '@article{silliman2019,\n  title = {Physical stress},\n  year  = 2019,\n}\n');
  await open(page, bib);
  const editor = page.getByTestId('editor');
  await expect(editor.locator('.tok-keyword')).toHaveText('@article');
  await expect(editor.locator('.tok-definition')).toHaveText('silliman2019');
  await expect(editor.locator('.tok-property').first()).toHaveText('title');
  await expect(editor.locator('.tok-string')).toHaveText('{Physical stress}');
  await expect(editor.locator('.tok-number')).toHaveText('2019');

  const yml = `runs/site-${Date.now().toString(36)}.yml`;
  await create(yml, 'project:\n  type: book  # a comment\n  render: [index.qmd]\n');
  await open(page, yml);
  await expect(editor.locator('.tok-comment')).toHaveText('# a comment');
  await expect(editor.locator('.tok-property, .tok-definition').first()).toHaveText('project');
});
