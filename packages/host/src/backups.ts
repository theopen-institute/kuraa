// Backups (docs/decisions/0036-backups.md): plain git servers (GitHub, GitLab,
// any git host, or a folder) that this workspace's branches are pushed to, and
// nothing more. Never fetched from or merged: a backup receives, it never sends
// anything back. Never forced: a backup with work this device lacks (another of
// the person's devices pushed first) refuses the push, which is said, and done
// again once this device has that work.
//
// Kept in the repository's git config: `kuraa.backup` names the remotes; a
// backup added by address gets a remote of its own (`backup-<name>`), taken
// away with it. Pushed after commits (a while after the last), at start, and on
// request; with the person's own git credentials (SSH keys, a credential helper),
// never asking for any.
import { devNull } from 'node:os';
import type { Git } from './git.js';

export interface BackupStatus {
  /** The git remote it is pushed to. */
  name: string;
  /** Where, with any password in it left out. */
  url: string;
  /** When it last took everything (ISO), if it has. */
  lastPush: string | null;
  /** Why the last push did not go through, if it did not. */
  error: string | null;
  /** A push is under way. */
  pushing: boolean;
}

/** An address as it may be shown: no user:password@ in it. */
export function shownUrl(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1');
}

/** A remote name from an address: github.com/ada/notes → backup-ada-notes. */
export function backupName(url: string): string {
  const tail = shownUrl(url).replace(/\.git$/, '').split(/[/:]/).filter(Boolean).slice(-2).join('-');
  const slug = tail.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `backup-${slug || 'remote'}`;
}

export class Backups {
  private readonly status = new Map<string, { lastPush: string | null; error: string | null; pushing: boolean }>();
  private timer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(private readonly git: Git, private readonly o: { delayMs: number; log: (m: string) => void; serial: <T>(fn: () => Promise<T>) => Promise<T> }) {}

  /** The remotes that are backups. */
  async names(): Promise<string[]> {
    const r = await this.git.run(['config', '--get-all', 'kuraa.backup'], { allowFail: true });
    return r.code === 0 ? [...new Set(r.stdout.split('\n').map((s) => s.trim()).filter(Boolean))] : [];
  }

  private async remotes(): Promise<string[]> {
    return (await this.git.out(['remote'])).split('\n').filter(Boolean);
  }

  async list(): Promise<BackupStatus[]> {
    const out: BackupStatus[] = [];
    for (const name of await this.names()) {
      const url = (await this.git.run(['remote', 'get-url', name], { allowFail: true })).stdout.trim();
      const s = this.status.get(name) ?? { lastPush: null, error: null, pushing: false };
      out.push({ name, url: shownUrl(url), ...s });
    }
    return out;
  }

  /**
   * Add a backup: an existing remote by its name, or an address (a remote of its
   * own is made for it). It is pushed to at once. Returns its remote's name.
   */
  async add(target: string): Promise<string> {
    const t = target.trim();
    if (!t) throw new Error('Give the address of a git repository (or the name of a remote)');
    if (t.startsWith('kuraa://')) throw new Error('That is a device of this workspace: devices sync with each other already');
    let name = t;
    if (!(await this.remotes()).includes(t)) {
      name = backupName(t);
      for (let i = 2; (await this.remotes()).includes(name); i++) name = `${backupName(t)}-${i}`;
      await this.git.run(['remote', 'add', name, t]);
      await this.git.run(['config', `remote.${name}.kuraabackup`, 'true']);
    } else if ((await this.git.run(['remote', 'get-url', t])).stdout.trim().startsWith('kuraa://')) {
      throw new Error('That is a device of this workspace: devices sync with each other already');
    }
    if (!(await this.names()).includes(name)) await this.git.run(['config', '--add', 'kuraa.backup', name]);
    void this.push(name).catch(() => undefined);
    return name;
  }

  /** No longer a backup. A remote made for it goes too; one that was there before stays. The repository there is not touched. */
  async remove(name: string): Promise<void> {
    if (!(await this.names()).includes(name)) throw new Error(`No backup called ${name}`);
    await this.git.run(['config', '--unset-all', 'kuraa.backup', `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`], { allowFail: true });
    if ((await this.git.run(['config', `remote.${name}.kuraabackup`], { allowFail: true })).stdout.trim() === 'true') {
      await this.git.run(['remote', 'remove', name], { allowFail: true });
    }
    this.status.delete(name);
  }

  /** Something was committed: push to every backup a while after the last such. */
  changed(): void {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.pushAll().catch(() => undefined), this.o.delayMs);
    this.timer.unref?.();
  }

  async pushAll(): Promise<BackupStatus[]> {
    for (const name of await this.names()) await this.push(name);
    return this.list();
  }

  /**
   * Push every branch to a backup: only what comes on top of what it has (never
   * forced), with the person's own credentials, and no prompting for any.
   */
  async push(name: string): Promise<void> {
    const s = this.status.get(name) ?? { lastPush: null, error: null, pushing: false };
    this.status.set(name, s);
    s.pushing = true;
    try {
      // In turn with commits and merges, so the branches do not move underneath.
      const r = await this.o.serial(() => this.git.run(
        ['-c', `core.hooksPath=${devNull}`, 'push', '--porcelain', name, 'refs/heads/*:refs/heads/*'],
        { allowFail: true, timeoutMs: 10 * 60_000, env: { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes' } },
      ));
      const rejected = r.stdout.split('\n').filter((l) => l.startsWith('!'));
      if (r.code === 0 && !rejected.length) {
        s.lastPush = new Date().toISOString();
        s.error = null;
      } else if (rejected.length && rejected.every((l) => /\[rejected\]|non-fast-forward|fetch first/.test(l))) {
        s.error = 'It has work this device does not have yet (from another of your devices): it is backed up once this device has it.';
      } else {
        const why = (r.stderr || r.stdout).trim().split('\n').filter((l) => !l.startsWith('To ')).slice(-2).join(' ');
        s.error = `${why || 'The push did not go through'}. Backups use your own git credentials (an SSH key, or a credential helper for https).`;
      }
      if (s.error) this.o.log(`backup ${name}: ${s.error}`);
    } finally {
      s.pushing = false;
    }
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
  }
}
