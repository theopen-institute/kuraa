// Images: one pasted is shown in a dialog (0108: its size as kept, what was in
// its file and is removed, smaller sizes), then kept as one of the document's
// own files (0109: `report.md.files/`, not shown in the file list) and shown
// from the workspace; `![alt](src)` typed becomes an image too; renaming the
// document takes its files and their references with it.
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E, KEYS } from './env.js';

const MAC = process.platform === 'darwin';
const PNG = '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a1d5e5a90000000049454e44ae426082';

test('a pasted image is kept with the document and shown; a typed one too; both follow a rename', async ({ page }) => {
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
    // The data set on the event, not given to it: Firefox empties what a page gives a ClipboardEvent it makes.
    el.dispatchEvent(Object.defineProperty(new ClipboardEvent('paste', { bubbles: true, cancelable: true }), 'clipboardData', { value: data }));
  }, PNG);
  // The dialog: nothing hidden in this one; its description from its name; Enter adds it.
  const dialog = page.getByTestId('add-images');
  await expect(dialog.getByTestId('add-image-removed')).toHaveText('Nothing else is stored in the file: only the picture.');
  await expect(dialog.getByTestId('add-image-alt')).toHaveValue('Growth Curve');
  await expect(dialog.getByTestId('add-image-size')).toHaveText('70 bytes');
  await expect(dialog.getByTestId('add-images-total')).toContainText('Adds 70 bytes to the workspace.');
  await expect(dialog.getByTestId('add-images-ok')).toBeEnabled();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  const image = editor.getByTestId('image').first();
  await expect(image.locator('img')).toHaveAttribute('src', /^blob:/);
  await expect(image.locator('img')).toHaveAttribute('alt', 'Growth Curve');
  expect(existsSync(join(E2E.dir, dir, 'report.md.files', 'growth-curve.png'))).toBe(true);
  // Not in the file list: it is the document's.
  await expect(page.getByTestId(`folder:${dir}/report.md.files`)).toHaveCount(0);
  await expect(page.getByTestId(`file:${dir}/report.md.files/growth-curve.png`)).toHaveCount(0);

  // A typed image, pointing at it.
  await page.keyboard.press(KEYS.lineEnd);
  await page.keyboard.press('Enter');
  await page.keyboard.type('Again: ![the curve](report.md.files/growth-curve.png) and a missing ![x](images/none.png)', { delay: 10 });
  await expect(editor.getByTestId('image')).toHaveCount(3);
  await expect(editor.getByTestId('image').nth(1).locator('img')).toHaveAttribute('src', /^blob:/);
  await expect(editor.getByTestId('image').nth(2)).toHaveClass(/image-missing/);

  const file = join(E2E.dir, dir, 'report.md');
  await expect.poll(() => readFileSync(file, 'utf8'), { timeout: 10_000 }).toContain('none.png');
  const text = readFileSync(file, 'utf8');
  expect(text).toContain('![Growth Curve](report.md.files/growth-curve.png)');
  expect(text).toContain('Again: ![the curve](report.md.files/growth-curve.png) and a missing ![x](images/none.png)');

  // Renamed (as the file list's Rename does): its files go with it, and both references follow.
  const renamed = await fetch(`${E2E.url}/api/files`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${E2E.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: `${dir}/report.md`, to: `${dir}/findings.md` }),
  });
  expect(renamed.status).toBe(200);
  const after = readFileSync(join(E2E.dir, dir, 'findings.md'), 'utf8');
  expect(after).toContain('![Growth Curve](findings.md.files/growth-curve.png)');
  expect(after).toContain('Again: ![the curve](findings.md.files/growth-curve.png) and a missing ![x](images/none.png)');
  expect(existsSync(join(E2E.dir, dir, 'findings.md.files', 'growth-curve.png'))).toBe(true);
  await page.reload();
  await page.getByTestId(`file:${dir}/findings.md`).click();
  await expect(page.getByTestId('editor').getByTestId('image').first().locator('img')).toHaveAttribute('src', /^blob:/);
  await expect(page.getByTestId(`folder:${dir}/findings.md.files`)).toHaveCount(0);
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

