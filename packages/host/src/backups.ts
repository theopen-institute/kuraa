// Online copies (docs/decisions/0039-online-copy.md): plain git servers (GitHub,
// GitLab, any git host, or a folder) that this workspace keeps a copy on, so
// devices that cannot reach each other directly still meet there.
//
// - Each save is pushed to it (a while after the last), and so is everything
//   at start.
// - On Sync, and every few minutes, it is fetched from, its branches are merged
//   in (the same merges every device makes, merging.ts), and the result pushed.
// - A push refused because the copy moved (another device pushed first) is
//   followed by the same: fetch, merge, push. Never forced.
//
// Kept in the repository's git config: `kuraa.online` names the remotes; one
// added by address gets a remote of its own (`online-<owner>-<name>`), taken
// away with it. Network calls run in one place (`network`), outside the host's
// queue of git work, with the person's own git credentials (SSH keys, a
// credential helper), never asking for any and never waiting forever; only the
// merge runs in the queue (`bringIn`).
import { devNull } from 'node:os';
import type { Git } from './git.js';

export interface OnlineCopyStatus {
  /** The git remote it is. */
  name: string;
  /** Where, with any password in it left out. */
  url: string;
  /** When this device and it last had the same work (ISO), if they have. */
  lastSync: string | null;
  /** Why the last sync with it did not go through, if it did not. */
  error: string | null;
  /** Syncing with it now. */
  busy: boolean;
}

/** An address as it may be shown: no user:password@ in it. */
export function shownUrl(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1');
}

/** A remote name from an address: github.com/ada/notes → online-ada-notes. */
export function copyName(url: string): string {
  const tail = shownUrl(url).replace(/\.git$/, '').split(/[/:]/).filter(Boolean).slice(-2).join('-');
  const slug = tail.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `online-${slug || 'copy'}`;
}

/** How long one fetch or push may take. */
const NETWORK_MS = 10 * 60_000;
/** How many times a push refused because the copy moved is tried again (after fetching and merging). */
const TRIES = 3;

export interface OnlineOptions {
  /** Push this long after the last save. */
  delayMs: number;
  /** Fetch, merge and push this often (0: never on its own). */
  everyMs: number;
  log: (m: string) => void;
  /**
   * Bring the copy's branches (fetched into refs/remotes/<name>/) into this
   * repository's, merging as every device does, in turn with the host's other
   * git work. Returns what the merge into the open branch kept, to say.
   * Without it (the command line), work on the copy is left for a host to bring in.
   */
  bringIn?: (name: string) => Promise<string>;
}

export class OnlineCopies {
  private readonly status = new Map<string, { lastSync: string | null; error: string | null; busy: boolean }>();
  /** One sync per copy at a time. */
  private readonly running = new Map<string, Promise<string | null>>();
  private timer: NodeJS.Timeout | undefined;
  private every: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(private readonly git: Git, private readonly o: OnlineOptions) {}

  /** Fetch, merge and push every few minutes, so work pushed by others comes in without a save here. */
  start(): void {
    if (!this.o.everyMs || this.every) return;
    this.every = setInterval(() => void this.syncAll().catch(() => undefined), this.o.everyMs);
    this.every.unref?.();
  }

  /** The remotes that are online copies. */
  async names(): Promise<string[]> {
    const r = await this.git.run(['config', '--get-all', 'kuraa.online'], { allowFail: true });
    return r.code === 0 ? [...new Set(r.stdout.split('\n').map((s) => s.trim()).filter(Boolean))] : [];
  }

  private async remotes(): Promise<Map<string, string>> {
    const r = await this.git.run(['config', '--get-regexp', '^remote\\..*\\.url$'], { allowFail: true });
    const out = new Map<string, string>();
    for (const line of r.stdout.split('\n')) {
      const m = /^remote\.(.+)\.url (.*)$/.exec(line.trim());
      if (m) out.set(m[1]!, m[2]!);
    }
    return out;
  }

  async list(): Promise<OnlineCopyStatus[]> {
    const remotes = await this.remotes();
    return (await this.names()).map((name) => ({ name, url: shownUrl(remotes.get(name) ?? ''), ...(this.status.get(name) ?? { lastSync: null, error: null, busy: false }) }));
  }

  /**
   * Add an online copy: an existing remote, by its name or address, or an
   * address (a remote of its own is made for it). It is synced with at once.
   * Returns its remote's name.
   */
  async add(target: string): Promise<string> {
    const t = target.trim();
    if (!t) throw new Error('Give the address of a git repository (or the name of a remote)');
    const device = 'That is a device of this workspace: devices sync with each other already';
    if (t.startsWith('kuraa://')) throw new Error(device);
    const remotes = await this.remotes();
    let name = remotes.has(t) ? t : [...remotes].find(([, url]) => url === t)?.[0];
    if (name && remotes.get(name)!.startsWith('kuraa://')) throw new Error(device);
    if (!name) {
      name = copyName(t);
      for (let i = 2; remotes.has(name); i++) name = `${copyName(t)}-${i}`;
      await this.git.run(['remote', 'add', name, t]);
      await this.git.run(['config', `remote.${name}.kuraaonline`, 'true']);
    }
    if (!(await this.names()).includes(name)) await this.git.run(['config', '--add', 'kuraa.online', name]);
    void this.sync(name).catch(() => undefined);
    return name;
  }

