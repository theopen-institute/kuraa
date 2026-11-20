// Tools (decision 0045): toolchains such as TeX, downloaded when someone asks,
// kept once per computer, and seen read-only by the processes that use them.
// The host knows none by name: they come from run components (run-kit's Tool).
//
// In the data folder packages use (--data-dir, or the app's preference):
//   tools/<id>/<version>-<arch>/tool.json   what was installed, for which
//                                            architecture, when, and what added since
//   tools/<id>/<version>-<arch>/files/      the tool, mounted read-only at its
//                                            `inside` path where it is used
//   tools/<id>/.staging-<random>/            an install under way, renamed into
//                                            place only once it has finished
//   tools/.work/<id>/                        the installer's scratch and scripts
//
// The installer runs through the environment, as package installers do: the
// network, no workspace, only the tool's folder writable. One install, add or
// removal per tool at a time, for every host in this process (a hub runs many)
// that keeps its data in the same folder; whoever asks for a download already
// under way joins it. A tool is removed once no render is using it. Parts
// (LaTeX packages) are added in place: tlmgr adds files and rewrites its own
// list, so a render running meanwhile at worst misses what is being added.
import { randomBytes } from 'node:crypto';
import { existsSync, type Dirent } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { TOOL_REPLY_PREFIX, type Environment, type PathView, type Policy, type Tool, type ToolCommand } from '@kuraa/run-kit';
import { renameOver } from './files.js';

/** What tool.json records. */
export interface ToolRecord {
  id: string;
  version: string;
  arch: string;
  installedAt: string;
  /** The parts it has (its packages), as the installer reported them, and those added since. */
  parts: string[];
  /** What was added since, and when. */
  added: { names: string[]; at: string }[];
  /** Bytes on disk, when last measured. */
  size: number;
}

export type ToolState = 'absent' | 'downloading' | 'ready' | 'adding' | 'removing';

/** A tool, as the app is told about it. */
export interface ToolInfo {
  id: string;
  label: string;
  description: string;
  version: string;
  downloadBytes: number;
  state: ToolState;
  /** While downloading or adding: what is happening now. */
  progress: string | null;
  /** Why the last download, addition or removal failed, if it did. */
  error: string | null;
  /** Once downloaded: bytes on this computer, and when. */
  size: number | null;
  installedAt: string | null;
  /** Why it cannot be downloaded here, if it cannot (no build for this kind of computer). */
  unavailable: string | null;
  /** Something to know: it was downloaded for another kind of computer only, say. */
  note: string | null;
  /** If it has parts: what they are called, and how many were added on this computer. */
  parts: { label: string; added: number } | null;
}

/** What an install needs from the host: where to run it and with what limits. */
export interface ToolEnv {
  environment: Environment;
  options: unknown;
  policy: Policy;
  /** The environment's architecture, if it says. */
  arch: string | null;
  log(m: string): void;
}

export interface ToolResult {
  ok: boolean;
  message: string;
  log: string;
}

