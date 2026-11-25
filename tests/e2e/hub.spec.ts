// A hub in the browser: no workspaces at first; one made from the app, another
// joined from an invite link; switching between them.
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import createTestnet from 'hyperdht/testnet.js';
import { startHost, startHub } from '../../packages/host/src/index.js';
import { openSettings } from './settings.js';

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
  // Named by Bo, who made it (0061): whoever joins sees this name.
  mkdirSync(join(theirs, '.kuraa'));
  writeFileSync(join(theirs, '.kuraa', 'workspace.json'), '{"name":"Bo’s survey"}\n');
  git(theirs, 'add', '-A');
  git(theirs, 'commit', '-q', '-m', 'Initial');
  const other = await startHost({ dir: theirs, timings: TIMINGS, peers });
  const link = await other.host.peers!.inviteLink({ hours: 1, once: true });

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
    await expect(page.getByTestId('editor').locator('h1.doc-title')).toBeFocused();
    await page.keyboard.type('Day one');
    await expect(page.locator('[data-testid^="file:untitled-"]')).toContainText('Day one');
    expect(readdirSync(join(root, 'field-notes')).some((f) => /^untitled-[a-z0-9]{5}\.md$/.test(f))).toBe(true);

    // Another, joined from Bo's link.
    await page.getByTestId('workspace-switcher').click();
    await page.getByTestId('workspace-add').click();
    await dialog.getByTestId('add-workspace-join').click();
    await dialog.getByTestId('add-workspace-invitation').fill(link);
    // Nobody joining names it: it is called what it calls itself.
    await expect(dialog.getByTestId('add-workspace-name')).toHaveCount(0);
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

    // Renamed here, in Workspace settings, for everyone: Bo's copy takes the new name.
    await openSettings(page);
    await page.getByTestId('settings-tab-workspace').click();
    await page.getByTestId('menu-rename-workspace').click();
    await expect(page.getByTestId('ask').locator('input')).toHaveValue('Bo’s survey');
    await page.getByTestId('ask').locator('input').fill('Dune survey');
    await page.getByTestId('ask').getByRole('button', { name: 'Rename' }).click();
    await expect(page.getByTestId('notice')).toContainText('Renamed the workspace “Dune survey”, for everyone in it.');
    // Settings says the new name too, and stays open until closed.
    await expect(page.getByTestId('settings-workspace-name')).toHaveText('Dune survey');
    await page.getByTestId('settings-close').click();
    await expect(page.getByTestId('workspace-name')).toHaveText('Dune survey');
    await expect.poll(() => other.host.sharedName, { timeout: 30_000 }).toBe('Dune survey');
    // Renamed on Bo's device: the page says so, in the list of workspaces too.
    await other.host.rename('Dune and shore survey');
    await expect(page.getByTestId('workspace-name')).toHaveText('Dune and shore survey', { timeout: 30_000 });
    await page.getByTestId('workspace-switcher').click();
    await expect(page.getByTestId('workspace:shared-workspace')).toContainText('Dune and shore survey');
    await page.keyboard.press('Escape');

    // Switching back opens the first, as it was.
    await page.getByTestId('workspace-switcher').click();
    await page.getByTestId('workspace:field-notes').click();
    await expect(page.getByTestId('workspace-name')).toHaveText('Field notes');
    // The new document kept its name: it was left for another workspace, not for a file beside it.
    await expect(page.locator('[data-testid^="file:untitled-"]')).toContainText('Day one');
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

