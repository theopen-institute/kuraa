// Tables: `| a | b |` and Enter makes one; Tab moves between cells and makes
// rows; right-click adds and deletes rows and columns; the file gets a pipe table.
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E } from './env.js';

const MAC = process.platform === 'darwin';

test('a typed table is edited with Tab and the right-click menu, and written as a pipe table', async ({ page }) => {
  const path = `tables-${Date.now().toString(36)}.md`;
  const res = await fetch(`${E2E.url}/api/files`, {
    method: 'POST',
    headers: { authorization: `Bearer ${E2E.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ path, content: '# Counts\n\nBees per roof.\n' }),
  });
  expect(res.status).toBe(201);

  page.on('pageerror', (e) => console.error(`page error: ${e.message}`));
  await page.goto(`/?token=${E2E.token}&name=Table%20Tester&email=tables%40example.org`);
  await page.getByTestId(`file:${path}`).click();
  const editor = page.getByTestId('editor');
  await expect(page.getByTestId('status')).toContainText('Connected');
  await editor.locator('p', { hasText: 'Bees per roof.' }).click();
  await page.keyboard.press(MAC ? 'Meta+ArrowRight' : 'End');
  await page.waitForTimeout(100);
  const type = (text: string) => page.keyboard.type(text, { delay: 15 });

  await page.keyboard.press('Enter');
  await type('| Roof | Bees |');
  await page.keyboard.press('Enter');
  await expect(editor.locator('table th')).toHaveText(['Roof', 'Bees']);
  await type('North');
  await page.keyboard.press('Tab');
  await type('12');
  await page.keyboard.press('Tab');
  await type('South');
  await page.keyboard.press('Tab');
  await type('7');
  await expect(editor.locator('table tr')).toHaveCount(3);
  await page.keyboard.press('Shift+Tab');
  await type(' roof');
  await expect(editor.locator('table td').nth(2)).toHaveText('South roof');

  // A column to the right of Bees, then a row above South.
  await editor.locator('table th', { hasText: 'Bees' }).click({ button: 'right' });
  await expect(page.getByTestId('table-menu')).toBeVisible();
  await page.getByTestId('table:column-right').click();
  await type('Year');
  await editor.locator('table td', { hasText: 'South roof' }).click({ button: 'right' });
  await page.getByTestId('table:row-above').click();
  await type('West');
  await expect(editor.locator('table tr')).toHaveCount(4);
  await editor.locator('table td', { hasText: 'West' }).click({ button: 'right' });
  await page.getByTestId('table:delete-row').click();
  await expect(editor.locator('table tr')).toHaveCount(3);

  // Two rows more, selected from the first to the second (Shift+click) and deleted at once.
  await editor.locator('table td', { hasText: 'South roof' }).click({ button: 'right' });
  await page.getByTestId('table:row-below').click();
  await type('East');
  await page.keyboard.press('Enter');
  await type('Peak');
  await expect(editor.locator('table tr')).toHaveCount(5);
  await editor.locator('table td', { hasText: 'East' }).click();
  await page.keyboard.press(MAC ? 'Meta+ArrowLeft' : 'Home');
  await editor.locator('table td', { hasText: 'Peak' }).click({ modifiers: ['Shift'] });
  await editor.locator('table td', { hasText: 'East' }).click({ button: 'right' });
  await expect(page.getByTestId('table:delete-row')).toHaveText('Delete 2 rows');
  await page.getByTestId('table:delete-row').click();
  await expect(editor.locator('table tr')).toHaveCount(3);
  await editor.locator('table td', { hasText: 'South roof' }).click({ button: 'right' });
  await expect(page.getByTestId('table:delete-row')).toHaveText('Delete the row');
  await page.keyboard.press('Escape');
  await editor.locator('table td', { hasText: 'South roof' }).click();
  await page.keyboard.press(MAC ? 'Meta+ArrowRight' : 'End');

  // ⌘Enter leaves the table.
  await page.keyboard.press(MAC ? 'Meta+Enter' : 'Control+Enter');
  await type('After the table.');

  const file = join(E2E.dir, path);
  await expect.poll(() => readFileSync(file, 'utf8'), { timeout: 10_000 }).toContain('After the table.');
  expect(readFileSync(file, 'utf8')).toContain('| Roof | Bees | Year |\n|---|---|---|\n| North | 12 |  |\n| South roof | 7 |  |\n\nAfter the table.');
});
