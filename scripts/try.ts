// pnpm try [<worktree>] [dev|desktop]
//
// Try a feature branch from the main checkout: the code of one of the
// repository's git worktrees (.claude/worktrees/<name>), run from that
// worktree, while your own `pnpm dev` and the desktop app go on as they are.
//
//   pnpm try                          the worktrees, to choose from (↑↓, Enter: pnpm dev, d: desktop)
//   pnpm try <name>                   its pnpm dev, on a free port (never 5173), opened in the browser
//   pnpm try <name> desktop           its desktop app, with data of its own
//   --no-open                         the address said, the browser not opened
//
// <name> is the worktree's folder (words-metadata), or its branch
// (worktree-words-metadata), or the start of either, where only one has it.
//
// Its packages are installed first (seconds: pnpm links from its store). Its
// pnpm dev has workspaces of its own (the worktree's .dev-workspaces, with a
// Scratch the first time). Its desktop app keeps its preferences and list of
// workspaces in the worktree (.try-desktop/), never with yours: two apps never
// save to the same workspaces, and the branch never sees your documents.
// Other arguments go on to pnpm dev or the app (`pnpm try words -- --dir ~/x`).
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { emitKeypressEvents } from 'node:readline';
import { basename, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const given = process.argv.slice(2).filter((a) => a !== '--');
/** --no-open: the address said, the browser not opened. */
const noOpen = given.includes('--no-open');
const args = given.filter((a) => a !== '--no-open');
const [name, modeArg, ...rest] = args;
const mode = modeArg === 'desktop' ? 'desktop' : modeArg === 'dev' || modeArg === undefined ? 'dev' : null;
const extra = modeArg === 'desktop' || modeArg === 'dev' ? rest : modeArg === undefined ? [] : [modeArg, ...rest];

interface Worktree {
  path: string;
  branch: string | null;
  name: string;
}

/** The repository's worktrees but the main checkout, from git. */
function worktrees(): Worktree[] {
  const out = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  const main = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const mainCheckout = resolve(main, '..');
  return out.split('\n\n').map((block) => {
    const path = /^worktree (.+)$/m.exec(block)?.[1] ?? '';
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null;
    return { path, branch, name: basename(path) };
  }).filter((w) => w.path && resolve(w.path) !== mainCheckout);
}

const subject = (path: string) => {
  try {
    return execFileSync('git', ['log', '-1', '--format=%cr: %s'], { cwd: path, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};

function list(all: Worktree[]): void {
  if (!all.length) {
    console.log('No worktrees: each feature is made in one (.claude/worktrees/<name>).');
    return;
  }
  console.log('Worktrees (pnpm try <name> [desktop]):\n');
  for (const w of all) {
    const last = subject(w.path);
    console.log(`  ${w.name.padEnd(24)} ${w.branch ?? '(no branch)'}`);
    if (last) console.log(`  ${''.padEnd(24)} ${last.length > 90 ? `${last.slice(0, 89)}…` : last}`);
  }
}

/** The worktree a name means: its folder or branch, whole, else the start of only one. */
function find(all: Worktree[], wanted: string): Worktree {
  const exact = all.find((w) => w.name === wanted || w.branch === wanted || w.branch === `worktree-${wanted}`);
  if (exact) return exact;
  const starts = all.filter((w) => w.name.startsWith(wanted) || w.branch?.startsWith(wanted) || w.branch?.startsWith(`worktree-${wanted}`));
  if (starts.length === 1) return starts[0]!;
  console.error(starts.length ? `try: ${wanted} could be ${starts.map((w) => w.name).join(' or ')}` : `try: no worktree ${wanted}`);
  list(all);
  process.exit(1);
}

function portFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const server = createServer();
    server.once('error', () => done(false));
    server.listen(port, '127.0.0.1', () => server.close(() => done(true)));
  });
}

/** A port for the branch's pnpm dev: from 5174 up, never 5173 (yours). */
async function freePort(): Promise<number> {
  for (let p = 5174; p < 5300; p++) if (await portFree(p)) return p;
  throw new Error('no free port between 5174 and 5300');
}

function openInBrowser(url: string): void {
  const [command, ...flags] = process.platform === 'darwin' ? ['open'] : process.platform === 'win32' ? ['cmd', '/c', 'start', '""'] : ['xdg-open'];
  try {
    spawn(command!, [...flags, url], { stdio: 'ignore', detached: true }).unref();
  } catch { /* the address is printed: open it by hand */ }
}

/**
 * The worktrees to choose from, in the terminal: ↑ and ↓ (or k and j) move,
 * Enter runs its pnpm dev, d its desktop app, q or Escape leaves. Null: left.
 */
function pick(all: Worktree[]): Promise<{ wt: Worktree; mode: 'dev' | 'desktop' } | null> {
  const { stdin, stdout } = process;
  const width = Math.max(40, (stdout.columns || 100) - 4);
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const rows = all.map((w) => ({ w, last: subject(w.path) }));
  const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
  let at = 0;
  let drawn = 0;
  const draw = () => {
    // Back over what was drawn, and clear it.
    if (drawn) stdout.write(`\x1b[${drawn}A\x1b[J`);
    const lines = ['Try which branch? ' + dim('↑↓ choose · Enter: pnpm dev · d: desktop app · q: leave'), ''];
    rows.forEach(({ w, last }, i) => {
      const here = i === at;
      const head = `${here ? '\x1b[1m›' : ' '} ${w.name.padEnd(24)} ${w.branch ?? '(no branch)'}${here ? '\x1b[22m' : ''}`;
      lines.push(cut(head, width + 10), `   ${dim(cut(last, width - 3))}`);
    });
    stdout.write(`${lines.join('\n')}\n`);
    drawn = lines.length;
  };
  return new Promise((done) => {
    emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdout.write('\x1b[?25l');
    const finish = (choice: { wt: Worktree; mode: 'dev' | 'desktop' } | null) => {
      stdin.off('keypress', onKey);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\x1b[?25h');
      done(choice);
    };
    const onKey = (_: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === 'c') return finish(null);
      switch (key.name) {
        case 'up': case 'k': at = (at - 1 + rows.length) % rows.length; return draw();
        case 'down': case 'j': at = (at + 1) % rows.length; return draw();
        case 'return': return finish({ wt: rows[at]!.w, mode: 'dev' });
        case 'd': return finish({ wt: rows[at]!.w, mode: 'desktop' });
        case 'q': case 'escape': return finish(null);
        default: return undefined;
      }
    };
    stdin.on('keypress', onKey);
    draw();
  });
}

const all = worktrees();
let wt: Worktree;
let chosenMode: 'dev' | 'desktop';
if (!name) {
  // In a terminal: chosen from the list; otherwise (piped, a script), the list said.
  if (!process.stdin.isTTY || !process.stdout.isTTY || !all.length) {
    list(all);
    process.exit(0);
  }
  const choice = await pick(all);
  if (!choice) process.exit(0);
  wt = choice.wt;
  chosenMode = choice.mode;
} else {
  if (!mode) {
    console.error(`try: ${modeArg} is neither dev nor desktop`);
    process.exit(1);
  }
  wt = find(all, name);
  chosenMode = mode;
}
console.log(`[try] ${wt.name} (${wt.branch ?? 'no branch'}): ${subject(wt.path)}`);

// Its packages, as its lockfile has them.
console.log('[try] installing its packages…');
execFileSync('pnpm', ['install', '--prefer-offline'], { cwd: wt.path, stdio: ['ignore', 'ignore', 'inherit'] });

if (chosenMode === 'dev') {
  // Workspaces added to its list from elsewhere (your own, say): said, as two apps saving to one workspace at once can go wrong.
  try {
    const listed = JSON.parse(readFileSync(join(wt.path, '.dev-workspaces', '.kuraa-workspaces.json'), 'utf8')) as { name?: string; dir?: string }[];
    const outside = listed.filter((w) => w.dir && !resolve(w.dir).startsWith(`${resolve(wt.path)}/`));
    for (const w of outside) console.log(`[try] NOTE: its list has ${w.name ?? w.dir} (${w.dir}), from outside the worktree: if the desktop app or another pnpm dev has it open, close it there first, or remove it from this list.`);
  } catch { /* no list yet: Scratch only */ }
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/`;
  console.log(`[try] its pnpm dev at ${url} (its own workspaces: ${join(wt.path, '.dev-workspaces')})`);
  const child = spawn('pnpm', ['dev', '--port', String(port), ...extra], { cwd: wt.path, stdio: ['inherit', 'pipe', 'inherit'] });
  let opened = false;
  child.stdout.on('data', (chunk: Buffer) => {
    process.stdout.write(chunk);
    // Opened once Vite is ready.
    if (!opened && !noOpen && /ready in/.test(chunk.toString())) {
      opened = true;
      openInBrowser(url);
    }
  });
  child.on('exit', (code) => process.exit(code ?? 0));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
} else {
  // Data of its own, in the worktree: never your preferences or your workspaces.
  const data = join(wt.path, '.try-desktop');
  const workspaces = join(data, 'workspaces');
  mkdirSync(workspaces, { recursive: true });
  console.log(`[try] its desktop app, with data of its own (${data})`);
  if (!existsSync(join(data, 'preferences.json'))) console.log('[try] no workspaces yet: add one, or Open a folder…, in the app');
  const child = spawn('pnpm', ['desktop', '--', '--workspaces', workspaces, ...extra], { cwd: wt.path, stdio: 'inherit', env: { ...process.env, KURAA_USER_DATA: data } });
  child.on('exit', (code) => process.exit(code ?? 0));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
}
