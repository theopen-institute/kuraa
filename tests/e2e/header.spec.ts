// The header: not in the page, edited in its own dialog (right-click the file),
// shown as text in the Source view.
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHost, type RunningHost } from '../../packages/host/src/index.js';

const PAPER = '---\n# Set by the journal\ntitle: Old title\nauthor: Ada Lovelace\n---\n\n# Introduction\n\nThe text.\n';

async function ownHost(): Promise<{ host: RunningHost; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'kuraa-e2e-header-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Owner');
  git('config', 'user.email', 'owner@example.org');
  writeFileSync(join(dir, 'paper.md'), PAPER);
  writeFileSync(join(dir, 'plain.md'), '# Plain\n\nNo header.\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Initial');
  const host = await startHost({
    dir,
    staticDir: fileURLToPath(new URL('../../apps/web/dist', import.meta.url)),
    timings: { flushMs: 200, idleCommitMs: 1500, maxCommitMs: 10_000, dropMs: 1000 },
  });
  return { host, dir };
}

const onDisk = (dir: string, file: string) => () => readFileSync(join(dir, file), 'utf8');

async function openHeader(page: Page, file: string) {
  await page.getByTestId(`file:${file}`).click({ button: 'right' });
  await page.getByTestId('context:document-settings').click();
  await expect(page.getByTestId('header')).toBeVisible();
}

test('the header is edited in its dialog, not in the page', async ({ page }) => {
  const { host, dir } = await ownHost();
  try {
    await page.goto(`${host.url}/?token=${host.token}&name=Owner`);
    await page.getByTestId('file:paper.md').click();
    const editor = page.getByTestId('editor');
    await expect(editor).toContainText('Introduction');
    await expect(editor).not.toContainText('Old title');

    // Typing at the very start of the page goes into the text, not the header.
    await editor.getByText('Introduction').click();
    await page.keyboard.press('ControlOrMeta+ArrowUp');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Home');
    await page.keyboard.type('An ');
    await expect.poll(onDisk(dir, 'paper.md')).toContain('# An Introduction');
    expect(onDisk(dir, 'paper.md')()).toContain('---\n# Set by the journal\ntitle: Old title\nauthor: Ada Lovelace\n---');

    await openHeader(page, 'paper.md');
    const dialog = page.getByTestId('header');
    await expect(dialog.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Old title');
    await expect(dialog.getByRole('textbox', { name: 'Authors 1', exact: true })).toHaveValue('Ada Lovelace');
    await dialog.getByRole('textbox', { name: 'Title', exact: true }).fill('A better title: with a colon');
    // A second author: Enter starts the next one.
    await dialog.getByRole('textbox', { name: 'Authors 1', exact: true }).press('End');
    await dialog.getByRole('textbox', { name: 'Authors 1', exact: true }).press('Enter');
    await page.keyboard.type('Grace Hopper');
    // Pandoc's fields are offered by name.
    await dialog.getByTestId('header-add').click();
    await dialog.getByLabel('Search fields', { exact: true }).fill('bibliog');
    await dialog.getByTestId('header-add:bibliography').click();
    await page.keyboard.type('refs.bib');
    await dialog.getByTestId('header-add').click();
    await dialog.getByTestId('header-add:link-citations').click();
    await expect(dialog.getByTestId('header-field:link-citations').getByRole('checkbox')).toBeChecked();
    await dialog.getByTestId('header-save').click();
    await expect(dialog).toBeHidden();

    await expect.poll(onDisk(dir, 'paper.md')).toBe(
      '---\n# Set by the journal\ntitle: "A better title: with a colon"\nauthor:\n  - Ada Lovelace\n  - Grace Hopper\nbibliography:\n  - refs.bib\nlink-citations: true\n---\n\n# An Introduction\n\nThe text.\n',
    );
    await expect(editor).not.toContainText('better title');
    // The sidebar shows the document by its new title.
    await expect(page.getByTestId('file:paper.md')).toContainText('A better title: with a colon');

    // The Source view shows it as text.
    await page.getByTestId('menu-button').click();
    await page.getByTestId('menu-document').click();
    await page.getByTestId('toggle-source').click();
    await expect(page.locator('.source-view')).toContainText('title: "A better title: with a colon"');
  } finally {
    await host.close();
  }
});

test('a document needs a title; YAML that does not parse cannot be saved', async ({ page }) => {
  const { host, dir } = await ownHost();
  try {
    await page.goto(`${host.url}/?token=${host.token}&name=Owner`);
    await page.getByTestId('file:plain.md').click();
    await expect(page.getByTestId('editor')).toContainText('No header.');

    await openHeader(page, 'plain.md');
    const dialog = page.getByTestId('header');
    // Every document has a title: asked for first, and needed to save.
    await expect(dialog.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('');
    await expect(dialog.getByTestId('header-required')).toHaveText('A document needs a title.');
    await expect(dialog.getByTestId('header-save')).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Remove Title' })).toHaveCount(0);

    await dialog.getByTestId('header-yaml-tab').click();
    const yaml = dialog.getByTestId('header-yaml');
    await yaml.fill('title: [unclosed');
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(dialog.getByTestId('header-save')).toBeDisabled();
    await yaml.fill('lang: fr');
    await expect(dialog.getByRole('alert')).toHaveText('A document needs a title.');
    await expect(dialog.getByTestId('header-save')).toBeDisabled();
    await yaml.fill('title: Fresh\nlang: fr');
    await expect(dialog.getByTestId('header-save')).toBeEnabled();
    // Back to the fields: they are read from the YAML.
    await dialog.getByTestId('header-fields-tab').click();
    await expect(dialog.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Fresh');
    await expect(dialog.getByRole('combobox', { name: 'Language', exact: true })).toHaveValue('fr');
    await dialog.getByTestId('header-save').click();
    await expect.poll(onDisk(dir, 'plain.md')).toBe('---\ntitle: Fresh\nlang: fr\n---\n\n# Plain\n\nNo header.\n');
    // The sidebar shows the new title.
    await expect(page.getByTestId('file:plain.md')).toContainText('Fresh');

    // Other fields can be removed; the title stays.
    await page.getByTestId('menu-button').click();
    await page.getByTestId('menu-document').click();
    await dialog.getByRole('button', { name: 'Remove Language' }).click();
    await dialog.getByTestId('header-save').click();
    await expect.poll(onDisk(dir, 'plain.md')).toBe('---\ntitle: Fresh\n---\n\n# Plain\n\nNo header.\n');
  } finally {
    await host.close();
  }
});
