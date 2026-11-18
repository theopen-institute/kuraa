// The Plugins panel shows what the host's flags turned on (engines, where code
// runs, formats) and changes none of it; each person's editing
// behaviour is theirs to turn on and off. Documents cannot put script in the page.
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHost, type RunningHost } from '../../packages/host/src/index.js';
import { standardRunPlugins } from '../../packages/run-plugins/src/index.js';
import { E2E } from './env.js';

const RMD = '# Chunks\n\n```{r}\n1 + 1\n```\n';

/** A host of the test's own, started with flags of its own. */
async function ownHost(formats?: string[]): Promise<RunningHost> {
  const dir = mkdtempSync(join(tmpdir(), 'kuraa-e2e-plugins-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Owner');
  git('config', 'user.email', 'owner@example.org');
  writeFileSync(join(dir, 'analysis.Rmd'), RMD);
  writeFileSync(join(dir, 'notes.md'), '# Notes\n\nPlain text here. [A web link](https://example.org/) and [a script](javascript:document.title="pwned").\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Initial');
  return startHost({
    dir,
    formats,
    run: { engines: [], plugins: standardRunPlugins, dataDir: mkdtempSync(join(tmpdir(), 'kuraa-e2e-plugins-data-')) },
    staticDir: fileURLToPath(new URL('../../apps/web/dist', import.meta.url)),
    timings: { flushMs: 300, idleCommitMs: 1500, maxCommitMs: 10_000, dropMs: 1000 },
  });
}

async function openPlugins(page: Page): Promise<void> {
  await page.getByTestId('menu-button').click();
  await page.getByTestId('menu').getByRole('button', { name: 'Plugins…' }).click();
  await expect(page.getByTestId('plugins')).toBeVisible();
}

const box = (page: Page, name: string) => page.getByTestId('plugins').getByRole('checkbox', { name, exact: true });

test('the host’s flags decide; the panel only shows them', async ({ page }) => {
  const host = await ownHost(['pandoc-markdown', 'text']);
  try {
    await page.goto(`${host.url}/?token=${host.token}&name=Owner`);
    // R Markdown is off on this host: the file opens as a Text file.
    await page.getByTestId('file:analysis.Rmd').click();
    await expect(page.getByTestId('editor')).toHaveClass(/lines-doc/);
    await expect(page.getByTestId('editor')).toContainText('```{r}');

    await openPlugins(page);
    await expect(page.getByTestId('plugins')).toContainText('--format');
    await expect(box(page, 'R')).not.toBeChecked();
    await expect(box(page, 'R Markdown')).not.toBeChecked();
    await expect(box(page, 'Pandoc markdown')).toBeChecked();
    for (const name of ['R', 'R Markdown', 'Pandoc markdown', 'Text file']) await expect(box(page, name)).toBeDisabled();
    // Where code runs: the environments loaded (here only Podman), none in use while no engine is on.
    await expect(page.getByTestId('environment:podman')).toContainText('In a Podman container');
    await expect(page.getByTestId('environment:podman')).not.toContainText('not sandboxed');
    await expect(box(page, 'In a Podman container')).not.toBeChecked();
    await expect(box(page, 'In a Podman container')).toBeDisabled();
  } finally {
    await host.close();
  }
});

test('a link in a document reaches the page only if it is a web or mail address', async ({ page }) => {
  const host = await ownHost();
  try {
    await page.goto(`${host.url}/?token=${host.token}&name=Owner`);
    await page.getByTestId('file:notes.md').click();
    const editor = page.getByTestId('editor');
    await expect(editor.locator('a', { hasText: 'A web link' })).toHaveAttribute('href', 'https://example.org/');
    const script = editor.locator('a', { hasText: 'a script' });
    await expect(script).toBeVisible();
    await expect(script).not.toHaveAttribute('href');
  } finally {
    await host.close();
  }
});

test('editing behaviour is yours alone, and kept', async ({ page }) => {
  const host = await ownHost();
  try {
    await page.goto(`${host.url}/?token=${host.token}&name=Owner`);
    await page.getByTestId('file:notes.md').click();
    const editor = page.getByTestId('editor');
    await expect(editor).toContainText('Plain text here.');

    await openPlugins(page);
    await box(page, 'Markdown editing').uncheck();
    await page.keyboard.press('Escape');
    await editor.locator('p', { hasText: 'Plain text here.' }).click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
    await page.waitForTimeout(100);
    await page.keyboard.type(' **as typed** ');
    await expect(editor).toContainText('**as typed**');
    await expect(editor.locator('strong')).toHaveCount(0);

    // Kept in this browser; turned back on, typing formats again.
    await page.reload();
    await page.getByTestId('file:notes.md').click();
    await openPlugins(page);
    await expect(box(page, 'Markdown editing')).not.toBeChecked();
    await box(page, 'Markdown editing').check();
    await page.keyboard.press('Escape');
    await editor.locator('p', { hasText: 'Plain text here.' }).click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
    await page.waitForTimeout(100);
    await page.keyboard.type(' **bold** ');
    await expect(editor.locator('strong')).toHaveText('bold');
  } finally {
    await host.close();
  }
});

test('on the shared host too, only your editing behaviour can change', async ({ page }) => {
  await page.goto(`/?token=${E2E.token}&name=Guest`);
  await expect(page.getByTestId('workspace-name')).toBeVisible();
  await openPlugins(page);
  await expect(box(page, 'R')).toBeChecked();
  await expect(box(page, 'R')).toBeDisabled();
  await expect(box(page, 'In a Podman container')).toBeChecked();
  await expect(box(page, 'R Markdown')).toBeDisabled();
  await expect(box(page, 'Markdown editing')).toBeEnabled();
});
