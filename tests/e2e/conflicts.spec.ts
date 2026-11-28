// Conflicts a merge kept: both versions in the page, who wrote each, and a way
// to choose; the sidebar counts them until they are settled.
import { expect, test } from '@playwright/test';
import { KEYS } from './env.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHost } from '../../packages/host/src/index.js';
import { standardFeatures } from '../../packages/features/src/index.js';

const version = (by: string, commit: string, text: string) => `::: {.version by="${by}" commit="${commit}"}\n${text}\n:::`;
const conflict = (a: string, b: string) => `:::: {.conflict}\n${version('Ada', '3f2c1e0', a)}\n\n${version('Bo', '9a41d7b', b)}\n::::`;
const DOC = `---\ntitle: Field notes\n---\n\n# Methods\n\n${conflict('Collected in spring.', 'Collected over two weeks in March.')}\n\nDried at 60 °C.\n\n${conflict('Ada counted.', 'Bo counted.')}\n`;

test('a conflict block shows both versions, and choosing settles it for everyone', async ({ browser }) => {
  const dir = mkdtempSync(join(tmpdir(), 'kuraa-e2e-conflicts-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Owner');
  git('config', 'user.email', 'owner@example.org');
  writeFileSync(join(dir, 'notes.md'), DOC);
  git('add', '-A');
  git('commit', '-q', '-m', 'Merged, with conflicts');
  const host = await startHost({ features: standardFeatures,
    dir,
    staticDir: fileURLToPath(new URL('../../apps/web/dist', import.meta.url)),
    timings: { flushMs: 200, idleCommitMs: 1500, maxCommitMs: 10_000, dropMs: 1000 },
  });
  const onDisk = () => readFileSync(join(dir, 'notes.md'), 'utf8');
  try {
    const open = async (name: string) => {
      const page = await (await browser.newContext()).newPage();
      await page.goto(`${host.url}/?token=${host.token}&name=${name}`);
      await page.getByTestId('file:notes.md').click();
      return page;
    };
    const ada = await open('Ada');
    const bo = await open('Bo');
    await expect(ada.getByTestId('conflicts:notes.md')).toHaveText('2 conflicts');

    const first = ada.getByTestId('conflict').first();
    await expect(first.getByTestId('conflict-version')).toHaveCount(2);
    await expect(first.getByTestId('conflict-version').nth(0)).toContainText('Ada · 3f2c1e0');
    await expect(first.getByTestId('conflict-version').nth(1)).toContainText('Collected over two weeks in March.');

    // The versions can be edited before choosing; the rest of the page as usual.
    await ada.getByText('Dried at 60 °C.').click();
    await ada.keyboard.press(KEYS.lineEnd);
    await ada.keyboard.type(' Then weighed.');

    // Keep Bo's version of the first.
    await first.getByTestId('conflict-version').nth(1).getByTestId('conflict-keep').click();
    await expect(ada.getByTestId('conflict')).toHaveCount(1);
    await expect(bo.getByTestId('conflict')).toHaveCount(1);
    await expect(ada.getByTestId('conflicts:notes.md')).toHaveText('1 conflict');
    // Keep both versions of the second, one after the other.
    await bo.getByTestId('conflict').getByTestId('conflict-keep-both').click();
    await expect(ada.getByTestId('conflict')).toHaveCount(0);
    await expect(ada.getByTestId('conflicts:notes.md')).toHaveCount(0);

    await expect.poll(onDisk).toBe('---\ntitle: Field notes\n---\n\n# Methods\n\nCollected over two weeks in March.\n\nDried at 60 °C. Then weighed.\n\nAda counted.\n\nBo counted.\n');
  } finally {
    await host.close();
  }
});
