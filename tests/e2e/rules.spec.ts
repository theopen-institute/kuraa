// Who can change what (0066): an admin says who may change a document, in
// Workspace settings; on another person's device it opens read only, saying
// who may, and they suggest a change instead; the admin sees the suggestion,
// compares it with the document, and accepts it, as her edit. On a local DHT.
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import createTestnet from 'hyperdht/testnet.js';
import { joinWorkspace, startHost } from '../../packages/host/src/index.js';
import { createPerson } from '../../packages/host/src/peers/person.js';
import { keptKey } from '../../packages/host/src/keys.js';

const STATIC = fileURLToPath(new URL('../../apps/web/dist', import.meta.url));
const TIMINGS = { flushMs: 200, idleCommitMs: 800, maxCommitMs: 10_000, dropMs: 1000 };

test('an admin says who can change a document; someone else suggests a change, and she accepts it', async ({ browser }) => {
  test.setTimeout(120_000);
  const testnet = await createTestnet(3);
  const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const dirA = mkdtempSync(join(tmpdir(), 'kuraa-e2e-rules-a-'));
  git(dirA, 'init', '-q', '-b', 'main');
  git(dirA, 'config', 'user.name', 'Ada');
  git(dirA, 'config', 'user.email', 'ada@example.org');
  writeFileSync(join(dirA, 'notes.md'), '---\ntitle: Field notes\n---\n\nThe tide was out.\n');
  git(dirA, 'add', '-A');
  git(dirA, 'commit', '-q', '-m', 'Initial');
  const peers = { bootstrap: testnet.bootstrap as never };
  const keys = mkdtempSync(join(tmpdir(), 'kuraa-e2e-rules-keys-'));
  const asAda = { ...peers, person: await createPerson('Ada', join(keys, 'ada', 'person.json')), signing: await keptKey(join(keys, 'ada', 'signing.json')) };
  const boPerson = await createPerson('Bo', join(keys, 'bo', 'person.json'));
  const asBo = { ...peers, person: boPerson, signing: await keptKey(join(keys, 'bo', 'signing.json')) };
  const a = await startHost({ dir: dirA, staticDir: STATIC, timings: TIMINGS, peers: asAda, invites: { peers: asAda } });
  const dirB = join(mkdtempSync(join(tmpdir(), 'kuraa-e2e-rules-b-')), 'notes');
  await joinWorkspace({ dir: dirB, invitation: await a.host.peers!.inviteLink({ hours: 24, once: true }), name: 'laptop', bootstrap: peers.bootstrap, timeoutMs: 20_000, person: boPerson, signing: asBo.signing });
  git(dirB, 'config', 'user.name', 'Bo');
  git(dirB, 'config', 'user.email', 'bo@example.org');
  const b = await startHost({ dir: dirB, staticDir: STATIC, timings: TIMINGS, peers: asBo, invites: { peers: asBo } });
  try {
    const open = async (h: typeof a, name: string) => {
      const page = await (await browser.newContext()).newPage();
      await page.goto(`${h.url}/?token=${h.token}&name=${name}`);
      await page.getByTestId('file:notes.md').click();
      await expect(page.getByTestId('editor')).toContainText('The tide was out.');
      return page;
    };
    const ada = await open(a, 'Ada');
    const bo = await open(b, 'Bo');
    await expect(bo.getByTestId('editor')).toHaveAttribute('contenteditable', 'true');

    // Ada, the workspace's admin: only she may change notes.md.
    await ada.getByTestId('settings-button').click();
    await ada.getByTestId('settings-tab-workspace').click();
    const rules = ada.getByTestId('rules');
    await expect(rules.getByTestId('permission:*')).toContainText('Anyone in the workspace can change it');
    await expect.poll(async () => (await a.host.peers!.people()).people.length, { timeout: 15_000 }).toBe(2);
    // Another file's permissions, from the overview: the same dialog as a document's.
    await rules.getByTestId('rule-path').fill('notes.md');
    await rules.getByTestId('rule-open').click();
    const perms = ada.getByTestId('permissions-dialog');
    await perms.getByTestId('write-me').check();
    await perms.getByTestId('permissions-save').click();
    await expect(perms).toBeHidden();
    // The overview lists it.
    await ada.getByTestId('settings-button').click();
    await ada.getByTestId('settings-tab-workspace').click();
    await expect(ada.getByTestId('rules').getByTestId('permission:notes.md')).toContainText('changed by Ada');
    await ada.keyboard.press('Escape');

    // On Bo's device: read only, saying who may change it.
    await expect(bo.getByTestId('read-only')).toContainText('Only Ada can change this document', { timeout: 20_000 });
    await expect(bo.getByTestId('editor')).toHaveAttribute('contenteditable', 'false');
    // He suggests a change instead.
    await bo.getByTestId('suggest').click();
    const dialog = bo.getByTestId('suggest-dialog');
    const text = await dialog.getByTestId('suggest-text').inputValue();
    await dialog.getByTestId('suggest-text').fill(text.replace('The tide was out.', 'The tide was out. Bo saw a heron.'));
    await dialog.getByTestId('suggest-send').click();
    await expect(dialog).toBeHidden();
    await expect(bo.getByTestId('editor')).not.toContainText('heron');
    expect(readFileSync(join(dirB, 'notes.md'), 'utf8')).not.toContain('heron');

    // Ada sees it, compares it with the document, and accepts it.
    await expect(ada.getByTestId('suggestions')).toContainText('1 suggestion', { timeout: 30_000 });
    await ada.getByTestId('suggestion:0').click();
    await expect(ada.getByTestId('suggestion-by')).toContainText('Suggested by Bo');
    await ada.getByTestId('compare-now').click();
    await expect(ada.getByTestId('compare-changed')).toContainText('heron');
    await ada.getByTestId('accept-suggestion').click();
    await ada.getByTestId('ask').getByRole('button', { name: 'Accept' }).click();
    await expect(ada.getByTestId('editor')).toContainText('Bo saw a heron.');
    await expect(ada.getByTestId('suggestions')).toHaveCount(0, { timeout: 15_000 });
    // It reaches Bo's device, as Ada's edit.
    await expect(bo.getByTestId('editor')).toContainText('Bo saw a heron.', { timeout: 20_000 });
  } finally {
    await b.close();
    await a.close();
    await testnet.destroy();
  }
});

