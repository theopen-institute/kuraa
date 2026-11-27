// A feature's panel stays drawn while how features stand changes (another
// feature turned on for the workspace, a feature's settings saved): it is told,
// not taken down and drawn again, so what was typed in it is kept.
import { expect, test } from '@playwright/test';
import { E2E } from './env.js';
import { openComponents } from './settings.js';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const api = (path: string, init: RequestInit = {}) =>
  fetch(`${E2E.url}${path}`, { ...init, headers: { authorization: `Bearer ${E2E.token}`, 'content-type': 'application/json' } });

async function marksOn(page: import('@playwright/test').Page, on: boolean) {
  await openComponents(page);
  const box = page.getByTestId('feature-marks');
  await expect(box).toBeVisible();
  const saved = page.waitForResponse((r) => r.url().endsWith('/api/features/marks') && r.request().method() === 'PATCH');
  if (on) await box.check();
  else await box.uncheck();
  expect((await saved).status()).toBe(200);
  await page.getByTestId('settings-close').click();
}

test('an open panel keeps what was typed in it when another feature is turned on', async ({ page }) => {
  const id = Date.now().toString(36);
  const path = `stable-${id}.md`;
  expect((await api('/api/files', { method: 'POST', body: JSON.stringify({ path, content: `# Stable\n\nKelp ${id}.\n` }) })).status).toBe(201);
  await page.goto(`/?token=${E2E.token}&name=Ada`);
  await page.getByTestId(`file:${path}`).click();
  await expect(page.getByTestId('status')).toContainText('Connected');

  await page.keyboard.press(`${MOD}+Shift+F`);
  const input = page.getByTestId('search-panel').getByTestId('search-input');
  await expect(input).toBeFocused();
  await input.fill(`kelp ${id}`);
  // Marked, so a panel drawn again (a new input) is told apart from the same one.
  await input.evaluate((el) => el.setAttribute('data-drawn', 'first'));

  await marksOn(page, true);
  await expect(page.locator('.editor-scroll[data-features="marks"]')).toBeVisible();
  await expect(input).toHaveValue(`kelp ${id}`);
  await expect(input).toHaveAttribute('data-drawn', 'first');

  await marksOn(page, false);
  await expect(input).toHaveAttribute('data-drawn', 'first');
});
