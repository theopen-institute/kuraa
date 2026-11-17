// The New file dialog offers a type, Markdown by default, and keeps the type
// and the name's extension in step.
import { expect, test, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { E2E } from './env.js';

async function openApp(page: Page): Promise<void> {
  await page.goto(`/?token=${E2E.token}&name=Maker&email=make%40example.org`);
  await expect(page.getByRole('button', { name: 'New file', exact: true })).toBeVisible();
}

const dialog = (page: Page) => page.getByTestId('ask');

test('new files default to Markdown; the type and the extension follow each other', async ({ page }) => {
  await openApp(page);
  const stamp = Date.now().toString(36);

  // Default: Markdown, with a .md name.
  await page.getByRole('button', { name: 'New file', exact: true }).click();
  const type = dialog(page).getByLabel('File type');
  const name = dialog(page).getByLabel('Name');
  await expect(type).toHaveValue('pandoc-markdown');
  await expect(name).toHaveValue('untitled.md');
  await expect(type.locator('optgroup')).toHaveCount(2);

  // Choosing a type changes the extension.
  await type.selectOption('rmarkdown');
  await expect(name).toHaveValue('untitled.Rmd');
  await type.selectOption('text');
  await expect(name).toHaveValue('untitled.txt');
  // Only three choices: Markdown, R Markdown, Text file.
  await expect(type.locator('option')).toHaveText(['Pandoc markdown (.md)', 'R Markdown (.Rmd)', 'Text file (.txt)']);

  // Typing a known extension chooses the type: a script or data file is a text file.
  await type.selectOption('pandoc-markdown');
  await name.fill(`runs/new-${stamp}.py`);
  await expect(type).toHaveValue('text');
  await name.fill(`runs/new-${stamp}.Rmd`);
  await expect(type).toHaveValue('rmarkdown');

  // A name with no extension gets the chosen type's.
  await name.fill(`runs/report-${stamp}`);
  await dialog(page).getByRole('button', { name: 'Create' }).click();
  await expect(page.getByTestId(`file:runs/report-${stamp}.Rmd`)).toBeVisible();
  await expect(page.getByTestId('editor')).toBeVisible();
  expect(existsSync(join(E2E.dir, `runs/report-${stamp}.Rmd`))).toBe(true);

  // Escape cancels.
  await page.getByRole('button', { name: 'New file', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
});

test('the sidebar shows the workspace name, makes folders, and opens the menu', async ({ page }) => {
  await openApp(page);
  await expect(page.getByTestId('workspace-name')).toHaveText('kuraa-e2e-workspace');
  await expect(page.locator('footer.status')).toHaveCount(0);

  // A new folder: committed (with a placeholder git keeps), shown, and a place for new files.
  const folder = `runs/folder-${Date.now().toString(36)}`;
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  await page.getByTestId('ask').locator('input').fill(folder);
  await page.getByTestId('ask').getByRole('button', { name: 'Create' }).click();
  const row = page.locator('.tree-dir-row', { hasText: folder.split('/')[1]! });
  await expect(row).toBeVisible();
  expect(existsSync(join(E2E.dir, folder, '.gitkeep'))).toBe(true);
  await expect(page.locator('[data-testid$="/.gitkeep"]')).toHaveCount(0);
  await row.hover();
  await row.getByRole('button', { name: /^New file in/ }).click();
  await expect(dialog(page).getByLabel('Name')).toHaveValue(`${folder}/untitled.md`);
  await page.keyboard.press('Escape');

  // ⌘, (Ctrl+, elsewhere) opens and closes the menu.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Comma' : 'Control+Comma');
  await expect(page.getByTestId('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('menu')).toHaveCount(0);
});