  /** No longer an online copy. A remote made for it goes too; one that was there before stays. The repository there is not touched. */
  async remove(name: string): Promise<void> {
    if (!(await this.names()).includes(name)) throw new Error(`No online copy called ${name}`);
    await this.git.run(['config', '--unset-all', 'kuraa.online', `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`], { allowFail: true });
    if ((await this.git.run(['config', `remote.${name}.kuraaonline`], { allowFail: true })).stdout.trim() === 'true') {
      await this.git.run(['remote', 'remove', name], { allowFail: true });
    }
    this.status.delete(name);
  }

  /** Something was committed: push to every online copy a while after the last such. */
  changed(): void {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.names().then((names) => Promise.all(names.map((n) => this.sync(n, false)))).catch(() => undefined);
    }, this.o.delayMs);
    this.timer.unref?.();
  }

  /** Sync with every online copy: fetch, merge, push. What each brought (or why it did not go through). */
  async syncAll(): Promise<{ ok: boolean; messages: string[] }> {
    const names = await this.names();
    const said = await Promise.all(names.map(async (name) => ({ name, said: await this.sync(name) })));
    const messages = said.map(({ name, said }) => {
      const s = this.status.get(name);
      return s?.error ? `${name}: ${s.error}` : (said ?? `Synced with ${name}`);
    });
    return { ok: names.every((n) => !this.status.get(n)?.error), messages };
  }

  /**
   * Sync with one online copy: fetch it and bring its work in (unless only
   * pushing, after a save), then push every branch. A push refused because the
   * copy moved is followed by fetch, merge and push again: never forced.
   * Returns what it said, or null if it did not go through (see list()).
   */
  sync(name: string, fetchFirst = true): Promise<string | null> {
    const before = this.running.get(name) ?? Promise.resolve(null);
    const run = before.catch(() => null).then(() => this.syncNow(name, fetchFirst));
    this.running.set(name, run);
    void run.finally(() => {
      if (this.running.get(name) === run) this.running.delete(name);
    });
    return run;
  }

  private async syncNow(name: string, fetchFirst: boolean): Promise<string | null> {
    if (this.closed) return null;
    const s = this.status.get(name) ?? { lastSync: null, error: null, busy: false };
    this.status.set(name, s);
    s.busy = true;
    const fail = (why: string) => {
      s.error = why;
      this.o.log(`online copy ${name}: ${why}`);
      return null;
    };
    try {
      let said = '';
      for (let i = 0; i < TRIES; i++) {
        if (fetchFirst || i > 0) {
          const f = await this.network(['fetch', '--prune', '--no-write-fetch-head', name, `+refs/heads/*:refs/remotes/${name}/*`]);
          if (f.code !== 0) return fail(gitSays(f));
          said = (await this.o.bringIn?.(name)) ?? '';
        }
        const p = await this.network(['push', '--porcelain', name, 'refs/heads/*:refs/heads/*']);
        const rejected = p.stdout.split('\n').filter((l) => l.startsWith('!'));
        if (p.code === 0 && !rejected.length) {
          s.lastSync = new Date().toISOString();
          s.error = null;
          return `Synced with ${name}${said}`;
        }
        // Moved since this device last fetched: fetch, merge and push again.
        if (!rejected.length || !rejected.every((l) => /\[rejected\]|non-fast-forward|fetch first/.test(l))) return fail(gitSays(p));
        if (!this.o.bringIn) return fail('It has work this device does not have yet: the host brings it in when it next syncs.');
      }
      return fail('It kept changing while this device synced with it; this device tries again after its next save.');
    } catch (e) {
      return fail((e as Error).message);
    } finally {
      s.busy = false;
    }
  }

  /**
   * The one place this talks to a git server: hooks off, with the person's own
   * credentials and never a prompt for any (SSH in batch mode), and a time limit.
   */
  private network(args: string[]) {
    return this.git.run(['-c', `core.hooksPath=${devNull}`, ...args], {
      allowFail: true,
      timeoutMs: NETWORK_MS,
      env: { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes' },
    });
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    clearInterval(this.every);
  }
}

/** Git's own answer, shortened, and where credentials come from. */
function gitSays(r: { stdout: string; stderr: string }): string {
  const why = (r.stderr || r.stdout).trim().split('\n').filter((l) => !l.startsWith('To ') && l !== 'Done').slice(-2).join(' ');
  return `${why || 'It did not go through'}. Online copies use your own git credentials (an SSH key, or a credential helper for https).`;
}
