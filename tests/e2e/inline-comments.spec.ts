// Inline comments (docs/decisions/0133-inline-comments.md), in the app: begun on the paragraph the caret is in
// (⌥⇧⌘M) or on a selection (Inline, beside it), each a thread drawn in the text after its block, set apart from
// it; replied to there; someone else's reply shown in it, by their name; folded and shown again; listed in the
// Comments panel; kept in the commenter's own file as a W3C comment whose target's styleClass says it is
// inline, never in the document, and the document still typed in around it.
import { expect, test, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E } from './env.js';
import { openComponents } from './settings.js';

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${E2E.url}${path}`, { ...init, headers: { authorization: `Bearer ${E2E.token}`, 'content-type': 'application/json' } });
type Annotation = { id: string; motivation: string; body: { value: string }; target: { styleClass?: string; selector?: { exact?: string }[] } | string };
/** Everyone's annotations beside a document, from their own files. */
const annotations = (path: string): Annotation[] => {
  const folder = join(E2E.dir, `${path}.annotations`);
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter((n) => /^@[0-9a-f]{64}\.jsonld$/.test(n)).flatMap((n) => JSON.parse(readFileSync(join(folder, n), 'utf8')).items);
};

async function annotationsOn(page: Page) {
  await openComponents(page);
  const box = page.getByTestId('feature-annotations');
  if (!(await box.isChecked())) {
    const saved = page.waitForResponse((r) => r.url().endsWith('/api/features/annotations') && r.request().method() === 'PATCH');
    await box.check();
    expect((await saved).status()).toBe(200);
  }
  await page.getByTestId('settings-close').click();
}

test('inline comments: a discussion in the text, after its block, kept beside the document, never in it', async ({ page }) => {
  const path = `inline-${Date.now().toString(36)}.md`;
  const TEXT = '# Interview\n\nAfter the flood, I never trusted the council.\n\nNobody came for us. Not the council, not the church.\n\nWe rebuilt it ourselves.\n';
  expect((await api('/api/files', { method: 'POST', body: JSON.stringify({ path, content: TEXT }) })).status).toBe(201);
  page.on('pageerror', (e) => console.error(`page error: ${e.message}`));
  await page.goto(`/?token=${E2E.token}&name=Ada`);
  await page.getByTestId(`file:${path}`).click();
  await expect(page.getByTestId('status')).toContainText('Connected');
  await annotationsOn(page);
  await expect(page.locator('.editor-scroll[data-features~="annotations"]')).toBeVisible();

  const editor = page.getByTestId('editor');
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  const council = editor.locator('p', { hasText: 'After the flood' });

  // The caret in a paragraph (once the document, reopened as the feature came on, offers it: Inline beside a
  // selection), then ⌥⇧⌘M: a box to begin the discussion in, in the text, just after that paragraph.
  await council.selectText();
  await expect(page.getByTestId('annotations-inline')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('selection-actions')).toHaveCount(0);
  await page.keyboard.press(`${mod}+Alt+Shift+m`);
  const begun = editor.getByTestId('inline-new');
  await expect(begun).toBeVisible();
  await expect(council.locator('xpath=following-sibling::*[1]')).toHaveAttribute('data-testid', 'inline-new');
  await expect(page.getByTestId('inline-new-text')).toBeFocused();
  await page.keyboard.type('Which council: the old one or the new?');
  await page.keyboard.press('Enter');
  await expect(begun).toHaveCount(0);
  const first = editor.getByTestId('inline-thread').first();
  await expect(council.locator('xpath=following-sibling::*[1]')).toHaveAttribute('data-testid', 'inline-thread');
  await expect(first.getByTestId('inline-comment')).toContainText('Which council: the old one or the new?');
  await expect(first.getByTestId('inline-comment')).toContainText('You');
  // The paragraph as a whole: not quoted (it is just above), and no 💬 in the margin (the thread is in the text).
  await expect(first.locator('.kuraa-inline-quote')).toHaveCount(0);
  await expect(page.getByTestId('feature-mark')).toHaveCount(0);
  // Set apart from the text: another face than the document's.
  const face = await first.evaluate((e) => getComputedStyle(e).fontFamily);
  expect(face).not.toBe(await council.evaluate((e) => getComputedStyle(e).fontFamily));

  // Kept in the commenter's own file, a W3C comment marked inline; the document as it was.
  await expect.poll(() => annotations(path).map((a) => a.body.value)).toEqual(['Which council: the old one or the new?']);
  const made = annotations(path)[0]!;
  expect(made.motivation).toBe('commenting');
  expect(made.target).toMatchObject({ styleClass: 'inline-comment' });
  expect((made.target as { selector: { exact?: string }[] }).selector[0]).toMatchObject({ exact: 'After the flood, I never trusted the council.' });
  expect(readFileSync(join(E2E.dir, path), 'utf8')).toBe(TEXT);

  // Replied to, in the text.
  await first.getByTestId('inline-reply-text').click();
  await page.keyboard.type('The new one, I think.');
  await page.keyboard.press('Enter');
  await expect(first.getByTestId('inline-reply')).toContainText('The new one, I think.');
  await expect(first.getByTestId('inline-reply-text')).toHaveValue('');
  await expect.poll(() => annotations(path).length).toBe(2);

  // A passage selected, then Inline beside it: the passage quoted in its thread, after its own paragraph.
  const nobody = editor.locator('p', { hasText: 'Nobody came' });
  await nobody.getByText('Nobody came for us.', { exact: false }).evaluate((p) => {
    const t = p.firstChild!;
    const r = document.createRange();
    r.setStart(t, 0);
    r.setEnd(t, 'Nobody came for us.'.length);
    const s = getSelection()!;
    s.removeAllRanges();
    s.addRange(r);
  });
  await page.getByTestId('annotations-inline').click();
  await expect(begun.locator('.kuraa-inline-quote')).toHaveText('“Nobody came for us.”');
  await expect(editor.locator('.kuraa-inline-passage')).toHaveText('Nobody came for us.');
  await page.keyboard.type('Ask who she means by nobody.');
  await page.keyboard.press('Enter');
  await expect(editor.getByTestId('inline-thread')).toHaveCount(2);
  await expect(nobody.locator('xpath=following-sibling::*[1]')).toHaveAttribute('data-testid', 'inline-thread');
  await expect(editor.getByTestId('inline-thread').nth(1).locator('.kuraa-inline-quote')).toHaveText('“Nobody came for us.”');

  // Begun and given up (Esc): nothing kept.
  await editor.locator('p', { hasText: 'rebuilt' }).click();
  await page.keyboard.press(`${mod}+Alt+Shift+m`);
  await expect(begun).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(begun).toHaveCount(0);
  await expect.poll(() => annotations(path).length).toBe(3);

  // The document still typed in, beside a thread: it stays after its paragraph.
  await council.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Never.');
  await expect(council).toHaveText('After the flood, I never trusted the council. Never.');
  await expect(council.locator('xpath=following-sibling::*[1]')).toHaveAttribute('data-testid', 'inline-thread');

  // Someone else's reply (their own file, theirs alone): in the thread, by their name, in a colour of their own.
  const BEN = 'b'.repeat(64);
  const folder = join(E2E.dir, `${path}.annotations`);
  mkdirSync(folder, { recursive: true });
  const reply = { id: 'urn:uuid:0000ben0-0000-4000-8000-000000000001', type: 'Annotation', motivation: 'replying', created: '2099-01-01T00:00:00.000Z', modified: '2099-01-01T00:00:00.000Z', creator: { id: `urn:kuraa:person:${BEN}`, type: 'Person', name: 'Ben' }, body: { type: 'TextualBody', value: 'No: the old one. She said so on the tape.', format: 'text/markdown', purpose: 'replying' }, target: made.id };
  writeFileSync(join(folder, `@${BEN}.jsonld`), `${JSON.stringify({ '@context': 'http://www.w3.org/ns/anno.jsonld', id: `@${BEN}.jsonld`, type: 'AnnotationPage', items: [reply] }, null, 2)}\n`);
  await page.reload();
  await page.getByTestId(`file:${path}`).click();
  await expect(page.getByTestId('status')).toContainText('Connected');
  await expect(first.getByTestId('inline-reply')).toHaveCount(2);
  await expect(first.getByTestId('inline-reply').nth(1)).toContainText('Ben');
  await expect(first.getByTestId('inline-reply').nth(1)).toContainText('No: the old one.');
  const hues = await first.locator('.kuraa-inline-message').evaluateAll((rows) => rows.map((r) => (r as HTMLElement).style.getPropertyValue('--who-color')));
  expect(hues[0]).toBe(hues[1]);
  expect(hues[2]).not.toBe(hues[0]);
  await expect(first.locator('.kuraa-inline-title')).toHaveText('3 messages');

  // Folded away, and shown again: a convenience of the reader's.
  await first.getByTestId('inline-fold').click();
  await expect(first.getByTestId('inline-comment')).toHaveCount(0);
  await expect(first.locator('.kuraa-inline-who')).toHaveText('You, Ben');
  await first.getByTestId('inline-fold').click();
  await expect(first.getByTestId('inline-comment')).toBeVisible();

  // In the Comments panel too, said to be inline.
  await council.click();
  await page.keyboard.press(`${mod}+Alt+k`);
  const panel = page.getByTestId('feature-panel-annotations-comments');
  await expect(panel.getByTestId('annotations-thread')).toHaveCount(2);
  await expect(panel.getByTestId('annotations-inline-note')).toHaveCount(2);

  // Your own, deleted from the text: gone from it.
  await editor.getByTestId('inline-thread').nth(1).getByTestId('inline-comment').hover();
  await editor.getByTestId('inline-thread').nth(1).getByTestId('inline-delete').click();
  await expect(editor.getByTestId('inline-thread')).toHaveCount(1);
  await expect.poll(() => readFileSync(join(E2E.dir, path), 'utf8')).toBe(TEXT.replace('the council.\n', 'the council. Never.\n'));
});
