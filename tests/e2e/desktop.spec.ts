// M8: the Electron app opens a local folder, edits and commits; it can also join
// a shared host. The M5 checks run against the folder while other programs
// (plain file writes, git pull) change it.
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { startHost, type RunningHost } from '../../packages/host/src/index.js';
import { NOTES } from './env.js';
import { podmanWorks } from '../../packages/env-podman/src/index.js';
import { openSettings } from './settings.js';

const DESKTOP = resolve(import.meta.dirname, '../../apps/desktop');
const MAIN = join(DESKTOP, 'build/main.cjs');
const ELECTRON = createRequire(join(DESKTOP, 'package.json'))('electron') as unknown as string;
// KURAA_DESKTOP_APP=<the packaged app's executable> runs these against it instead,
// with no git on its PATH: it must use the git it ships.
const PACKAGED = process.env.KURAA_DESKTOP_APP;
const MAC = process.platform === 'darwin';

const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

/** A repository with notes.md; `shared`: a workspace shared between devices (as inviting someone makes it), which syncs. */
function makeRepo(shared = false): string {
  const dir = mkdtempSync(join(tmpdir(), 'kuraa-desktop-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Desk Top');
  git(dir, 'config', 'user.email', 'desk@example.org');
  if (shared) {
    git(dir, 'config', 'kuraa.workspace', randomBytes(16).toString('hex'));
    git(dir, 'config', 'kuraa.secret', randomBytes(32).toString('hex'));
  }
  writeFileSync(join(dir, 'notes.md'), NOTES);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'Initial');
  return dir;
}

async function launch(args: string[], timings: object, extraEnv: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page }> {
  // Each launch keeps its workspaces (and their list) in a folder of its own, never in Documents.
  const workspaces = mkdtempSync(join(tmpdir(), 'kuraa-desktop-workspaces-'));
  const app = await electron.launch({
    executablePath: PACKAGED ?? ELECTRON,
    args: [...(PACKAGED ? [] : [MAIN]), '--workspaces', workspaces, ...args],
    // VS Code's terminal sets ELECTRON_RUN_AS_NODE, which would start Electron as plain Node.
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE')) as Record<string, string>, KURAA_TIMINGS: JSON.stringify(timings),
      // Its preferences and list of workspaces, apart from the person's.
      KURAA_USER_DATA: mkdtempSync(join(tmpdir(), 'kuraa-desktop-data-')),
      // A person's key of its own (none yet), never that of whoever runs the tests.
      KURAA_PERSON: join(mkdtempSync(join(tmpdir(), 'kuraa-desktop-person-')), 'person.json'),
      // Out of sight, so the tests do not take the screen; KURAA_SHOW_WINDOWS=1 to watch them.
      ...(process.env.KURAA_SHOW_WINDOWS ? {} : { KURAA_HIDDEN_WINDOWS: '1' }),
      ...(PACKAGED ? { PATH: '/bin:/usr/sbin:/sbin' } : {}),
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
    await expect(page).toHaveTitle(`Field notes · ${basename(dir)} · kuraa`);

    // The connection comes through the preload bridge, so a reload keeps it.
    await page.reload();
    await openNotes(page);

    // The app manages this host: Settings has no host or token. Joining a shared server is not offered (only --join).
    await expect(page.getByRole('button', { name: /join a shared server/i })).toHaveCount(0);
    await openSettings(page);
    await page.getByTestId('settings-tab-you').click();
    await expect(page.getByTestId('settings-you').getByLabel('Your name')).toHaveValue('Desk Top');
    await expect(page.getByLabel('Server address')).toHaveCount(0);
    await page.getByTestId('settings-tab-server').click();
    await expect(page.getByTestId('preferences')).toBeVisible();
    await page.keyboard.press('Escape');
    // Opening a folder is one of the ways to add a workspace, as in a browser; the list of workspaces offers only that, apart.
    await page.getByTestId('workspace-switcher').click();
    await expect(page.getByTestId('workspace-open-folder')).toHaveCount(0);
    await page.getByTestId('workspace-add').click();
    await expect(page.getByTestId('add-workspace-folder')).toBeVisible();
    await page.keyboard.press('Escape');

    // New and Rename ask in in-app dialogs (Electron has no window.prompt).
    await page.getByRole('button', { name: 'New file', exact: true }).click();
    await expect(page.getByTestId('editor').locator('h1.doc-title')).toBeFocused();
    await page.keyboard.type('Day one');
    await expect(page.getByTestId('file:untitled.md')).toContainText('Day one');
    // Left: its filename is made from its title.
    await page.getByTestId('file:notes.md').click();
    await expect(page.getByTestId('file:day-one.md')).toContainText('Day one');
    await expect.poll(() => existsSync(join(dir, 'day-one.md'))).toBe(true);
    const row = page.locator('li.tree-file', { has: page.getByTestId('file:day-one.md') });
    await row.hover();
    await row.getByTitle('Rename').click();
    await page.getByTestId('rename').getByLabel('Title').fill('Day 1');
    await page.getByTestId('rename').getByRole('button', { name: 'Rename' }).click();
    await expect(page.getByTestId('file:day-1.md')).toContainText('Day 1');
    await expect.poll(() => existsSync(join(dir, 'day-1.md'))).toBe(true);
    expect(existsSync(join(dir, 'day-one.md'))).toBe(false);
    await openNotes(page);

    // Edit and commit.
    await typeAtEnd(page, 'The tide', ' Desktop edit.');
    await expect.poll(() => read(dir), { timeout: 10_000 }).toContain('when we arrived. Desktop edit.');
    await expect.poll(() => git(dir, 'show', 'HEAD:notes.md'), { timeout: 15_000 }).toContain('Desktop edit.');
    await page.getByTestId('document-menu-button').click();
    await expect(page.getByTestId('last-commit')).not.toContainText('—');
    // Escape closes the document's menu.
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
    await expect(page.getByTestId('notice')).toContainText('changed this file outside the app', { timeout: 10_000 });
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
      await expect(page).toHaveTitle(`Field notes · ${basename(dir)} · kuraa`);
      await typeAtEnd(page, 'Light rain', ' Joined from the desktop.');
      await expect.poll(() => read(dir), { timeout: 10_000 }).toContain('Light rain all morning. Joined from the desktop.');
      await expect.poll(() => git(dir, 'log', '-1', '--format=%s'), { timeout: 15_000 }).not.toBe('Initial');
      // Joined, not managed: Settings shows the server and access code.
      await openSettings(page);
      await page.getByTestId('settings-tab-you').click();
      await expect(page.getByLabel('Server address')).toHaveValue(host.url);
    } finally {
      await app.close();
    }
  } finally {
    await host.close();
  }
  expect(existsSync(join(dir, '.git'))).toBe(true);
});

