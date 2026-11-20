// Citations: typing @ offers the bibliography's keys; typed citations become
// chips naming what they cite, unknown keys marked; the file gets Pandoc
// citations, and an email stays an email.
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E } from './env.js';

const MAC = process.platform === 'darwin';

const create = async (path: string, content: string) => {
  const res = await fetch(`${E2E.url}/api/files`, {
    method: 'POST',
    headers: { authorization: `Bearer ${E2E.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ path, content }),
  });
  expect(res.status).toBe(201);
};

const BIB = `@article{smith2020,
  author = {Smith, Ann},
  title = {Tides of the Saltmarsh},
  year = {2020}
}

@book{doe2019,
  author = {Doe, John and Roe, Rita},
  title = {Marsh Birds},
  year = 2019
}
`;

test('typing @ offers the bibliography, and citations are written as Pandoc citations', async ({ page }) => {
  const dir = `cite-${Date.now().toString(36)}`;
  await create(`${dir}/refs.bib`, BIB);
  await create(`${dir}/paper.md`, '---\ntitle: Paper\nbibliography: refs.bib\n---\n\nStart here.\n');

  page.on('pageerror', (e) => console.error(`page error: ${e.message}`));
  await page.goto(`/?token=${E2E.token}&name=Cite%20Tester&email=cite%40example.org`);
  await page.getByTestId(`file:${dir}/paper.md`).click();
  const editor = page.getByTestId('editor');
  await expect(page.getByTestId('status')).toContainText('Connected');
  await editor.locator('p', { hasText: 'Start here.' }).click();
  await page.keyboard.press(MAC ? 'Meta+ArrowRight' : 'End');
  await page.waitForTimeout(100);
  const type = (text: string) => page.keyboard.type(text, { delay: 15 });

  // In brackets: the picker completes the key, and the bracket closing makes the citation.
  await type(' As [@');
  const picker = page.getByTestId('citation-picker');
  await expect(picker).toBeVisible();
  await expect(picker).toContainText('Smith (2020) Tides of the Saltmarsh');
  await expect(picker).toContainText('Doe & Roe (2019) Marsh Birds');
  await type('smi');
  await expect(picker.getByTestId('citation-option:doe2019')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(picker).toBeHidden();
  await type(', p. 3]');
  const chips = editor.getByTestId('citation');
  await expect(chips.first()).toHaveText('(Smith 2020, p. 3)');

  // In the text: choosing makes the citation at once; arrows choose.
  await type(' and @');
  await expect(picker).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(chips.nth(1)).toHaveText('Doe & Roe 2019');

  // Typed without the picker; Escape closes it. A key the bibliography lacks is marked.
  await type(' found it, as did @nobody');
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();
  await type(' and [-@smith2020]. Write to ada@example.org.');
  await expect(chips).toHaveCount(4);
  await expect(chips.nth(2)).toHaveText('@nobody');
  await expect(chips.nth(2)).toHaveClass(/citation-unknown/);
  await expect(chips.nth(3)).toHaveText('(2020)');

  // An in-text citation with a locator after it.
  await type(' Also @doe2019 [chap. 2] agrees.');
  await expect(chips.nth(4)).toHaveText('Doe & Roe 2019, chap. 2');

  const file = join(E2E.dir, dir, 'paper.md');
  await expect.poll(() => readFileSync(file, 'utf8'), { timeout: 10_000 }).toContain('agrees.');
  expect(readFileSync(file, 'utf8')).toContain(
    'Start here. As [@smith2020, p. 3] and @doe2019 found it, as did @nobody and [-@smith2020]. Write to ada@example.org. Also @doe2019 [chap. 2] agrees.',
  );
});
