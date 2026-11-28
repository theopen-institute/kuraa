// The Tauri app (decision 0127), as the Electron app is tested (desktop.spec.ts):
// what the shell does, around the web client the browser tests cover (WebKit's
// among them, which is this app's webview on a Mac). It opens a folder and keeps
// what is written, through a reload and quitting; joins a shared host; opens
// folders with the system's dialog, from the page and from its launcher; renders
// with the pandoc and Typst it carries, and saves what it renders where the person
// says; takes the Electron app's flags; shows only its own pages; says how
// updating stands; keeps its preferences where the Electron app keeps them; runs
// git-remote-kuraa with the Node it carries; makes you from your name; asks the
// system's spell checker.
//
// Driven through tauri-app.ts (the build `pnpm --filter @kuraa/tauri build:test`
// makes, which beforeAll makes unless KURAA_TAURI_BUILT=1), on macOS, Windows and
// Linux (where a display is needed: xvfb-run in CI, and in apps/tauri/scripts/test-linux.mjs).
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, join, resolve } from 'node:path';
import { startHost, type RunningHost } from '../../packages/host/src/index.js';
import { standardFeatures } from '../../packages/features/src/index.js';
import { NOTES } from './env.js';
import { APP_PAGES, launchTauri, TAURI_NODE, type Launched } from './tauri-app.js';

test.describe.configure({ mode: 'serial' });

const ROOT = resolve(import.meta.dirname, '../..');
const TIMINGS = { flushMs: 300, idleCommitMs: 1000, maxCommitMs: 10_000, dropMs: 1000 };
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const read = (dir: string, file = 'notes.md') => readFileSync(join(dir, file), 'utf8');

test.beforeAll(() => {
  test.setTimeout(20 * 60_000);
  if (process.env.KURAA_TAURI_BUILT !== '1') execFileSync('pnpm', ['--filter', '@kuraa/tauri', 'build:test'], { cwd: ROOT, stdio: 'inherit' });
});

/** A repository with notes.md; `shared`: a workspace shared between devices (as inviting someone makes it), which syncs. */
function makeRepo(shared = false): string {
  const dir = mkdtempSync(join(tmpdir(), 'kuraa-tauri-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Desk Top');
  git(dir, 'config', 'user.email', 'desk@example.org');
  if (shared) {
    git(dir, 'config', 'kuraa.workspace', randomBytes(16).toString('hex'));
    git(dir, 'config', 'kuraa.secret', randomBytes(32).toString('hex'));
  }
  writeFileSync(join(dir, 'notes.md'), NOTES);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'Initial');
  return dir;
}

// What the page is asked, in its own terms: elements by test id, controls by their labels.
const PRELUDE = `
  const $t = (id) => document.querySelector('[data-testid="' + id + '"]');
  const byText = (selector, text) => [...document.querySelectorAll(selector)].find((e) => e.textContent.trim() === text);
  const byLabel = (text) => { const l = [...document.querySelectorAll('label')].find((l) => l.textContent.trim().startsWith(text)); return l ? (l.control ?? l.querySelector('input, select, textarea')) : null; };
  const shown = (e) => !!e && e.getClientRects().length > 0;
`;
const inPage = (body: string) => `(async () => { ${PRELUDE} ${body} })()`;

/** Click an element (by test id) once it is there. */
async function click(app: Launched, testid: string): Promise<void> {
  await app.waitFor(inPage(`const e = $t(${JSON.stringify(testid)}); if (!shown(e)) return false; e.click(); return true;`));
}

/** Click a button by its text once it is there. */
async function clickButton(app: Launched, text: string, within = 'body'): Promise<void> {
  await app.waitFor(inPage(`const e = byText(${JSON.stringify(`${within} button`)}, ${JSON.stringify(text)}); if (!shown(e)) return false; e.click(); return true;`));
}