test('opens a folder that is not yet a repository', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kuraa-plain-'));
  writeFileSync(join(dir, 'notes.md'), NOTES);
  const { app, page } = await launch([], { flushMs: 300, idleCommitMs: 1000, maxCommitMs: 10_000, dropMs: 1000 });
  try {
    // Native dialogs cannot be clicked from a test: answer them in the main process.
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog;
      dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox;
    }, dir);

    // It starts with its workspaces: none yet.
    await expect(page.getByTestId('no-workspace')).toContainText('No workspaces yet');
    // Open a folder…: the folder from the app's own dialog, then the page asks, as in a browser (decision 0047).
    await page.getByRole('button', { name: 'Open a folder…' }).click();
    await expect(page.getByTestId('ask')).toContainText(`Use “${basename(dir)}” as a workspace?`);
    await page.getByTestId('ask').getByRole('button', { name: 'Use this folder' }).click();
    await openNotes(page);
    await expect(page.getByTestId('workspace-name')).toHaveText(basename(dir));
    expect(git(dir, 'log', '--format=%s')).toBe('Initialise workspace');
    await typeAtEnd(page, 'Light rain', ' Opened from the launcher.');
    await expect.poll(() => read(dir), { timeout: 10_000 }).toContain('Opened from the launcher.');
  } finally {
    await app.close();
  }
});

const PODMAN_RUNNING = podmanWorks();

