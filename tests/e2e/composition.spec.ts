// Composition mode (docs/decisions/0120-composition-mode.md): the page alone,
// from the ⋯ menu or ⌥⌘P; typewriter scrolling keeps the line being written at
// one height; the words and the target at the page's foot; the other
// paragraphs faded where Settings › You says; Escape leaves it.
import { expect, test } from '@playwright/test';
import { E2E } from './env.js';
import { openComponents } from './settings.js';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

test('composition mode: the page alone, typewriter scrolling, the words at its foot; faded paragraphs as set; Escape leaves', async ({ page }) => {
  const path = `runs/compose-${Date.now().toString(36)}.md`;
  const paragraphs = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1} about the tide coming in over the harbour wall, and the boats rising with it.`);
  const res = await fetch(`${E2E.url}/api/files`, {
    method: 'POST',
    headers: { authorization: `Bearer ${E2E.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ path, content: `---\ntitle: Tides\ntarget-words: 1000\n---\n\n${paragraphs.join('\n\n')}\n` }),
  });
  expect(res.status).toBe(201);
  await page.goto(`/?token=${E2E.token}&name=Writer&email=w%40example.org`);
  await page.getByTestId(`file:${path}`).click();
  await expect(page.getByTestId('status')).toContainText('Connected');

  // From the ⋯ menu: the page alone, the sidebar gone, the words and the target at its foot.
  await page.getByTestId('editor').locator('p', { hasText: 'Paragraph 20 ' }).click();
  await page.getByTestId('document-menu-button').click();
  await page.getByTestId('menu-composition').click();
  await expect(page.locator('.app')).toHaveClass(/\bpage-alone\b/);
  await expect(page.locator('.layout-area')).toBeHidden();
  await expect(page.getByTestId('composition-count')).toHaveText(/^[\d,]+ of 1,000 words · \d+%$/);

  // Typewriter scrolling: the line being written at about 45% of the page's height.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
  await page.keyboard.type(' The light changed.');
  await expect(page.getByTestId('composition-count')).toHaveText(/^[\d,]+ of 1,000 words/);
  const at = async () => page.evaluate(() => {
    const sel = window.getSelection()!;
    const r = sel.getRangeAt(0).getBoundingClientRect();
    const node = sel.anchorNode!;
    const box = (node instanceof Element ? node : node.parentElement)!.closest('.editor-scroll')!.getBoundingClientRect();
    return (r.top - box.top) / box.height;
  });
  await expect.poll(at).toBeGreaterThan(0.4);
  expect(await at()).toBeLessThan(0.5);

  // Escape: everything back.
  await page.keyboard.press('Escape');
  await expect(page.locator('.app')).not.toHaveClass(/\bpage-alone\b/);
  await expect(page.locator('.layout-area')).toBeVisible();
  await expect(page.getByTestId('composition-count')).toHaveCount(0);

  // Settings › You: fade the other paragraphs, no count.
  await openComponents(page);
  await page.getByTestId('open-feature-you-composition').click();
  await page.getByTestId('composition-fade').check();
  await page.getByTestId('composition-count').uncheck();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('settings-window')).toHaveCount(0);

  // ⌥⌘P: the others faded, no count; and again to leave.
  await page.getByTestId('editor').locator('p', { hasText: 'Paragraph 5 ' }).click();
  await page.keyboard.press(`${MOD}+Alt+p`);
  await expect(page.locator('.app')).toHaveClass(/\bpage-alone\b/);
  await expect(page.locator('.ProseMirror.composition-fading')).toBeAttached();
  await expect(page.getByTestId('editor').locator('p', { hasText: 'Paragraph 5 ' })).toHaveClass(/composition-current/);
  await expect(page.getByTestId('editor').locator('p', { hasText: 'Paragraph 6 ' })).toHaveCSS('opacity', '0.3');
  await expect(page.getByTestId('composition-count')).toHaveCount(0);
  await page.keyboard.press(`${MOD}+Alt+p`);
  await expect(page.locator('.app')).not.toHaveClass(/\bpage-alone\b/);
  await expect(page.locator('.composition-fading')).toHaveCount(0);
});