/** A button of the launcher (the app's own page), once it shows: the window says its address as it starts going there. */
async function clickLauncher(app: Launched, id: string): Promise<void> {
  await app.waitFor(`(() => { const b = (location.protocol === 'tauri:' || location.hostname === 'tauri.localhost') && document.getElementById(${JSON.stringify(id)}); if (!b) return false; b.click(); return true; })()`);
}

const textOf = (app: Launched, testid: string) => app.evaluate<string>(inPage(`return $t(${JSON.stringify(testid)})?.textContent ?? '';`));

async function pressEscape(app: Launched): Promise<void> {
  await app.evaluate(`(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })), true`);
}

async function openNotes(app: Launched): Promise<void> {
  await click(app, 'file:notes.md');
  await app.waitFor(inPage(`return shown($t('editor')) && ($t('status')?.textContent ?? '').includes('Connected');`), { timeout: 20_000 });
}

async function openSettings(app: Launched): Promise<void> {
  await click(app, 'workspace-switcher');
  await click(app, 'workspace-settings');
}

/** Type at the end of the paragraph that has `paragraph` in it, as the system would put typed text in. */
async function typeAtEnd(app: Launched, paragraph: string, text: string): Promise<void> {
  // Its text may show a moment after the editor says it is connected.
  await app.waitFor(inPage(`return [...document.querySelectorAll('[data-testid="editor"] p')].some((p) => p.textContent.includes(${JSON.stringify(paragraph)}));`));
  await app.evaluate(
    inPage(`
      const p = [...document.querySelectorAll('[data-testid="editor"] p')].find((p) => p.textContent.includes(${JSON.stringify(paragraph)}));
      if (!p) throw new Error('no paragraph with ${paragraph}');
      p.closest('[contenteditable="true"]').focus();
      const r = document.createRange();
      r.selectNodeContents(p);
      r.collapse(false);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      // ProseMirror reads a moved caret from selectionchange a moment later.
      await new Promise((d) => setTimeout(d, 150));
      document.execCommand('insertText', false, ${JSON.stringify(text)});
      return true;
    `),
  );
}

test('opens a local folder, edits and commits; a reload keeps the connection; quitting commits what is pending', async () => {
  const dir = makeRepo();
  // A long flush interval keeps the last edit pending when the app quits.
  const app = await launchTauri({ args: ['--open', dir], timings: { flushMs: 1500, idleCommitMs: 2500, maxCommitMs: 20_000, dropMs: 1000 } });
  let quit = false;
  try {
    await openNotes(app);
    // The window's title is the page's.
    await expect.poll(() => app.title()).toBe(`Field notes · ${basename(dir)} · Kuraa`);
    // Its connection is not in its address (taken from it at once), and a reload keeps it.
    expect(await app.url()).not.toContain('token');
    expect(await app.url()).not.toContain('kuraa-config');
    await app.evaluate(`(window.__beforeReload = true)`);
    await app.menu('reload');
    await app.waitFor(`!window.__beforeReload && document.readyState === 'complete'`);
    await openNotes(app);

    // The app manages this host: Settings has your name (git's) and no host or access code.
    await openSettings(app);
    await click(app, 'settings-tab-you');
    await app.waitFor(inPage(`return byLabel('Your name')?.value === 'Desk Top';`));
    expect(await app.evaluate(inPage(`return byLabel('Host address') === null;`))).toBe(true);
    await click(app, 'settings-tab-host');
    await app.waitFor(inPage(`return shown($t('preferences'));`));
    await pressEscape(app);

    // Edit and commit.
    await typeAtEnd(app, 'The tide', ' Desktop edit.');
    await expect.poll(() => read(dir), { timeout: 10_000 }).toContain('when we arrived. Desktop edit.');
    await expect.poll(() => git(dir, 'show', 'HEAD:notes.md'), { timeout: 15_000 }).toContain('Desktop edit.');

    // Another program edits the file: the editor shows it.
    writeFileSync(join(dir, 'notes.md'), read(dir).replace('Light rain all morning.', 'Heavy rain all morning.'));
    await app.waitFor(inPage(`return $t('editor').textContent.includes('Heavy rain all morning.');`));

    // Typed just before quitting: written and committed as it quits.
    await typeAtEnd(app, 'Mateus', ' Last words.');
    await app.quit();
    quit = true;
    expect(read(dir)).toContain('Last words.');
    expect(git(dir, 'status', '--porcelain', '--', 'notes.md')).toBe('');
    // What the hub said, it kept in its log too, with the app's data.
    expect(app.output()).toContain('[desktop] hub http://127.0.0.1:');
  } finally {
    if (!quit) await app.quit();
  }
});