test('runs R chunks in a Podman container by default', async () => {
  test.skip(!PODMAN_RUNNING, 'Podman is not installed and running');
  test.setTimeout(15 * 60_000); // the first run builds the R image
  const dir = makeRepo();
  writeFileSync(join(dir, 'analysis.Rmd'), '# Analysis\n\n```{r}\nx <- 21\nx * 2\n```\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'Analysis');
  const { app, page } = await launch(['--open', dir], { flushMs: 300, idleCommitMs: 1000, maxCommitMs: 10_000, dropMs: 1000 });
  try {
    await page.getByTestId('file:analysis.Rmd').click();
    await expect(page.getByTestId('status')).toContainText('Connected');
    await page.locator('.code-node-code_chunk').getByRole('button', { name: '▶ Run' }).click();
    await expect(page.locator('.chunk-output')).toContainText('[1] 42', { timeout: 14 * 60_000 });
    await page.getByTestId('document-menu-button').click();
    await expect(page.getByTestId('r-state')).toHaveText('R ready · in a Podman container');
  } finally {
    await app.close();
  }
});

test('flags set what runs and which formats are on; the window shows only the app', async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, 'analysis.Rmd'), '# Analysis\n\n```{r}\n1 + 1\n```\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'An R Markdown file');
  const { app, page } = await launch(['--open', dir, '--engine', 'none', '--format', 'pandoc-markdown', '--format', 'text'], { flushMs: 300, idleCommitMs: 1000, maxCommitMs: 10_000, dropMs: 1000 });
  try {
    // R Markdown is off: the file opens as text; nothing runs.
    await page.getByTestId('file:analysis.Rmd').click();
    await expect(page.getByTestId('editor')).toHaveClass(/lines-doc/);
    await page.getByTestId('document-menu-button').click();
    await expect(page.getByTestId('r-state')).toHaveCount(0);
    await page.keyboard.press('Escape');
    // Settings › Server says what runs (decision 0064).
    await openSettings(page);
    await page.getByTestId('settings-tab-server').click();
    const components = page.getByTestId('settings-window');
    await expect(components.getByRole('checkbox', { name: 'R', exact: true })).not.toBeChecked();
    await expect(components.getByRole('checkbox', { name: 'R', exact: true })).toBeDisabled();
    await expect(components.getByRole('checkbox', { name: 'R Markdown', exact: true })).not.toBeChecked();
    await expect(components.getByRole('checkbox', { name: 'Pandoc markdown', exact: true })).toBeChecked();
    await page.keyboard.press('Escape');

    // Out of sight while testing: no window was shown.
    if (!process.env.KURAA_SHOW_WINDOWS) expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isVisible()))).toEqual([false]);

    // A page cannot take the window elsewhere, or open another.
    const home = page.url();
    await page.evaluate(() => {
      location.href = 'file:///etc/hosts';
    });
    await page.waitForTimeout(500);
    expect(page.url()).toBe(home);
    expect(await page.evaluate(() => window.open('file:///etc/hosts') === null)).toBe(true);
    expect(app.windows()).toHaveLength(1);
  } finally {
    await app.close();
  }
});

test('updates: says when one is ready, with Restart now; run from the repository, it does not look for them', async () => {
  const dir = makeRepo();
  const { app, page } = await launch(['--open', dir], { flushMs: 300, idleCommitMs: 1000, maxCommitMs: 10_000, dropMs: 1000 });
  try {
    await openNotes(page);
    // Check for Updates… in the app's menu opens its window, which says this copy does not update itself.
    const opened = app.waitForEvent('window');
    await app.evaluate(({ Menu }) => {
      const items = Menu.getApplicationMenu()!.items.flatMap((i) => i.submenu?.items ?? []);
      items.find((i) => i.label === 'Check for Updates…')!.click();
    });
    const updates = await opened;
    await expect(updates.locator('#message')).toHaveText('This copy of kuraa does not update itself (run from the repository).');
    await expect(updates.locator('#bar')).toBeHidden();
    // OK closes it.
    await updates.getByRole('button', { name: 'OK' }).click();
    await expect.poll(() => app.windows().length).toBe(1);
    // An update downloaded (as updates.ts tells the page): the page says so, with Restart now.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('kuraa:update-ready', '9.9.9'));
    await expect(page.getByTestId('notice')).toContainText('kuraa 9.9.9 is ready');
    await expect(page.getByTestId('update-restart')).toHaveText('Restart now');
  } finally {
    await app.close();
  }
});

/** Open Settings from the app's menu (⌥⌘,): the client's window, in the window, as in a browser (decision 0047). */
async function openPreferences(app: ElectronApplication, page: Page): Promise<Locator> {
  const item = await app.evaluate(({ Menu }) => {
    const items = Menu.getApplicationMenu()!.items.flatMap((i) => i.submenu?.items ?? []);
    const preferences = items.find((i) => i.label === 'Settings…')!;
    preferences.click();
    return { accelerator: preferences.accelerator };
  });
  expect(item.accelerator).toBe('CmdOrCtrl+Alt+,');
  // Settings, at the section last shown: this computer's server is its own section (decision 0064).
  await page.getByTestId('settings-tab-server').click();
  const prefs = page.getByTestId('preferences');
  await expect(prefs.getByTestId('pref-workspaces')).not.toHaveValue('');
  // No window of its own.
  expect(app.windows()).toHaveLength(1);
  return prefs;
}

