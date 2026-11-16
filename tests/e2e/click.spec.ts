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
  const box = (await page.locator('.editor-scroll').boundingBox())!;
  await page.mouse.click(box.x + box.width * xFraction, box.y + box.height - fromBottom);
}

test('a click below the text puts the cursor at the end; beside a line, on that line', async ({ page }) => {
  const path = `runs/click-${Date.now().toString(36)}.md`;
  await openNew(page, path, '# One line\n');
  const editor = page.getByTestId('editor');

  await clickBlank(page, 0.5, 40);
  await page.keyboard.type(' and more');
  await expect(editor.locator('h1')).toHaveText('One line and more');

  // The left margin, level with the heading: the start of that line.
  const h1 = (await editor.locator('h1').boundingBox())!;
  const scroll = (await page.locator('.editor-scroll').boundingBox())!;
  await page.mouse.click(scroll.x + 8, h1.y + h1.height / 2);
  await page.keyboard.type('Just ');
  await expect(editor.locator('h1')).toHaveText('Just One line and more');

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
