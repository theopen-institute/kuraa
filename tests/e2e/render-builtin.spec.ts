// Markdown rendered without Podman (docs/decisions/0107-rendering-without-podman.md):
// the Preview panel shows a Markdown document rendered by the built-in pandoc,
// its image inside, in a frame where nothing in it runs, and what was typed a
// moment ago; Word and PDF saved. Needs only the programs pnpm install fetches.
import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pandocWasm, typstParts } from '../../packages/render-pandoc/src/where.js';
import { E2E } from './env.js';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

test.skip(!pandocWasm(), 'pandoc has not been fetched (node scripts/fetch-render-tools.mjs)');

test('the Preview panel renders Markdown with the built-in pandoc, and saves Word and PDF', async ({ page }) => {
  test.setTimeout(120_000);
  const folder = `builtin-${Date.now().toString(36)}`;
  mkdirSync(join(E2E.dir, folder, 'art'), { recursive: true });
  writeFileSync(join(E2E.dir, folder, 'art', 'pixel.png'), PIXEL);
  // And one of the document's own files (0109), beside it in tide.md.files/.
  mkdirSync(join(E2E.dir, folder, 'tide.md.files'), { recursive: true });
  writeFileSync(join(E2E.dir, folder, 'tide.md.files', 'own.png'), PIXEL);
  const path = `${folder}/tide.md`;
  const res = await fetch(`${E2E.url}/api/files`, {
    method: 'POST',
    headers: { authorization: `Bearer ${E2E.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ path, content: '---\ntitle: "Tide tables"\n---\n\nThe tide was out.\n\n![A pixel](art/pixel.png)\n\n![Its own pixel](tide.md.files/own.png)\n\n<script>document.body.append("SCRIPT RAN")</script>\n' }),
  });
  expect(res.status).toBe(201);
  await page.goto(`/?token=${E2E.token}&name=Renderer&email=r%40example.org`);
  await page.getByTestId(`file:${path}`).click();
  await expect(page.getByTestId('status')).toContainText('Connected');

  await page.getByTestId('document-menu-button').click();
  await page.getByTestId('menu-preview').click();
  const panel = page.getByTestId('preview-panel');
  await expect(panel.getByTestId('render-status')).toContainText('Rendered to HTML.', { timeout: 60_000 });
  const body = page.frameLocator('[data-testid="render-frame"]').locator('body');
  await expect(body).toContainText('The tide was out.');
  await expect(body.locator('img[src^="data:image/png"]')).toHaveCount(2);
  await expect(body).not.toContainText('SCRIPT RAN');

  // Typed a moment ago, rendered with ⇧⌘R.
  await page.getByTestId('editor').locator('p', { hasText: 'The tide was out' }).click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
  await page.keyboard.type(' Typed just now.');
  await page.keyboard.press(`${MOD}+Shift+R`);
  await expect(body).toContainText('Typed just now.', { timeout: 60_000 });

  const save = async (format: string) => {
    const download = page.waitForEvent('download', { timeout: 60_000 });
    await panel.getByTestId(`save-${format}`).click();
    return readFileSync((await (await download).path())!);
  };
  expect((await save('docx')).subarray(0, 2).toString()).toBe('PK');
  if (typstParts()) expect((await save('pdf')).subarray(0, 5).toString()).toBe('%PDF-');
});
