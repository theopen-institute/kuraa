// Two devices of one workspace, each with its own host and a browser on it:
// people on the two edit one document live, the menu shows the devices, and work
// held for the upstream is accepted there. On a local DHT, so nothing leaves this
// machine.
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import createTestnet from 'hyperdht/testnet.js';
import { joinWorkspace, startHost } from '../../packages/host/src/index.js';

const STATIC = fileURLToPath(new URL('../../apps/web/dist', import.meta.url));
const TIMINGS = { flushMs: 200, idleCommitMs: 800, maxCommitMs: 10_000, dropMs: 1000 };

test('people on two devices edit one document, and the upstream accepts held work', async ({ browser }) => {
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
  const a = await startHost({ dir: dirA, staticDir: STATIC, timings: TIMINGS, peers });
  const dirB = join(mkdtempSync(join(tmpdir(), 'kuraa-e2e-dev-b-')), 'notes');
  await joinWorkspace({ dir: dirB, invitation: await a.host.peers!.invitation(), name: 'laptop', bootstrap: peers.bootstrap, timeoutMs: 20_000 });
  git(dirB, 'config', 'user.name', 'Bo');
  git(dirB, 'config', 'user.email', 'bo@example.org');
  const b = await startHost({ dir: dirB, staticDir: STATIC, timings: TIMINGS, peers });
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

    // The menu shows the devices.
    await ada.getByTestId('menu-button').click();
    await expect(ada.getByTestId('devices')).toContainText('1 of 1 other device connected');
    await expect(ada.getByTestId('device:laptop')).toContainText('connected');
    await ada.keyboard.press('Escape');

    // Ada's device becomes the upstream, with main gated: Bo's new file waits for it.
    git(dirA, 'config', 'kuraa.upstream', 'self');
    git(dirA, 'config', 'kuraa.gated', 'main');
    const res = await fetch(`${b.url}/api/files`, { method: 'POST', headers: { authorization: `Bearer ${b.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ path: 'idea.md', content: '---\ntitle: An idea\n---\n' }) });
    expect(res.status).toBe(201);
    await ada.getByTestId('menu-button').click();
    const proposal = ada.getByTestId('proposal:laptop/main');
    await expect(proposal).toContainText('Create idea.md', { timeout: 20_000 });
    await expect(ada.getByTestId('file:idea.md')).toHaveCount(0);
    await proposal.getByRole('button', { name: 'Accept' }).click();
    await expect(proposal).toHaveCount(0);
    await ada.keyboard.press('Escape');
    await expect(ada.getByTestId('file:idea.md')).toContainText('An idea');
  } finally {
    await b.close();
    await a.close();
    await testnet.destroy();
  }
});
