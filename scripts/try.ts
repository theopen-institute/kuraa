// pnpm try [<worktree>] [dev|desktop]
//
// Try a feature branch from the main checkout: the code of one of the
// repository's git worktrees (.claude/worktrees/<name>), run from that
// worktree, while your own `pnpm dev` and the desktop app go on as they are.
//
//   pnpm try                          the worktrees, to choose from (↑↓, Enter: pnpm dev, d: desktop)
//   pnpm try <name>                   its pnpm dev, on a free port (never 5173), its address printed,
//                                     with your pnpm dev's workspaces
//   pnpm try <name> desktop           its desktop app, with data of its own
//   --open                            the browser opened at it, once it is ready
//   --own                             its pnpm dev with the worktree's own workspaces instead (a Scratch)
//
// <name> is the worktree's folder (words-metadata), or its branch
// (worktree-words-metadata), or the start of either, where only one has it.
//
// Its packages are installed first (seconds: pnpm links from its store). Its
// pnpm dev serves your pnpm dev's workspaces (the main checkout's .dev-workspaces:
// its list and its settings), so the branch is tried on what you work with; its
// edits are real. Served by your pnpm dev at the same time, it says so and goes
// on: two hosts on one workspace take each other's saves as outside changes, and
// typing in one document through both at once can double or drop a little of it.
// --own gives it the worktree's own .dev-workspaces (a Scratch the first time).
// Its desktop app keeps its preferences and list of workspaces in the worktree
// (.try-desktop/), never with yours.
// Other arguments go on to pnpm dev or the app (`pnpm try words -- --dir ~/x`).
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { emitKeypressEvents } from 'node:readline';
import { basename, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const given = process.argv.slice(2).filter((a) => a !== '--');
/** --open: the browser opened at its address; else the address is said, and nothing opened. */
const openIt = given.includes('--open');
/** --own: its pnpm dev with the worktree's own workspaces, not yours. */
const own = given.includes('--own');
const args = given.filter((a) => a !== '--open' && a !== '--own');
const [name, modeArg, ...rest] = args;
const mode = modeArg === 'desktop' ? 'desktop' : modeArg === 'dev' || modeArg === undefined ? 'dev' : null;
const extra = modeArg === 'desktop' || modeArg === 'dev' ? rest : modeArg === undefined ? [] : [modeArg, ...rest];

interface Worktree {
  path: string;
  branch: string | null;
  name: string;
}

/** The main checkout (where your pnpm dev runs), wherever this is run from. */
const mainCheckout = resolve(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8' }).trim(), '..');

/** The repository's worktrees but the main checkout, from git. */
function worktrees(): Worktree[] {
  const out = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
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

/** Processes of hosts serving a folder of workspaces now (a pnpm dev, a pnpm try, `pnpm host --workspaces`): their pids. */
function servingNow(workspaces: string): string[] {
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
    return out.split('\n')
      .filter((l) => l.includes('host/src/cli.ts') && (l.includes(`--workspaces ${workspaces} `) || l.endsWith(`--workspaces ${workspaces}`)))
      .map((l) => l.trim().split(' ')[0]!);
  } catch {
    return []; // No ps (Windows): nothing said.
  }
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
  // Your pnpm dev's workspaces, unless --own, or others are named (--dir, --workspaces).
  const named = extra.some((a) => /^--(dir|workspaces)(=|$)/.test(a));
  const shared = !own && !named;
  const workspaces = shared ? join(mainCheckout, '.dev-workspaces') : join(wt.path, '.dev-workspaces');
  const served: string[] = [];
  if (shared) {
    served.push('--workspaces', workspaces);
    // Their settings too, where the branch's pnpm dev can be given them (--settings); else it keeps its own beside the list.
    if (readFileSync(join(wt.path, 'scripts', 'dev.ts'), 'utf8').includes("settings: { type: 'string' }")) served.push('--settings', join(workspaces, 'settings.json'));
    else console.log(`[try] NOTE: this branch's pnpm dev cannot be given your settings: it keeps its own, in ${join(workspaces, '.kuraa-settings.json')}.`);
    // Said once, however many processes it has (tsx watch and the host it runs).
    if (servingNow(workspaces).length) {
      console.log('[try] NOTE: your pnpm dev (or another try) is serving these workspaces now. Both will save to them: each takes the other\'s saves'
        + ' as outside changes, and typing in one document through both at once can double or drop a little of it. --own gives the branch workspaces of its own.');
    }
  }
  // Workspaces on the list from elsewhere (your Documents, say): said, as the desktop app may have them open.
  try {
    const listed = JSON.parse(readFileSync(join(workspaces, '.kuraa-workspaces.json'), 'utf8')) as { name?: string; dir?: string }[];
    const outside = listed.filter((w) => w.dir && !resolve(w.dir).startsWith(`${resolve(workspaces)}/`));
    for (const w of outside) console.log(`[try] NOTE: the list has ${w.name ?? w.dir} (${w.dir}), from elsewhere: if the desktop app has it open too, both will save to it.`);
  } catch { /* no list yet: Scratch only */ }
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/`;
  console.log(`[try] its pnpm dev at ${url} (${shared ? 'your pnpm dev\'s workspaces' : 'workspaces of its own'}: ${workspaces})`);
  const child = spawn('pnpm', ['dev', '--port', String(port), ...served, ...extra], { cwd: wt.path, stdio: ['inherit', 'pipe', 'inherit'] });
  let opened = false;
  child.stdout.on('data', (chunk: Buffer) => {
    process.stdout.write(chunk);
    // Opened once Vite is ready.
    if (!opened && openIt && /ready in/.test(chunk.toString())) {
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
