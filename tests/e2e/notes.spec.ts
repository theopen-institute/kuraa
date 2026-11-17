// Footnotes: references show as superscript labels with the note on hover;
// notes show with their label, which leads back to the reference. Typing
// [^label] or ^[text], or ⌥⌘F, makes notes; the file stays plain Pandoc markdown.
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E } from './env.js';

const MAC = process.platform === 'darwin';
const START = 'Cores were taken at low tide.[^cores] A second visit is planned.^[Weather permitting.]\n\nMore text.\n\n[^cores]: Cores were 25 cm deep.\n';

async function endOf(page: Page, text: string): Promise<void> {
  await page.getByTestId('editor').locator('p', { hasText: text }).first().click();
  await page.keyboard.press(MAC ? 'Meta+ArrowRight' : 'End');
  await page.waitForTimeout(100);
}

test('footnotes display, link both ways, and can be made by typing', async ({ page }) => {
  const path = `runs/notes-${Date.now().toString(36)}.md`;
  const res = await fetch(`${E2E.url}/api/files`, {
    method: 'POST',
    headers: { authorization: `Bearer ${E2E.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ path, content: START }),
  });
  expect(res.status).toBe(201);
  await page.goto(`/?token=${E2E.token}&name=Noter&email=note%40example.org`);
  await page.getByTestId(`file:${path}`).click();
  await expect(page.getByTestId('peers')).toContainText('Noter');
  const editor = page.getByTestId('editor');

  // Display.
  const ref = editor.locator('.footnote-ref');
  await expect(ref).toHaveText('cores');
  await ref.hover();
  await expect(ref).toHaveAttribute('title', /Cores were 25 cm deep\./);
  await expect(editor.locator('.inline-note')).toHaveText('Weather permitting.');
  const note = editor.locator('aside.note');
  await expect(note.locator('.note-label')).toHaveText('cores');
  await expect(note.locator('.note-body')).toHaveText('Cores were 25 cm deep.');

  // ⌘-click a reference: the cursor goes to its note.
  await ref.click({ modifiers: [MAC ? 'Meta' : 'Control'] });
  await page.keyboard.press(MAC ? 'Meta+ArrowRight' : 'End');
  await page.keyboard.type(' With an auger.');
  await expect(note.locator('.note-body')).toHaveText('Cores were 25 cm deep. With an auger.');

  // Typing [^label] makes a reference and an empty note at the end, with the cursor in it.
  await endOf(page, 'More text.');
  await page.keyboard.type(' Depth varied.[^depth]', { delay: 10 });
  await page.keyboard.type('Measured at low water.');
  await expect(editor.locator('aside.note')).toHaveCount(2);
  await expect(editor.locator('aside.note').nth(1).locator('.note-body')).toHaveText('Measured at low water.');

  // The note's label leads back, just after the reference.
  await editor.locator('aside.note').nth(1).locator('.note-label').click();
  await page.keyboard.type(' So did salinity.');
  await expect(editor.locator('p', { hasText: 'More text.' })).toHaveText('More text. Depth varied.depth So did salinity.');

  // ^[text] makes an inline note; ⌥⌘F a numbered footnote.
  await page.keyboard.type(' ^[Quick aside]', { delay: 10 });
  await expect(editor.locator('.inline-note').nth(1)).toHaveText('Quick aside');
  await page.keyboard.press(MAC ? 'Meta+Alt+KeyF' : 'Control+Alt+KeyF');
  await page.keyboard.type('First numbered note.');
  await expect(editor.locator('aside.note').nth(2).locator('.note-label')).toHaveText('1');

  await expect.poll(() => readFileSync(join(E2E.dir, path), 'utf8'), { timeout: 10_000 }).toContain('First numbered note.');
  expect(readFileSync(join(E2E.dir, path), 'utf8')).toBe(
    'Cores were taken at low tide.[^cores] A second visit is planned.^[Weather permitting.]\n\n' +
    'More text. Depth varied.[^depth] So did salinity. ^[Quick aside][^1]\n\n' +
    '[^cores]: Cores were 25 cm deep. With an auger.\n\n' +
    '[^depth]: Measured at low water.\n\n' +
    '[^1]: First numbered note.\n',
  );
});