test('closing the window quits, saying so, with the last edits saved (0131)', async () => {
  const dir = makeRepo();
  // No commit before quitting: closing commits the last edits.
  const app = await launchTauri({ args: ['--open', dir], timings: { flushMs: 300, idleCommitMs: 60_000, maxCommitMs: 60_000, dropMs: 60_000 } });
  try {
    await openNotes(app);
    await typeAtEnd(app, 'Light rain', ' Typed just before closing.');
    await expect.poll(() => read(dir), { timeout: 10_000 }).toContain('Typed just before closing.');
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('Initial');
    // The window closed (its close button), not Quit: the app quits all the same, the window saying so meanwhile.
    await app.close();
  } finally {
    await app.quit();
  }
  expect(app.output()).toContain('[tauri] closing: the window says so');
  expect(git(dir, 'status', '--porcelain', '--', 'notes.md')).toBe('');
  expect(git(dir, 'show', 'HEAD:notes.md')).toContain('Typed just before closing.');
});

test('joins a shared host without starting one, showing its own pages', async () => {
  const dir = makeRepo();
  const host: RunningHost = await startHost({ features: standardFeatures, dir, port: 0, host: '127.0.0.1', staticDir: join(ROOT, 'apps/web/dist'), timings: TIMINGS });
  try {
    const app = await launchTauri({ args: ['--join', host.url, '--token', host.token] });
    try {
      await openNotes(app);
      expect(new URL(await app.url()).origin).toBe(host.url);
      await expect.poll(() => app.title()).toBe(`Field notes · ${basename(dir)} · Kuraa`);
      await typeAtEnd(app, 'Light rain', ' Joined from the desktop.');
      await expect.poll(() => read(dir), { timeout: 10_000 }).toContain('Light rain all morning. Joined from the desktop.');
      // Joined, not managed: Settings shows the host and access code.
      await openSettings(app);
      await click(app, 'settings-tab-you');
      await app.waitFor(inPage(`return byLabel('Host address')?.value === ${JSON.stringify(host.url)};`));
      await pressEscape(app);
      // Its page is not this app's code: it may not pick folders, join elsewhere, or restart the app.
      expect(await app.evaluate(`typeof window.kuraa.chooseFolder`)).toBe('undefined');
      expect(await app.evaluate(`window.kuraa.join('http://127.0.0.1:1', 'x').then(() => 'joined', (e) => 'refused: ' + e)`)).toMatch(/^refused/);
      expect(app.output()).not.toContain('[desktop] hub http');
    } finally {
      await app.quit();
    }
  } finally {
    await host.close();
  }
});

