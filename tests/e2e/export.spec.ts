// Export… on the document's ⋯ menu (0100): the Preview panel, opened at its
// formats to export as, the first one focused, and nothing rendered for the page.
import { expect, test } from '@playwright/test';
import { E2E } from './env.js';

test('Export… opens Preview at the formats to export as, rendering nothing yet', async ({ page }) => {
  const path = `export-${Date.now().toString(36)}.md`;
  const res = await fetch(`${E2E.url}/api/files`, {
    method: 'POST',
    headers: { authorization: `Bearer ${E2E.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ path, content: '# Tides\n\nHigh at noon.\n' }),
  });
  expect(res.status).toBe(201);
  await page.goto(`/?token=${E2E.token}&name=Exporter&email=e%40example.org`);
  await page.getByTestId(`file:${path}`).click();
  await expect(page.getByTestId('status')).toContainText('Connected');

  await page.getByTestId('document-menu-button').click();
  await expect(page.getByTestId('menu-export')).toHaveText(/Export…/);
  await page.getByTestId('menu-export').click();
  const panel = page.getByTestId('preview-panel');
  await expect(panel.getByTestId('save-pdf')).toBeVisible();
  await expect(panel).toContainText('Export as');
  // Where this host can render, the first format is focused, to choose with the keyboard.
  if (await panel.getByTestId('save-pdf').isEnabled()) {
    await expect(panel.locator('[data-export]:focus')).toHaveCount(1);
  }
  await expect(panel.getByTestId('render-status')).toHaveCount(0);
});
