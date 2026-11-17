// Running R chunks from the browser: outputs appear under each chunk, for
// everyone with the document open, survive a reload, and never touch the file.
import { expect, test, type Browser, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRscript } from '../../packages/engine-r/src/index.js';
import { E2E } from './env.js';

const MAC = process.platform === 'darwin';
const MOD = MAC ? 'Meta' : 'Control';
const DOC = [
  '# Runs',
  '',
  '```{r setup}',
  'x <- 21',
  'print(x * 2)',
  '```',
  '',
  '```{r table}',
  'data.frame(n = 1:3, letter = c("a", "b", NA))',
  '```',
  '',
  '```{r figure, fig.width = 4, fig.height = 3}',
  'plot(1:10)',
  '```',
  '',
].join('\n');

test.skip(findRscript() === null, 'R is not installed');

async function open(browser: Browser, name: string, path: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  page.on('pageerror', (e) => console.error(`[${name}] page error: ${e.message}`));
  await page.goto(`/?token=${E2E.token}&name=${encodeURIComponent(name)}&email=${name.toLowerCase()}%40example.org`);
  await page.getByTestId(`file:${path}`).click();
  await expect(page.getByTestId('peers')).toContainText(name);
  return page;
}

const chunk = (page: Page, i: number) => page.locator('.code-node-code_chunk').nth(i);
const output = (page: Page, i: number) => chunk(page, i).locator('.chunk-output');

test('chunks run on the host, and everyone sees the outputs', async ({ browser }) => {
  test.setTimeout(120_000);
  const path = `runs/run-${Date.now().toString(36)}.Rmd`;
  const res = await fetch(`${E2E.url}/api/files`, {
    method: 'POST',
    headers: { authorization: `Bearer ${E2E.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ path, content: DOC }),
  });
  expect(res.status).toBe(201);
  const ada = await open(browser, 'Ada', path);
  const bo = await open(browser, 'Bo', path);

  // Run one chunk with its button: text output, credited to who ran it.
  await chunk(ada, 0).getByRole('button', { name: '▶ Run' }).click();
  await expect(output(ada, 0)).toContainText('[1] 42', { timeout: 30_000 });
  await expect(output(ada, 0).locator('.chunk-meta')).toContainText('Ada');
  // Bo sees it too, without running anything.
  await expect(output(bo, 0)).toContainText('[1] 42');

  // ⇧⌘↩ in the next chunk; the session keeps x from the first one.
  await chunk(ada, 1).locator('.cm-content').click();
  await ada.keyboard.press(`${MOD}+Shift+Enter`);
  const table = output(ada, 1).locator('.out-table');
  await expect(table).toBeVisible({ timeout: 30_000 });
  await expect(table.locator('thead')).toContainText('letter');
  await expect(table.locator('td.na')).toHaveText('NA');
  await expect(table).toContainText('3 rows · 2 columns');

  // A plot, at the chunk's fig.width (4 in at 96 px per inch).
  await chunk(bo, 2).getByRole('button', { name: '▶ Run' }).click();
  const img = output(ada, 2).locator('img.out-image');
  await expect(img).toBeVisible({ timeout: 30_000 });
  await expect(img).toHaveAttribute('width', '384');

  // ⌘↩ runs just the current line.
  await chunk(ada, 0).locator('.cm-line').first().click();
  await ada.keyboard.press(`${MOD}+Enter`);
  await expect(output(ada, 0).locator('.chunk-meta')).toContainText('Ran part', { timeout: 30_000 });

  // Editing the code marks the output as out of date.
  await chunk(ada, 1).locator('.cm-line').first().click();
  await ada.keyboard.press('End');
  await ada.keyboard.type(' # edited');
  await expect(output(ada, 1).locator('.chunk-stale')).toBeVisible();

  // A long run can be interrupted, and the session carries on.
  await chunk(ada, 0).locator('.cm-line').first().click();
  await ada.keyboard.press('End');
  await ada.keyboard.type('; Sys.sleep(30)');
  await chunk(ada, 0).getByRole('button', { name: '▶ Run' }).click();
  await expect(chunk(ada, 0).locator('.chunk-status')).toContainText('Running', { timeout: 30_000 });
  await chunk(ada, 0).getByRole('button', { name: 'Stop' }).click();
  await expect(output(ada, 0)).toContainText('Interrupted.', { timeout: 10_000 });
  await expect(ada.getByTestId('r-state')).toHaveText('R ready · on this computer (not sandboxed)');

  // Outputs come back after a reload; the file holds only what was typed.
  await bo.reload();
  await bo.getByTestId(`file:${path}`).click();
  await expect(output(bo, 2).locator('img.out-image')).toBeVisible();
  await expect(output(bo, 1).locator('.out-table')).toBeVisible();
  await expect.poll(() => readFileSync(join(E2E.dir, path), 'utf8'), { timeout: 10_000 }).toContain('# edited');
  const text = readFileSync(join(E2E.dir, path), 'utf8');
  expect(text).not.toContain('[1] 42');
  expect(text).toBe(DOC.replace("c(\"a\", \"b\", NA))", "c(\"a\", \"b\", NA)) # edited").replace('x <- 21', 'x <- 21; Sys.sleep(30)'));
});
