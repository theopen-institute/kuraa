// Tools (decision 0045): the Components dialog lists the tools the host knows,
// what each downloads, and offers to download and remove them where installs
// are allowed; the preview offers a tool a PDF needs, and renders again once it
// is there. Downloads here are of a fake tool (packages/host/test/fixtures/tools.mjs):
// nothing is fetched.
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHost, type RunningHost } from '../../packages/host/src/index.js';
import { standardFeatures } from '../../packages/features/src/index.js';
import { E2E } from './env.js';
import { openSettings } from './settings.js';

const TOOLS = fileURLToPath(new URL('../../packages/host/test/fixtures/tools.mjs', import.meta.url));

async function fakeHost(): Promise<RunningHost> {
  const dir = mkdtempSync(join(tmpdir(), 'kuraa-e2e-tools-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Owner');
  git('config', 'user.email', 'owner@example.org');
  writeFileSync(join(dir, 'paper.md'), '# Paper\n\nNEEDS-PDF-TOOL with a \\usepackage{boxes} in it.\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Initial');
  return startHost({
    dir,
    run: {
      engines: ['typeset'], environment: 'toolbox', components: [TOOLS], allowInstalls: true,
      dataDir: mkdtempSync(join(tmpdir(), 'kuraa-e2e-tools-data-')), options: { toolbox: { slowMs: 1500 } },
    },
    staticDir: fileURLToPath(new URL('../../apps/web/dist', import.meta.url)),
    timings: { flushMs: 300, idleCommitMs: 1500, maxCommitMs: 10_000, dropMs: 1000 },
    // Preview is a component (0089): a host has it where it is given the standard features, as every real one is.
    features: standardFeatures,
  });
}

/** Settings › Components, where the tools are (decisions 0064, 0084). */
async function openComponents(page: Page): Promise<void> {
  await openSettings(page);
  await page.getByTestId('settings-tab-you').click();
  await page.getByTestId('settings-tab-components').click();
  await page.getByTestId('kind:tools').click();
  await expect(page.getByTestId('components')).toBeVisible();
}

test('Settings › Components lists TinyTeX, with its size, to download', async ({ page }) => {
  await page.goto(`/?token=${E2E.token}&name=Guest`);
  await expect(page.getByTestId('workspace-name')).toBeVisible();
  await openComponents(page);
  const tool = page.getByTestId('tool:tinytex');
  await expect(tool).toContainText('PDF with LaTeX');
  await expect(tool).toContainText('TinyTeX');
  await expect(page.getByTestId('tool-status:tinytex')).toHaveText('About 54 MB to download.');
  // Not clicked: it would download TeX.
  await expect(page.getByTestId('tool-download:tinytex')).toBeEnabled();
});

test('a tool is downloaded and removed in Settings › Components', async ({ page }) => {
  const host = await fakeHost();
  try {
    await page.goto(`${host.url}/?token=${host.token}&name=Owner`);
    await expect(page.getByTestId('workspace-name')).toBeVisible();
    await openComponents(page);
    const status = page.getByTestId('tool-status:fakepdf');
    await expect(status).toHaveText('About 12 MB to download.');
    await page.getByTestId('tool-download:fakepdf').click();
    await expect(status).toContainText('Downloading Fake PDF…');
    await expect(page.getByTestId('tool-download:fakepdf')).toBeDisabled();
    await expect(status).toContainText('Downloaded:', { timeout: 15_000 });
    await page.getByTestId('tool-remove:fakepdf').click();
    await expect(status).toHaveText('About 12 MB to download.', { timeout: 15_000 });
    await expect(page.getByTestId('tool-download:fakepdf')).toBeEnabled();
  } finally {
    await host.close();
  }
});

test('the preview offers the tool a PDF needs, and renders it once downloaded', async ({ page }) => {
  const host = await fakeHost();
  try {
    await page.goto(`${host.url}/?token=${host.token}&name=Owner&email=owner%40example.org`);
    await page.getByTestId('file:paper.md').click();
    await page.getByTestId('document-menu-button').click();
    await page.getByTestId('menu-export').click();
    const panel = page.getByTestId('preview-panel');
    await panel.getByTestId('save-pdf').click();
    const offer = panel.getByTestId('render-download-tool');
    await expect(offer).toHaveText('Download Fake PDF (about 12 MB)');
    await expect(panel.getByTestId('render-status')).toContainText('This document needs Fake PDF.');
    const saved = page.waitForEvent('download', { timeout: 30_000 });
    await offer.click();
    await expect(panel.getByTestId('render-status')).toContainText('Downloading Fake PDF…');
    // Downloaded, rendered again (adding the package it lacked), and saved as asked.
    await expect(panel.getByTestId('render-status')).toContainText('Added boxes to this computer for it.', { timeout: 30_000 });
    expect((await saved).suggestedFilename()).toBe('paper.pdf');
    await expect(offer).toHaveCount(0);
  } finally {
    await host.close();
  }
});
