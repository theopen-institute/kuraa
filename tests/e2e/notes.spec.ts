// Footnotes behave as in a word processor: references show the number a reader
// will see, with the note on hover; notes stay together at the end in that
// order, each showing its number, which leads back to the reference. Typing
// [^label] or ^[text], or ⌥⌘F, makes notes. Labels in the file never change.
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
  // Numbers in reading order, counting inline notes: [^cores] is 1, the inline note 2.
  const ref = editor.locator('.footnote-ref');
  await expect(ref).toHaveText('1');
  await ref.hover();
  await expect(ref).toHaveAttribute('title', /Cores were 25 cm deep\.[\s\S]*\[\^cores\]/);
  await expect(editor.locator('.inline-note')).toHaveText('2Weather permitting.');
  const note = editor.locator('aside.note');
  await expect(note.locator('.note-label')).toHaveText('1');
  await expect(note.locator('.note-label')).toHaveAttribute('title', /\[\^cores\]/);
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
  await expect(editor.locator('p', { hasText: 'More text.' })).toHaveText('More text. Depth varied.3 So did salinity.');

  // ^[text] makes an inline note; ⌥⌘F a numbered footnote.
  await page.keyboard.type(' ^[Quick aside]', { delay: 10 });
  await expect(editor.locator('.inline-note').nth(1)).toHaveText('4Quick aside');
  await page.keyboard.press(MAC ? 'Meta+Alt+KeyF' : 'Control+Alt+KeyF');
  await page.keyboard.type('First numbered note.');
  // Labelled [^1] in the file (no numeric labels yet), shown as 5: the fifth note in reading order.
  await expect(editor.locator('aside.note').nth(2).locator('.note-label')).toHaveText('5');

  await expect.poll(() => readFileSync(join(E2E.dir, path), 'utf8'), { timeout: 10_000 }).toContain('First numbered note.');
  expect(readFileSync(join(E2E.dir, path), 'utf8')).toBe(
    'Cores were taken at low tide.[^cores] A second visit is planned.^[Weather permitting.]\n\n' +
    'More text. Depth varied.[^depth] So did salinity. ^[Quick aside][^1]\n\n' +
    '[^cores]: Cores were 25 cm deep. With an auger.\n\n' +
    '[^depth]: Measured at low water.\n\n' +
    '[^1]: First numbered note.\n',
  );

  // A footnote inserted before the others takes its place in the notes, in order.
  await endOf(page, 'Cores were taken at low tide.');
  await page.keyboard.press('Home');
  await page.keyboard.type('Early[^early]', { delay: 10 });
  await page.keyboard.type('An early note.');
  await expect(editor.locator('aside.note .note-label')).toHaveText(['1', '2', '4', '6']);
  await expect(editor.locator('aside.note').first().locator('.note-body')).toHaveText('An early note.');
  await expect.poll(() => readFileSync(join(E2E.dir, path), 'utf8'), { timeout: 10_000 }).toContain('[^early]: An early note.\n\n[^cores]:');
  await expect(page.getByRole('button', { name: 'Renumber notes' })).toHaveCount(0);
});

test('with two people, notes stay in order and are never duplicated', async ({ browser }) => {
  const path = `runs/notes2-${Date.now().toString(36)}.md`;
  const res = await fetch(`${E2E.url}/api/files`, {
    method: 'POST',
    headers: { authorization: `Bearer ${E2E.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ path, content: 'First point.[^a]\n\nSecond point.\n\n[^a]: Note A.\n' }),
  });
  expect(res.status).toBe(201);
  const open = async (name: string) => {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`/?token=${E2E.token}&name=${name}&email=${name.toLowerCase()}%40example.org`);
    await page.getByTestId(`file:${path}`).click();
    await expect(page.getByTestId('peers')).toContainText(name);
    return page;
  };
  const ada = await open('Ada');
  const bo = await open('Bo');

  // Ada adds a note to the second paragraph; Bo adds one before Ada's first.
  await endOf(ada, 'Second point.');
  await ada.keyboard.type('[^b]', { delay: 10 });
  await ada.keyboard.type('Note B.');
  await bo.getByTestId('editor').locator('p', { hasText: 'First point.' }).click();
  await bo.keyboard.press(MAC ? 'Meta+ArrowLeft' : 'Home');
  await bo.waitForTimeout(100);
  await bo.keyboard.type('Zero.[^z]', { delay: 10 });
  await bo.keyboard.type('Note Z.');

  for (const page of [ada, bo]) {
    // (Containment, not equality: the other person's cursor label may sit inside a note.)
    const bodies = page.getByTestId('editor').locator('aside.note .note-body');
    await expect(bodies).toHaveCount(3);
    for (const [i, text] of ['Note Z.', 'Note A.', 'Note B.'].entries()) await expect(bodies.nth(i)).toContainText(text);
    await expect(page.getByTestId('editor').locator('aside.note .note-label')).toHaveText(['1', '2', '3']);
  }
  await expect.poll(() => readFileSync(join(E2E.dir, path), 'utf8'), { timeout: 10_000 }).toBe(
    'Zero.[^z]First point.[^a]\n\nSecond point.[^b]\n\n[^z]: Note Z.\n\n[^a]: Note A.\n\n[^b]: Note B.\n',
  );
});
