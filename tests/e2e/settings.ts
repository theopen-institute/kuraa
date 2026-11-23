// Opening Settings in the browser tests: from the workspace's menu (its name, in
// the sidebar's header), at the workspace; or, with none open, Settings… there.
import type { Page } from '@playwright/test';

export async function openSettings(page: Page): Promise<void> {
  await page.getByTestId('workspace-switcher').click();
  await page.getByTestId('workspace-settings').click();
}
