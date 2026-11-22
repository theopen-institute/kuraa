// The browser is the desktop app's equal (decision 0047): on a server listening
// only on this computer, whoever has the access code changes its Preferences and
// opens any folder, through the hub, as the desktop app does.
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SettingsStore, startHub, type RunningHub } from '../../packages/host/src/index.js';
import { standardRunComponents } from '../../packages/run-components/src/index.js';

const STATIC = fileURLToPath(new URL('../../apps/web/dist', import.meta.url));
const TIMINGS = { flushMs: 200, idleCommitMs: 800, maxCommitMs: 10_000, dropMs: 1000 };

/** Your workspaces, as `pnpm host` serves them: settings and list in an app data folder of the test's own. */
async function yourWorkspaces(): Promise<{ hub: RunningHub; app: string }> {
  const base = mkdtempSync(join(tmpdir(), 'kuraa-e2e-prefs-'));
  const app = join(base, 'app');
  const hub = await startHub({
    defaultRoot: join(base, 'workspaces'),
    registry: join(app, 'workspaces.json'),
    settings: new SettingsStore(join(app, 'settings.json'), {}, app),
    staticDir: STATIC,
    hosts: { timings: TIMINGS, run: { components: standardRunComponents } },
  });
  const w = await hub.hub.create('Notes');
  writeFileSync(join(w.path, 'analysis.Rmd'), '# Chunks\n\n```{r}\n1 + 1\n```\n');
  return { hub, app };
}

test('Settings in the browser: a wrong value refused, a kind of document turned off, applied on closing', async ({ page }) => {
  const { hub, app } = await yourWorkspaces();
  try {
    await page.goto(`${hub.url}/?token=${hub.token}&name=Owner`);
    await expect(page.getByTestId('workspace-name')).toHaveText('Notes');
    await page.getByTestId('menu-button').click();
    await page.getByTestId('menu-settings').click();
    // One window of four sections (decision 0064): opened at You; this computer's server is a section of its own.
    await expect(page.getByTestId('settings-you').getByLabel('Your name')).toHaveValue('Owner');
    await expect(page.getByTestId('settings-scope')).toContainText('Only you');
    await page.getByTestId('settings-tab-server').click();
    await expect(page.getByTestId('settings-scope')).toContainText('Only you, its owner, can change it');
    const prefs = page.getByTestId('preferences');
    await expect(prefs.getByTestId('pref-workspaces')).toHaveValue(/workspaces$/);
    await expect(prefs.getByTestId('pref-format-rmarkdown')).toBeChecked();
    await expect(prefs.getByTestId('pref-environments')).not.toBeEmpty();

    // No Save button: changes take effect on closing, as said by Done once something is changed.
    await expect(page.getByTestId('pref-save')).toHaveCount(0);
    await expect(page.getByTestId('pref-pending')).toHaveCount(0);
    // A value that is wrong is refused on closing, saying what; the window stays, and nothing is kept.
    await prefs.getByTestId('pref-run-advanced').locator('summary').click();
    await prefs.getByTestId('pref-memory').fill('lots');
    await expect(page.getByTestId('pref-pending')).toContainText('take effect when you close Settings');
    await page.getByTestId('settings-close').click();
    await expect(prefs.getByTestId('pref-error')).toContainText('The memory limit should be a size such as 4g or 512m');
    await expect(page.getByTestId('settings-window')).toBeVisible();
    await expect(page.getByTestId('settings-discard')).toBeVisible();
    expect(existsSync(join(app, 'settings.json'))).toBe(false);

    await prefs.getByTestId('pref-memory').fill('3g');
    await prefs.getByTestId('pref-format-rmarkdown').uncheck();
    // A relay to connect through, named by its key (kuraa-host relay prints it).
    await prefs.getByTestId('pref-network-advanced').locator('summary').click();
    await prefs.getByTestId('pref-relays').fill('ab'.repeat(32));
    // Done: the hub reopens every workspace with them, then the page reloads.
    const reloaded = page.waitForEvent('load', { timeout: 30_000 });
    await page.getByTestId('settings-close').click();
    await reloaded;
    await expect(page.getByTestId('workspace-name')).toHaveText('Notes');
    expect(JSON.parse(readFileSync(join(app, 'settings.json'), 'utf8'))).toMatchObject({ memory: '3g', relays: ['ab'.repeat(32)], formats: expect.not.arrayContaining(['rmarkdown']) });

    // R Markdown is off now, and the file opens as plain text.
    await page.getByTestId('menu-button').click();
    await page.getByTestId('menu-settings').click();
    await page.getByTestId('settings-tab-server').click();
    await expect(page.getByTestId('pref-format-rmarkdown')).not.toBeChecked();
    await expect(page.getByTestId('pref-format-pandoc-markdown')).toBeChecked();
    await page.keyboard.press('Escape');

    // Kept: the dialog opens with them, from the keyboard too (⌥⌘, as in the desktop app).
    await page.keyboard.press('ControlOrMeta+Alt+Comma');
    await page.getByTestId('settings-tab-server').click();
    await expect(prefs.getByTestId('pref-format-rmarkdown')).not.toBeChecked();
    await prefs.getByTestId('pref-run-advanced').locator('summary').click();
    await expect(prefs.getByTestId('pref-memory')).toHaveValue('3g');
    await page.keyboard.press('Escape');
    await expect(prefs).toHaveCount(0);
  } finally {
    await hub.close();
  }
});

