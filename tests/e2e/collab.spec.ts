// M2: two browser pages type into the same paragraph at once, converge to the
// same text, and show each other's cursors. Also checks, through the real UI,
// that the host writes the file (M3) and the history panel shows the commit (M4).
import { expect, test, type Browser, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E, NOTES } from './env.js';

const PARAGRAPH = 'The tide was already on the turn when we arrived.';

/** A fresh file per run, so the test does not depend on earlier runs against the same host. */
async function createNotes(): Promise<string> {
  const path = `runs/notes-${Date.now().toString(36)}.md`;
  const res = await fetch(`${E2E.url}/api/files`, {
    method: 'POST',
    headers: { authorization: `Bearer ${E2E.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ path, content: NOTES }),
  });
  expect(res.status).toBe(201);
  return path;
}

async function open(browser: Browser, name: string, email: string, path: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error(`[${name}] page error: ${e.message}`));
  await page.goto(`/?token=${E2E.token}&name=${encodeURIComponent(name)}&email=${encodeURIComponent(email)}`);
  await page.getByTestId(`file:${path}`).click();
  await expect(page.getByTestId('editor')).toBeVisible();
  await expect(page.getByTestId('status')).toContainText('Connected');
  return page;
}

const MAC = process.platform === 'darwin';

/** Put the caret at the start or end of the paragraph that starts with `text`. */
async function caretIn(page: Page, text: string, where: 'start' | 'end'): Promise<void> {
  await page.getByTestId('editor').locator('p', { hasText: text }).click();
  const key = where === 'end' ? (MAC ? 'Meta+ArrowRight' : 'End') : MAC ? 'Meta+ArrowLeft' : 'Home';
  await page.keyboard.press(key);
  await page.waitForTimeout(100); // see desktop.spec.ts typeAtEnd
}

test('two browsers co-edit one paragraph and see each other', async ({ browser }) => {
  const path = await createNotes();
  const alice = await open(browser, 'Alice Ng', 'alice@example.org', path);
  const bob = await open(browser, 'Bob Ferreira', 'bob@example.org', path);

  // Presence: each sees both people.
  for (const page of [alice, bob]) {
    await expect(page.getByTestId('peers')).toContainText('Alice Ng');
    await expect(page.getByTestId('peers')).toContainText('Bob Ferreira');
  }

  // Same paragraph, different places. (Two carets at exactly the same position
  // interleave keystrokes, as in other Yjs editors; the text still converges.)
  await caretIn(alice, 'The tide', 'end');
  await caretIn(bob, 'The tide', 'start');

  // Type at the same time, into the same paragraph.
  await Promise.all([
    alice.keyboard.type(' Alice saw herons.', { delay: 25 }),
    bob.keyboard.type('Bob counted crabs. ', { delay: 25 }),
  ]);

  const paragraph = (page: Page) => page.getByTestId('editor').locator('p', { hasText: 'turn when we arrived' });
  const expected = `Bob counted crabs. ${PARAGRAPH} Alice saw herons.`;
  for (const page of [alice, bob]) {
    await expect(paragraph(page)).toContainText('Alice saw herons.');
    await expect(paragraph(page)).toContainText('Bob counted crabs.');
  }
  // Converged: the text (without the other person's cursor label) is identical on both pages.
  const text = (page: Page) => paragraph(page).evaluate((p) => {
    const clone = p.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('.ProseMirror-yjs-cursor').forEach((c) => c.remove());
    return clone.textContent;
  });
  await expect.poll(() => text(alice)).toBe(expected);
  await expect.poll(() => text(bob)).toBe(expected);

  // Cursors: each page shows the other person's caret, labelled with their name.
  await expect(alice.locator('.ProseMirror-yjs-cursor', { hasText: 'Bob Ferreira' })).toBeVisible();
  await expect(bob.locator('.ProseMirror-yjs-cursor', { hasText: 'Alice Ng' })).toBeVisible();

  // M3 through the UI: the file on disk catches up, and untouched blocks are byte-identical.
  const file = join(E2E.dir, path);
  await expect.poll(() => readFileSync(file, 'utf8'), { timeout: 10_000 }).toContain('Bob counted crabs.');
  const onDisk = readFileSync(file, 'utf8');
  expect(onDisk).toContain('Alice saw herons.');
  const untouched = NOTES.split('\n\n').filter((block) => !block.includes(PARAGRAPH));
  expect(onDisk).toContain(`\n${expected}\n`);
  for (const block of untouched) expect(onDisk).toContain(block);
  await alice.getByTestId('document-menu-button').click();
  await expect(alice.getByTestId('last-flush')).not.toContainText('—');

  // M4 through the UI: the idle commit appears in the history panel with both people.
  // The panel starts closed.
  await expect(alice.getByTestId('last-commit')).not.toContainText('—', { timeout: 15_000 });
  await expect(alice.getByTestId('history')).toHaveCount(0);
  await alice.getByTestId('document-menu').getByRole('button', { name: 'History' }).click();
  const latest = alice.getByTestId('history').locator('li').first();
  await expect(latest).toContainText('Alice Ng');
  await expect(latest).toContainText('Bob Ferreira');

  // The earlier version opens read-only.
  await alice.getByTestId('history').locator('li').last().click();
  await expect(alice.getByTestId('past-version')).toContainText(PARAGRAPH);
  await expect(alice.getByTestId('past-version')).not.toContainText('Alice saw herons.');
});
