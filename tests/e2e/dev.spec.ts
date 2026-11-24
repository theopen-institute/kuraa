// `pnpm dev`: one command gives a working client with no settings to enter, the
// host behind Vite's proxy, and a clean stop on Ctrl+C.
import { expect, test } from '@playwright/test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { NOTES } from './env.js';
import { openSettings } from './settings.js';

const ROOT = resolve(import.meta.dirname, '../..');
const PORT = 5199;
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

test('pnpm dev serves the client against a live host with nothing to configure', async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'kuraa-dev-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Dev Person');
  git(dir, 'config', 'user.email', 'dev@example.org');
  writeFileSync(join(dir, 'notes.md'), NOTES);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'Initial');

  // Its own process group, so the test can send Ctrl+C to all of it as a terminal would.
  const dev: ChildProcess = spawn(join(ROOT, 'node_modules/.bin/tsx'), ['scripts/dev.ts', '--dir', dir, '--port', String(PORT)], {
    cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  dev.stdout!.on('data', (d: Buffer) => (log += d));
  dev.stderr!.on('data', (d: Buffer) => (log += d));
  const exited = new Promise<void>((done) => dev.on('exit', () => done()));
  try {
    await expect.poll(() => log, { timeout: 30_000 }).toMatch(/\[web\][\s\S]*Local/);
    await expect.poll(() => log, { timeout: 30_000 }).toContain('[kuraa] url:');

    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.getByTestId('file:notes.md').click();
    await expect(page.getByTestId('status')).toContainText('Connected');
    await expect(page.getByTestId('peers')).toContainText('Dev Person');
    await page.getByTestId('editor').locator('p', { hasText: 'Light rain' }).click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
    await page.waitForTimeout(100);
    await page.keyboard.type(' Typed in dev.', { delay: 10 });
    await expect.poll(() => readFileSync(join(dir, 'notes.md'), 'utf8'), { timeout: 10_000 }).toContain('Light rain all morning. Typed in dev.');

    // One folder: the switcher shows it, and nothing can be added.
    await page.getByTestId('workspace-switcher').click();
    await expect(page.getByTestId(`workspace:${basename(dir).toLowerCase()}`)).toBeVisible();
    await expect(page.getByTestId('workspace-add')).toHaveCount(0);
    await page.keyboard.press('Escape');

    // The dev server supplies the host, so Settings has no host or token.
    await openSettings(page);
    await page.getByTestId('settings-tab-you').click();
    await expect(page.getByLabel('Host address')).toHaveCount(0);
  } finally {
    process.kill(-dev.pid!, 'SIGINT');
    await exited;
  }
  console.log(log);
  // The host committed the edit as it stopped.
  expect(git(dir, 'status', '--porcelain')).toBe('');
  expect(git(dir, 'show', 'HEAD:notes.md')).toContain('Typed in dev.');
  expect(log).not.toContain('Force killing');
  console.log(log);
});

test('pnpm dev without --dir serves a folder of workspaces, starting with Scratch, and people may add more', async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), 'kuraa-dev-workspaces-'));
  // A person's key of its own (none yet), never that of whoever runs the tests.
  const person = join(mkdtempSync(join(tmpdir(), 'kuraa-dev-person-')), 'person.json');
  const dev: ChildProcess = spawn(join(ROOT, 'node_modules/.bin/tsx'), ['scripts/dev.ts', '--workspaces', root, '--port', String(PORT)], {
    cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, KURAA_PERSON: person },
  });
  let log = '';
  dev.stdout!.on('data', (d: Buffer) => (log += d));
  dev.stderr!.on('data', (d: Buffer) => (log += d));
  const exited = new Promise<void>((done) => dev.on('exit', () => done()));
  try {
    await expect.poll(() => log, { timeout: 30_000 }).toMatch(/\[web\][\s\S]*Local/);
    await expect.poll(() => log, { timeout: 30_000 }).toContain('[kuraa] url:');
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await expect(page.getByTestId('workspace-name')).toHaveText('Scratch');
    await page.getByTestId('file:scratch.md').click();
    await expect(page.getByTestId('status')).toContainText('Connected');
    await page.getByTestId('workspace-switcher').click();
    await page.getByTestId('workspace-add').click();
    const dialog = page.getByTestId('add-workspace');
    await dialog.getByTestId('add-workspace-name').fill('Field notes');
    await dialog.getByTestId('add-workspace-submit').click();
    await expect(page.getByTestId('workspace-name')).toHaveText('Field notes');
    expect(existsSync(join(root, 'field-notes', '.git'))).toBe(true);

    // You on this computer, in the browser too: pnpm dev runs the host on your own computer, and lets the app
    // manage it. Your identity is made for you from your name; the keys are in Sign in from another device, in Settings.
    await openSettings(page);
    await page.getByTestId('settings-tab-you').click();
    const key = page.getByTestId('person-key');
    await expect(key.getByTestId('you-here')).toContainText('You on this computer:');
    await expect.poll(() => existsSync(person), { timeout: 10_000 }).toBe(true);
    await page.getByTestId('open-sign-in').click();
    await expect(page.getByTestId('subpanel-title')).toHaveText('Sign in from another device');
    await expect(key.getByTestId('signing-key')).toBeHidden();
    await key.getByText('Keys', { exact: true }).click();
    await expect(key.getByTestId('signing-key')).toHaveText(/^[0-9a-f]{8}…$/);
    await page.getByTestId('subpanel-back').click();
    await expect(key.getByTestId('you-here')).toBeVisible();
    await page.getByTestId('settings-close').click();

    // An online copy, added from its component in Settings › Host (decision 0059): a plain git repository each save is pushed to.
    const bare = mkdtempSync(join(tmpdir(), 'kuraa-dev-online-'));
    execFileSync('git', ['init', '-q', '--bare'], { cwd: bare });
    await openSettings(page);
    await page.getByTestId('settings-tab-host').click();
    await expect(page.getByTestId('component-sync:online')).toContainText('not set up');
    await page.getByTestId('sync-settings:online').click();
    await expect(page.getByTestId('subpanel-title')).toHaveText('Online copy');
    const online = page.getByTestId('subpanel-sync:online').getByTestId('sync:online');
    await online.getByTestId('sync-address').fill(bare);
    await online.getByTestId('sync-add').click();
    await expect(online).toContainText('up to date', { timeout: 15_000 });
    expect(execFileSync('git', ['log', '--all', '--format=%s'], { cwd: bare, encoding: 'utf8' })).toContain('Initialise workspace');
  } finally {
    process.kill(-dev.pid!, 'SIGINT');
    await exited;
  }
  expect(log).not.toContain('Force killing');
});
