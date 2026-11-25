// Opening Settings in the browser tests: ⚙ on the open workspace's row of the
// menu of its name, at the workspace; or, with none open, Settings… there, at You.
import type { Page } from '@playwright/test';

export async function openSettings(page: Page): Promise<void> {
  await page.getByTestId('workspace-switcher').click();
  await page.getByTestId('workspace-settings').click();
}
