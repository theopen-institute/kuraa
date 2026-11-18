// The Plugins panel: on a host you run, formats and run plugins turn on and off
// for everyone, live; your editing behaviour, for you alone. On a shared host the
// host's plugins show, but cannot be changed.
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHost, type RunningHost } from '../../packages/host/src/index.js';
import { E2E } from './env.js';

const RMD = '# Chunks\n\n```{r}\n1 + 1\n```\n';

async function ownHost(): Promise<{ host: RunningHost; dir: string; settings: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'kuraa-e2e-plugins-'));
  const data = mkdtempSync(join(tmpdir(), 'kuraa-e2e-plugins-data-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Owner');
  git('config', 'user.email', 'owner@example.org');
  writeFileSync(join(dir, 'analysis.Rmd'), RMD);
  writeFileSync(join(dir, 'notes.md'), '# Notes\n\nPlain text here.\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Initial');
  const settings = join(data, 'plugins.json');
  const host = await startHost({
    dir,
    host: '127.0.0.1',
    run: { engines: ['r'], environments: ['local'], dataDir: data },
    pluginSettings: settings,
    staticDir: fileURLToPath(new URL('../../apps/web/dist', import.meta.url)),
    timings: { flushMs: 300, idleCommitMs: 1500, maxCommitMs: 10_000, dropMs: 1000 },
  });
  return { host, dir, settings };
}

async function openPlugins(page: Page): Promise<void> {
  await page.getByTestId('menu-button').click();
  await page.getByTestId('menu').getByRole('button', { name: 'Plugins…' }).click();
  await expect(page.getByTestId('plugins')).toBeVisible();
}

const box = (page: Page, name: string) => page.getByTestId('plugins').getByRole('checkbox', { name, exact: true });
/** A change to the host's plugins has been applied (the boxes are enabled again). */
const applied = (page: Page) => expect(box(page, 'R')).toBeEnabled();

test('on your own host, a format turned off reopens its files as text, live', async ({ page }) => {
  const { host, dir, settings } = await ownHost();
  try {
    await page.goto(`${host.url}/?token=${host.token}&name=Owner`);
    await page.getByTestId('file:analysis.Rmd').click();
    const editor = page.getByTestId('editor');
    await expect(editor.locator('.code-node')).toHaveCount(1);

    await openPlugins(page);
    await expect(box(page, 'R')).toBeChecked();
    await expect(box(page, 'On this computer')).toBeChecked();
    await expect(box(page, 'In a Podman container')).not.toBeChecked();
    await box(page, 'R Markdown').uncheck();
    await applied(page);
    await expect(box(page, 'R Markdown')).not.toBeChecked();
    expect(JSON.parse(readFileSync(settings, 'utf8'))).toMatchObject({ formats: { rmarkdown: false } });

    // The open file is now a Text file: one line per line, the fence as typed.
    await expect(page.getByTestId('editor')).toHaveClass(/lines-doc/);
    await expect(page.getByTestId('editor')).toContainText('```{r}');
    expect(readFileSync(join(dir, 'analysis.Rmd'), 'utf8')).toBe(RMD);

    // And back.
    await box(page, 'R Markdown').check();
    await applied(page);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('plugins')).toHaveCount(0);
    await expect(page.getByTestId('editor').locator('.code-node')).toHaveCount(1);

    // Running off: the engine unticked; the document still opens.
    await openPlugins(page);
    await box(page, 'R').uncheck();
    await applied(page);
    await expect(box(page, 'R')).not.toBeChecked();
    await page.keyboard.press('Escape');
    await page.getByTestId('menu-button').click();
    await expect(page.getByTestId('r-state')).toHaveCount(0);
  } finally {
    await host.close();
  }
});

test('editing behaviour is yours alone, and kept', async ({ page }) => {
  const { host } = await ownHost();
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

test('on a shared host, its plugins show but cannot be changed', async ({ page }) => {
  await page.goto(`/?token=${E2E.token}&name=Guest`);
  await expect(page.getByTestId('workspace-name')).toBeVisible();
  await openPlugins(page);
  await expect(page.getByTestId('plugins')).toContainText('set by whoever runs this host');
  await expect(box(page, 'R')).toBeDisabled();
  await expect(box(page, 'R Markdown')).toBeDisabled();
  await expect(box(page, 'Markdown editing')).toBeEnabled();
});
