// Rendering from the browser: the Preview panel shows the document knitted in a
// Podman container, in a frame where nothing in it runs; ⇧⌘R renders what was
// just typed; Word is saved as a file. Skipped where Podman is not installed and running.
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { podmanWorks } from '../../packages/env-podman/src/index.js';
import { E2E } from './env.js';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const DOC = [
  '---',
  'title: "Tidal report"',
  '---',
  '',
  '# Results',
  '',
  'The answer is `r 6 * 7`.',
  '',
  '<script>document.body.append("SCRIPT RAN")</script>',
  '',
].join('\n');

test.skip(!podmanWorks(), 'Podman is not installed and running');

test('the Preview panel renders the document as it is now, and saves Word', async ({ page }) => {
  test.setTimeout(600_000);
  const path = `runs/render-${Date.now().toString(36)}.Rmd`;
  const res = await fetch(`${E2E.url}/api/files`, {
    method: 'POST',
    headers: { authorization: `Bearer ${E2E.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ path, content: DOC }),
  });
  expect(res.status).toBe(201);
  await page.goto(`/?token=${E2E.token}&name=Renderer&email=r%40example.org`);
  await page.getByTestId(`file:${path}`).click();
  await expect(page.getByTestId('status')).toContainText('Connected');

  await page.getByTestId('menu-button').click();
  await page.getByTestId('menu-document').click();
  await page.getByTestId('menu-preview').click();
  const panel = page.getByTestId('preview-panel');
  await expect(panel.getByTestId('render-status')).toContainText('Rendered to HTML.', { timeout: 240_000 });
  const frame = page.getByTestId('render-frame');
  await expect(frame).toHaveAttribute('sandbox', '');
  const body = page.frameLocator('[data-testid="render-frame"]').locator('body');
  await expect(body).toContainText('The answer is 42.');
  // Nothing in the document runs in the app.
  await expect(body).not.toContainText('SCRIPT RAN');

  // Typed a moment ago, rendered with ⇧⌘R.
  await page.getByTestId('editor').locator('p', { hasText: 'The answer is' }).click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
  await page.keyboard.type(' Typed just now.');
  await page.keyboard.press(`${MOD}+Shift+R`);
  await expect(body).toContainText('Typed just now.', { timeout: 120_000 });

  // Word, saved as a file named after the document.
  const download = page.waitForEvent('download', { timeout: 120_000 });
  await panel.getByTestId('save-docx').click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(path.slice(path.lastIndexOf('/') + 1).replace(/\.Rmd$/, '.docx'));

  // A failure says why, with the log behind Details.
  await page.getByTestId('editor').locator('p', { hasText: 'The answer is' }).click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
  await page.keyboard.type(' `r stop("no tide data")`');
  await page.keyboard.press(`${MOD}+Shift+R`);
  await expect(panel.getByTestId('render-status')).toContainText('no tide data', { timeout: 120_000 });
  await panel.getByText('Details').click();
  await expect(panel.getByTestId('render-log')).toBeVisible();

  // Nothing was written beside the document.
  expect(execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', 'runs'], { cwd: E2E.dir, encoding: 'utf8' })).not.toMatch(/\.(html|docx|pdf)/);
});
