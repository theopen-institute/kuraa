// Coding (docs/decisions/0082-annotations.md, "Coding by #"), in the app: turned on for the workspace under
// Annotations; # typed over a passage, a new code named and made there and then; # at the caret, an existing
// code suggested and applied to that point; each a tag in the margin, its passage highlighted only while
// pointed at; the document never changed; # still typed as text where it is meant as text (Esc, a heading's
// space); a tag's menu removing your coding and retrieving every passage with its code.
import { expect, test, type Page } from '@playwright/test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E } from './env.js';
import { openSettings } from './settings.js';

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${E2E.url}${path}`, { ...init, headers: { authorization: `Bearer ${E2E.token}`, 'content-type': 'application/json' } });
type Coding = { motivation: string; body: { source: string }; target: { selector: { type: string; exact?: string; start?: number; end?: number }[] } };
const codings = (path: string): Coding[] => {
  const folder = join(E2E.dir, `${path}.annotations`);
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter((n) => /^@[0-9a-f]{64}\.jsonld$/.test(n)).flatMap((n) => JSON.parse(readFileSync(join(folder, n), 'utf8')).items).filter((i: { motivation: string }) => i.motivation === 'classifying');
};
const quoteOf = (c: Coding) => c.target.selector.find((s) => s.type === 'TextQuoteSelector')?.exact;
const codebook = () => JSON.parse(readFileSync(join(E2E.dir, '.kuraa/codebook.jsonld'), 'utf8'))['@graph'].filter((n: { type: string }) => n.type === 'Concept') as { id: string; prefLabel: string; color?: string }[];

async function settingsSave(page: Page, testid: string, on: boolean, url: string) {
  const saved = page.waitForResponse((r) => r.url().endsWith(url) && r.request().method() === 'PATCH');
  const box = page.getByTestId(testid);
  if (on) await box.check();
  else await box.uncheck();
  expect((await saved).status()).toBe(200);
}

test('coding by #: a passage and a point, tags in the margin, highlighted when pointed at, # still text where meant', async ({ page }) => {
  const path = `coding-${Date.now().toString(36)}.md`;
  const TEXT = '# Interview\n\nAfter the flood, I never trusted the council.\n\nNobody came for us.\n';
  expect((await api('/api/files', { method: 'POST', body: JSON.stringify({ path, content: TEXT }) })).status).toBe(201);
  page.on('pageerror', (e) => console.error(`page error: ${e.message}`));
  await page.goto(`/?token=${E2E.token}&name=Ada`);
  await page.getByTestId(`file:${path}`).click();
  await expect(page.getByTestId('status')).toContainText('Connected');
  const editor = page.getByTestId('editor');

  // Annotations on, and coding with it (its own switch, shown under Annotations once it is on).
  await openSettings(page);
  await expect(page.getByTestId('annotations-coding')).toHaveCount(0);
  await settingsSave(page, 'feature-annotations', true, '/api/features/annotations');
  await expect(page.getByTestId('annotations-comments')).toBeChecked();
  await settingsSave(page, 'annotations-coding', true, '/api/features/annotations');
  await page.getByTestId('settings-close').click();
  await expect(page.locator('.editor-scroll[data-features~="annotations"]')).toBeVisible();

  // A passage selected, then #: the code box, a new code's name, Enter.
  await editor.locator('p', { hasText: 'council' }).selectText();
  await page.keyboard.type('#');
  const box = page.getByTestId('codebox');
  await expect(box).toBeVisible();
  await page.keyboard.type('Distrust of institutions');
  await expect(box.getByTestId('codebox-new')).toContainText('New code “Distrust of institutions”');
  await page.keyboard.press('Enter');
  await expect(box).toHaveCount(0);
  const tags = page.getByTestId('feature-tag');
  await expect(tags).toHaveCount(1);
  await expect(tags.first()).toHaveText('Distrust of institutions');
  await expect.poll(() => codings(path).length).toBe(1);
  expect(quoteOf(codings(path)[0]!)).toBe('After the flood, I never trusted the council.');
  const distrust = codebook().find((c) => c.prefLabel === 'Distrust of institutions')!;
  expect(codings(path)[0]!.body.source).toBe(distrust.id);
  expect(distrust.color).toMatch(/^#[0-9a-f]{6}$/);

  // Highlighted only while pointed at: its tag, or the passage itself.
  await expect(editor.locator('.kuraa-coded-hover')).toHaveCount(0);
  await tags.first().hover();
  await expect(editor.locator('.kuraa-coded-hover')).toHaveText('After the flood, I never trusted the council.');
  await page.mouse.move(2, 2);
  await expect(editor.locator('.kuraa-coded-hover')).toHaveCount(0);
  await editor.locator('p', { hasText: 'council' }).hover({ position: { x: 30, y: 8 } });
  await expect(editor.locator('.kuraa-coded-hover')).toHaveCount(1);
  await expect(tags.first()).toHaveClass(/active/);
  await page.mouse.move(2, 2);

  // # at the caret: the code there is suggested; Tab completes its name, Enter applies it to that point.
  await editor.locator('p', { hasText: 'Nobody' }).click({ position: { x: 4, y: 8 } });
  await page.keyboard.press('End');
  await page.keyboard.type('#');
  await expect(box).toBeVisible();
  await page.keyboard.type('distr');
  await expect(box.getByTestId('codebox-code')).toHaveText(/Distrust of institutions/);
  await page.keyboard.press('Tab');
  await expect(box.getByTestId('codebox-input')).toHaveValue('Distrust of institutions');
  await page.keyboard.press('Enter');
  await expect(tags).toHaveCount(2);
  await expect.poll(() => codings(path).length).toBe(2);
  const point = codings(path).find((c) => quoteOf(c) === '')!;
  const place = point.target.selector.find((s) => s.type === 'TextPositionSelector')!;
  expect(place.start).toBe(place.end);
  expect(place.start).toBe(TEXT.indexOf('for us.') + 'for us.'.length);
  expect(codebook().filter((c) => c.prefLabel === 'Distrust of institutions')).toHaveLength(1);
  // Its pin, while its tag is pointed at.
  await tags.nth(1).hover();
  await expect(editor.locator('.kuraa-point')).toHaveCount(1);
  await page.mouse.move(2, 2);
  // Nothing of it in the document.
  await expect.poll(() => readFileSync(join(E2E.dir, path), 'utf8')).toBe(TEXT);

  // The point's tag: your coding removed.
  await tags.nth(1).click();
  await expect(page.getByTestId('code-menu')).toContainText('At a point in the text');
  await page.getByTestId('code-remove').click();
  await expect(tags).toHaveCount(1);
  await expect.poll(() => codings(path).length).toBe(1);

  // The passage's tag: every passage with its code.
  await tags.first().click();
  await page.getByTestId('code-retrieve').click();
  const retrieve = page.getByTestId('feature-panel-annotations-retrieve');
  await expect(retrieve.getByTestId('retrieve-row')).toHaveCount(1);
  await expect(retrieve.getByTestId('retrieve-row')).toContainText('I never trusted the council');

  // # meant as text: Esc types it, with what followed; at a new line's start, # and a space make a heading.
  await editor.locator('p', { hasText: 'Nobody' }).click({ position: { x: 4, y: 8 } });
  await page.keyboard.press('End');
  await page.keyboard.type('#');
  await page.keyboard.type('1');
  await page.keyboard.press('Escape');
  await expect(box).toHaveCount(0);
  await expect(editor.locator('p', { hasText: 'Nobody' })).toHaveText('Nobody came for us.#1');
  await page.keyboard.press('Enter');
  await page.keyboard.type('#');
  await page.keyboard.press(' ');
  await page.keyboard.type('Later');
  await expect(editor.locator('h1', { hasText: 'Later' })).toHaveCount(1);
  await expect(tags).toHaveCount(1);

  // Coding off, then annotations: nothing of them shown; the codebook kept.
  await openSettings(page);
  await settingsSave(page, 'annotations-coding', false, '/api/features/annotations');
  await settingsSave(page, 'feature-annotations', false, '/api/features/annotations');
  await page.getByTestId('settings-close').click();
  await expect(tags).toHaveCount(0);
  expect(existsSync(join(E2E.dir, '.kuraa/codebook.jsonld'))).toBe(true);
  await api(`/api/files?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
});
