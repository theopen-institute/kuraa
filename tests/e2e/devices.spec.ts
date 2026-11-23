// Two devices of one workspace, each with its own host and a browser on it:
// people on the two edit one document live; Workspace settings list the
// devices and the people, and the person who joined last, a member, may not
// remove anyone until the first makes them an admin (0066); then they rename
// their device and remove the first. On a local DHT, so nothing leaves this machine.
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
import { sign, signRecord, signsMessage, vouchMessage } from '../../packages/host/src/peers/records.js';
import { openSettings } from './settings.js';

const STATIC = fileURLToPath(new URL('../../apps/web/dist', import.meta.url));
const TIMINGS = { flushMs: 200, idleCommitMs: 800, maxCommitMs: 10_000, dropMs: 1000 };

test('people on two devices edit one document; a member made owner renames their device and removes another', async ({ browser }) => {
  test.setTimeout(120_000);
  const testnet = await createTestnet(3);
  const dirA = mkdtempSync(join(tmpdir(), 'kuraa-e2e-dev-a-'));
  const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git(dirA, 'init', '-q', '-b', 'main');
  git(dirA, 'config', 'user.name', 'Ada');
  git(dirA, 'config', 'user.email', 'ada@example.org');
  writeFileSync(join(dirA, 'notes.md'), '---\ntitle: Field notes\n---\n\nThe tide was out.\n');
  git(dirA, 'add', '-A');
  git(dirA, 'commit', '-q', '-m', 'Initial');
  const peers = { bootstrap: testnet.bootstrap as never };
  // Two people, each on a computer of their own: their own identity and signing key.
  const keys = mkdtempSync(join(tmpdir(), 'kuraa-e2e-dev-keys-'));
  const adaPerson = await createPerson('Ada', join(keys, 'ada', 'person.json'));
  const boPerson = await createPerson('Bo', join(keys, 'bo', 'person.json'));
  const asAda = { ...peers, person: adaPerson, signing: await keptKey(join(keys, 'ada', 'signing.json')) };
  const asBo = { ...peers, person: boPerson, signing: await keptKey(join(keys, 'bo', 'signing.json')) };
  const a = await startHost({ dir: dirA, staticDir: STATIC, timings: TIMINGS, peers: asAda, invites: { peers: asAda } });
  const dirB = join(mkdtempSync(join(tmpdir(), 'kuraa-e2e-dev-b-')), 'notes');
  // Invited as a member (as links do, unless they say admin).
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

    // Typing on one device appears on the other.
    await ada.getByTestId('editor').getByText('The tide was out.').click();
    await ada.keyboard.press('End');
    await ada.keyboard.type(' Ada was here.');
    await expect(bo.getByTestId('editor')).toContainText('The tide was out. Ada was here.', { timeout: 20_000 });
    await bo.getByTestId('editor').getByText('Ada was here.').click();
    await bo.keyboard.press('End');
    await bo.keyboard.type(' So was Bo.');
    await expect(bo.getByTestId('editor')).toContainText('Ada was here. So was Bo.');
    await expect(ada.getByTestId('editor')).toContainText('Ada was here. So was Bo.', { timeout: 20_000 });
    await expect.poll(() => readFileSync(join(dirA, 'notes.md'), 'utf8'), { timeout: 20_000 }).toContain('Ada was here. So was Bo.');
    await expect.poll(() => git(dirA, 'rev-parse', 'HEAD') === git(dirB, 'rev-parse', 'HEAD') && git(dirB, 'status', '--porcelain') === '', { timeout: 20_000 }).toBe(true);

    // Workspace settings list the devices, in plain words: online or offline, no keys or branches.
    await openSettings(ada);
    await ada.getByTestId('settings-tab-workspace').click();
    await expect(ada.getByTestId('devices')).toContainText('1 of 1 other device online');
    await expect(ada.getByTestId('device:laptop')).toContainText('online');
    await expect(ada.getByTestId('devices')).not.toContainText(/[0-9a-f]{8}/);
    // A device Ada's cannot reach, which the laptop says it is connected to: online, through the laptop.
    // Bo's phone (0072: a device is in as its person is): its own key, which Bo's identity vouches for.
    const phoneDevice = await keptKey(join(keys, 'phone', 'device.json'));
    const phoneKey = await keptKey(join(keys, 'phone', 'signing.json'));
    const phone = phoneDevice.publicKey.toString('hex');
    const hexOf = (k: { publicKey: Buffer }) => k.publicKey.toString('hex');
    const vouch = vouchMessage(hexOf(phoneKey), boPerson.id, 'Bo');
    await a.host.peers!.node.identity.takeRecords([
      signRecord({ kind: 'signs', workspace: git(dirA, 'config', 'kuraa.workspace'), subject: hexOf(phoneKey), proof: sign(signsMessage(phone), phoneKey), name: 'phone' }, phoneDevice),
      signRecord({ kind: 'vouch', workspace: git(dirA, 'config', 'kuraa.workspace'), subject: hexOf(phoneKey), person: boPerson.id, personKey: hexOf(boPerson), name: 'Bo', proof: sign(vouch, boPerson), keyProof: sign(vouch, phoneKey) }, phoneDevice),
    ]);
    b.host.peers!.node.links.get(a.host.peers!.node.myKey)!.send({ type: 'present', keys: [phone] });
    await expect(ada.getByTestId('through:phone')).toHaveText(/^online, through .*laptop$/, { timeout: 10_000 });
    await expect(ada.getByTestId('devices')).toContainText('2 of 2 other devices online');
    // The people, with their roles: Ada, who made the workspace, its owner; Bo, invited, a member.
    await expect(ada.getByTestId('role:Ada')).toHaveText('owner');
    await expect(ada.getByTestId('role:Bo')).toHaveText('member', { timeout: 15_000 });

    // On Bo's device: a member, he may rename his device, but not invite or remove anyone.
    await openSettings(bo);
    await bo.getByTestId('settings-tab-workspace').click();
    await expect(bo.getByTestId('not-admin')).toContainText('Only the workspace’s admins');
    await expect(bo.getByTestId('invite-button')).toHaveCount(0);
    await expect(bo.getByTestId('devices').getByRole('button', { name: 'Lost or no longer used…' })).toHaveCount(0);

    // Ada makes him an admin, then the owner, giving up the role (she stays an admin: 0070).
    await ada.getByTestId('make-admin:Bo').click();
    await expect(ada.getByTestId('role:Bo')).toHaveText('admin');
    await ada.getByTestId('make-owner:Bo').click();
    await expect(ada.getByTestId('ask')).toContainText('You give up the role');
    await ada.getByTestId('ask').getByRole('button', { name: 'Make owner' }).click();
    await expect(ada.getByTestId('role:Bo')).toHaveText('owner');
    await expect(ada.getByTestId('role:Ada')).toHaveText('admin');
    await expect(ada.getByTestId('make-member:Bo')).toHaveCount(0);
    await ada.keyboard.press('Escape');

    // Bo, the owner now: rename his device, then remove Ada's (an admin's: the owner's to remove). It is permanent, and she keeps her copy.
    await expect(bo.getByTestId('role:Bo')).toHaveText('owner', { timeout: 15_000 });
    await expect(bo.getByTestId('invite-button')).toBeVisible();
    await bo.getByTestId('rename-device').click();
    await bo.getByTestId('ask').locator('input').fill('Bo’s laptop');
    await bo.getByTestId('ask').getByRole('button', { name: 'Rename' }).click();
    await expect(bo.getByTestId('this-device')).toContainText('You are on bo-s-laptop');
    const adas = bo.getByTestId('person:Ada').locator('li[data-testid^="device:"]');
    await expect(adas).toHaveCount(1);
    await adas.getByRole('button', { name: 'Lost or no longer used…' }).click();
    await expect(bo.getByTestId('ask')).toContainText('permanent');
    await expect(bo.getByTestId('ask')).toContainText('keeps their copy');
    await bo.getByTestId('ask').getByRole('button', { name: 'Remove' }).click();
    // Her computer is out (0072: its key dropped); she is still in the workspace, and the removal is listed.
    await expect(adas).toHaveCount(0, { timeout: 20_000 });
    await expect(bo.getByTestId('removals')).toContainText('A computer of Ada’s removed by Bo');
    // Ada's device learns it, and stops syncing; her files stay as they were.
    await expect.poll(async () => (await a.host.peers!.status()).removed, { timeout: 20_000 }).toBe(true);
    // Her Devices section says so, and offers nothing the others would refuse.
    await openSettings(ada);
    await ada.getByTestId('settings-tab-workspace').click();
    await expect(ada.getByTestId('device-removed')).toContainText('removed from the workspace', { timeout: 10_000 });
    await expect(ada.getByTestId('invite-button')).toHaveCount(0);
    await expect(ada.getByTestId('devices').getByRole('button', { name: 'Lost or no longer used…' })).toHaveCount(0);
    await ada.keyboard.press('Escape');
    expect(readFileSync(join(dirA, 'notes.md'), 'utf8')).toContain('Ada was here. So was Bo.');
  } finally {
    await b.close();
    await a.close();
    await testnet.destroy();
  }
});