/** The longest an install or addition may take. */
const INSTALL_MS = 30 * 60_000;
/** The end of an installer's output kept. */
const MAX_LOG = 200_000;
const ARCH = /^[a-z0-9_]{1,20}$/;
/** Leftovers of an install a host did not finish (it crashed) are removed after this long. */
const STALE_MS = 6 * 3600_000;

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const mb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1e6))} MB`;

const stores = new Map<string, ToolStore>();

export class ToolStore {
  /** The store for a data folder: one per folder in this process. */
  static at(dataDir: string): ToolStore {
    const root = resolve(dataDir, 'tools');
    let store = stores.get(root);
    if (!store) stores.set(root, (store = new ToolStore(root)));
    return store;
  }

  /** Work under way or waiting, per tool: one at a time. */
  private readonly queues = new Map<string, Promise<unknown>>();
  /** What each tool is doing now. */
  private readonly work = new Map<string, { kind: Exclude<ToolState, 'absent' | 'ready'>; progress: string | null }>();
  /** A download under way, to join. */
  private readonly downloads = new Map<string, Promise<ToolResult>>();
  private readonly errors = new Map<string, string>();
  /** Tools asked to be removed: no render starts using them. */
  private readonly removing = new Set<string>();
  /** Renders using each installed folder. */
  private readonly users = new Map<string, number>();
  private readonly idle = new Map<string, (() => void)[]>();
  private readonly listeners = new Set<() => void>();
  private emitTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor(readonly root: string) {
    void this.tidy();
  }

  /** Told when a tool's state changes (at most a few times a second). */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      for (const fn of this.listeners) fn();
    }, 250);
    this.emitTimer.unref?.();
  }

  folder(tool: Tool, arch: string): string {
    return join(this.root, tool.id, `${tool.version}-${arch}`);
  }

  /** The tool as installed for an architecture (this version), if it is. */
  async record(tool: Tool, arch: string): Promise<ToolRecord | null> {
    const dir = this.folder(tool, arch);
    try {
      const r = JSON.parse(await readFile(join(dir, 'tool.json'), 'utf8')) as ToolRecord;
      if (!existsSync(join(dir, 'files'))) return null;
      return { ...r, parts: strings(r.parts), added: Array.isArray(r.added) ? r.added : [] };
    } catch {
      return null;
    }
  }

  /** Every installed version and architecture of a tool. */
  private async installed(tool: Tool): Promise<{ dir: string; record: ToolRecord | null }[]> {
    const names = await readdir(join(this.root, tool.id)).catch(() => [] as string[]);
    const out: { dir: string; record: ToolRecord | null }[] = [];
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const dir = join(this.root, tool.id, name);
      const record = await readFile(join(dir, 'tool.json'), 'utf8').then((t) => JSON.parse(t) as ToolRecord, () => null);
      out.push({ dir, record });
    }
    return out;
  }

  /** Why the tool cannot be installed for an architecture, or null. */
  cannotInstall(tool: Tool, arch: string | null): string | null {
    if (arch && !tool.architectures.includes(arch)) {
      return `${tool.label} is not available for the kind of computer code runs on here (${arch}); it is made for ${tool.architectures.join(' and ')}.`;
    }
    return null;
  }

  busy(tool: Tool): ToolState | null {
    return this.work.get(tool.id)?.kind ?? (this.removing.has(tool.id) ? 'removing' : null);
  }

  async info(tool: Tool, arch: string | null): Promise<ToolInfo> {
    const all = await this.installed(tool);
    const here = arch ? await this.record(tool, arch) : (all.find((i) => i.record && i.record.version === tool.version)?.record ?? null);
    const others = all.filter((i) => i.record && i.record.arch !== here?.arch && i.record.version === tool.version).map((i) => i.record!.arch);
    const work = this.work.get(tool.id);
    return {
      id: tool.id, label: tool.label, description: tool.description, version: tool.version, downloadBytes: tool.downloadBytes,
      state: work?.kind ?? (this.removing.has(tool.id) ? 'removing' : here ? 'ready' : 'absent'),
      progress: work?.progress ?? null,
      error: this.errors.get(tool.id) ?? null,
      size: here?.size ?? null,
      installedAt: here?.installedAt ?? null,
      unavailable: this.cannotInstall(tool, arch),
      note: !here && others.length && arch ? `It was downloaded for ${others.join(' and ')} computers, and code here runs on ${arch}: download it again for this one.` : null,
      parts: tool.parts ? { label: tool.parts.label, added: (here?.added ?? []).reduce((n, a) => n + a.names.length, 0) } : null,
    };
  }

  /**
   * Work for one tool, after whatever is under way for it. `kind` is what
   * people see meanwhile; a failure is kept to show.
   */
  private queue<T extends { ok: boolean; message: string }>(tool: Tool, kind: Exclude<ToolState, 'absent' | 'ready'>, fn: (progress: (m: string) => void) => Promise<T>, onProgress?: (m: string) => void): Promise<T> {
    const run = async () => {
      this.work.set(tool.id, { kind, progress: null });
      this.errors.delete(tool.id);
      this.changed();
      const progress = (m: string) => {
        this.work.set(tool.id, { kind, progress: m });
        onProgress?.(m);
        this.changed();
      };
      try {
        const result = await fn(progress);
        if (!result.ok) this.errors.set(tool.id, result.message);
        return result;
      } catch (e) {
        this.errors.set(tool.id, (e as Error).message);
        throw e;
      } finally {
        this.work.delete(tool.id);
        this.changed();
      }
    };
    const next = (this.queues.get(tool.id) ?? Promise.resolve()).then(run, run);
    const settled = next.catch(() => undefined);
    this.queues.set(tool.id, settled);
    void settled.then(() => {
      if (this.queues.get(tool.id) === settled) this.queues.delete(tool.id);
    });
    return next;
  }

  /** Download and install a tool for the environment's architecture; joins one under way. */
  install(tool: Tool, env: ToolEnv): Promise<ToolResult> {
    const under = this.downloads.get(tool.id);
    if (under) return under;
    const why = this.cannotInstall(tool, env.arch);
    if (why) return Promise.resolve({ ok: false, message: why, log: '' });
    const done = this.queue(tool, 'downloading', async (progress) => {
      if (env.arch && (await this.record(tool, env.arch))) return { ok: true, message: `${tool.label} is already on this computer.`, log: '' };
      progress(`Downloading ${tool.label} (about ${mb(tool.downloadBytes)})…`);
      const staging = join(this.root, tool.id, `.staging-${randomBytes(6).toString('hex')}`);
      const files = join(staging, 'files');
      await mkdir(files, { recursive: true });
      try {
        const { reply, log, why: stopped } = await this.runInstaller(tool, env, files, (view) => tool.installer.install(view, { arch: env.arch }), progress);
        if (stopped || reply?.ok !== true) return { ok: false, message: `${tool.label} could not be downloaded: ${stopped ?? (typeof reply?.message === 'string' ? reply.message : 'the installer stopped without saying why.')}`, log };
        const arch = typeof reply.arch === 'string' && ARCH.test(reply.arch) ? reply.arch : env.arch;
        if (!arch) return { ok: false, message: `${tool.label} was installed, but for which kind of computer is not known, so it is not used.`, log };
        if (env.arch && arch !== env.arch) return { ok: false, message: `${tool.label} was installed for ${arch} computers, and code here runs on ${env.arch}, so it is not used.`, log };
        progress('Measuring…');
        const record: ToolRecord = {
          id: tool.id, version: tool.version, arch, installedAt: new Date().toISOString(),
          parts: strings(reply.parts).filter((p) => !tool.parts || tool.parts.valid(p)),
          added: [], size: await sizeOf(files),
        };
        await writeFile(join(staging, 'tool.json'), `${JSON.stringify(record, null, 2)}\n`);
        const dest = this.folder(tool, arch);
        // Another host on this computer may have installed it meanwhile: keep theirs.
        if (!existsSync(dest)) await rename(staging, dest);
        return { ok: true, message: `${tool.label} is downloaded: ${mb(record.size)} on this computer.`, log };
      } finally {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      }
    });
    this.downloads.set(tool.id, done);
    void done.catch(() => undefined).then(() => this.downloads.delete(tool.id));
    return done;
  }

  /** Add parts (LaTeX packages) to an installed tool. `added` names what it now has that it did not. */
  addParts(tool: Tool, names: string[], env: ToolEnv, onProgress?: (m: string) => void): Promise<ToolResult & { added: string[] }> {
    const parts = tool.parts;
    if (!parts) return Promise.resolve({ ok: false, message: `${tool.label} has no parts to add.`, log: '', added: [] });
    const wanted = [...new Set(names.filter((n) => parts.valid(n)))].slice(0, 40);
    if (!wanted.length) return Promise.resolve({ ok: false, message: `Name the ${parts.label} to add.`, log: '', added: [] });
    return this.queue(tool, 'adding', async (progress) => {
      const record = await this.installedFor(tool, env.arch);
      if (!record) return { ok: false, message: `${tool.label} is not downloaded on this computer.`, log: '', added: [] };
      const fresh = wanted.filter((n) => !record.parts.includes(n));
      if (!fresh.length) return { ok: true, message: `It already has ${wanted.join(', ')}.`, log: '', added: [] };
      progress(`Adding ${parts.label}: ${fresh.join(', ')}…`);
      const dir = this.folder(tool, record.arch);
      const { reply, log, why } = await this.runInstaller(tool, env, join(dir, 'files'), (view) => parts.add(view, { arch: record.arch, names: fresh }), progress);
      const added = strings(reply?.added).filter((n) => parts.valid(n));
      if (added.length) {
        const now = (await this.record(tool, record.arch)) ?? record;
        now.parts = [...new Set([...now.parts, ...added])].sort();
        now.added = [...now.added, { names: added, at: new Date().toISOString() }];
        now.size = await sizeOf(join(dir, 'files'));
        const file = join(dir, 'tool.json');
        await writeFile(`${file}.tmp`, `${JSON.stringify(now, null, 2)}\n`);
        await renameOver(`${file}.tmp`, file);
      }
      if (why || reply?.ok !== true) {
        const said = why ?? (typeof reply?.message === 'string' ? reply.message : 'the installer stopped without saying why.');
        return { ok: false, message: `The ${parts.label} could not be added: ${said}`, log, added };
      }
      return { ok: true, message: `Added the ${parts.label} ${added.join(', ')}.`, log, added };
    }, onProgress);
  }

  /** The tool as installed for an architecture, or (if the environment does not say) for any. */
  private async installedFor(tool: Tool, arch: string | null): Promise<ToolRecord | null> {
    if (arch) return this.record(tool, arch);
    for (const i of await this.installed(tool)) if (i.record?.version === tool.version) return this.record(tool, i.record.arch);
    return null;
  }

  /**
   * Use an installed tool in a render: its folder and record, until `release`.
   * Null if it is not installed for the architecture, or is being removed.
   */
  async acquire(tool: Tool, arch: string | null): Promise<{ record: ToolRecord; files: string; release: () => void } | null> {
    if (this.removing.has(tool.id)) return null;
    const record = await this.installedFor(tool, arch);
    if (!record || this.removing.has(tool.id)) return null;
    const dir = this.folder(tool, record.arch);
    this.users.set(dir, (this.users.get(dir) ?? 0) + 1);
    let released = false;
    return {
      record, files: join(dir, 'files'),
      release: () => {
        if (released) return;
        released = true;
        const n = (this.users.get(dir) ?? 1) - 1;
        if (n > 0) return void this.users.set(dir, n);
        this.users.delete(dir);
        for (const fn of this.idle.get(dir)?.splice(0) ?? []) fn();
      },
    };
  }

  private whenUnused(dir: string): Promise<void> {
    if (!this.users.get(dir)) return Promise.resolve();
    return new Promise((resolve) => this.idle.set(dir, [...(this.idle.get(dir) ?? []), resolve]));
  }

  /** Remove every version of a tool from this computer, once no render is using it. */
  remove(tool: Tool, onProgress?: (m: string) => void): Promise<ToolResult> {
    this.removing.add(tool.id);
    const done = this.queue(tool, 'removing', async (progress) => {
      const all = await this.installed(tool);
      if (!all.length) return { ok: true, message: `${tool.label} is not on this computer.`, log: '' };
      for (const { dir } of all) {
        if (this.users.get(dir)) progress('Waiting for the renders using it to finish…');
        await this.whenUnused(dir);
        // Out of the way at once, then deleted: nothing finds a half-deleted tool.
        const trash = join(this.root, tool.id, `.trash-${randomBytes(6).toString('hex')}`);
        await rename(dir, trash);
        progress('Removing…');
        await rm(trash, { recursive: true, force: true });
      }
      return { ok: true, message: `${tool.label} was removed from this computer.`, log: '' };
    }, onProgress);
    void done.catch(() => undefined).then(() => this.removing.delete(tool.id));
    return done;
  }

  /** Run a tool's installer, with its folder at `target` writable. Its reply, its output, and why it was stopped, if it was. */
  private async runInstaller(tool: Tool, env: ToolEnv, target: string, command: (view: PathView) => ToolCommand, progress: (m: string) => void): Promise<{ reply: Record<string, unknown> | null; log: string; why?: string }> {
    const work = join(this.root, '.work', tool.id);
    const scratch = join(work, 'scratch');
    const files = join(work, 'files');
    await mkdir(scratch, { recursive: true });
    await mkdir(files, { recursive: true });
    await emptyDir(scratch);
    for (const [name, content] of Object.entries(tool.installer.files)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error(`The tool ${tool.id} names a file "${name}" its installer cannot have.`);
      await writeFile(join(files, name), content);
    }
    let log = '';
    const keep = (text: string) => (log = (log + text).slice(-MAX_LOG));
    let said = '';
    let shown = 0;
    let reply: Record<string, unknown> | null = null;
    const proc = await env.environment.start({
      name: `tool-${tool.id}`,
      // No workspace at all: the installer has the network.
      workspace: scratch, scratch, files,
      mounts: [{ host: target, inside: tool.inside, access: 'read-write' }],
      policy: { ...env.policy, workspace: 'none', network: true },
      image: tool.installer.image,
      command: (view) => {
        const c = command(view);
        return { argv: c.argv, cwd: view.scratch, env: c.env };
      },
      log: env.log,
      status: progress,
    }, env.options);
    proc.stdin.on('error', () => undefined);
    proc.stdin.end();
    let out = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d: string) => {
      out = (out + d).slice(-MAX_LOG);
      keep(d);
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d: string) => {
      keep(d);
      // Progress: the last thing said, and a percentage if a bar follows it (curl's).
      const pieces = d.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
      let pct: string | null = null;
      for (const p of pieces) {
        const bar = /^[#\s=O-]*?(\d{1,3}(?:[.,]\d)?)\s*%$/.exec(p);
        if (bar) pct = `${Math.floor(Number(bar[1]!.replace(',', '.')))}%`;
        else {
          said = p.slice(0, 120);
          pct = null;
        }
      }
      if (said && Date.now() - shown > 250) {
        shown = Date.now();
        progress(pct ? `${said} ${pct}` : said);
      }
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, INSTALL_MS);
    const { reason } = await proc.exited;
    clearTimeout(timer);
    const at = out.lastIndexOf(TOOL_REPLY_PREFIX);
    if (at >= 0) {
      try {
        const parsed = JSON.parse(out.slice(at + TOOL_REPLY_PREFIX.length).split('\n')[0]!) as unknown;
        if (parsed && typeof parsed === 'object') reply = parsed as Record<string, unknown>;
      } catch { /* cut short */ }
    }
    log = log.split(TOOL_REPLY_PREFIX).join('').trim();
    if (reason) return { reply, log, why: `it was stopped. ${reason}` };
    if (timedOut) return { reply, log, why: `it took longer than ${INSTALL_MS / 60_000} minutes and was stopped.` };
    return { reply, log };
  }

  /** Leftovers of installs and removals a host did not finish. */
  private async tidy(): Promise<void> {
    for (const id of await readdir(this.root).catch(() => [] as string[])) {
      if (id.startsWith('.')) continue;
      for (const name of await readdir(join(this.root, id)).catch(() => [] as string[])) {
        const path = join(this.root, id, name);
        const old = name.startsWith('.trash-') || (name.startsWith('.staging-') && Date.now() - ((await stat(path).catch(() => null))?.mtimeMs ?? Date.now()) > STALE_MS);
        if (old) await rm(path, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
}

/** Bytes under a folder, not following links. */
export async function sizeOf(dir: string): Promise<number> {
  let bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let found: Dirent[];
    try {
      found = await readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of found) {
      const path = join(d, e.name);
      if (e.isDirectory()) stack.push(path);
      else bytes += await lstat(path).then((st) => st.size, () => 0);
    }
  }
  return bytes;
}

async function emptyDir(dir: string): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[]);
  await Promise.all(names.map((n) => rm(join(dir, n), { recursive: true, force: true })));
}
