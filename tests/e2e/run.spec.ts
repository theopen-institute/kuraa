// Running R chunks from the browser: outputs appear under each chunk, for
// everyone with the document open, survive a reload, and never touch the file.
// R runs in Podman containers; skipped where Podman is not installed and running.
import { expect, test, type Browser, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { podmanWorks } from '../../packages/env-podman/src/index.js';
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

test.skip(!podmanWorks(), 'Podman is not installed and running');

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

  // Every chunk above ran as it reads (a line run again does not change that): nothing to rebuild.
  for (const i of [1, 2]) await expect(chunk(ada, i).getByRole('button', { name: /above/ })).toHaveCount(0);

  // Editing the code marks the output as out of date, and the outputs below it that it fed.
  await chunk(ada, 1).locator('.cm-line').first().click();
  await ada.keyboard.press('End');
  await ada.keyboard.type(' # edited');
  await expect(output(ada, 1).locator('.chunk-stale')).toHaveText('code changed since');
  await expect(output(ada, 2).locator('.chunk-stale.upstream')).toHaveText('chunk “table” changed since');
  await expect(output(bo, 2).locator('.chunk-stale.upstream')).toHaveText('chunk “table” changed since');
  // Rebuild above runs again from the changed chunk, and only that far.
  await chunk(bo, 2).getByRole('button', { name: 'Rebuild above' }).click();
  await expect(output(ada, 1).locator('.chunk-stale')).toHaveCount(0, { timeout: 30_000 });
  await expect(chunk(ada, 2).getByRole('button', { name: /above/ })).toHaveCount(0);
  await expect(output(ada, 0).locator('.chunk-meta')).toContainText('Ran part');
  // The plot still came from the old table until it runs again.
  await expect(output(ada, 2).locator('.chunk-stale.upstream')).toBeVisible();
  await chunk(ada, 2).getByRole('button', { name: '▶ Run' }).click();
  await expect(output(ada, 2).locator('.chunk-stale')).toHaveCount(0, { timeout: 30_000 });

  // A long run can be interrupted, and the session carries on.
  await chunk(ada, 0).locator('.cm-line').first().click();
  await ada.keyboard.press('End');
  await ada.keyboard.type('; Sys.sleep(30)');
  await chunk(ada, 0).getByRole('button', { name: '▶ Run' }).click();
  await expect(chunk(ada, 0).locator('.chunk-status')).toContainText('Running', { timeout: 30_000 });
  await chunk(ada, 0).getByRole('button', { name: 'Stop' }).click();
  await expect(output(ada, 0)).toContainText('Interrupted.', { timeout: 10_000 });
  await ada.getByTestId('document-menu-button').click();
  await expect(ada.getByTestId('r-state')).toHaveText('R ready · in a Podman container');
  // Escape closes the document's menu.
  await ada.keyboard.press('Escape');

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

const ONLINE = (() => {
  try {
    execFileSync('curl', ['-sSf', '--max-time', '10', '-o', '/dev/null', 'https://cloud.r-project.org/web/packages/hellno/index.html'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

test('the Packages panel installs and removes packages for the workspace', async ({ browser }) => {
  test.skip(!ONLINE, 'needs the network');
  test.setTimeout(300_000);
  const path = `runs/pkgs-${Date.now().toString(36)}.Rmd`;
  const res = await fetch(`${E2E.url}/api/files`, {
    method: 'POST',
    headers: { authorization: `Bearer ${E2E.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ path, content: '# Packages\n\n```{r}\nsuppressPackageStartupMessages(library(hellno)); "hellno works"\n```\n' }),
  });
  expect(res.status).toBe(201);
  const page = await open(browser, 'Pat', path);

  await page.getByTestId('document-menu-button').click();
  await page.getByTestId('document-menu').getByRole('menuitem', { name: 'Packages…' }).click();
  const dialog = page.getByTestId('packages');
  await expect(dialog.getByRole('heading')).toHaveText('R packages');
  await dialog.getByLabel('Packages to install').fill('hellno');
  await dialog.getByRole('button', { name: 'Install' }).click();
  await expect(dialog.locator('.packages-result')).toHaveText('Installed hellno.', { timeout: 240_000 });
  await expect(dialog.locator('section', { hasText: 'In this workspace' }).locator('tr', { hasText: 'hellno' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();

  await chunk(page, 0).getByRole('button', { name: '▶ Run' }).click();
  await expect(output(page, 0)).toContainText('[1] "hellno works"', { timeout: 60_000 });
  expect(JSON.parse(readFileSync(join(E2E.dir, '.kuraa/r-packages.json'), 'utf8')).requested).toContain('hellno');
  // The manifest is the app's own: it is committed, but not in the sidebar.
  await page.reload();
  await expect(page.getByTestId(`file:${path}`)).toBeVisible();
  await expect(page.locator('[data-testid^="file:.kuraa"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /\.kuraa/ })).toHaveCount(0);

  // A URL is not a package name: refused before anything is fetched.
  await page.getByTestId('document-menu-button').click();
  await page.getByTestId('document-menu').getByRole('menuitem', { name: 'Packages…' }).click();
  await dialog.getByLabel('Packages to install').fill('https://example.org/evil.tar.gz');
  await dialog.getByRole('button', { name: 'Install' }).click();
  await expect(dialog.locator('.packages-result.warn')).toContainText('Not a package name this host installs');

  await dialog.locator('tr', { hasText: 'hellno' }).getByRole('button', { name: 'Remove' }).click();
  await expect(dialog.locator('.packages-result')).toContainText('Removed hellno');
  await expect(dialog.locator('tr', { hasText: 'hellno' })).toHaveCount(0);
});
