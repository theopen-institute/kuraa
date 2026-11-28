// Past versions: labelled by date and people (the commit behind Details),
// compared with the document now, and restored as an edit that everyone sees
// and that can be undone.
import { expect, test, type Browser, type Page, type BrowserContext } from '@playwright/test';
import { E2E, NOTES } from './env.js';

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

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const api = (path: string, init: RequestInit = {}) =>
  fetch(`${E2E.url}${path}`, { ...init, headers: { authorization: `Bearer ${E2E.token}`, 'content-type': 'application/json' } });

async function open(browser: Browser, name: string, path: string): Promise<Page> {
  const page = await (await ownContext(browser)).newPage();
  await page.goto(`/?token=${E2E.token}&name=${name}&email=${name.toLowerCase()}%40example.org`);
  await page.getByTestId(`file:${path}`).click();
  await expect(page.getByTestId('status')).toContainText('Connected');
  return page;
}

test('a past version is compared with now, and restored as an edit everyone sees and can undo', async ({ browser }) => {
  const path = `runs/versions-${Date.now().toString(36)}.md`;
  expect((await api('/api/files', { method: 'POST', body: JSON.stringify({ path, content: NOTES }) })).status).toBe(201);
  const ada = await open(browser, 'Ada', path);
  const bo = await open(browser, 'Bo', path);

  // An edit, committed after a moment without typing.
  await ada.getByTestId('editor').locator('p', { hasText: 'Light rain' }).click();
  await ada.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
  await ada.keyboard.type(' Clearer by noon.');
  await expect(ada.getByTestId('editor')).toContainText('Clearer by noon.');
  await expect.poll(async () => (await (await api(`/api/history?path=${encodeURIComponent(path)}`)).json() as { commits: unknown[] }).commits.length, { timeout: 15_000 }).toBe(2);

  await ada.getByTestId('document-menu-button').click();
  await ada.getByTestId('document-menu').getByRole('menuitemcheckbox', { name: 'History' }).click();
  const entries = ada.getByTestId('history').locator('li');
  await expect(entries).toHaveCount(2);
  // People and times, not commit ids.
  await expect(entries.first()).toContainText('Ada');
  await expect(ada.getByTestId('history')).not.toContainText(/\b[0-9a-f]{7}\b/);
  await entries.last().click();
  const past = ada.getByTestId('past-version');
  await expect(past).toContainText('Light rain all morning.');
  await expect(past.getByTestId('past-hash')).toBeHidden();
  await past.getByText('Details').click();
  await expect(past.getByTestId('past-hash')).toBeVisible();
  await past.getByText('Details').click();

  // Compared with now: the paragraph that changed, with the words added marked.
  await past.getByTestId('compare-now').click();
  const changed = past.getByTestId('compare-changed');
  await expect(changed).toHaveCount(1);
  await expect(changed.locator('ins')).toContainText('Clearer by noon');
  await expect(changed).toContainText('Light rain all morning.');
  await past.getByTestId('compare-now').click();
  await expect(past.getByTestId('compare')).toHaveCount(0);

  // Restored, after saying what it does; Bo sees it.
  await past.getByTestId('restore-version').click();
  await expect(ada.getByTestId('ask')).toContainText('Everyone editing it will see the change');
  await ada.getByTestId('ask').getByRole('button', { name: 'Restore' }).click();
  await expect(past).toHaveCount(0);
  await expect(ada.getByTestId('notice')).toContainText('Restored the version of');
  await expect(ada.getByTestId('editor')).not.toContainText('Clearer by noon.');
  await expect(bo.getByTestId('editor')).not.toContainText('Clearer by noon.');
  await expect.poll(async () => (await api(`/api/files?path=${encodeURIComponent(path)}`)).text(), { timeout: 10_000 }).toBe(NOTES);

  // An edit like any other: undo brings the newer text back.
  await ada.getByTestId('editor').locator('h1:not(.doc-title)').click();
  await ada.keyboard.press(`${MOD}+z`);
  await expect(ada.getByTestId('editor')).toContainText('Clearer by noon.');
  await expect(bo.getByTestId('editor')).toContainText('Clearer by noon.');
});
