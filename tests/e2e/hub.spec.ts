// A hub in the browser: no workspaces at first; one made from the app, another
// joined from a subscription link; switching between them.
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import createTestnet from 'hyperdht/testnet.js';
import { startHost, startHub } from '../../packages/host/src/index.js';

const STATIC = fileURLToPath(new URL('../../apps/web/dist', import.meta.url));
const TIMINGS = { flushMs: 200, idleCommitMs: 800, maxCommitMs: 10_000, dropMs: 1000 };

test('workspaces are added from the app: a new folder, or one joined from a link', async ({ page }) => {
  test.setTimeout(120_000);
  const testnet = await createTestnet(3);
  const peers = { bootstrap: testnet.bootstrap as never };
  // Someone else's workspace, to join.
  const theirs = mkdtempSync(join(tmpdir(), 'kuraa-e2e-hub-theirs-'));
  const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git(theirs, 'init', '-q', '-b', 'main');
  git(theirs, 'config', 'user.name', 'Bo');
  git(theirs, 'config', 'user.email', 'bo@example.org');
  writeFileSync(join(theirs, 'plan.md'), '---\ntitle: Survey plan\n---\n\nWalk the transect.\n');
  git(theirs, 'add', '-A');
  git(theirs, 'commit', '-q', '-m', 'Initial');
  const other = await startHost({ dir: theirs, timings: TIMINGS, peers });
  const link = await other.host.peers!.subscriptionLink(1);

  const root = mkdtempSync(join(tmpdir(), 'kuraa-e2e-hub-'));
  const hub = await startHub({ root, staticDir: STATIC, hosts: { timings: TIMINGS }, peers });
  try {
    await page.goto(`${hub.url}/?token=${hub.token}&name=Ada`);
    await expect(page.getByTestId('no-workspace')).toContainText('No workspaces yet');

    // A new one.
    await page.getByTestId('add-workspace-button').click();
    const dialog = page.getByTestId('add-workspace');
    await dialog.getByTestId('add-workspace-submit').click();
    await expect(dialog.getByRole('alert')).toContainText('Give the workspace a name');
    await dialog.getByTestId('add-workspace-name').fill('Field notes');
    await dialog.getByTestId('add-workspace-submit').click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('workspace-name')).toHaveText('Field notes');
    expect(existsSync(join(root, 'field-notes', '.git'))).toBe(true);
    await page.getByRole('button', { name: 'New file', exact: true }).click();
    await page.getByTestId('new-file').getByLabel('Title').fill('Day one');
    await page.getByTestId('new-file').getByRole('button', { name: 'Create' }).click();
    await expect(page.getByTestId('file:day-one.md')).toContainText('Day one');
    expect(existsSync(join(root, 'field-notes', 'day-one.md'))).toBe(true);

    // Another, joined from Bo's link.
    await page.getByTestId('workspace-switcher').click();
    await page.getByTestId('workspace-add').click();
    await dialog.getByTestId('add-workspace-join').click();
    await dialog.getByTestId('add-workspace-invitation').fill(link);
    await dialog.getByTestId('add-workspace-name').fill('Bo’s survey');
    await dialog.getByTestId('add-workspace-submit').click();
    await expect(dialog).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId('workspace-name')).toHaveText('Bo’s survey');
    await page.getByTestId('file:plan.md').click();
    await expect(page.getByTestId('editor')).toContainText('Walk the transect.');
    // It syncs: an edit here reaches Bo's copy.
    await page.getByTestId('editor').getByText('Walk the transect.').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Then the dunes.');
    await expect.poll(() => readFileSync(join(theirs, 'plan.md'), 'utf8'), { timeout: 30_000 }).toContain('Then the dunes.');

    // Switching back opens the first, as it was.
    await page.getByTestId('workspace-switcher').click();
    await page.getByTestId('workspace:field-notes').click();
    await expect(page.getByTestId('workspace-name')).toHaveText('Field notes');
    await expect(page.getByTestId('file:day-one.md')).toBeVisible();
    await expect(page.getByTestId('file:plan.md')).toHaveCount(0);
    // A reload stays in it.
    await page.reload();
    await expect(page.getByTestId('workspace-name')).toHaveText('Field notes');
  } finally {
    await hub.close();
    await other.close();
    await testnet.destroy();
  }
});
