// Navigation is made of components (docs/decisions/0087-navigation-is-made-of-components.md):
// the sidebar (a layout) and the file tree (a view) are features on by default.
// With the sidebar off for a workspace, the core's own menu at the upper left
// still opens files, makes them, and reaches Settings; turned on again, the
// sidebar is back.
import { expect, test } from '@playwright/test';
import { E2E } from './env.js';

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${E2E.url}${path}`, { ...init, headers: { authorization: `Bearer ${E2E.token}`, 'content-type': 'application/json' } });
const turn = (id: string, on: boolean) => api(`/api/features/${id}`, { method: 'PATCH', body: JSON.stringify({ on, by: { name: 'Navigator', email: 'n@example.org', color: '#123456' } }) });

test('with the sidebar off, the menu at the upper left opens files, makes them and reaches Settings', async ({ page }) => {
  const id = Date.now().toString(36);
  const path = `nav-${id}/tide-${id}.md`;
  expect((await api('/api/files', { method: 'POST', body: JSON.stringify({ path, content: `---\ntitle: Tide ${id}\n---\n\nLow water.\n` }) })).status).toBe(201);

  // On by default: the sidebar, with the file tree in it.
  await page.goto(`/?token=${E2E.token}&name=Navigator&email=n%40example.org`);
  await expect(page.getByTestId(`file:${path}`)).toBeVisible();
  await expect(page.getByTestId('fallback-menu')).toHaveCount(0);

  try {
    expect((await turn('sidebar', false)).status).toBe(200);
    await page.reload();
    await expect(page.getByTestId('fallback-menu')).toBeVisible();
    await expect(page.getByTestId('workspace-switcher')).toHaveCount(0);
    await expect(page.getByTestId(`file:${path}`)).toHaveCount(0);

    // Files…: a plain list, filtered by name, opening the file chosen.
    await page.getByTestId('fallback-menu').click();
    await page.getByTestId('fallback-files').click();
    const list = page.getByTestId('files-list');
    await expect(list).toBeVisible();
    await list.getByTestId('files-filter').fill(`tide ${id}`);
    await expect(list.getByTestId(`files-list:${path}`)).toContainText(`Tide ${id}`);
    await expect(list.getByTestId(`files-list:${path}`)).toContainText(`nav-${id}`);
    await page.keyboard.press('Enter');
    await expect(list).toHaveCount(0);
    await expect(page.getByTestId('editor')).toContainText('Low water.');

    // The workspaces are in it, and Settings.
    await page.getByTestId('fallback-menu').click();
    await expect(page.getByTestId('context-menu').getByRole('menuitem', { name: /kuraa-e2e-workspace/ })).toBeVisible();
    await page.getByTestId('workspace-settings').first().click();
    await expect(page.getByTestId('settings-window')).toBeVisible();
  } finally {
    expect((await turn('sidebar', true)).status).toBe(200);
  }
  await page.reload();
  await expect(page.getByTestId(`file:${path}`)).toBeVisible();
  await expect(page.getByTestId('fallback-menu')).toHaveCount(0);
});
