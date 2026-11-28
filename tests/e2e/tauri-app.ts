// Drives the Tauri app (decision 0127) for the desktop tests: the build made
// with `pnpm --filter @kuraa/tauri build:test`, whose shell takes requests on
// loopback (apps/tauri/src-tauri/src/testing.rs). Playwright cannot drive the
// system's webview, so a test asks the page to work things out (`evaluate`),
// chooses from the app's menu, answers its dialogs ahead of time, and reads the
// window's title, through this.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

export const TAURI_APP = resolve(import.meta.dirname, '../../apps/tauri/src-tauri/target/release/bundle/macos/Kuraa.app/Contents/MacOS/Kuraa');

export interface Launched {
  /** Work out an expression (perhaps a promise) in a window's page: its value, as JSON. */
  evaluate<T = unknown>(js: string, window?: string): Promise<T>;
  /** Wait until an expression in the page is truthy; its value. */
  waitFor<T = unknown>(js: string, o?: { timeout?: number; window?: string }): Promise<T>;
  /** The window's title, as the system has it. */
  title(window?: string): Promise<string>;
  url(window?: string): Promise<string>;
  windows(): Promise<string[]>;
  /** Choose an item of the app's menu, by its id (menu.rs). */
  menu(id: string): Promise<void>;
  /** The next folder dialog picks `path` (null: cancelled). */
  answerFolder(path: string | null): Promise<void>;
  /** The next question asking `asking` is answered so. */
  answerConfirm(asking: string, answer: boolean): Promise<void>;
  /** The next file saved goes to `path`. */
  answerSave(path: string | null): Promise<void>;
  /** The questions asked so far. */
  asked(): Promise<string[]>;
  /** Tell the page what the shell would (shell.rs's emit: an update ready, the menu's Settings…). */
  emit(event: string, value?: unknown): Promise<void>;
  /** What the app has said (its own output and its hub's). */
  output(): string;
  /** Quit, as the menu's Quit does (the hub writes and commits first), and wait for it to go. */
  quit(): Promise<void>;
  process: ChildProcess;
}

export interface LaunchOptions {
  args?: string[];
  env?: Record<string, string>;
  timings?: object;
  /** Where its data is kept (preferences, the list of workspaces); a new folder if not given. */
  data?: string;
  person?: string;
}

export async function launchTauri(o: LaunchOptions = {}): Promise<Launched> {
  if (!existsSync(TAURI_APP)) throw new Error(`No Tauri app at ${TAURI_APP}: pnpm --filter @kuraa/tauri build:test`);
  const control = join(mkdtempSync(join(tmpdir(), 'kuraa-tauri-control-')), 'control');
  const workspaces = mkdtempSync(join(tmpdir(), 'kuraa-tauri-workspaces-'));
  const child = spawn(TAURI_APP, ['--workspaces', workspaces, ...(o.args ?? [])], {
    env: {
      ...(process.env as Record<string, string>),
      KURAA_TEST_CONTROL: control,
      KURAA_TIMINGS: JSON.stringify(o.timings ?? {}),
      KURAA_USER_DATA: o.data ?? mkdtempSync(join(tmpdir(), 'kuraa-tauri-data-')),
      KURAA_PERSON: o.person ?? join(mkdtempSync(join(tmpdir(), 'kuraa-tauri-person-')), 'person.json'),
      // Out of sight, so the tests do not take the screen; KURAA_SHOW_WINDOWS=1 to watch them.
      ...(process.env.KURAA_SHOW_WINDOWS ? {} : { KURAA_HIDDEN_WINDOWS: '1' }),
      ...o.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let said = '';
  const hear = (d: Buffer) => {
    said += d.toString();
    if (process.env.DEBUG) process.stderr.write(d);
  };
  child.stdout!.on('data', hear);
  child.stderr!.on('data', hear);
  const gone = new Promise<void>((done) => child.once('exit', () => done()));

  // Its control file says where it listens.
  const until = Date.now() + 20_000;
  while (!existsSync(control) || !readFileSync(control, 'utf8').includes('\n')) {
    if (child.exitCode !== null) throw new Error(`The app stopped at once:\n${said}`);
    if (Date.now() > until) throw new Error(`The app did not start:\n${said}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  const [port, code] = readFileSync(control, 'utf8').trim().split(' ');
  const socket: Socket = await new Promise((done, fail) => {
    const s = createConnection({ host: '127.0.0.1', port: Number(port) }, () => done(s));
    s.once('error', fail);
  });
  socket.write(`${code}\n`);
  const replies: ((v: { ok?: unknown; error?: string }) => void)[] = [];
  createInterface({ input: socket }).on('line', (line) => replies.shift()?.(JSON.parse(line) as { ok?: unknown; error?: string }));
  socket.on('error', () => undefined);
  // One request at a time, in order.
  let queue: Promise<unknown> = Promise.resolve();
  const ask = <T>(r: object): Promise<T> => {
    const next = queue.then(
      () =>
        new Promise<T>((done, fail) => {
          replies.push((v) => (v.error !== undefined ? fail(new Error(v.error)) : done(v.ok as T)));
          socket.write(`${JSON.stringify(r)}\n`);
        }),
    );
    queue = next.catch(() => undefined);
    return next;
  };

  const evaluate = <T>(js: string, window = 'main') => ask<T>({ op: 'eval', js, window });
  return {
    evaluate,
    async waitFor<T>(js: string, w: { timeout?: number; window?: string } = {}): Promise<T> {
      const end = Date.now() + (w.timeout ?? 15_000);
      let last: unknown;
      for (;;) {
        try {
          const v = await evaluate<T>(js, w.window);
          if (v) return v;
          last = v;
        } catch (e) {
          last = e;
        }
        if (Date.now() > end) throw new Error(`Waited for ${js}: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    title: (window = 'main') => ask<string>({ op: 'title', window }),
    url: (window = 'main') => ask<string>({ op: 'url', window }),
    windows: () => ask<string[]>({ op: 'windows' }),
    menu: (id) => ask({ op: 'menu', id }),
    answerFolder: (path) => ask({ op: 'folder', path }),
    answerConfirm: (asking, answer) => ask({ op: 'confirm', asking, answer }),
    answerSave: (path) => ask({ op: 'save', path }),
    asked: () => ask<string[]>({ op: 'asked' }),
    emit: (event, value = null) => ask({ op: 'emit', event, value }),
    output: () => said,
    async quit() {
      await ask({ op: 'quit' }).catch(() => undefined);
      const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
      await gone;
      clearTimeout(timer);
      socket.destroy();
    },
    process: child,
  };
}