test('opens folders with the system’s dialog: from the page, from the menu, and from the launcher', async () => {
  const plain = mkdtempSync(join(tmpdir(), 'kuraa-plain-'));
  writeFileSync(join(plain, 'notes.md'), NOTES);
  const app = await launchTauri({ timings: TIMINGS });
  try {
    // It starts with its workspaces: none yet.
    await app.waitFor(inPage(`return ($t('no-workspace')?.textContent ?? '').includes('No workspaces yet');`), { timeout: 20_000 });
    // Open a folder…: the folder from the system's dialog, then the page asks, as in a browser (decision 0047).
    await app.answerFolder(plain);
    await clickButton(app, 'Open a folder…');
    await app.waitFor(inPage(`return ($t('ask')?.textContent ?? '').includes(${JSON.stringify(`Use “${basename(plain)}” as a workspace?`)});`));
    await clickButton(app, 'Use this folder', '[data-testid="ask"]');
    await openNotes(app);
    await app.waitFor(inPage(`return $t('workspace-name')?.textContent.trim() === ${JSON.stringify(basename(plain))};`));
    expect(git(plain, 'log', '--format=%s')).toBe('Initialise workspace');
    await typeAtEnd(app, 'Light rain', ' Opened with the dialog.');
    await expect.poll(() => read(plain), { timeout: 10_000 }).toContain('Opened with the dialog.');

    // File › Open Folder… (⌘O): the page does it, through the hub, with the system's dialog.
    const repo = makeRepo();
    await app.answerFolder(repo);
    await app.menu('open');
    await app.waitFor(inPage(`return $t('workspace-name')?.textContent.trim() === ${JSON.stringify(basename(repo))};`));

    // Leaving goes to the launcher, this app's hub stopped; its Open folder… asks with the system's own question.
    await app.evaluate(`window.kuraa.leave(), true`);
    await expect.poll(() => app.url()).toBe(`${APP_PAGES}launcher.html`);
    await expect.poll(() => app.title()).toBe('Kuraa');
    const another = mkdtempSync(join(tmpdir(), 'kuraa-plain-'));
    writeFileSync(join(another, 'notes.md'), NOTES);
    await app.answerFolder(another);
    await app.answerConfirm(`Use “${basename(another)}”`, true);
    await clickLauncher(app, 'open');
    await openNotes(app);
    expect(await app.asked()).toContain(`Use “${basename(another)}” as a workspace?`);
    await app.waitFor(inPage(`return $t('workspace-name')?.textContent.trim() === ${JSON.stringify(basename(another))};`));
    expect(git(another, 'log', '--format=%s')).toBe('Initialise workspace');
    // Declined: nothing is added, and the launcher stays.
    await app.evaluate(`window.kuraa.leave(), true`);
    await expect.poll(() => app.url()).toBe(`${APP_PAGES}launcher.html`);
    const declined = mkdtempSync(join(tmpdir(), 'kuraa-plain-'));
    await app.answerFolder(declined);
    await app.answerConfirm(`Use “${basename(declined)}”`, false);
    await clickLauncher(app, 'open');
    await expect.poll(async () => (await app.asked()).includes(`Use “${basename(declined)}” as a workspace?`)).toBe(true);
    expect(existsSync(join(declined, '.git'))).toBe(false);
    expect(await app.url()).toBe(`${APP_PAGES}launcher.html`);
    // Your workspaces, from the launcher: all three.
    await clickLauncher(app, 'home');
    await click(app, 'workspace-switcher');
    for (const d of [plain, repo, another]) await app.waitFor(inPage(`return document.body.textContent.includes(${JSON.stringify(basename(d))});`));
  } finally {
    await app.quit();
  }
});

test('renders with the pandoc and Typst it carries, and saves what it renders where the person says', async () => {
  const dir = makeRepo();
  // Only its own copies: the computer's cache pointed at nothing.
  const app = await launchTauri({ args: ['--open', dir, '--engine', 'none'], timings: TIMINGS, env: { KURAA_RENDER_TOOLS: mkdtempSync(join(tmpdir(), 'kuraa-no-render-tools-')) } });
  try {
    await openNotes(app);
    await click(app, 'document-menu-button');
    await click(app, 'menu-export');
    await app.waitFor(inPage(`return ($t('render-status')?.textContent ?? '').includes('Rendered to HTML.');`), { timeout: 60_000 });
    // Shown in a sandboxed frame (no script of the page's reaches it): what it was given.
    await app.waitFor(inPage(`return ($t('render-frame')?.srcdoc ?? '').includes('Field notes');`));
    // Saved as HTML…: the system's save dialog says where (answered here), and the file is there.
    const saved = join(mkdtempSync(join(tmpdir(), 'kuraa-saved-')), 'notes.html');
    await app.answerSave(saved);
    await click(app, 'save-html');
    await expect.poll(() => existsSync(saved), { timeout: 30_000 }).toBe(true);
    expect(readFileSync(saved, 'utf8')).toContain('Field notes');
  } finally {
    await app.quit();
  }
});

