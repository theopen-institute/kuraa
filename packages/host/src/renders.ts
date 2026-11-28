// Rendering documents to HTML, Word, PDF and EPUB (0106), through run components.
//
// The host knows neither R nor pandoc: an engine that is on renders the file
// types it says it does (run-kit's DocumentRenderer), in the environment code
// runs in, with the workspace read-only and no network. The document is
// rendered as it is now: its open room is written to the file first.
//
// Outputs never go into the working tree. Each document's latest render in
// each format is kept in .git/kuraa/renders/, with what was said about it, and
// served to the app (GET /api/renders/file) for the preview and for saving.
// One render runs at a time per document; asking again for one under way
// joins it.
//
// Documents of a kind a renderer with no environment renders (Markdown:
// decision 0107, pandoc.wasm and Typst) are rendered by it, code running here
// or not, unless it says an engine should (a PDF asking for LaTeX) and one can.
// It reads the workspace's files only through the host (read()).
//
// Tools (decision 0045): a render may use one (TeX), which the runner mounts
// for it. A render whose log says the tool lacks parts (LaTeX packages) runs
// again once they are added, where installs are allowed: a few times at most,
// as long as each round adds something (a package's own needs show only once
// it loads). One that needs a tool this computer does not have says so, with
// what to offer people (`needs`).
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, posix, resolve } from 'node:path';
import type { Renderer, RenderFormat, RenderResult } from '@kuraa/run-kit';
import type { MadeFrom, PresenceUser } from '@kuraa/session/server';
import type { Json } from '@kuraa/feature-kit';
import type { Runner } from './runner.js';
import { renameOver } from './files.js';
import { checkMadeFrom } from './madefrom.js';

export type { RenderFormat };
export const RENDER_FORMATS: RenderFormat[] = ['html', 'docx', 'pdf', 'epub'];
/** The most times a render runs again after adding parts its tools lacked. */
const MAX_REPAIRS = 4;
/** The largest output kept. */
const MAX_OUTPUT = 256 * 1024 * 1024;
/** The most of a render's log kept and sent. */
const MAX_LOG = 200_000;

export interface RenderState {
  path: string;
  format: RenderFormat;
  state: 'rendering' | 'done' | 'failed';
  /** What to tell people, in plain words. */
  message: string;
  /** While rendering: what is happening now (building the environment, say). */
  progress: string | null;
  /** What the tools said, for a Details disclosure. */
  log: string;
  by: string | null;
  startedAt: string;
  finishedAt: string | null;
  /**
   * The latest output of this format, if there is one (it may be from before a failed render), and what it
   * was made from (0081; absent on renders from before).
   */
  output: { at: string; size: number; madeFrom?: MadeFrom } | null;
  /** A tool the document needs that this computer lacks, and people may download: what to offer. */
  needs?: { tool: string; label: string; downloadBytes: number } | null;
}

/** What the app is told about rendering a document. */
export interface RenderInfo {
  /** Formats it can be rendered to here; none if it cannot be. */
  formats: RenderFormat[];
  /** Why it cannot be rendered now, if it cannot. */
  unavailable: string | null;
  renders: RenderState[];
}

export const MIME: Record<RenderFormat, string> = {
  html: 'text/html; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  epub: 'application/epub+zip',
};

/** A folder's documents joined, to render: the folders where what they refer to is found, and files to put beside it (a Word template, a cover: 0106). */
export interface CompiledBook {
  text: string;
  resources: string[];
  files?: { name: string; from: string }[];
}

/** What renders a path: a folder (ending in `/`: 0093) is compiled to Markdown, and rendered as that. */
const asRendered = (path: string): string => (path.endsWith('/') ? `${path === '/' ? '' : path}book.md` : path);

/** What a compiled folder's book is called (its output's name): the folder's name. */
export const bookName = (path: string): string => (path === '/' ? 'book' : path.replace(/\/$/, '').split('/').pop() || 'book');

/** How a render is made: by a renderer with no environment (0107), by an engine where code runs, or why not. */
type RenderRoute = { alone: Renderer } | { engine: NonNullable<ReturnType<Runner['rendererFor']>> } | { why: string };

export class Renders {
  private readonly current = new Map<string, { state: RenderState; done: Promise<RenderState> }>();
  /** One render at a time per document. */
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly closing = new AbortController();

