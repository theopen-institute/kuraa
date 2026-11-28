// Who can read what (0066): someone says only they and another can read a
// document; it stays on both their devices, marked with who reads it, and
// leaves the third person's. On a local DHT, so nothing leaves this machine.
import { expect, test, type Browser, type BrowserContext } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import createTestnet from 'hyperdht/testnet.js';
import { joinWorkspace, startHost } from '../../packages/host/src/index.js';
import { createPerson } from '../../packages/host/src/peers/person.js';
import { keptKey } from '../../packages/host/src/keys.js';
import { standardFeatures } from '../../packages/features/src/index.js';

// Contexts a test opens are closed when it ends: left open, each keeps a page connected to the host for the rest of the run.
const contexts: BrowserContext[] = [];
test.afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close().catch(() => undefined);
});
async function ownContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext();
  contexts.push(context);
  return context;
}

const STATIC = fileURLToPath(new URL('../../apps/web/dist', import.meta.url));
const TIMINGS = { flushMs: 200, idleCommitMs: 800, maxCommitMs: 10_000, dropMs: 1000 };

test('a document only two people read: on their devices, marked so, and gone from the third person’s', async ({ browser }) => {
  test.setTimeout(150_000);
  const testnet = await createTestnet(3);
  const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const dirA = mkdtempSync(join(tmpdir(), 'kuraa-e2e-spaces-a-'));
  git(dirA, 'init', '-q', '-b', 'main');
  git(dirA, 'config', 'user.name', 'Ada');
  git(dirA, 'config', 'user.email', 'ada@example.org');
  writeFileSync(join(dirA, 'notes.md'), '---\ntitle: Field notes\n---\n\nThe tide was out.\n');
  writeFileSync(join(dirA, 'plan.md'), '---\ntitle: The plan\n---\n\nThe surprise party is on Friday.\n');
  git(dirA, 'add', '-A');
  git(dirA, 'commit', '-q', '-m', 'Initial');
  const peers = { bootstrap: testnet.bootstrap as never };
  const keys = mkdtempSync(join(tmpdir(), 'kuraa-e2e-spaces-keys-'));
  const as = async (name: string) => ({ ...peers, person: await createPerson(name, join(keys, name, 'person.json')), signing: await keptKey(join(keys, name, 'signing.json')) });
  const asAda = await as('Ada');
  const a = await startHost({ features: standardFeatures, dir: dirA, staticDir: STATIC, timings: TIMINGS, peers: asAda, invites: { peers: asAda } });
  const joined = async (name: string) => {
    const who = await as(name);
    const dir = join(mkdtempSync(join(tmpdir(), `kuraa-e2e-spaces-${name}-`)), 'notes');
    await joinWorkspace({ dir, invitation: await a.host.peers!.inviteLink({ hours: 24, once: true }), name: `${name.toLowerCase()}-laptop`, bootstrap: peers.bootstrap, timeoutMs: 20_000, person: who.person, signing: who.signing });
    git(dir, 'config', 'user.name', name);
    git(dir, 'config', 'user.email', `${name.toLowerCase()}@example.org`);
    return { dir, h: await startHost({ features: standardFeatures, dir, staticDir: STATIC, timings: TIMINGS, peers: who, invites: { peers: who } }) };
  };
  const { h: b } = await joined('Bo');
  const { dir: dirC, h: c } = await joined('Cy');
  try {
    const open = async (h: typeof a, name: string) => {
      const page = await (await ownContext(browser)).newPage();
      await page.goto(`${h.url}/?token=${h.token}&name=${name}`);
      await expect(page.getByTestId('file:plan.md')).toBeVisible({ timeout: 20_000 });
      // A document open: news of files changed reaches the page through it.
      await page.getByTestId('file:notes.md').click();
      await expect(page.getByTestId('editor')).toContainText('The tide was out.');
      return page;
    };
    const ada = await open(a, 'Ada');
    const bo = await open(b, 'Bo');
    const cy = await open(c, 'Cy');
    await expect.poll(async () => (await a.host.peers!.people()).people.length, { timeout: 20_000 }).toBe(3);

    // Ada: only she and Bo can read the plan.
    await ada.getByTestId('file:plan.md').click();
    await expect(ada.getByTestId('editor')).toContainText('surprise party');
    await ada.getByTestId('document-menu-button').click();
    await ada.getByTestId('menu-permissions').click();
    const dialog = ada.getByTestId('permissions-dialog');
    await dialog.getByTestId('read-chosen').check();
    await dialog.getByTestId('read-person:Bo').check();
    await dialog.getByTestId('permissions-save').click();
    await expect(dialog).toBeHidden();
    await expect(ada.getByTestId('readers-line')).toContainText('Only you and Bo can read this document.');
    await expect(ada.getByTestId('readers:plan.md')).toBeVisible();

    // Bo still has it, marked with who reads it.
    await expect(bo.getByTestId('readers:plan.md')).toBeVisible({ timeout: 30_000 });
    await bo.getByTestId('file:plan.md').click();
    await expect(bo.getByTestId('editor')).toContainText('surprise party');
    await expect(bo.getByTestId('readers-line')).toContainText('Only you and Ada can read this document.');

    // Cy: gone, from the list and the folder.
    await expect(cy.getByTestId('file:plan.md')).toHaveCount(0, { timeout: 30_000 });
    expect(existsSync(join(dirC, 'plan.md'))).toBe(false);
    await expect(cy.getByTestId('file:notes.md')).toBeVisible();
  } finally {
    await c.close();
    await b.close();
    await a.close();
    await testnet.destroy();
  }
});