test('preferences set what runs, apply at once, and are kept; a shared workspace syncs', async () => {
  const dir = makeRepo(true);
  const data = mkdtempSync(join(tmpdir(), 'kuraa-desktop-data-'));
  const timings = { flushMs: 300, idleCommitMs: 1000, maxCommitMs: 10_000, dropMs: 1000 };
  const rOn = async (page: Page) => {
    await openSettings(page);
    await page.getByTestId('settings-tab-you').click();
    await page.getByTestId('settings-tab-server').click();
    const on = await page.getByTestId('components-run').getByRole('checkbox', { name: 'R', exact: true }).isChecked();
    await page.keyboard.press('Escape');
    return on;
  };
  let { app, page } = await launch(['--open', dir], timings, { KURAA_USER_DATA: data });
  try {
    await expect(page.getByTestId('file:notes.md')).toBeVisible();
    expect(await rOn(page)).toBe(true);
    const prefs = await openPreferences(app, page);
    // Whether code can run here is said up front (Podman installed and running, or not).
    await expect(prefs.getByTestId('pref-environments')).not.toBeEmpty();
    await prefs.getByTestId('pref-run').uncheck();
    // Syncing is not a setting: the dialog says which workspaces sync (0048).
    await expect(prefs.getByTestId('pref-sync')).toContainText('invite link');
    // What a host takes as flags is here too (decision 0046): a value that is wrong is refused, saying what.
    await prefs.getByTestId('pref-run-advanced').locator('summary').click();
    await prefs.getByTestId('pref-memory').fill('lots');
    await page.getByTestId('settings-close').click();
    await expect(prefs.getByTestId('pref-error')).toContainText('memory limit should be a size');
    await prefs.getByTestId('pref-memory').fill('3g');
    await prefs.getByTestId('pref-format-rmarkdown').uncheck();
    // The hub reopens the workspaces with them (writing and committing first), and the page reloads.
    const reloaded = page.waitForEvent('load', { timeout: 15_000 });
    await page.getByTestId('settings-close').click();
    await reloaded;
    await expect(page.getByTestId('file:notes.md')).toBeVisible();
    expect(await rOn(page)).toBe(false);
    expect(JSON.parse(readFileSync(join(data, 'preferences.json'), 'utf8'))).toMatchObject({
      runCode: false, memory: '3g', formats: ['pandoc-markdown', 'text'],
    });
    // R Markdown is off now: Settings › Server says so.
    await openSettings(page);
    await page.getByTestId('settings-tab-you').click();
    await page.getByTestId('settings-tab-server').click();
    await expect(page.getByTestId('pref-format-rmarkdown')).not.toBeChecked();
    await expect(page.getByTestId('pref-format-pandoc-markdown')).toBeChecked();
    await page.keyboard.press('Escape');

    // The workspace is shared, so it syncs: git reaches other devices through git-remote-kuraa, which runs the app as Node.
    const helper = join(dir, '.git', 'kuraa', 'bin');
    await expect.poll(() => existsSync(join(helper, 'git-remote-kuraa'))).toBe(true);
    let answer = '';
    try {
      execFileSync('git', ['ls-remote', `kuraa://${'ab'.repeat(32)}`], { cwd: dir, env: { ...process.env, PATH: `${helper}:${process.env.PATH}`, ELECTRON_RUN_AS_NODE: '' }, stdio: 'pipe' });
    } catch (e) {
      answer = String((e as { stderr: Buffer }).stderr);
    }
    expect(answer).toContain('kuraa: the device abababab… is not connected');
  } finally {
    await app.close();
  }
  // Kept for next time.
  ({ app, page } = await launch(['--open', dir], timings, { KURAA_USER_DATA: data }));
  try {
    await expect(page.getByTestId('file:notes.md')).toBeVisible();
    expect(await rOn(page)).toBe(false);
    const prefs = await openPreferences(app, page);
    await expect(prefs.getByTestId('pref-run')).not.toBeChecked();
    await expect(prefs.getByTestId('pref-memory')).toHaveValue('3g');
    await expect(prefs.getByTestId('pref-format-rmarkdown')).not.toBeChecked();
    // The page's own ⌥⌘, opens it too (as in a browser), and Escape closes it.
    await page.keyboard.press('Escape');
    await expect(prefs).toHaveCount(0);
    await page.keyboard.press('ControlOrMeta+Alt+Comma');
    await expect(prefs.getByTestId('pref-run')).not.toBeChecked();
  } finally {
    await app.close();
  }
});

