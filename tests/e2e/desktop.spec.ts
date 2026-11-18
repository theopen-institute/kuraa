// M8: the Electron app opens a local folder, edits and commits; it can also join
// a shared host. The M5 checks run against the folder while other programs
// (plain file writes, git pull) change it.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { startHost, type RunningHost } from '../../packages/host/src/index.js';
import { NOTES } from './env.js';
import { findPodman } from '../../packages/env-podman/src/index.js';

const DESKTOP = resolve(import.meta.dirname, '../../apps/desktop');
const MAIN = join(DESKTOP, 'build/main.cjs');
const ELECTRON = createRequire(join(DESKTOP, 'package.json'))('electron') as unknown as string;
const MAC = process.platform === 'darwin';

const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kuraa-desktop-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Desk Top');
  git(dir, 'config', 'user.email', 'desk@example.org');
  writeFileSync(join(dir, 'notes.md'), NOTES);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'Initial');
  return dir;
}

async function launch(args: string[], timings: object, extraEnv: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    executablePath: ELECTRON,
    args: [MAIN, ...args],
    // VS Code's terminal sets ELECTRON_RUN_AS_NODE, which would start Electron as plain Node.
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE')) as Record<string, string>, KURAA_TIMINGS: JSON.stringify(timings),
      // The app's plugin choices, apart from those of whoever runs the tests.
      KURAA_PLUGIN_SETTINGS: join(mkdtempSync(join(tmpdir(), 'kuraa-plugins-')), 'plugins.json'),
      ...extraEnv },
  });
  const page = await app.firstWindow();
  page.on('pageerror', (e) => console.error(`[desktop] page error: ${e.message}`));
  app.process().stdout?.on('data', (d: Buffer) => process.env.DEBUG && process.stdout.write(d));
  return { app, page };
}

async function openNotes(page: Page): Promise<void> {
  await page.getByTestId('file:notes.md').click();
  await expect(page.getByTestId('editor')).toBeVisible();
  await expect(page.getByTestId('status')).toContainText('Connected');
}

async function typeAtEnd(page: Page, paragraph: string, text: string): Promise<void> {
  await page.getByTestId('editor').locator('p', { hasText: paragraph }).click();
  await page.keyboard.press(MAC ? 'Meta+ArrowRight' : 'End');
  // ProseMirror reads a moved caret from selectionchange a moment later; a sync
  // arriving before that would put the caret back where ProseMirror last saw it.
  await page.waitForTimeout(100);
  await page.keyboard.type(text, { delay: 20 });
}

const read = (dir: string) => readFileSync(join(dir, 'notes.md'), 'utf8');
const editorText = (page: Page) => page.getByTestId('editor');

test.beforeAll(() => {
  execFileSync('pnpm', ['--filter', '@kuraa/desktop', 'build'], { stdio: 'inherit' });
});