test('Open a folder… in the browser: chosen in the folder picker, asked before it keeps versions', async ({ page }) => {
  const { hub } = await yourWorkspaces();
  const parent = mkdtempSync(join(tmpdir(), 'kuraa-e2e-open-'));
  const plain = join(parent, 'Field trip');
  mkdirSync(plain);
  mkdirSync(join(parent, '.hidden'));
  writeFileSync(join(plain, 'diary.md'), '# Diary\n\nLow tide at six.\n');
  try {
    await page.goto(`${hub.url}/?token=${hub.token}&name=Owner`);
    await expect(page.getByTestId('workspace-name')).toHaveText('Notes');
    // Add a workspace… → An existing folder → Choose a folder…
    await page.getByTestId('workspace-switcher').click();
    await page.getByTestId('workspace-add').click();
    await page.getByTestId('add-workspace-folder').click();
    await page.getByTestId('add-workspace-submit').click();
    const picker = page.getByTestId('folder-picker');
    await expect(picker).toBeVisible();
    // It starts at home; a path goes straight there.
    await picker.getByTestId('folder-picker-path').fill(parent);
    await picker.getByTestId('folder-picker-path').press('Enter');
    await expect(picker.getByTestId('folder:Field trip')).toBeVisible();
    await expect(picker.getByTestId('folder:.hidden')).toHaveCount(0);
    await picker.getByTestId('folder-picker-hidden').check();
    await expect(picker.getByTestId('folder:.hidden')).toBeVisible();
    await picker.getByTestId('folder:Field trip').click();
    await expect(picker.getByTestId('folder-picker-path')).toHaveValue(plain);
    await picker.getByTestId('folder-picker-choose').click();

    // Not yet a repository: asked first, in the desktop app's words.
    const ask = page.getByTestId('ask');
    await expect(ask).toContainText('Use “Field trip” as a workspace?');
    await expect(ask).toContainText('starting with the item already there');
    await ask.getByRole('button', { name: 'Use this folder' }).click();
    await expect(page.getByTestId('workspace-name')).toHaveText('Field trip');
    await page.getByTestId('file:diary.md').click();
    await expect(page.getByTestId('editor')).toContainText('Low tide at six.');
    expect(execFileSync('git', ['log', '--format=%s'], { cwd: plain, encoding: 'utf8' }).trim()).toBe('Initialise workspace');
    expect(basename(plain)).toBe('Field trip');
  } finally {
    await hub.close();
  }
});