test('you on this computer: made from your name, said in each workspace that syncs, taken to another computer, and recovered', async () => {
  const dir = makeRepo(true);
  const timings = { flushMs: 300, idleCommitMs: 1000, maxCommitMs: 10_000, dropMs: 1000 };
  const person = join(mkdtempSync(join(tmpdir(), 'kuraa-desktop-person-')), 'person.json');
  let { app, page } = await launch(['--open', dir], timings, { KURAA_PERSON: person });
  let line: string;
  let recovery: string;
  try {
    await expect(page.getByTestId('file:notes.md')).toBeVisible();
    // Made without asking, from the name in Settings (git's, here), and said to the workspace's other devices.
    const name = () => {
      try {
        return (JSON.parse(readFileSync(person, 'utf8')) as { name: string }).name;
      } catch {
        return null;
      }
    };
    await expect.poll(name, { timeout: 15_000 }).toBe('Desk Top');
    const said = () => {
      try {
        return (JSON.parse(readFileSync(join(dir, '.git', 'kuraa', 'records.json'), 'utf8')) as { kind: string; name?: string }[]).some((r) => r.kind === 'vouch' && r.name === 'Desk Top');
      } catch {
        return false;
      }
    };
    await expect.poll(said, { timeout: 15_000 }).toBe(true);
    // Settings says so in plain words; copying it to another computer is in Sign in from another device.
    await openSettings(page);
    await page.getByTestId('settings-tab-you').click();
    const key = page.getByTestId('person-key');
    await expect(key.getByTestId('you-here')).toContainText('You on this computer: Desk Top');
    await page.getByTestId('open-sign-in').click();
    await key.getByTestId('person-copy').click();
    await expect(page.getByTestId('person-status')).toContainText('Copied');
    line = await app.evaluate(({ clipboard }) => clipboard.readText());
    expect(line).toMatch(/^kuraa-id:/);
    // Its recovery key, shown until it is saved elsewhere (on You, and in Account recovery); then removed from this computer (0066).
    await page.getByTestId('subpanel-back').click();
    const notice = key.getByTestId('person-recovery');
    await notice.getByTestId('recovery-copy').click();
    await expect(page.getByTestId('person-status')).toContainText('Keep it somewhere safe');
    recovery = await app.evaluate(({ clipboard }) => clipboard.readText());
    expect(recovery).toMatch(/^kuraa-recovery:/);
    await notice.getByTestId('recovery-saved').click();
    await expect(notice).toBeHidden();
    expect(existsSync(join(dirname(person), 'recovery.json'))).toBe(false);
  } finally {
    await app.close();
  }
  // Another computer (another key file), with an identity of its own made there: the first one's replaces it.
  const elsewhere = join(mkdtempSync(join(tmpdir(), 'kuraa-desktop-person-')), 'person.json');
  ({ app, page } = await launch(['--open', makeRepo()], timings, { KURAA_PERSON: elsewhere }));
  try {
    await expect(page.getByTestId('file:notes.md')).toBeVisible();
    await expect.poll(() => existsSync(elsewhere), { timeout: 15_000 }).toBe(true);
    await openSettings(page);
    await page.getByTestId('settings-tab-you').click();
    const key = page.getByTestId('person-key');
    await page.getByTestId('open-sign-in').click();
    await key.getByTestId('person-line').fill(line);
    await key.getByTestId('person-import').click();
    await expect(page.getByTestId('person-status')).toContainText('Your identity is here now');
    expect(JSON.parse(readFileSync(elsewhere, 'utf8')).publicKey).toBe(JSON.parse(readFileSync(person, 'utf8')).publicKey);
    await page.getByTestId('subpanel-back').click();
    await expect(key.getByTestId('you-here')).toContainText('You on this computer: Desk Top');
    // Account recovery: the recovery key, and trustees.
    await page.getByTestId('open-recovery').click();
    await expect(page.getByTestId('subpanel-title')).toHaveText('Account recovery');
    await expect(page.getByTestId('trustees')).toBeVisible();
    // The first computer is stolen: recovered here with the recovery key, the identity keeps its ID, with a new key.
    const before = JSON.parse(readFileSync(elsewhere, 'utf8')) as { id: string; publicKey: string };
    await key.getByTestId('recover-line').fill(recovery);
    await key.getByTestId('recover-check').click();
    await key.getByTestId('recover-confirm').getByTestId('recover').click();
    await expect(page.getByTestId('person-status')).toContainText('Your identity is recovered');
    const after = JSON.parse(readFileSync(elsewhere, 'utf8')) as { id: string; publicKey: string };
    expect(after.id).toBe(before.id);
    expect(after.publicKey).not.toBe(before.publicKey);
    // A new recovery key, to save.
    await expect(key.getByTestId('person-recovery')).toBeVisible();
  } finally {
    await app.close();
  }
});
