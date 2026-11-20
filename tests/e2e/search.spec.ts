// Searching every file (⇧⌘F): results grouped by file, documents by their title,
// what is being typed found at once, and a result opens its file at the match.
import { expect, test } from '@playwright/test';
import { E2E } from './env.js';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const api = (path: string, init: RequestInit = {}) =>
  fetch(`${E2E.url}${path}`, { ...init, headers: { authorization: `Bearer ${E2E.token}`, 'content-type': 'application/json' } });

test('search finds a phrase in every file and opens the file at the match', async ({ page }) => {
  const id = Date.now().toString(36);
  const word = `kelp${id}`;
  const doc = `runs/search-${id}.md`;
  const script = `runs/search-${id}.R`;
  const content = `---\ntitle: Kelp survey ${id}\n---\n\n# Plots\n\n${'Filler paragraph.\n\n'.repeat(40)}The ${word} forest was dense.\n`;
  expect((await api('/api/files', { method: 'POST', body: JSON.stringify({ path: doc, content }) })).status).toBe(201);
  expect((await api('/api/files', { method: 'POST', body: JSON.stringify({ path: script, content: `# ${word} counts\nx <- 1\n` }) })).status).toBe(201);

  await page.goto(`/?token=${E2E.token}&name=Searcher&email=s%40example.org`);
  await expect(page.getByTestId(`file:${doc}`)).toBeVisible();
  await page.keyboard.press(`${MOD}+Shift+F`);
  const panel = page.getByTestId('search-panel');
  await expect(panel.getByTestId('search-input')).toBeFocused();
  await page.keyboard.type(word);
  await expect(panel.getByTestId('search-summary')).toHaveText('2 matches in 2 files.');
  // The document by its title, the script by its name.
  await expect(panel.getByTestId(`search-file:${doc}`)).toContainText(`Kelp survey ${id}`);
  await expect(panel.getByTestId(`search-file:${script}`)).toContainText(`search-${id}.R`);
  await expect(panel.getByTestId(`search-file:${doc}`).locator('mark')).toHaveText(word);

  // Opening a result: the file, with the phrase selected (and scrolled to).
  await panel.getByTestId(`search-file:${doc}`).getByTestId('search-match').click();
  await expect(page.getByTestId('editor')).toContainText('dense');
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(word);
  await expect(page.getByTestId('editor').locator('p', { hasText: 'dense' })).toBeInViewport();

  // What is typed now is found before it reaches the file.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
  await page.keyboard.type(` Urchins${id} too.`);
  await panel.getByTestId('search-input').fill(`urchins${id}`);
  await expect(panel.getByTestId('search-summary')).toHaveText('1 match in 1 file.');
  await panel.getByTestId('search-case').check();
  await expect(panel.getByTestId('search-summary')).toHaveText(`Nothing found for “urchins${id}”.`);
});
