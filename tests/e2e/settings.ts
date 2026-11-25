// Opening Settings in the browser tests: ⚙ in the sidebar's lower right corner,
// at the workspace; or, with none open, at You.
import type { Page } from '@playwright/test';

export async function openSettings(page: Page): Promise<void> {
  await page.getByTestId('workspace-settings').click();
}