  constructor(private readonly o: {
    root: string;
    stateDir: string;
    runner: Runner;
    /** Write the document's open room, if it has one, to its file, and commit it. */
    flush(path: string): Promise<void>;
    /** What code rendering a document reads now: the commits, and the files that differ from them (0081). */
    madeFrom(path: string): Promise<MadeFrom>;
    /** A folder's documents joined, to compile it (0093: '' the top level) to a format, as `request` asks (0122: the feature's to read); a string says why not. */
    compile(folder: string, request: Json, format: RenderFormat): Promise<CompiledBook | string>;
    /**
     * A workspace file a renderer with no environment reads for a document
     * (0107): inside the workspace, not .git, through no link, not hidden from
     * the document's readers; null if not.
     */
    read(path: string, file: string): Promise<Buffer | null>;
    log(m: string): void;
  }) {}

  /** What a render of a folder (a path ending in `/`, the top level `/`: 0093) compiles, as it was asked. */
  private readonly compiling = new Map<string, Json>();

  private dir(path: string): string {
    return join(this.o.stateDir, 'renders', createHash('sha1').update(path).digest('hex').slice(0, 20));
  }

  private outputFile(path: string, format: RenderFormat): string {
    return join(this.dir(path), `output.${format}`);
  }

  /** Why a document cannot be rendered where code runs, here and now, or null if it can. */
  private async engineUnavailable(path: string): Promise<string | null> {
    const { runner } = this.o;
    if (!runner.enabled) return runner.standaloneFor(asRendered(path)) ? 'This needs code to run (Podman), and running code is off on this host. Whoever runs the host can turn it on.' : 'Rendering is turned off on this host: documents are rendered where code runs, and running code is off here. Whoever runs the host can turn it on.';
    if (!runner.rendererFor(asRendered(path))) return 'Nothing on this host renders this kind of file.';
    const { environment } = await runner.describe();
    if (!environment?.available) return environment?.message ?? 'There is nowhere to render documents.';
    return null;
  }

  /**
   * How a format of a document is rendered (0107): by a renderer that needs no
   * environment, where one renders its kind and can make the format here,
   * unless it would rather an engine did (`prefersEngine`, asked once the input
   * is there) and one can; else by an engine, where code runs; else why not.
   */
  private async route(path: string, format: RenderFormat, input?: string): Promise<RenderRoute> {
    const { runner } = this.o;
    const alone = runner.standaloneFor(asRendered(path));
    const found = runner.rendererFor(asRendered(path));
    const engine = async () => (found?.renderer.formats.includes(format) && !(await this.engineUnavailable(path)) ? found : null);
    if (alone?.formats.includes(format)) {
      const cannot = await alone.unavailable(format);
      if (!cannot) {
        // Where code runs, as the host's Settings may ask (Render Markdown where code runs), or as the renderer would rather.
        const prefers = runner.renderWhereCodeRuns || (input && alone.prefersEngine ? await alone.prefersEngine({ input, format }).catch(() => null) : null);
        const e = prefers ? await engine() : null;
        return e ? { engine: e } : { alone };
      }
      const e = await engine();
      return e ? { engine: e } : { why: cannot };
    }
    const why = await this.engineUnavailable(path);
    if (why) return { why };
    return found?.renderer.formats.includes(format) ? { engine: found } : { why: `This document cannot be rendered to ${format}.` };
  }

  async info(path: string): Promise<RenderInfo> {
    const alone = this.o.runner.standaloneFor(asRendered(path));
    const found = this.o.runner.rendererFor(asRendered(path));
    const formats = RENDER_FORMATS.filter((f) => alone?.formats.includes(f) || found?.renderer.formats.includes(f));
    const renders: RenderState[] = [];
    for (const format of formats) {
      const live = this.current.get(`${path}\0${format}`);
      const saved = live?.state ?? (await this.saved(path, format));
      if (saved) renders.push(saved);
    }
    // Whether it can be rendered at all: to HTML, as for the page.
    const page = formats.length ? await this.route(path, 'html') : { why: 'Nothing on this host renders this kind of file.' };
    return { formats, unavailable: 'why' in page ? page.why : null, renders };
  }

