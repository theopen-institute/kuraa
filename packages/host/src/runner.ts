// Running R code chunks. The host keeps one R session per document (started on
// the first run), runs requests for a document one at a time, and broadcasts
// each run's progress and outputs to everyone with the document open. Outputs
// are cached in .git/kuraa/outputs, never written into the document.
//
// Running code is running arbitrary programs on the host's machine, so it is off
// unless the host is started with it (`--allow-run`, or the desktop app for a
// folder it opened itself).
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import type { ChunkOutput, ChunkRef, PresenceUser, RoomMessage, RSessionInfo, RunRecord } from '@kuraa/session/server';
import { R_DRIVER, REPLY_PREFIX } from './r-driver.js';

/** Rscript on PATH, or in the usual install locations (apps started from the Dock get a short PATH). */
export function findRscript(explicit?: string): string | null {
  const given = explicit ?? process.env.KURAA_RSCRIPT;
  if (given) return existsSync(given) ? given : null;
  const exe = process.platform === 'win32' ? 'Rscript.exe' : 'Rscript';
  const dirs = [
    ...(process.env.PATH ?? '').split(delimiter),
    '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin',
    '/Library/Frameworks/R.framework/Resources/bin', '/opt/R/current/bin',
  ];
  for (const d of dirs) if (d && existsSync(join(d, exe))) return join(d, exe);
  return null;
}

const OWN_GROUP = process.platform !== 'win32';
const MAX_TEXT = 200_000;

type DriverOutput = Exclude<ChunkOutput, { type: 'image' }> | { type: 'image'; file: string; width: number; height: number };
interface DriverReply { type: 'result'; id: string; outputs: DriverOutput[]; interrupted?: boolean }
interface DriverRequest { id: string; code: string; options: string; dir: string; out: string }

/** One R process, talking line-delimited JSON over stdin and stdout. */
class RSession {
  info: RSessionInfo;
  private proc: ChildProcess | null = null;
  private buffer = '';
  private stray = '';
  private waiting: { id: string; resolve: (r: DriverReply) => void; reject: (e: Error) => void } | null = null;
  private ready: Promise<void> | null = null;
  private failure: string | null = null;

  constructor(private readonly o: {
    path: string; rscript: string; root: string; driver: string;
    onInfo: (info: RSessionInfo) => void; log: (m: string) => void;
  }) {
    this.info = { path: o.path, state: 'none', message: null };
  }

  private set(state: RSessionInfo['state'], message: string | null = this.info.message): void {
    this.info = { path: this.o.path, state, message };
    this.o.onInfo(this.info);
  }

  get alive(): boolean {
    return this.proc !== null && this.proc.exitCode === null && this.proc.signalCode === null;
  }

  start(): Promise<void> {
    if (this.ready) return this.ready;
    this.set('starting', null);
    // Started in the workspace root, so a project's .Rprofile (renv, for instance) applies.
    const proc = spawn(this.o.rscript, ['--no-save', '--no-restore', this.o.driver], {
      cwd: this.o.root, env: { ...process.env, R_KURAA: '1' }, detached: OWN_GROUP, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;
    this.ready = new Promise<void>((resolveReady, rejectReady) => {
      const timer = setTimeout(() => rejectReady(new Error('R did not start within 60 seconds.')), 60_000);
      const done = (err?: Error) => {
        clearTimeout(timer);
        if (err) rejectReady(err);
        else resolveReady();
      };
      proc.stdout!.setEncoding('utf8');
      proc.stdout!.on('data', (chunk: string) => {
        this.buffer += chunk;
        let nl: number;
        while ((nl = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, nl);
          this.buffer = this.buffer.slice(nl + 1);
          const at = line.indexOf(REPLY_PREFIX);
          if (at < 0) {
            this.strayOutput(line + '\n');
            continue;
          }
          if (at > 0) this.strayOutput(line.slice(0, at));
          let msg: { type: string; [k: string]: unknown };
          try {
            msg = JSON.parse(line.slice(at + REPLY_PREFIX.length)) as typeof msg;
          } catch {
            continue;
          }
          if (msg.type === 'ready') {
            this.set('ready', String(msg.r ?? 'R'));
            done();
          } else if (msg.type === 'fatal') {
            this.failure = String(msg.message ?? 'R failed to start.');
            done(new Error(this.failure));
          } else if (msg.type === 'result' && this.waiting?.id === msg.id) {
            const w = this.waiting!;
            this.waiting = null;
            w.resolve(msg as unknown as DriverReply);
          }
        }
      });
      proc.stderr!.setEncoding('utf8');
      proc.stderr!.on('data', (chunk: string) => this.strayOutput(chunk));
      proc.on('error', (e) => {
        this.failure = `Could not start R (${this.o.rscript}): ${e.message}`;
        done(new Error(this.failure));
      });
      proc.on('exit', (code, signal) => {
        const why = this.failure ?? `R exited (${signal ?? `status ${code}`}).`;
        this.proc = null;
        this.set(this.failure ? 'failed' : 'stopped', why);
        done(new Error(why));
        const w = this.waiting;
        this.waiting = null;
        w?.reject(new Error(this.stray ? `${why}\n${this.stray.trim()}` : why));
      });
    });
    this.ready.catch(() => undefined);
    return this.ready;
  }

  /** Output that did not come through evaluate: startup messages, output from system(), crashes. */
  private strayOutput(text: string): void {
    if (this.waiting) this.stray += text;
    else if (text.trim()) this.o.log(`R (${this.o.path}): ${text.trim()}`);
  }

  async exec(req: DriverRequest): Promise<{ reply: DriverReply; stray: string }> {
    await this.start();
    if (!this.alive) throw new Error(this.info.message ?? 'R is not running.');
    this.stray = '';
    this.set('busy');
    try {
      const reply = await new Promise<DriverReply>((resolveReply, rejectReply) => {
        this.waiting = { id: req.id, resolve: resolveReply, reject: rejectReply };
        this.proc!.stdin!.write(JSON.stringify(req) + '\n');
      });
      return { reply, stray: this.stray };
    } finally {
      if (this.alive) this.set('ready');
    }
  }

  interrupt(): void {
    if (this.alive && this.waiting) this.proc!.kill('SIGINT');
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc || !this.alive) return;
    const exited = new Promise<void>((r) => proc.once('exit', () => r()));
    proc.stdin!.end();
    const kill = setTimeout(() => proc.kill('SIGKILL'), 3000);
    if (this.waiting) proc.kill('SIGTERM');
    await exited;
    clearTimeout(kill);
  }
}

interface Job {
  record: RunRecord;
  code: string;
  options: string;
}

export interface RunnerOptions {
  /** Workspace root; R starts here. */
  root: string;
  /** Where the runner keeps its driver, plot files and output cache (inside .git). */
  stateDir: string;
  rscript: string | null;
  broadcast: (path: string, message: RoomMessage) => void;
  log: (m: string) => void;
  /** Stop a document's R session after this long without runs. */
  idleMs?: number;
}

export class Runner {
  private readonly sessions = new Map<string, RSession>();
  private readonly queues = new Map<string, Job[]>();
  private readonly active = new Map<string, Job>();
  private readonly idle = new Map<string, NodeJS.Timeout>();
  private closed = false;