test('flags set what runs and which formats are on; the window shows only the app', async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, 'analysis.Rmd'), '# Analysis\n\n```{r}\n1 + 1\n```\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'An R Markdown file');
  const app = await launchTauri({ args: ['--open', dir, '--engine', 'none', '--format', 'pandoc-markdown', '--format', 'text'], timings: TIMINGS });
  try {
    // R Markdown is off: the file opens as text; nothing runs.
    await click(app, 'file:analysis.Rmd');
    await app.waitFor(inPage(`return $t('editor')?.classList.contains('lines-doc');`));
    await click(app, 'document-menu-button');
    expect(await app.evaluate(inPage(`return $t('r-state') === null;`))).toBe(true);
    await pressEscape(app);

    // A page cannot take the window elsewhere, or open another.
    const home = await app.url();
    await app.evaluate(`(location.href = 'file:///etc/hosts'), true`);
    await new Promise((r) => setTimeout(r, 500));
    expect(await app.url()).toBe(home);
    expect(await app.evaluate(`window.open('file:///etc/hosts') === null`)).toBe(true);
    expect(await app.windows()).toEqual(['main']);
    // Out of sight while testing: no window was shown.
    if (!process.env.KURAA_SHOW_WINDOWS) expect(await app.evaluate(`document.visibilityState`)).toBe('hidden');
  } finally {
    await app.quit();
  }
});

test('updates: Check for Updates… says this copy does not update itself; a ready update shows Restart now', async () => {
  const dir = makeRepo();
  const app = await launchTauri({ args: ['--open', dir], timings: TIMINGS });
  try {
    await openNotes(app);
    await app.menu('updates');
    await expect.poll(() => app.windows()).toContain('updates');
    await app.waitFor(`document.getElementById('message')?.textContent === 'This copy of Kuraa does not update itself (built without a place to look for updates (KURAA_UPDATES)).'`, { window: 'updates' });
    expect(await app.evaluate(`document.getElementById('bar').hidden`, 'updates')).toBe(true);
    // OK closes it.
    // Pressed a moment later: the window it closes would not answer.
    await app.evaluate(`setTimeout(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'OK').click(), 50), true`, 'updates');
    await expect.poll(() => app.windows()).toEqual(['main']);
    // An update downloaded (as updates.rs tells the page): the page says so, with Restart now.
    await app.emit('update-ready', '9.9.9');
    await app.waitFor(inPage(`return ($t('notice')?.textContent ?? '').includes('Kuraa 9.9.9 is ready');`));
    expect((await textOf(app, 'update-restart')).trim()).toBe('Restart now');
  } finally {
    await app.quit();
  }
});