test('joining says how it is going: looking, a slow network, copying; and why it failed', async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), 'kuraa-e2e-hub-'));
  const hub = await startHub({ root, staticDir: STATIC, hosts: { timings: TIMINGS } });
  // The hub's answers, as the test sets them: a join that goes on until let go.
  let status: object | null = null;
  const asked = new Set<string>();
  await page.route('**/hub/api/joins/*', (route) => {
    asked.add(new URL(route.request().url()).pathname.split('/').pop()!);
    return status ? route.fulfill({ json: status }) : route.fulfill({ status: 404, json: { error: 'none' } });
  });
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let progress = '';
  await page.route('**/hub/api/workspaces', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    progress = (route.request().postDataJSON() as { progress: string }).progress;
    await released;
    return route.fulfill({ status: 400, json: { error: 'Could not reach a device of the workspace: is one running, with syncing on?' } });
  });
  try {
    await page.goto(`${hub.url}/?token=${hub.token}&name=Ada`);
    await page.getByTestId('add-workspace-button').click();
    const dialog = page.getByTestId('add-workspace');
    await dialog.getByTestId('add-workspace-join').click();
    await dialog.getByTestId('add-workspace-invitation').fill('kuraa-invite:test');
    await dialog.getByTestId('add-workspace-submit').click();
    const shown = dialog.getByTestId('add-workspace-progress');
    await expect(shown).toContainText('Looking for a computer the workspace is on…');
    status = { step: 'looking', slowNetwork: true };
    await expect(dialog.getByTestId('add-workspace-slow')).toContainText('take a few tries');
    status = { step: 'copying', slowNetwork: false, from: 'bo' };
    await expect(shown).toContainText('Copying the workspace from bo…');
    await expect(dialog.getByTestId('add-workspace-slow')).toHaveCount(0);
    // It asked by the id it gave the join.
    expect(progress).toMatch(/^[0-9a-f]{24}$/);
    expect([...asked]).toEqual([progress]);
    release();
    await expect(dialog.getByRole('alert')).toContainText('Could not reach a device');
    await expect(shown).toHaveCount(0);
  } finally {
    release();
    await hub.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('people are invited from the app: a link for anyone, joined elsewhere, then revoked', async ({ page }) => {
  test.setTimeout(120_000);
  const testnet = await createTestnet(3);
  const peers = { bootstrap: testnet.bootstrap as never };
  const mine = await startHub({ root: mkdtempSync(join(tmpdir(), 'kuraa-e2e-inv-a-')), staticDir: STATIC, hosts: { timings: TIMINGS }, peers });
  const theirs = await startHub({ root: mkdtempSync(join(tmpdir(), 'kuraa-e2e-inv-b-')), hosts: { timings: TIMINGS }, peers });
  const hubCall = (h: typeof mine, path: string, body?: object) =>
    fetch(h.url + path, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${h.token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  try {
    await hubCall(mine, '/hub/api/workspaces', { kind: 'new', name: 'Field notes' });
    await page.goto(`${mine.url}/?token=${mine.token}&name=Ada`);
    await expect(page.getByTestId('workspace-name')).toHaveText('Field notes');

    // On this device only, so far: Workspace settings offer to invite people.
    await openSettings(page);
    await page.getByTestId('settings-tab-workspace').click();
    await expect(page.getByTestId('devices')).toContainText('on this computer only');
    await page.getByTestId('invite-button').click();
    const dialog = page.getByTestId('invite');
    await expect(dialog).toContainText('Making one turns on syncing');
    // As a member, unless the link says admin (0066).
    await expect(dialog).toContainText('they can read and change everything');
    await dialog.getByTestId('invite-admin').check();
    await expect(dialog).toContainText('the same say as you');
    await dialog.getByTestId('invite-anyone').click();
    await dialog.getByTestId('invite-expiry').selectOption({ label: 'in a day' });
    await dialog.getByTestId('invite-create').click();
    const code = await dialog.getByTestId('invite-code').inputValue();
    expect(code).toMatch(/^kuraa-invite:/);
    await expect(dialog.getByTestId('invite-links').locator('li')).toHaveCount(1);

    // Someone joins with it, on their own hub.
    const joined = await hubCall(theirs, '/hub/api/workspaces', { kind: 'join', invitation: code, name: 'Ada’s notes' });
    expect(joined.status).toBe(201);

    // Revoked here: it lets no one else in.
    await dialog.getByTestId('invite-links').getByRole('button', { name: 'Revoke' }).click();
    await expect(dialog.getByTestId('invite-links')).toContainText('revoked');
    await dialog.getByRole('button', { name: 'Done' }).click();
    const late = await hubCall(theirs, '/hub/api/workspaces', { kind: 'join', invitation: code, name: 'Too late' });
    expect(late.status).toBe(400);

    // Workspace settings now show the device that joined.
    await openSettings(page);
    await page.getByTestId('settings-tab-workspace').click();
    await expect(page.getByTestId('devices')).toContainText('1 of 1 other device online');
  } finally {
    await theirs.close();
    await mine.close();
    await testnet.destroy();
  }
});

test('a workspace whose folder is gone is listed as such, and taken off the list from it', async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), 'kuraa-e2e-gone-'));
  const first = await startHub({ root, hosts: { timings: TIMINGS } });
  const add = (name: string) => fetch(`${first.url}/hub/api/workspaces`, {
    method: 'POST', headers: { authorization: `Bearer ${first.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'new', name }),
  });
  expect((await add('Kept')).status).toBe(201);
  expect((await add('Gone')).status).toBe(201);
  await first.close();
  rmSync(join(root, 'gone'), { recursive: true, force: true });
  const hub = await startHub({ root, token: first.token, staticDir: STATIC, hosts: { timings: TIMINGS } });
  try {
    await page.goto(`${hub.url}/?token=${hub.token}&name=Ada`);
    await page.getByTestId('workspace-switcher').click();
    await page.getByTestId('workspace:gone').click();
    await page.getByRole('button', { name: 'Remove' }).click();
    await page.getByTestId('workspace-switcher').click();
    await expect(page.getByTestId('workspace:kept')).toBeVisible();
    await expect(page.getByTestId('workspace:gone')).toHaveCount(0);
    expect(JSON.parse(readFileSync(join(root, '.kuraa-workspaces.json'), 'utf8')).map((w: { id: string }) => w.id)).toEqual(['kept']);
  } finally {
    await hub.close();
  }
});
