// Images sized and placed, and columns (0130): an image's handles drag it
// narrower (`{width=…%}`), its bar places it on its line (`fig-align`); an image
// dragged to the edge of a paragraph puts the two in columns, whose gap is
// dragged to share the line otherwise; each as Pandoc writes it in the file.
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { E2E } from './env.js';

/** A plain blue PNG of a size. */
function png(w: number, h: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, sum]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0);
  head.writeUInt32BE(h, 4);
  head[8] = 8;
  head[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [40, 110, 200]).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function open(page: Page, content: string): Promise<{ file: string; dir: string }> {
  const dir = `layout-${Date.now().toString(36)}`;
  mkdirSync(join(E2E.dir, dir, 'report.md.files'), { recursive: true });
  writeFileSync(join(E2E.dir, dir, 'report.md.files', 'blue.png'), png(400, 200));
  const res = await fetch(`${E2E.url}/api/files`, {
    method: 'POST',
    headers: { authorization: `Bearer ${E2E.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ path: `${dir}/report.md`, content }),
  });
  expect(res.status).toBe(201);
  page.on('pageerror', (e) => console.error(`page error: ${e.message}`));
  await page.goto(`/?token=${E2E.token}&name=Layout%20Tester&email=layout%40example.org`);
  await page.getByTestId(`file:${dir}/report.md`).click();
  await expect(page.getByTestId('status')).toContainText('Connected');
  return { file: join(E2E.dir, dir, 'report.md'), dir };
}

const saved = (file: string) => () => readFileSync(file, 'utf8');

test('an image dragged narrower by its handle, and placed by its bar', async ({ page }) => {
  const { file } = await open(page, '# Report\n\nAbove the picture.\n\n![The coast](report.md.files/blue.png)\n\nBelow it.\n');
  const editor = page.getByTestId('editor');
  const image = editor.getByTestId('image');
  await expect(image.locator('img')).toHaveAttribute('src', /^blob:/);
  // Alone on its line: centred, as it says nothing.
  await expect(editor.locator('p.image-alone')).toHaveAttribute('data-align', 'center');

  await image.locator('img').click();
  const bar = image.getByTestId('image-bar');
  await expect(bar).toBeVisible();
  await expect(bar.getByTestId('image-align-center')).toHaveAttribute('aria-pressed', 'true');
  await expect(bar.getByTestId('image-own-size')).toHaveCount(0);

  // The right handle dragged in: centred, both sides move, so the image loses twice the distance.
  const handle = image.getByTestId('image-handle-right');
  await expect(handle).toBeVisible();
  const line = (await editor.locator('p.image-alone').evaluate((p) => {
    const s = getComputedStyle(p);
    return p.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
  }));
  const before = (await image.boundingBox())!;
  const h = (await handle.boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 - 60, h.y + h.height / 2, { steps: 6 });
  await page.mouse.up();
  const expected = Math.round(((before.width - 120) / line) * 100);
  await expect.poll(saved(file), { timeout: 10_000 }).toMatch(/!\[The coast\]\(report\.md\.files\/blue\.png\)\{width=\d+%\}/);
  const width = Number(/\{width=(\d+)%\}/.exec(saved(file)())![1]);
  expect(Math.abs(width - expected)).toBeLessThanOrEqual(1);
  await expect.poll(async () => Math.round(((await image.boundingBox())!.width / line) * 100)).toBe(width);

  // Placed right, then its own size again.
  await expect(bar).toBeVisible();
  await bar.getByTestId('image-align-right').click();
  await expect.poll(saved(file)).toContain(`{width=${width}% fig-align=right}`);
  await expect(editor.locator('p.image-alone')).toHaveAttribute('data-align', 'right');
  await bar.getByTestId('image-own-size').click();
  await expect.poll(saved(file)).toContain('![The coast](report.md.files/blue.png){fig-align=right}');
});

test('an image dragged to the edge of a paragraph: the two in columns; their gap dragged to share the line', async ({ page }) => {
  const { file } = await open(page, '# Report\n\nThe words that will sit beside the picture, a line or two of them to see them wrap in their column.\n\n![The coast](report.md.files/blue.png)\n\nAfter.\n');
  const editor = page.getByTestId('editor');
  const image = editor.getByTestId('image');
  await expect(image.locator('img')).toHaveAttribute('src', /^blob:/);
  await image.locator('img').click();

  // Dragged (as the browser drags: dragstart, dragover, drop) to the right edge of the paragraph above.
  const target = editor.locator('p', { hasText: 'The words that will sit' });
  const box = (await target.boundingBox())!;
  const at = { x: box.x + box.width - 8, y: box.y + box.height / 2 };
  await image.locator('img').evaluate((img, at) => {
    const data = new DataTransfer();
    const opts = { bubbles: true, cancelable: true, dataTransfer: data };
    img.closest('.image-node')!.dispatchEvent(new DragEvent('dragstart', opts));
    const over = document.elementFromPoint(at.x, at.y)!;
    over.dispatchEvent(new DragEvent('dragover', { ...opts, clientX: at.x, clientY: at.y }));
  }, at);
  await expect(page.getByTestId('column-drop')).toBeVisible();
  await page.evaluate((at) => {
    const over = document.elementFromPoint(at.x, at.y)!;
    const data = new DataTransfer();
    over.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data, clientX: at.x, clientY: at.y }));
  }, at);
  await expect(page.getByTestId('column-drop')).toHaveCount(0);
  const columns = editor.getByTestId('columns');
  await expect(columns.getByTestId('column')).toHaveCount(2);
  await expect(columns.getByTestId('column').nth(1).getByTestId('image')).toHaveCount(1);
  await expect.poll(saved(file), { timeout: 10_000 }).toContain(
    ':::: columns\n::: {.column width=50%}\nThe words that will sit beside the picture, a line or two of them to see them wrap in their column.\n:::\n\n'
    + '::: {.column width=50%}\n![The coast](report.md.files/blue.png)\n:::\n::::\n\nAfter.\n',
  );
  // Side by side on the page.
  const [a, b] = [(await columns.getByTestId('column').nth(0).boundingBox())!, (await columns.getByTestId('column').nth(1).boundingBox())!];
  expect(b.x).toBeGreaterThan(a.x + a.width);
  expect(Math.abs(a.y - b.y)).toBeLessThan(2);

  // The gap between them dragged left: the first narrower, the second wider, adding up to the line.
  const gutter = columns.getByTestId('column').nth(1).getByTestId('column-gutter');
  const g = (await gutter.boundingBox())!;
  await page.mouse.move(g.x + g.width / 2, g.y + 20);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2 - (a.width + b.width) * 0.2, g.y + 20, { steps: 8 });
  await page.mouse.up();
  await expect.poll(saved(file)).toMatch(/::: \{\.column width=(2[89]|3[01])%\}\nThe words[\s\S]*::: \{\.column width=(69|7[012])%\}\n!\[The coast\]/);
  const [w1, w2] = [...saved(file)().matchAll(/\{\.column width=(\d+)%\}/g)].map((m) => Number(m[1]));
  expect(w1! + w2!).toBe(100);
});
