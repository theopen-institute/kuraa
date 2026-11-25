// Clicking the editor's empty space puts the cursor somewhere useful: the end of
// the document below the text, the nearest point on the line beside it.
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E } from './env.js';

async function openNew(page: Page, path: string, content: string): Promise<void> {
  const res = await fetch(`${E2E.url}/api/files`, {
    method: 'POST',
    headers: { authorization: `Bearer ${E2E.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ path, content }),
  });
  expect(res.status).toBe(201);
  await page.goto(`/?token=${E2E.token}&name=Clicker&email=click%40example.org`);
  await page.getByTestId(`file:${path}`).click();
  await expect(page.getByTestId('peers')).toContainText('Clicker');
}

/** Click the editor's scroll area at a fraction of its width, `fromBottom` px above its bottom edge. */
async function clickBlank(page: Page, xFraction: number, fromBottom: number): Promise<void> {
  const box = (await page.locator('.editor-scroll:not(.editor-preview)').boundingBox())!;
  await page.mouse.click(box.x + box.width * xFraction, box.y + box.height - fromBottom);
}

test('a click below the text puts the cursor at the end; beside a line, on that line', async ({ page }) => {
  const path = `runs/click-${Date.now().toString(36)}.md`;
  await openNew(page, path, '# One line\n');
  const editor = page.getByTestId('editor');

  await clickBlank(page, 0.5, 40);
  await page.keyboard.type(' and more');
  await expect(editor.locator('h1:not(.doc-title)')).toHaveText('One line and more');

  // The left margin, level with the heading: the start of that line.
  const h1 = (await editor.locator('h1:not(.doc-title)').boundingBox())!;
  const scroll = (await page.locator('.editor-scroll:not(.editor-preview)').boundingBox())!;
  await page.mouse.click(scroll.x + 8, h1.y + h1.height / 2);
  await page.keyboard.type('Just ');
  await expect(editor.locator('h1:not(.doc-title)')).toHaveText('Just One line and more');

  await expect.poll(() => readFileSync(join(E2E.dir, path), 'utf8'), { timeout: 10_000 }).toBe('# Just One line and more\n');
});

test('the same in a source file', async ({ page }) => {
  const path = `runs/click-${Date.now().toString(36)}.R`;
  await openNew(page, path, 'x <- 1');
  await clickBlank(page, 0.5, 40);
  await page.keyboard.type(' + 1');
  await expect(page.getByTestId('editor').locator('.line').first()).toHaveText('x <- 1 + 1');
  await expect.poll(() => readFileSync(join(E2E.dir, path), 'utf8'), { timeout: 10_000 }).toBe('x <- 1 + 1');
});

test('below a document that ends with a code block, a click starts a new paragraph', async ({ page }) => {
  const path = `runs/click-${Date.now().toString(36)}.md`;
  const start = '# Another\n\n```{something}\ncode here\n```\n';
  await openNew(page, path, start);
  const editor = page.getByTestId('editor');

  await clickBlank(page, 0.5, 40);
  await page.keyboard.type('More text');
  await expect(editor.locator('p')).toHaveText('More text');
  await expect(editor.locator('.code-node')).toContainText('code here');
  await expect(editor.locator('.code-node')).not.toContainText('More text');
  await expect.poll(() => readFileSync(join(E2E.dir, path), 'utf8'), { timeout: 10_000 }).toBe(`${start}\nMore text\n`);
});

test('arrow keys leave a code block that ends or starts the document', async ({ page }) => {
  const path = `runs/arrows-${Date.now().toString(36)}.md`;
  await openNew(page, path, '```r\nx <- 1\n```\n');
  const editor = page.getByTestId('editor');
  await editor.locator('.cm-line').first().click();
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.type('After');
  await editor.locator('.cm-line').first().click();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.type('Before');
  await expect.poll(() => readFileSync(join(E2E.dir, path), 'utf8'), { timeout: 10_000 }).toBe('Before\n\n```r\nx <- 1\n```\n\nAfter\n');
});

test('below the footnotes, a click goes to the end of the last note and adds nothing', async ({ page }) => {
  const path = `runs/click-notes-${Date.now().toString(36)}.md`;
  const start = 'Main text.[^a]\n\n[^a]: The note.\n';
  await openNew(page, path, start);
  const editor = page.getByTestId('editor');

  await clickBlank(page, 0.5, 40);
  await clickBlank(page, 0.5, 40);
  await clickBlank(page, 0.5, 40);
  await page.keyboard.type(' More.');
  await expect(editor.locator('aside.note .note-body')).toHaveText('The note. More.');
  await expect(editor.locator('p')).toHaveCount(2); // the main paragraph and the note's
  await expect.poll(() => readFileSync(join(E2E.dir, path), 'utf8'), { timeout: 10_000 }).toBe('Main text.[^a]\n\n[^a]: The note. More.\n');
});

test('a drag that starts in the empty space selects, as in the text; so does Shift-click there', async ({ page }) => {
  const path = `runs/drag-${Date.now().toString(36)}.md`;
  await openNew(page, path, 'First line.\n\nSecond line.\n\nThird line.\n');
  const editor = page.getByTestId('editor');
  const scroll = (await page.locator('.editor-scroll:not(.editor-preview)').boundingBox())!;
  const first = (await editor.locator('p').nth(0).boundingBox())!;
  const second = (await editor.locator('p').nth(1).boundingBox())!;

  // From the left margin level with the first line, to the right margin level with the second.
  await page.mouse.move(scroll.x + 8, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(scroll.x + scroll.width - 8, second.y + second.height / 2, { steps: 5 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection()?.toString().replace(/\s+/g, ' ').trim())).toBe('First line. Second line.');

  // Shift-click below the text: from the cursor to the end.
  await editor.locator('p').nth(1).click();
  await page.keyboard.press('Home');
  await page.keyboard.down('Shift');
  await page.mouse.click(scroll.x + scroll.width / 2, scroll.y + scroll.height - 40);
  await page.keyboard.up('Shift');
  expect(await page.evaluate(() => window.getSelection()?.toString().replace(/\s+/g, ' ').trim())).toBe('Second line. Third line.');
});