test('opens a local folder, edits and commits; outside changes reach the editor', async () => {
  const dir = makeRepo();
  // A long flush interval keeps edits unflushed while the outside changes land.
  const { app, page } = await launch(['--open', dir], { flushMs: 1500, idleCommitMs: 2500, maxCommitMs: 20_000, dropMs: 1000 });
  try {
    await openNotes(page);
    await expect(page).toHaveTitle(`notes.md · ${basename(dir)} · kuraa`);

    // The connection comes through the preload bridge, so a reload keeps it.
    await page.reload();
    await openNotes(page);

    // The app manages this host: Settings has no host or token, and offers the shell's actions.
    await page.getByTestId('menu-button').click();
    await expect(page.getByLabel('Display name')).toHaveValue('Desk Top');
    await expect(page.getByLabel('Host URL')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Open another folder…' })).toBeVisible();
    await page.keyboard.press('Escape');

    // New and Rename ask in an in-app dialog (Electron has no window.prompt).
    await page.getByRole('button', { name: 'New file', exact: true }).click();
    await page.getByTestId('ask').locator('input').fill('field/day-one.md');
    await page.getByTestId('ask').getByRole('button', { name: 'Create' }).click();
    await expect(page.getByTestId('file:field/day-one.md')).toBeVisible();
    await expect.poll(() => existsSync(join(dir, 'field/day-one.md'))).toBe(true);
    const row = page.locator('li.tree-file', { has: page.getByTestId('file:field/day-one.md') });
    await row.hover();
    await row.getByTitle('Rename').click();
    await page.getByTestId('ask').locator('input').fill('field/day-1.md');
    await page.getByTestId('ask').getByRole('button', { name: 'Rename' }).click();
    await expect(page.getByTestId('file:field/day-1.md')).toBeVisible();
    await expect.poll(() => existsSync(join(dir, 'field/day-1.md'))).toBe(true);
    expect(existsSync(join(dir, 'field/day-one.md'))).toBe(false);
    await openNotes(page);

    // Edit and commit.
    await typeAtEnd(page, 'The tide', ' Desktop edit.');
    await expect.poll(() => read(dir), { timeout: 10_000 }).toContain('when we arrived. Desktop edit.');
    await expect.poll(() => git(dir, 'show', 'HEAD:notes.md'), { timeout: 15_000 }).toContain('Desktop edit.');
    await page.getByTestId('menu-button').click();
    await expect(page.getByTestId('last-commit')).not.toContainText('—');
    await page.keyboard.press('Escape');

    // M5 (a): another program edits elsewhere in the file while the user types.
    await typeAtEnd(page, 'The tide', ' Still typing.');
    writeFileSync(join(dir, 'notes.md'), read(dir).replace('Light rain all morning.', 'Heavy rain all morning.'));
    await expect(editorText(page)).toContainText('Heavy rain all morning.', { timeout: 10_000 });
    await expect(editorText(page)).toContainText('Desktop edit. Still typing.');
    await expect.poll(() => read(dir), { timeout: 10_000 }).toContain('Desktop edit. Still typing.');
    expect(read(dir)).toContain('Heavy rain all morning.');

    // M5 (b): a change arriving by merge (git pull in the folder).
    await expect.poll(() => git(dir, 'status', '--porcelain'), { timeout: 15_000 }).toBe('');
    const other = mkdtempSync(join(tmpdir(), 'kuraa-other-'));
    git(other, 'clone', '-q', dir, '.');
    git(other, 'config', 'user.name', 'Other Person');
    git(other, 'config', 'user.email', 'other@example.org');
    writeFileSync(join(other, 'notes.md'), read(other).replace('## Day two', '## Day two, wet'));
    git(other, 'commit', '-q', '-am', 'Retitle day two');
    git(dir, 'pull', '-q', '--no-rebase', '--no-edit', other, 'main');
    await expect(editorText(page)).toContainText('Day two, wet', { timeout: 10_000 });
    expect(read(dir)).toContain('## Day two, wet');

    // M5 (c): a conflicting outside edit to the paragraph being typed in.
    await typeAtEnd(page, 'Mateus', ' Live words.');
    writeFileSync(join(dir, 'notes.md'), read(dir).replace(/Mateus recalibrated[^\n]*/, 'Mateus did not recalibrate anything.'));
    await expect(page.getByTestId('notice')).toContainText('conflicting outside edit', { timeout: 10_000 });
    await expect(editorText(page)).toContainText('Live words.');
    await expect.poll(() => readdirSync(dir).some((f) => f.startsWith('notes.md.outside-'))).toBe(true);
    await expect.poll(() => read(dir), { timeout: 10_000 }).toContain('Live words.');
  } finally {
    await app.close();
  }
  // Quitting flushed and committed everything.
  expect(git(dir, 'status', '--porcelain', '--', 'notes.md')).toBe('');
});

test('joins a shared host without starting one', async () => {
  const dir = makeRepo();
  const host: RunningHost = await startHost({
    dir, port: 0, host: '127.0.0.1',
    timings: { flushMs: 300, idleCommitMs: 1000, maxCommitMs: 10_000, dropMs: 1000 },
  });
  try {
    const { app, page } = await launch(['--join', host.url, '--token', host.token], {});
    try {
      await openNotes(page);
      await expect(page).toHaveTitle(`notes.md · ${basename(dir)} · kuraa`);
      await typeAtEnd(page, 'Light rain', ' Joined from the desktop.');
      await expect.poll(() => read(dir), { timeout: 10_000 }).toContain('Light rain all morning. Joined from the desktop.');
      await expect.poll(() => git(dir, 'log', '-1', '--format=%s'), { timeout: 15_000 }).not.toBe('Initial');
    } finally {
      await app.close();
    }
  } finally {
    await host.close();
  }
  expect(existsSync(join(dir, '.git'))).toBe(true);
});

test('the launcher opens a folder that is not yet a repository, and joins a host', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kuraa-plain-'));
  writeFileSync(join(dir, 'notes.md'), NOTES);
  const shared = makeRepo();
  const host = await startHost({ dir: shared, port: 0, host: '127.0.0.1', timings: { flushMs: 300, idleCommitMs: 1000, maxCommitMs: 10_000, dropMs: 1000 } });
  const { app, page } = await launch([], { flushMs: 300, idleCommitMs: 1000, maxCommitMs: 10_000, dropMs: 1000 });
  try {
    // Native dialogs cannot be clicked from a test: answer them in the main process.
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog;
      dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox;
    }, dir);

    await page.getByRole('button', { name: 'Open folder…' }).click();
    await openNotes(page);
    expect(git(dir, 'log', '--format=%s')).toBe('Initialise workspace');
    await typeAtEnd(page, 'Light rain', ' Opened from the launcher.');
    await expect.poll(() => read(dir), { timeout: 10_000 }).toContain('Opened from the launcher.');

    // Menu → Join a shared host: back to the launcher; the embedded host stops and commits.
    await page.getByTestId('menu-button').click();
    await page.getByRole('button', { name: 'Join a shared host…' }).click();
    await expect(page.getByRole('button', { name: 'Open folder…' })).toBeVisible();
    expect(git(dir, 'status', '--porcelain')).toBe('');
    expect(git(dir, 'show', 'HEAD:notes.md')).toContain('Opened from the launcher.');

    await page.getByLabel('Host URL').fill(host.url);
    await page.getByLabel('Access token').fill('wrong');
    await page.getByRole('button', { name: 'Join' }).click();
    await expect(page.getByRole('alert')).toContainText('rejected the token');
    await page.getByLabel('Access token').fill(host.token);
    await page.getByRole('button', { name: 'Join' }).click();
    await openNotes(page);
    await expect(page).toHaveTitle(`notes.md · ${basename(shared)} · kuraa`);

    // Joined, not managed: Settings shows the host and token.
    await page.getByTestId('menu-button').click();
    await expect(page.getByLabel('Host URL')).toHaveValue(host.url);
  } finally {
    await app.close();
    await host.close();
  }
});

