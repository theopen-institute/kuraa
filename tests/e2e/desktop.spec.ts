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

async function launch(args: string[], timings: object): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    executablePath: ELECTRON,
    args: [MAIN, ...args],
    // VS Code's terminal sets ELECTRON_RUN_AS_NODE, which would start Electron as plain Node.
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE')) as Record<string, string>, KURAA_TIMINGS: JSON.stringify(timings) },
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

    // New and Rename ask in an in-app dialog (Electron has no window.prompt).
    await page.getByRole('button', { name: /New/ }).click();
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
    await expect(page.getByTestId('last-commit')).not.toContainText('—');

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
    await expect(page.getByTestId('status')).toContainText('conflicting outside edit', { timeout: 10_000 });
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