  private async saved(path: string, format: RenderFormat): Promise<RenderState | null> {
    try {
      const state = JSON.parse(await readFile(join(this.dir(path), `${format}.json`), 'utf8')) as RenderState;
      if (state.output?.madeFrom !== undefined) {
        const made = checkMadeFrom(state.output.madeFrom);
        if (made) state.output.madeFrom = made;
        else delete state.output.madeFrom;
      }
      return state;
    } catch {
      return null;
    }
  }

  /** What the latest output of a format was made from, if it says. */
  async madeFrom(path: string, format: RenderFormat): Promise<MadeFrom | null> {
    const live = this.current.get(`${path}\0${format}`);
    return (live?.state ?? (await this.saved(path, format)))?.output?.madeFrom ?? null;
  }

  /** The latest output of a format, if there is one. */
  async output(path: string, format: RenderFormat): Promise<Buffer | null> {
    try {
      return await readFile(this.outputFile(path, format));
    } catch {
      return null;
    }
  }

  /** Render a document, or join its render in this format under way. Resolves once it has started; `done` when it has finished. */
  async render(path: string, format: RenderFormat, person: PresenceUser | null, compile?: Json): Promise<{ state: RenderState; done: Promise<RenderState> }> {
    const by = person?.name ?? null;
    const key = `${path}\0${format}`;
    const under = this.current.get(key);
    if (under) return under;
    if (path.endsWith('/')) this.compiling.set(key, compile ?? {});
    const route = await this.route(path, format);
    const previous = await this.saved(path, format);
    const now = new Date().toISOString();
    const state: RenderState = {
      path, format, state: 'rendering', message: 'Waiting to render…', progress: null, log: '', by,
      startedAt: now, finishedAt: null, output: previous?.output ?? null,
    };
    if ('why' in route) {
      this.compiling.delete(key);
      const failed = { ...state, state: 'failed' as const, message: route.why, finishedAt: now };
      return { state: failed, done: Promise.resolve(failed) };
    }
    const job = (this.queues.get(path) ?? Promise.resolve()).then(() => this.run(state, person));
    const done = job.then(() => state, (e: Error) => {
      Object.assign(state, { state: 'failed', message: e.message, finishedAt: new Date().toISOString(), progress: null });
      return state;
    }).then(async (s) => {
      this.current.delete(key);
      this.compiling.delete(key);
      await this.keep(s).catch((e: Error) => this.o.log(`could not keep the render of ${path}: ${e.message}`));
      return s;
    });
    this.queues.set(path, done);
    void done.then(() => {
      if (this.queues.get(path) === done) this.queues.delete(path);
    });
    const entry = { state, done };
    this.current.set(key, entry);
    return entry;
  }

