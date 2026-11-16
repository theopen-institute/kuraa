// `pnpm dev`: one command gives a working client with no settings to enter, the
// host behind Vite's proxy, and a clean stop on Ctrl+C.
import { expect, test } from '@playwright/test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { NOTES } from './env.js';

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

    // The dev server supplies the host, so Settings has no host or token.
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByLabel('Host URL')).toHaveCount(0);
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