const PODMAN_RUNNING = (() => {
  const podman = findPodman();
  if (!podman) return false;
  try {
    execFileSync(podman, ['info'], { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
})();

test('runs R chunks in a Podman container by default', async () => {
  test.skip(!PODMAN_RUNNING, 'Podman is not installed and running');
  test.setTimeout(15 * 60_000); // the first run builds the R image
  const dir = makeRepo();
  writeFileSync(join(dir, 'analysis.Rmd'), '# Analysis\n\n```{r}\nx <- 21\nx * 2\n```\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'Analysis');
  const { app, page } = await launch(['--open', dir], { flushMs: 300, idleCommitMs: 1000, maxCommitMs: 10_000, dropMs: 1000 }, { KURAA_RUN_ENV: 'podman' });
  try {
    await page.getByTestId('file:analysis.Rmd').click();
    await expect(page.getByTestId('status')).toContainText('Connected');
    await page.locator('.code-node-code_chunk').getByRole('button', { name: '▶ Run' }).click();
    await expect(page.locator('.chunk-output')).toContainText('[1] 42', { timeout: 14 * 60_000 });
    await page.getByTestId('menu-button').click();
    await expect(page.getByTestId('r-state')).toHaveText('R ready · in a Podman container');
  } finally {
    await app.close();
  }
});