test('from a document’s ⋯ menu: an admin says only she can change it; then back to what the workspace says', async ({ browser }) => {
  test.setTimeout(120_000);
  const testnet = await createTestnet(3);
  const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const dirA = mkdtempSync(join(tmpdir(), 'kuraa-e2e-perm-a-'));
  git(dirA, 'init', '-q', '-b', 'main');
  git(dirA, 'config', 'user.name', 'Ada');
  git(dirA, 'config', 'user.email', 'ada@example.org');
  writeFileSync(join(dirA, 'notes.md'), '---\ntitle: Field notes\n---\n\nThe tide was out.\n');
  git(dirA, 'add', '-A');
  git(dirA, 'commit', '-q', '-m', 'Initial');
  const peers = { bootstrap: testnet.bootstrap as never };
  const keys = mkdtempSync(join(tmpdir(), 'kuraa-e2e-perm-keys-'));
  const asAda = { ...peers, person: await createPerson('Ada', join(keys, 'ada', 'person.json')), signing: await keptKey(join(keys, 'ada', 'signing.json')) };
  const boPerson = await createPerson('Bo', join(keys, 'bo', 'person.json'));
  const asBo = { ...peers, person: boPerson, signing: await keptKey(join(keys, 'bo', 'signing.json')) };
  const a = await startHost({ dir: dirA, staticDir: STATIC, timings: TIMINGS, peers: asAda, invites: { peers: asAda } });
  const dirB = join(mkdtempSync(join(tmpdir(), 'kuraa-e2e-perm-b-')), 'notes');
  await joinWorkspace({ dir: dirB, invitation: await a.host.peers!.inviteLink({ hours: 24, once: true }), name: 'laptop', bootstrap: peers.bootstrap, timeoutMs: 20_000, person: boPerson, signing: asBo.signing });
  const b = await startHost({ dir: dirB, staticDir: STATIC, timings: TIMINGS, peers: asBo, invites: { peers: asBo } });
  try {
    const open = async (h: typeof a, name: string) => {
      const page = await (await browser.newContext()).newPage();
      await page.goto(`${h.url}/?token=${h.token}&name=${name}`);
      await page.getByTestId('file:notes.md').click();
      await expect(page.getByTestId('editor')).toContainText('The tide was out.');
      return page;
    };
    const ada = await open(a, 'Ada');
    const bo = await open(b, 'Bo');
    await expect.poll(async () => (await a.host.peers!.people()).people.length, { timeout: 20_000 }).toBe(2);

    // Ada, from the document's ⋯ menu: only she can change it.
    await ada.getByTestId('document-menu-button').click();
    await ada.getByTestId('menu-permissions').click();
    const dialog = ada.getByTestId('permissions-dialog');
    await expect(dialog.getByTestId('permissions-write')).toContainText('As its folder or the workspace says (anyone in the workspace)');
    await dialog.getByTestId('write-me').check();
    await dialog.getByTestId('permissions-save').click();
    await expect(dialog).toBeHidden();
    // Kept as a rule for the file, in the workspace's rules too.
    await expect.poll(async () => (await a.host.peers!.rules()).rules).toEqual([{ path: 'notes.md', by: [asAda.person.id] }]);

    // Bo: read only; his Permissions… says who can change it, and that admins say.
    await expect(bo.getByTestId('read-only')).toContainText('Only Ada can change this document', { timeout: 20_000 });
    await bo.getByTestId('document-menu-button').click();
    await bo.getByTestId('menu-permissions').click();
    const his = bo.getByTestId('permissions-dialog');
    await expect(his.getByTestId('writers-now')).toContainText('Ada, by the rule for notes.md');
    await expect(his).toContainText('Only the workspace’s admins say who can change what');
    await expect(his.getByTestId('write-me')).toHaveCount(0);
    await his.getByRole('button', { name: 'Cancel' }).click();

    // Ada sets it back: as the workspace says (no rule of its own). Bo can change it again.
    await ada.getByTestId('document-menu-button').click();
    await ada.getByTestId('menu-permissions').click();
    await dialog.getByTestId('write-inherit').check();
    await dialog.getByTestId('permissions-save').click();
    await expect(dialog).toBeHidden();
    await expect(bo.getByTestId('read-only')).toHaveCount(0, { timeout: 20_000 });
    await expect(bo.getByTestId('editor')).toHaveAttribute('contenteditable', 'true');
  } finally {
    await b.close();
    await a.close();
    await testnet.destroy();
  }
});