  constructor(private readonly o: RunnerOptions) {}

  get available(): boolean {
    return this.o.rscript !== null;
  }

  private cacheFile(path: string): string {
    return join(this.o.stateDir, 'outputs', createHash('sha1').update(path).digest('hex') + '.json');
  }

  /** The latest run of each chunk, as cached. */
  async outputs(path: string): Promise<RunRecord[]> {
    try {
      return (JSON.parse(await readFile(this.cacheFile(path), 'utf8')) as { runs: RunRecord[] }).runs;
    } catch {
      return [];
    }
  }

  session(path: string): RSessionInfo {
    return this.sessions.get(path)?.info ?? { path, state: 'none', message: null };
  }

  /** Runs for a document that have not finished, in order. */
  pending(path: string): RunRecord[] {
    const active = this.active.get(path);
    return [...(active ? [active.record] : []), ...(this.queues.get(path) ?? []).map((j) => j.record)];
  }

  /** Queue code from a chunk of the document at `path`. */
  run(path: string, req: { code: string; header: string; chunk: ChunkRef; by: PresenceUser }): RunRecord {
    if (!this.o.rscript) throw new Error('R was not found on this host.');
    const record: RunRecord = {
      id: `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
      path,
      chunk: req.chunk,
      state: 'queued',
      outputs: [],
      by: { name: req.by.name, color: req.by.color },
      queuedAt: new Date().toISOString(),
      finishedAt: null,
      ms: null,
    };
    // The header is `r label, options`: knitr's options are everything after the engine.
    const options = req.header.replace(/^\s*[A-Za-z][\w-]*\s*,?\s*/, '');
    const queue = this.queues.get(path) ?? [];
    queue.push({ record, code: req.code, options });
    this.queues.set(path, queue);
    this.o.broadcast(path, { type: 'run', run: record });
    void this.pump(path);
    return record;
  }

  private sessionFor(path: string): RSession {
    let s = this.sessions.get(path);
    if (!s) {
      s = new RSession({
        path,
        rscript: this.o.rscript!,
        root: this.o.root,
        driver: join(this.o.stateDir, 'run', 'driver.R'),
        onInfo: (info) => this.o.broadcast(path, { type: 'r-session', session: info }),
        log: this.o.log,
      });
      this.sessions.set(path, s);
    }
    return s;
  }

  private async pump(path: string): Promise<void> {
    if (this.active.has(path) || this.closed) return;
    const job = this.queues.get(path)?.shift();
    if (!job) {
      this.scheduleIdle(path);
      return;
    }
    clearTimeout(this.idle.get(path));
    this.active.set(path, job);
    const { record } = job;
    record.state = 'running';
    this.o.broadcast(path, { type: 'run', run: record });
    const started = Date.now();
    const outDir = join(this.o.stateDir, 'run', 'plots');
    try {
      await mkdir(outDir, { recursive: true });
      await writeFile(join(this.o.stateDir, 'run', 'driver.R'), R_DRIVER);
      let session = this.sessionFor(path);
      if (!session.alive && session.info.state !== 'none' && session.info.state !== 'starting') {
        // It stopped or crashed: start a fresh one.
        this.sessions.delete(path);
        session = this.sessionFor(path);
      }
      const { reply, stray } = await session.exec({
        id: record.id, code: job.code, options: job.options,
        dir: dirname(resolve(this.o.root, path)), out: outDir,
      });
      record.outputs = await this.collect(reply.outputs, stray);
      record.state = reply.interrupted ? 'interrupted' : record.outputs.some((o) => o.type === 'error') ? 'failed' : 'done';
      if (reply.interrupted) record.outputs.push({ type: 'note', text: 'Interrupted.' });
    } catch (e) {
      record.state = 'failed';
      record.outputs.push({ type: 'error', text: (e as Error).message });
    }
    record.ms = Date.now() - started;
    record.finishedAt = new Date().toISOString();
    this.active.delete(path);
    this.o.broadcast(path, { type: 'run', run: record });
    await this.remember(record).catch((e) => this.o.log(`could not cache outputs: ${e}`));
    void this.pump(path);
  }

  /** Read plot files into the outputs, merge adjacent text, and cap its size. */
  private async collect(outputs: DriverOutput[], stray: string): Promise<ChunkOutput[]> {
    const out: ChunkOutput[] = [];
    for (const o of outputs ?? []) {
      if (o.type === 'image' && 'file' in o) {
        try {
          const data = (await readFile(o.file)).toString('base64');
          out.push({ type: 'image', mime: 'image/png', data, width: o.width, height: o.height });
        } catch {
          out.push({ type: 'error', text: 'A plot could not be read.' });
        }
        await rm(o.file, { force: true });
        continue;
      }
      const prev = out[out.length - 1];
      if (o.type === 'text' && prev?.type === 'text') prev.text += o.text;
      else out.push(o as ChunkOutput);
    }
    if (stray.trim()) out.push({ type: 'message', text: stray });
    for (const o of out) {
      if ('text' in o && o.text.length > MAX_TEXT) o.text = `${o.text.slice(0, MAX_TEXT)}\n… (${o.text.length - MAX_TEXT} more characters not shown)`;
    }
    return out;
  }

  /** Keep the latest run of each chunk: same label, or same position among unlabelled chunks, or same code. */
  private async remember(record: RunRecord): Promise<void> {
    if (record.state === 'cancelled') return;
    const c = record.chunk;
    const same = (r: RunRecord) =>
      (c.label !== null && r.chunk.label === c.label) ||
      (c.label === null && r.chunk.label === null && r.chunk.index === c.index) ||
      r.chunk.codeHash === c.codeHash;
    const runs = [...(await this.outputs(record.path)).filter((r) => !same(r)), record];
    const file = this.cacheFile(record.path);
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ path: record.path, runs }));
    await rename(tmp, file);
  }

  /** Forget one chunk's output, or all of a document's. */
  async clear(path: string, chunk?: ChunkRef): Promise<void> {
    const runs = chunk
      ? (await this.outputs(path)).filter((r) => !(r.chunk.index === chunk.index && r.chunk.label === chunk.label && r.chunk.codeHash === chunk.codeHash))
      : [];
    const file = this.cacheFile(path);
    if (!runs.length) await rm(file, { force: true });
    else await writeFile(file, JSON.stringify({ path, runs }));
  }

  /** Stop what is running for a document, and drop what is queued. */
  interrupt(path: string): void {
    for (const job of this.queues.get(path)?.splice(0) ?? []) {
      job.record.state = 'cancelled';
      job.record.finishedAt = new Date().toISOString();
      this.o.broadcast(path, { type: 'run', run: job.record });
    }
    this.sessions.get(path)?.interrupt();
  }

  /** A fresh R session for a document: everything defined so far is gone. */
  async restart(path: string): Promise<void> {
    this.interrupt(path);
    const s = this.sessions.get(path);
    this.sessions.delete(path);
    await s?.stop();
    this.o.broadcast(path, { type: 'r-session', session: { path, state: 'none', message: 'Restarted.' } });
  }

  /** A session has been idle for idleMs: stop it to give the memory back. */
  private scheduleIdle(path: string): void {
    clearTimeout(this.idle.get(path));
    const ms = this.o.idleMs ?? 60 * 60 * 1000;
    this.idle.set(path, setTimeout(() => {
      if (this.active.has(path)) return;
      const s = this.sessions.get(path);
      this.sessions.delete(path);
      void s?.stop().then(() => this.o.log(`stopped idle R session for ${path}`));
    }, ms).unref());
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const t of this.idle.values()) clearTimeout(t);
    for (const path of this.queues.keys()) this.interrupt(path);
    await Promise.all([...this.sessions.values()].map((s) => s.stop()));
    this.sessions.clear();
  }
}
