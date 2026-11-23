// Images: one pasted is kept in images/ beside the document and shown from the
// workspace; `![alt](src)` typed becomes an image too.
import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E } from './env.js';

const MAC = process.platform === 'darwin';
const PNG = '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a1d5e5a90000000049454e44ae426082';

test('a pasted image is kept beside the document and shown; a typed one too', async ({ page }) => {
  const dir = `img-${Date.now().toString(36)}`;
  const res = await fetch(`${E2E.url}/api/files`, {
    method: 'POST',
    headers: { authorization: `Bearer ${E2E.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ path: `${dir}/report.md`, content: '# Report\n\nThe plot:\n' }),
  });
  expect(res.status).toBe(201);

  page.on('pageerror', (e) => console.error(`page error: ${e.message}`));
  await page.goto(`/?token=${E2E.token}&name=Image%20Tester&email=img%40example.org`);
  await page.getByTestId(`file:${dir}/report.md`).click();
  const editor = page.getByTestId('editor');
  await expect(page.getByTestId('status')).toContainText('Connected');
  await editor.locator('p', { hasText: 'The plot:' }).click();
  await page.keyboard.press(MAC ? 'Meta+ArrowRight' : 'End');
  await page.waitForTimeout(100);
  await page.keyboard.press('Enter');

  // Paste an image file.
  await editor.evaluate((el, hex) => {
    const bytes = new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16)));
    const data = new DataTransfer();
    data.items.add(new File([bytes], 'Growth Curve.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, PNG);
  const image = editor.getByTestId('image').first();
  await expect(image.locator('img')).toHaveAttribute('src', /^blob:/);
  await expect(image.locator('img')).toHaveAttribute('alt', 'Growth Curve');
  expect(existsSync(join(E2E.dir, dir, 'images', 'growth-curve.png'))).toBe(true);

  // A typed image, pointing at it.
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Again: ![the curve](images/growth-curve.png) and a missing ![x](images/none.png)', { delay: 10 });
  await expect(editor.getByTestId('image')).toHaveCount(3);
  await expect(editor.getByTestId('image').nth(1).locator('img')).toHaveAttribute('src', /^blob:/);
  await expect(editor.getByTestId('image').nth(2)).toHaveClass(/image-missing/);

  const file = join(E2E.dir, dir, 'report.md');
  await expect.poll(() => readFileSync(file, 'utf8'), { timeout: 10_000 }).toContain('none.png');
  const text = readFileSync(file, 'utf8');
  expect(text).toContain('![Growth Curve](images/growth-curve.png)');
  expect(text).toContain('Again: ![the curve](images/growth-curve.png) and a missing ![x](images/none.png)');
});

test('an image at a web address is shown only once asked for', async ({ page }) => {
  const path = `remote-${Date.now().toString(36)}.md`;
  const res = await fetch(`${E2E.url}/api/files`, {
    method: 'POST',
    headers: { authorization: `Bearer ${E2E.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ path, content: '# Remote\n\n![a pixel](https://tracker.invalid/pixel.png)\n' }),
  });
  expect(res.status).toBe(201);
  const asked: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('tracker.invalid')) asked.push(r.url());
  });
  await page.goto(`/?token=${E2E.token}&name=Image%20Tester&email=img%40example.org`);
  await page.getByTestId(`file:${path}`).click();
  const image = page.getByTestId('editor').getByTestId('image');
  await expect(image.getByTestId('image-load')).toContainText('tracker.invalid');
  await expect(image.locator('img')).not.toHaveAttribute('src', /./);
  expect(asked).toEqual([]);
  await image.getByTestId('image-load').click();
  await expect(image.locator('img')).toHaveAttribute('src', 'https://tracker.invalid/pixel.png');
  await expect(image.getByTestId('image-load')).toHaveCount(0);
});
