// The editor has no toolbar: formatting comes from typing markdown. Each cue turns
// into the construct it stands for, and the file on disk gets that markdown back
// (a cue that did nothing would be written escaped, as \*\*bold\*\*).
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E } from './env.js';

const MAC = process.platform === 'darwin';

test('typing markdown formats the text, and the file keeps that markdown', async ({ page }) => {
  const path = `runs/cues-${Date.now().toString(36)}.Rmd`;
  const res = await fetch(`${E2E.url}/api/files`, {
    method: 'POST',
    headers: { authorization: `Bearer ${E2E.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ path, content: '# Cues\n\nStart here.\n' }),
  });
  expect(res.status).toBe(201);

  page.on('pageerror', (e) => console.error(`page error: ${e.message}`));
  await page.goto(`/?token=${E2E.token}&name=Cue%20Tester&email=cues%40example.org`);
  await page.getByTestId(`file:${path}`).click();
  const editor = page.getByTestId('editor');
  await expect(page.getByTestId('status')).toContainText('Connected');
  await expect(page.getByTestId('peers')).toContainText('Cue Tester');

  // No toolbar, no top bar, history closed.
  await expect(page.locator('.toolbar, .topbar, [role=toolbar]')).toHaveCount(0);
  await expect(page.getByTestId('history')).toHaveCount(0);

  await editor.locator('p', { hasText: 'Start here.' }).click();
  await page.keyboard.press(MAC ? 'Meta+ArrowRight' : 'End');
  // ProseMirror picks up a caret moved by click or arrow key from the browser's
  // selectionchange event, a few milliseconds later; Enter is a command on that caret.
  await page.waitForTimeout(100);
  const type = (text: string) => page.keyboard.type(text, { delay: 15 });

  await page.keyboard.press('Enter');
  await type('Plain **bold** and *it* and `code` and ~~gone~~ and H~2~O and [site](https://example.org) and $x$ done.');
  await expect(editor.locator('strong')).toHaveText('bold');
  await expect(editor.locator('em')).toHaveText('it');
  await expect(editor.locator('code')).toHaveText('code');
  await expect(editor.locator('s')).toHaveText('gone');
  await expect(editor.locator('sub')).toHaveText('2');
  await expect(editor.locator('a[href="https://example.org"]')).toHaveText('site');
  await expect(editor.locator('.math-inline')).toHaveCount(1);

  // Backspace straight after a cue undoes it, leaving the typed markdown.
  await type(' **raw**');
  await page.keyboard.press('Backspace');
  await expect(editor).toContainText('done. **raw**');

  await page.keyboard.press('Enter');
  await type('## ');
  await type('Heading');
  await expect(editor.locator('h2')).toHaveText('Heading');

  // A fence and Enter starts a chunk; a closing fence and Enter ends it.
  await page.keyboard.press('Enter');
  await type('```{r setup}');
  await page.keyboard.press('Enter');
  await type('x <- 1');
  await page.keyboard.press('Enter');
  await type('```');
  await page.keyboard.press('Enter');
  await type('---');
  await type('- item');
  await expect(editor.locator('hr')).toHaveCount(1);
  await expect(editor.locator('ul li')).toHaveText('item');

  const file = join(E2E.dir, path);
  await expect.poll(() => readFileSync(file, 'utf8'), { timeout: 10_000 }).toContain('- item');
  const text = readFileSync(file, 'utf8');
  expect(text).toContain('Plain **bold** and *it* and `code` and ~~gone~~ and H~2~O and [site](https://example.org) and $x$ done. \\*\\*raw\\*\\*');
  expect(text).toContain('## Heading');
  expect(text).toMatch(/```\{r setup\}\nx <- 1\n```/);
  expect(text).toMatch(/\n(?:---|\* \* \*|-{3,})\n/);
});
