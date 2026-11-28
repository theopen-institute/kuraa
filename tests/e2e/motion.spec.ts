// Motion (docs/decisions/0115-motion.md): rows moved in the file tree glide to
// their places, only those whose place changed; a pane beside the document comes
// in from the right. Neither where motion is reduced (the other tests' setting).
import { expect, test, type Page } from '@playwright/test';
import { E2E } from './env.js';

test.use({ reducedMotion: 'no-preference' });

const api = (path: string, body: object) =>
  fetch(`${E2E.url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${E2E.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
/** The folder's rows, top to bottom, as the tree shows them. */
const rowsIn = (page: Page, folder: string) => async () =>
  (await page.locator(`.tree [role="treeitem"][data-path^="${folder}/"]`).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.path!))).map((p) => p.slice(p.lastIndexOf('/') + 1)).join(' ');
/** The rows animated since last asked, by name. */
const glided = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { glided: string[] };
  const said = w.glided.map((p) => p.slice(p.lastIndexOf('/') + 1)).sort().join(' ');
  w.glided = [];
  return said;
});

test('a row moved in the tree glides, with those it passed; a side panel comes in; neither where motion is reduced', async ({ page }) => {
  const folder = `motion-${Date.now().toString(36)}`;
  for (const name of ['a.md', 'b.md', 'c.md']) expect((await api('/api/files', { path: `${folder}/${name}`, content: `# ${name}\n` })).status).toBe(201);
  // Every animation started on a tree row, by the row's path.
  await page.addInitScript(() => {
    const w = window as unknown as { glided: string[] };
    w.glided = [];
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, ...args: Parameters<Element['animate']>) {
      const path = this.closest<HTMLElement>('.tree li[data-path]')?.dataset.path;
      if (path) w.glided.push(path);
      return animate.apply(this, args);
    };
  });
  await page.goto(`/?token=${E2E.token}&name=Mover&email=m%40example.org`);
  await expect.poll(rowsIn(page, folder)).toBe('a.md b.md c.md');

  // Alt+↓ on a: a and b change places and glide; c stays still.
  await page.locator(`[role="treeitem"][data-path="${folder}/a.md"]`).focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect.poll(rowsIn(page, folder)).toBe('b.md a.md c.md');
  await expect.poll(() => glided(page)).toBe('a.md b.md');

  // Reduced: moved at once.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator(`[role="treeitem"][data-path="${folder}/a.md"]`).focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect.poll(rowsIn(page, folder)).toBe('b.md c.md a.md');
  expect(await glided(page)).toBe('');

  // A side panel (Export): it comes in, as it opens; where motion is reduced, it is simply there.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.getByTestId(`file:${folder}/b.md`).click();
  await page.getByTestId('document-menu-button').click();
  await page.getByTestId('menu-export').click();
  const panel = page.getByTestId('feature-panel-preview-preview');
  await expect(panel).toBeVisible();
  expect(await panel.evaluate((el) => getComputedStyle(el).animationName)).toBe('pane-in');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await panel.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
});