test('a folder’s permissions, from its right-click menu: only she reads it, and its files leave the other’s device', async ({ browser }) => {
  test.setTimeout(120_000);
  const testnet = await createTestnet(3);
  const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const dirA = mkdtempSync(join(tmpdir(), 'kuraa-e2e-folder-a-'));
  git(dirA, 'init', '-q', '-b', 'main');
  git(dirA, 'config', 'user.name', 'Ada');
  git(dirA, 'config', 'user.email', 'ada@example.org');
  writeFileSync(join(dirA, 'notes.md'), '---\ntitle: Field notes\n---\n\nThe tide was out.\n');
  mkdirSync(join(dirA, 'plans'));
  writeFileSync(join(dirA, 'plans', 'party.md'), '---\ntitle: The party\n---\n\nOn Friday.\n');
  git(dirA, 'add', '-A');
  git(dirA, 'commit', '-q', '-m', 'Initial');
  const peers = { bootstrap: testnet.bootstrap as never };
  const keys = mkdtempSync(join(tmpdir(), 'kuraa-e2e-folder-keys-'));
  const as = async (name: string) => ({ ...peers, person: await createPerson(name, join(keys, name, 'person.json')), signing: await keptKey(join(keys, name, 'signing.json')) });
  const asAda = await as('Ada');
  const a = await startHost({ features: standardFeatures, dir: dirA, staticDir: STATIC, timings: TIMINGS, peers: asAda, invites: { peers: asAda } });
  const asBo = await as('Bo');
  const dirB = join(mkdtempSync(join(tmpdir(), 'kuraa-e2e-folder-b-')), 'notes');
  await joinWorkspace({ dir: dirB, invitation: await a.host.peers!.inviteLink({ hours: 24, once: true }), name: 'bo-laptop', bootstrap: peers.bootstrap, timeoutMs: 20_000, person: asBo.person, signing: asBo.signing });
  const b = await startHost({ features: standardFeatures, dir: dirB, staticDir: STATIC, timings: TIMINGS, peers: asBo, invites: { peers: asBo } });
  try {
    const open = async (h: typeof a, name: string) => {
      const page = await (await ownContext(browser)).newPage();
      await page.goto(`${h.url}/?token=${h.token}&name=${name}`);
      await page.getByTestId('file:notes.md').click();
      await expect(page.getByTestId('editor')).toContainText('The tide was out.');
      return page;
    };
    const ada = await open(a, 'Ada');
    const bo = await open(b, 'Bo');
    await expect(bo.getByTestId('file:plans/party.md')).toBeVisible();
    await expect.poll(async () => (await a.host.peers!.people()).people.length, { timeout: 20_000 }).toBe(2);

    // Ada: plans/ is for the admins (she alone is one) to read, from its right-click menu. No one reads
    // something alone (0110): the owner reads everything, as the dialog says.
    await ada.getByTestId('folder:plans').click({ button: 'right' });
    await ada.getByTestId('context:folder-permissions').click();
    const dialog = ada.getByTestId('permissions-dialog');
    await expect(dialog).toContainText('Permissions for the folder plans');
    await expect(dialog.getByTestId('read-me')).toHaveCount(0);
    await expect(dialog.getByTestId('reads-everything')).toContainText('As the workspace’s owner, you read everything in it.');
    await dialog.getByTestId('read-chosen').check();
    await expect(dialog.getByTestId('groups-about')).toContainText('whoever its admins put in it');
    await dialog.getByTestId('read-person:Ada').check();
    await dialog.getByTestId('permissions-save').click();
    await expect(dialog).toContainText('Choose who reads it besides you');
    await dialog.getByTestId('read-person:Ada').uncheck();
    await dialog.getByTestId('read-group:The workspace’s admins').check();
    await dialog.getByTestId('permissions-save').click();
    await expect(dialog).toBeHidden();
    // Marked in her file list, the folder and its file.
    await expect(ada.getByTestId('readers:plans/')).toBeVisible({ timeout: 15_000 });
    await expect(ada.getByTestId('readers:plans/party.md')).toBeVisible();

    // Bo: the folder's file is gone from his list and his folder.
    await expect(bo.getByTestId('file:plans/party.md')).toHaveCount(0, { timeout: 30_000 });
    expect(existsSync(join(dirB, 'plans', 'party.md'))).toBe(false);
  } finally {
    await b.close();
    await a.close();
    await testnet.destroy();
  }
});
