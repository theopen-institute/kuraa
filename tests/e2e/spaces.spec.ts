// Who can read what (0066): someone says only they and another can read a
// document; it stays on both their devices, marked with who reads it, and
// leaves the third person's. On a local DHT, so nothing leaves this machine.
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import createTestnet from 'hyperdht/testnet.js';
import { joinWorkspace, startHost } from '../../packages/host/src/index.js';
import { createPerson } from '../../packages/host/src/peers/person.js';
import { keptKey } from '../../packages/host/src/keys.js';

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
  const a = await startHost({ dir: dirA, staticDir: STATIC, timings: TIMINGS, peers: asAda, invites: { peers: asAda } });
  const joined = async (name: string) => {
    const who = await as(name);
    const dir = join(mkdtempSync(join(tmpdir(), `kuraa-e2e-spaces-${name}-`)), 'notes');
    await joinWorkspace({ dir, invitation: await a.host.peers!.inviteLink({ hours: 24, once: true }), name: `${name.toLowerCase()}-laptop`, bootstrap: peers.bootstrap, timeoutMs: 20_000, person: who.person, signing: who.signing });
    git(dir, 'config', 'user.name', name);
    git(dir, 'config', 'user.email', `${name.toLowerCase()}@example.org`);
    return { dir, h: await startHost({ dir, staticDir: STATIC, timings: TIMINGS, peers: who, invites: { peers: who } }) };
  };
  const { h: b } = await joined('Bo');
  const { dir: dirC, h: c } = await joined('Cy');
  try {
    const open = async (h: typeof a, name: string) => {
      const page = await (await browser.newContext()).newPage();
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
    await ada.getByTestId('menu-readers').click();
    const dialog = ada.getByTestId('readers-dialog');
    await dialog.getByTestId('readers-chosen').check();
    await dialog.getByTestId('readers-person:Bo').check();
    await dialog.getByTestId('readers-save').click();
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
