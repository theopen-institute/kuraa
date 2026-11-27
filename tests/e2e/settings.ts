// Opening Settings in the browser tests: ⚙ on the open workspace's row of the
// menu of its name, at the workspace; or, with none open, Settings… there, at You.
// Components (0095): Settings, at Components, where every component is switched,
// at the tab of a kind (0104): Features unless said.
import type { Page } from '@playwright/test';

export async function openSettings(page: Page): Promise<void> {
  await page.getByTestId('workspace-switcher').click();
  await page.getByTestId('workspace-settings').click();
}

export async function openComponents(page: Page, kind = 'features'): Promise<void> {
  await openSettings(page);
  await page.getByTestId('settings-tab-components').click();
  await page.getByTestId(`kind:${kind}`).click();
}
