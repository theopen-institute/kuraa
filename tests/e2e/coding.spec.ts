// Coding (docs/decisions/0082-annotations.md, step 3), in the app: turned on for the workspace under
// Annotations; a passage selected and coded with a code made there and then; the passage underlined in
// its code's colour, kept in the coder's own file; the codebook with its counts; the passage retrieved by
// its code; and the coding removed from its mark in the margin.
import { expect, test, type Page } from '@playwright/test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E } from './env.js';
import { openSettings } from './settings.js';

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${E2E.url}${path}`, { ...init, headers: { authorization: `Bearer ${E2E.token}`, 'content-type': 'application/json' } });
const codings = (path: string): { motivation: string; body: { source: string } }[] => {
  const folder = join(E2E.dir, `${path}.annotations`);
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter((n) => /^@[0-9a-f]{64}\.jsonld$/.test(n)).flatMap((n) => JSON.parse(readFileSync(join(folder, n), 'utf8')).items).filter((i: { motivation: string }) => i.motivation === 'classifying');
};

async function settingsSave(page: Page, testid: string, on: boolean, url: string) {
  const saved = page.waitForResponse((r) => r.url().endsWith(url) && r.request().method() === 'PATCH');
  const box = page.getByTestId(testid);
  if (on) await box.check();
  else await box.uncheck();
  expect((await saved).status()).toBe(200);
}

test('coding: a passage coded with a code made there and then, underlined, retrieved, and removed', async ({ page }) => {
  const path = `coding-${Date.now().toString(36)}.md`;
  const TEXT = '# Interview\n\nAfter the flood, I never trusted the council.\n\nNobody came for us.\n';
  expect((await api('/api/files', { method: 'POST', body: JSON.stringify({ path, content: TEXT }) })).status).toBe(201);
  page.on('pageerror', (e) => console.error(`page error: ${e.message}`));
  await page.goto(`/?token=${E2E.token}&name=Ada`);
  await page.getByTestId(`file:${path}`).click();
  await expect(page.getByTestId('status')).toContainText('Connected');

  // Annotations on, and coding with it (its own setting, under Annotations).
  await openSettings(page);
  await settingsSave(page, 'feature-annotations', true, '/api/features/annotations');
  await page.getByTestId('open-feature-annotations').click();
  await settingsSave(page, 'annotations-coding', true, '/api/features/annotations');
  await page.getByTestId('settings-close').click();
  await expect(page.locator('.editor-scroll[data-features~="annotations"]')).toBeVisible();

  // A passage selected, then Code: the Codes panel, to find a code or name a new one.
  await page.getByTestId('editor').locator('p', { hasText: 'council' }).selectText();
  await page.getByTestId('annotations-code').click();
  const panel = page.getByTestId('feature-panel-annotations-codes');
  await panel.getByTestId('codes-filter').fill('Distrust of institutions');
  await panel.getByTestId('codes-create-apply').click();
  await expect(page.getByTestId('editor').locator('.kuraa-coded')).toHaveText('After the flood, I never trusted the council.');
  await expect(page.getByTestId('feature-mark').filter({ hasText: '●' })).toHaveCount(1);
  await expect.poll(() => codings(path).length).toBe(1);
  const code = codings(path)[0]!.body.source;
  expect(JSON.parse(readFileSync(join(E2E.dir, 'codebook.jsonld'), 'utf8'))['@graph'].find((n: { id: string }) => n.id === code).prefLabel).toBe('Distrust of institutions');
  expect(readFileSync(join(E2E.dir, path), 'utf8')).toBe(TEXT);

  // The codebook, with the code and its count; its passages retrieved.
  const row = panel.getByTestId('codes-row').filter({ hasText: 'Distrust of institutions' });
  await expect(row).toContainText('1');
  await row.getByTestId('codes-retrieve').click();
  const retrieve = page.getByTestId('feature-panel-annotations-retrieve');
  await expect(retrieve.getByTestId('retrieve-row')).toHaveCount(1);
  await expect(retrieve.getByTestId('retrieve-row')).toContainText('I never trusted the council');

  // From its mark in the margin: the codings there, and yours removed.
  await page.getByTestId('feature-mark').filter({ hasText: '●' }).click();
  await expect(page.getByTestId('codes-here-row')).toContainText('Distrust of institutions');
  await page.getByTestId('codes-remove').click();
  await expect(page.getByTestId('editor').locator('.kuraa-coded')).toHaveCount(0);
  await expect.poll(() => codings(path).length).toBe(0);

  // Coding off, then annotations: nothing of them shown; the codebook kept.
  await openSettings(page);
  await page.getByTestId('open-feature-annotations').click();
  await settingsSave(page, 'annotations-coding', false, '/api/features/annotations');
  await page.getByTestId('subpanel-back').click();
  await settingsSave(page, 'feature-annotations', false, '/api/features/annotations');
  await page.getByTestId('settings-close').click();
  expect(existsSync(join(E2E.dir, 'codebook.jsonld'))).toBe(true);
  await api(`/api/files?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
});