test('preferences, from the menu, apply at once and are kept where the Electron app keeps them; git reaches other devices with the Node it carries', async () => {
  const dir = makeRepo(true);
  const data = mkdtempSync(join(tmpdir(), 'kuraa-tauri-data-'));
  const runOn = async (app: Launched) => {
    await openSettings(app);
    await click(app, 'settings-tab-components');
    await click(app, 'kind:engines');
    const on = await app.waitFor<{ on: boolean }>(inPage(`const c = $t('pref-run'); return c ? { on: c.checked } : false;`));
    await pressEscape(app);
    return on.on;
  };
  let app = await launchTauri({ args: ['--open', dir], timings: TIMINGS, data });
  try {
    await app.waitFor(inPage(`return shown($t('file:notes.md'));`), { timeout: 20_000 });
    expect(await runOn(app)).toBe(true);
    // Settings… (⌥⌘,) in the app's menu: the client's window, in the page.
    await app.menu('preferences');
    await click(app, 'settings-tab-components');
    await click(app, 'kind:engines');
    await app.evaluate(inPage(`const c = $t('pref-run'); if (c.checked) c.click(); return true;`));
    // The hub opens the workspaces again with them (writing and committing first), and the page reloads.
    await click(app, 'settings-close');
    await expect.poll(() => (existsSync(join(data, 'preferences.json')) ? JSON.parse(readFileSync(join(data, 'preferences.json'), 'utf8')).runCode : undefined), { timeout: 15_000 }).toBe(false);
    await app.waitFor(inPage(`return shown($t('file:notes.md'));`), { timeout: 20_000 });

    // The workspace is shared, so it syncs: git reaches other devices through git-remote-kuraa, which runs with the app's Node.
    const helper = join(dir, '.git', 'kuraa', 'bin');
    await expect.poll(() => existsSync(join(helper, 'git-remote-kuraa'))).toBe(true);
    // The helper names the app's Node (with forward slashes on Windows, for git's sh).
    expect(readFileSync(join(helper, 'git-remote-kuraa'), 'utf8')).toContain(TAURI_NODE.replace(/\\/g, '/'));
    let answer = '';
    try {
      execFileSync('git', ['ls-remote', `kuraa://${'ab'.repeat(32)}`], { cwd: dir, env: { ...process.env, PATH: `${helper}${delimiter}${process.env.PATH}` }, stdio: 'pipe' });
    } catch (e) {
      answer = String((e as { stderr: Buffer }).stderr);
    }
    expect(answer).toContain('kuraa: the device abababab… is not connected');
  } finally {
    await app.quit();
  }
  // Kept for next time.
  app = await launchTauri({ args: ['--open', dir], timings: TIMINGS, data });
  try {
    await app.waitFor(inPage(`return shown($t('file:notes.md'));`), { timeout: 20_000 });
    expect(await runOn(app)).toBe(false);
  } finally {
    await app.quit();
  }
});

test('you on this computer: made from your name, and said in each workspace that syncs', async () => {
  const dir = makeRepo(true);
  const person = join(mkdtempSync(join(tmpdir(), 'kuraa-tauri-person-')), 'person.json');
  const app = await launchTauri({ args: ['--open', dir], timings: TIMINGS, person });
  try {
    await app.waitFor(inPage(`return shown($t('file:notes.md'));`), { timeout: 20_000 });
    const name = () => {
      try {
        return (JSON.parse(readFileSync(person, 'utf8')) as { name: string }).name;
      } catch {
        return null;
      }
    };
    await expect.poll(name, { timeout: 15_000 }).toBe('Desk Top');
    const said = () => {
      try {
        return (JSON.parse(readFileSync(join(dir, '.git', 'kuraa', 'records.json'), 'utf8')) as { kind: string; name?: string }[]).some((r) => r.kind === 'vouch' && r.name === 'Desk Top');
      } catch {
        return false;
      }
    };
    await expect.poll(said, { timeout: 15_000 }).toBe(true);
    await openSettings(app);
    await click(app, 'settings-tab-you');
    await app.waitFor(inPage(`return ($t('you-here')?.textContent ?? '').includes('You on this computer: Desk Top');`));
  } finally {
    await app.quit();
  }
});

test('the system’s spell checker (a Mac’s), for the editor’s own menus; the Help menu shows the page’s sheet', async () => {
  const dir = makeRepo();
  const app = await launchTauri({ args: ['--open', dir], timings: TIMINGS });
  try {
    await openNotes(app);
    // Misspelled: its suggestions; spelled right: none. Only a Mac's can be asked yet (0127): elsewhere the editor's
    // menus offer none, as if every word were spelled right (the webview still checks as you type).
    const suggestions = await app.evaluate<string[] | null>(`window.kuraa.spellingSuggestions('recieve')`);
    if (process.platform === 'darwin') expect(suggestions).toContain('receive');
    else expect(suggestions).toBeNull();
    expect(await app.evaluate(`window.kuraa.spellingSuggestions('receive')`)).toBeNull();
    // Help › Markdown and Shortcuts: the page's own sheet.
    await app.menu('help');
    await app.waitFor(inPage(`return shown($t('help'));`));
  } finally {
    await app.quit();
  }
});