test('a photo is kept without where it was taken, at a smaller size if chosen; cancelling adds nothing', async ({ page }) => {
  const dir = `photo-${Date.now().toString(36)}`;
  const res = await fetch(`${E2E.url}/api/files`, {
    method: 'POST',
    headers: { authorization: `Bearer ${E2E.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ path: `${dir}/trip.md`, content: '# Trip\n\nThe view:\n' }),
  });
  expect(res.status).toBe(201);
  page.on('pageerror', (e) => console.error(`page error: ${e.message}`));
  await page.goto(`/?token=${E2E.token}&name=Image%20Tester&email=img%40example.org`);
  await page.getByTestId(`file:${dir}/trip.md`).click();
  const editor = page.getByTestId('editor');
  await expect(page.getByTestId('status')).toContainText('Connected');
  await editor.locator('p', { hasText: 'The view:' }).click();
  await page.keyboard.press(MAC ? 'Meta+ArrowRight' : 'End');
  await page.keyboard.press('Enter');

  // A phone's photo, 3000 × 2000 of noise (large as a JPEG), with EXIF saying the camera and where.
  const paste = () => editor.evaluate(async (el) => {
    const canvas = document.createElement('canvas');
    canvas.width = 3000;
    canvas.height = 2000;
    const g = canvas.getContext('2d')!;
    const img = g.createImageData(3000, 2000);
    let x = 7;
    for (let i = 0; i < img.data.length; i++) img.data[i] = i % 4 === 3 ? 255 : (x = (x * 1103515245 + 12345) & 0x7fffffff) >> 23;
    g.putImageData(img, 0, 0);
    const jpeg = new Uint8Array(await (await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/jpeg', 0.95))).arrayBuffer());
    // EXIF (big-endian TIFF): Make "Apple", a GPS directory with a latitude.
    const tiff = [0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 2,
      0x01, 0x0f, 0, 2, 0, 0, 0, 6, 0, 0, 0, 38,
      0x88, 0x25, 0, 4, 0, 0, 0, 1, 0, 0, 0, 44,
      0, 0, 0, 0,
      0x41, 0x70, 0x70, 0x6c, 0x65, 0,
      0, 1, 0, 2, 0, 2, 0, 0, 0, 2, 0x4e, 0, 0, 0, 0, 0, 0, 0];
    const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
    const app1 = [0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body];
    const photo = new Uint8Array([...jpeg.subarray(0, 2), ...app1, ...jpeg.subarray(2)]);
    const data = new DataTransfer();
    data.items.add(new File([photo], 'IMG_0042.jpg', { type: 'image/jpeg' }));
    // Set on the event, as above (Firefox).
    el.dispatchEvent(Object.defineProperty(new ClipboardEvent('paste', { bubbles: true, cancelable: true }), 'clipboardData', { value: data }));
  });

  // Cancelled: nothing added.
  await paste();
  const dialog = page.getByTestId('add-images');
  await expect(dialog.getByTestId('add-image-removed')).toHaveText('Removed from the file: where it was taken and the camera and its settings.');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(editor.getByTestId('image')).toHaveCount(0);
  await expect(editor.locator('.image-uploading')).toHaveCount(0);

  await paste();
  await expect(dialog.getByTestId('add-image-removed')).toContainText('where it was taken');
  // Large: said so, and smaller sizes offered once made, each with its size.
  await expect(dialog.getByTestId('add-images-large')).toBeVisible();
  const choice = dialog.getByTestId('add-image-choice');
  await expect(choice.locator('option[value="1600"]')).toHaveText(/^1600 × 1067 — [\d.]+ (KB|MB)$/);
  await expect(choice.locator('option[value="0"]')).toHaveText(/^Full size, 3000 × 2000 — [\d.]+ MB$/);
  await choice.selectOption('1600');
  await expect(dialog.getByTestId('add-image-size')).toHaveText(/ → /);
  const total = (await dialog.getByTestId('add-images-total').textContent())!;
  expect(total).toContain('Its history is');
  await dialog.getByTestId('add-image-alt').fill('The bay from the hill');
  await dialog.getByTestId('add-images-ok').click();
  await expect(dialog).toHaveCount(0);

  const image = editor.getByTestId('image');
  await expect(image.locator('img')).toHaveAttribute('src', /^blob:/);
  await expect(image.locator('img')).toHaveAttribute('alt', 'The bay from the hill');
  await expect.poll(() => image.locator('img').evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(1600);
  const kept = readFileSync(join(E2E.dir, dir, 'trip.md.files', 'img-0042.jpg'));
  expect(kept.includes(Buffer.from('Apple'))).toBe(false);
  expect(kept.includes(Buffer.from('Exif'))).toBe(false);
  // What the dialog said it adds is what was kept.
  const n = kept.length;
  const shown = n < 10 * 1024 ? `${(n / 1024).toFixed(1)} KB` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;
  expect(total).toContain(`Adds ${shown} to the workspace.`);
  expect(execFileSync('git', ['log', '-1', '--format=%s'], { cwd: E2E.dir, encoding: 'utf8' })).toContain(`Add image ${dir}/trip.md.files/img-0042.jpg`);
});