  private async run(state: RenderState, person: PresenceUser | null): Promise<void> {
    const { path, format } = state;
    state.message = 'Rendering…';
    // A folder (0093): its documents joined, each as it is now, into one in scratch.
    const compile = this.compiling.get(`${path}\0${format}`);
    let joined: CompiledBook | null = null;
    if (compile !== undefined) {
      state.message = 'Putting the documents together…';
      const r = await this.o.compile(path === '/' ? '' : path.slice(0, -1), compile, format);
      if (typeof r === 'string') {
        Object.assign(state, { state: 'failed', message: r, finishedAt: new Date().toISOString(), progress: null });
        return;
      }
      joined = r;
      state.message = 'Rendering…';
    }
    // The document as it is now: what is being typed reaches the file (and a commit) first.
    if (!joined) await this.o.flush(path);
    const madeFrom = joined ? undefined : await this.o.madeFrom(path).catch((e: Error) => {
      this.o.log(`could not say what ${path} was rendered from: ${e.message}`);
      return undefined;
    });
    const scratch = join(this.o.stateDir, 'run', 'render', createHash('sha1').update(path).digest('hex').slice(0, 12));
    // Emptied, not made again: Podman on a Mac can take a folder removed and made again for one missing.
    await mkdir(scratch, { recursive: true });
    await emptyDir(scratch);
    const progress = (m: string) => (state.progress = m);
    /** The document to render: its file, or (a folder: 0093) the book joined in scratch, the workspace being read-only to the render and staying as it is. */
    const prepare = async (): Promise<string> => {
      if (!joined) return resolve(this.o.root, path);
      const input = join(scratch, 'in', `${bookName(path)}.md`);
      await mkdir(dirname(input), { recursive: true });
      await writeFile(input, joined.text);
      // Beside it, by the names its header gives them: a Word template, a cover (0106).
      for (const f of joined.files ?? []) await copyFile(f.from, join(scratch, 'in', f.name));
      return input;
    };
    const resources = joined ? { resources: joined.resources } : {};
    let tools: ReturnType<Runner['renderTools']> | null = null;
    try {
      let result: RenderResult;
      const input = await prepare();
      const route = await this.route(path, format, input);
      if ('why' in route) result = { ok: false, message: route.why, log: '' };
      else if ('alone' in route) {
        // Rendered with no environment (0107): given what it reads, as the host lets it have it.
        const r = route.alone;
        result = await r.render({
          scratch,
          workspace: this.o.root,
          read: (file) => this.o.read(asRendered(path), file),
          timeLimitMs: this.o.runner.renderTimeLimitMs,
          signal: this.closing.signal,
          log: (m) => this.o.log(`${r.id} render: ${m}`),
          status: progress,
        }, { input, format, ...resources });
      } else {
        const found = route.engine;
        tools = this.o.runner.renderTools(person && person.email ? person : null, progress);
        const added: string[] = [];
        for (let round = 0; ; round++) {
          const ctx = await this.o.runner.renderContext(found.engine, scratch, this.closing.signal, progress, tools, asRendered(path));
          result = await found.renderer.render(ctx, { input: round ? await prepare() : input, format, ...resources });
          if (result.ok || round >= MAX_REPAIRS || this.closing.signal.aborted) break;
          // Parts its tools lacked (LaTeX packages): added, then rendered again.
          const repair = await tools.repair(result.log);
          if (!repair) break;
          if (!repair.ok) {
            result = { ...result, message: `${result.message} ${repair.message}` };
            break;
          }
          added.push(...repair.added);
          progress('Rendering again…');
          await emptyDir(scratch);
        }
        if (added.length) result = { ...result, message: `${result.message} Added ${added.join(', ')} to this computer for it.` };
      }
      state.needs = result.needs ? this.o.runner.toolOffer(result.needs.tool) : null;
      state.log = result.log.length > MAX_LOG ? `…\n${result.log.slice(-MAX_LOG)}` : result.log;
      state.message = result.message;
      if (result.ok && result.output) {
        const bytes = await readOutput(scratch, result.output);
        if (!bytes) {
          state.state = 'failed';
          state.message = 'The render finished, but what it made could not be read.';
        } else {
          await mkdir(this.dir(path), { recursive: true });
          const file = this.outputFile(path, format);
          const tmp = `${file}.${process.pid}.tmp`;
          await writeFile(tmp, bytes);
          await renameOver(tmp, file);
          state.state = 'done';
          state.output = { at: new Date().toISOString(), size: bytes.length, ...(madeFrom ? { madeFrom } : {}) };
        }
      } else state.state = 'failed';
    } finally {
      tools?.release();
      state.progress = null;
      state.finishedAt = new Date().toISOString();
      await emptyDir(scratch).catch(() => undefined);
    }
  }

  private async keep(state: RenderState): Promise<void> {
    await mkdir(this.dir(state.path), { recursive: true });
    await writeFile(join(this.dir(state.path), `${state.format}.json`), JSON.stringify(state));
  }

  close(): void {
    this.closing.abort();
  }
}

/**
 * A file a render's process made, inside scratch: only through real folders (not
 * links it may have left), and only a plain file of a sensible size. Null if not.
 */
export async function readOutput(scratch: string, relative: string): Promise<Buffer | null> {
  const parts = posix.normalize(relative).split('/');
  if (!parts.length || parts.some((p) => !p || p === '.' || p === '..')) return null;
  let at = scratch;
  for (const dir of parts.slice(0, -1)) {
    at = join(at, dir);
    const st = await lstat(at).catch(() => null);
    if (!st?.isDirectory()) return null;
  }
  const file = join(at, parts[parts.length - 1]!);
  try {
    if (process.platform === 'win32' && !(await lstat(file)).isFile()) return null;
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const st = await handle.stat();
      if (!st.isFile() || st.size > MAX_OUTPUT) return null;
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/** Remove what is in a folder, keeping the folder. */
async function emptyDir(dir: string): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[]);
  await Promise.all(names.map((n) => rm(join(dir, n), { recursive: true, force: true })));
}
