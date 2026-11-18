// Runnable chunks on the client: which chunks a document has, the runs the host
// reports for it, which run belongs to which chunk, and how outputs look.
//
// Chunks have no ids in the file, so runs are matched to chunks in passes: by
// label, then by code, then by position among unlabelled chunks. A run claimed
// in an earlier pass is not offered to later ones, so a chunk inserted above
// another does not take over its output.
import { hashText, type NodeViewHint } from '@kuraa/kernel';
import type { ChunkOutput, ChunkRef, RoomMessage, RunRecord, RunSessionInfo } from '@kuraa/session/model';
import type { Node as PMNode } from 'prosemirror-model';
import type { HostApi, RunInfo } from './api.js';

export interface Chunk {
  pos: number;
  index: number;
  engine: string;
  label: string | null;
  header: string;
  code: string;
  codeHash: string;
}

type RunHint = Extract<NodeViewHint, { kind: 'code' }>;

/** knitr's reading of a chunk header: `r label, opt = value` → engine and label. */
export function parseHeader(header: string): { engine: string; label: string | null } {
  const text = header.trim();
  const engine = /^[A-Za-z][\w-]*/.exec(text)?.[0] ?? '';
  const after = text.slice(engine.length).replace(/^[\s,]+/, '');
  const named = /(?:^|,)\s*label\s*=\s*(["'])(.*?)\1/.exec(after);
  const first = after.split(',')[0]!.trim();
  const label = named ? named[2]! : first && !first.includes('=') ? first.replace(/^["']|["']$/g, '') : '';
  return { engine: engine.toLowerCase(), label: label || null };
}

export function chunkOf(node: PMNode, hint: RunHint, pos: number, index: number): Chunk {
  const header = hint.header ? String(node.attrs[hint.header.attr] ?? '') : '';
  const parsed = parseHeader(header);
  const engine = parsed.engine || String(node.attrs[hint.run!.engineAttr] ?? '').toLowerCase();
  const code = node.textContent;
  return { pos, index, engine, label: parsed.label, header: header || engine, code, codeHash: hashText(code) };
}

/** Every runnable block in a document, in order. */
export function collectChunks(doc: PMNode, hints: Record<string, NodeViewHint>): Chunk[] {
  const out: Chunk[] = [];
  doc.descendants((node, pos) => {
    const hint = hints[node.type.name];
    if (hint?.kind === 'code' && hint.run) out.push(chunkOf(node, hint, pos, out.length));
    return !node.isTextblock;
  });
  return out;
}

const FINISHED = new Set(['done', 'failed', 'interrupted']);
const PENDING = new Set(['queued', 'running']);

export interface ChunkState {
  /** The latest finished run, whose outputs are shown. */
  last: RunRecord | null;
  /** A run waiting or under way. */
  pending: RunRecord | null;
  /** The chunk's code has changed since `last` ran. */
  stale: boolean;
}

const EMPTY: ChunkState = { last: null, pending: null, stale: false };

export class ChunkRunner {
  private readonly runs = new Map<string, RunRecord>();
  private chunks: Chunk[] = [];
  private states = new Map<number, ChunkState>();
  private readonly listeners = new Set<() => void>();
  session: RunSessionInfo;
  /** The latest news about packages (an install's progress or result), and a counter that changes with it. */
  packageNews: { engine: string; message: string; at: number } | null = null;
  /** Bumped on every change. */
  version = 0;

  constructor(
    private readonly api: HostApi,
    readonly path: string,
    /** What the host runs, and where. */
    readonly info: RunInfo,
    private readonly user: () => { name: string; email: string; color: string },
  ) {
    this.session = { path, engine: null, environment: null, state: 'none', message: null };
  }

  canRun(engine: string): boolean {
    return this.info.engines.some((e) => e.handles.includes(engine.toLowerCase()));
  }

  /** The engine's name for the session's engine, or for the document's chunks: 'R'. */
  get engineLabel(): string {
    const byId = this.info.engines.find((e) => e.id === this.session.engine);
    const used = this.info.engines.find((e) => this.chunks.some((c) => e.handles.includes(c.engine)));
    return (byId ?? used)?.label ?? 'Code';
  }

  get hasRunnableChunks(): boolean {
    return this.chunks.some((c) => this.canRun(c.engine));
  }

  get busy(): boolean {
    return [...this.runs.values()].some((r) => PENDING.has(r.state));
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.assign();
    this.version++;
    for (const fn of this.listeners) fn();
  }

  async load(): Promise<void> {
    const r = await this.api.runs(this.path);
    for (const run of [...r.runs, ...r.pending]) if (!this.runs.has(run.id)) this.runs.set(run.id, run);
    this.session = r.session;
    this.emit();
  }

  receive(m: RoomMessage): void {
    if (m.type === 'run' && m.run.path === this.path) {
      if (m.run.state === 'cancelled') this.runs.delete(m.run.id);
      else this.runs.set(m.run.id, m.run);
      this.emit();
    } else if (m.type === 'packages') {
      this.packageNews = { engine: m.engine, message: m.message, at: Date.now() };
      this.emit();
    } else if (m.type === 'run-session' && m.session.path === this.path) {
      this.session = m.session;
      this.emit();
    }
  }

  setChunks(chunks: Chunk[]): void {
    this.chunks = chunks;
    this.emit();
  }

  chunkAt(pos: number): Chunk | undefined {
    return this.chunks.find((c) => c.pos === pos);
  }

  state(pos: number): ChunkState {
    return this.states.get(pos) ?? EMPTY;
  }

  private assign(): void {
    const claimed = new Set<string>();
    const mine = new Map<number, RunRecord[]>();
    const runs = [...this.runs.values()];
    const pass = (match: (c: Chunk, r: RunRecord) => boolean) => {
      for (const c of this.chunks) {
        for (const r of runs) {
          if (claimed.has(r.id) || !match(c, r)) continue;
          claimed.add(r.id);
          mine.set(c.pos, [...(mine.get(c.pos) ?? []), r]);
        }
      }
    };
    pass((c, r) => c.label !== null && r.chunk.label === c.label);
    pass((c, r) => r.chunk.codeHash === c.codeHash && (c.label === null || r.chunk.label === null));
    pass((c, r) => c.label === null && r.chunk.label === null && r.chunk.index === c.index);
    this.states = new Map();
    for (const c of this.chunks) {
      const list = (mine.get(c.pos) ?? []).sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
      const last = [...list].reverse().find((r) => FINISHED.has(r.state)) ?? null;
      const pending = [...list].reverse().find((r) => PENDING.has(r.state)) ?? null;
      this.states.set(c.pos, { last, pending, stale: !!last && !last.chunk.partial && last.chunk.codeHash !== c.codeHash });
    }
  }

  private ref(c: Chunk, code: string, partial: boolean): ChunkRef {
    return { label: c.label, index: c.index, codeHash: partial ? c.codeHash : hashText(code), partial };
  }

  /** Run a chunk, or part of it (a line or a selection). */
  async run(c: Chunk, part?: string): Promise<void> {
    const code = part ?? c.code;
    const run = await this.api.run({ path: this.path, engine: c.engine, code, header: c.header, chunk: this.ref(c, code, part !== undefined), by: this.user() });
    // The host's broadcast may have arrived first, with a later state.
    if (!this.runs.has(run.id)) {
      this.runs.set(run.id, run);
      this.emit();
    }
  }

  /** Run every runnable chunk before `pos`, in order. */
  async runAbove(pos: number): Promise<void> {
    for (const c of this.chunks) if (c.pos < pos && this.canRun(c.engine)) await this.run(c);
  }

  async runAll(): Promise<void> {
    for (const c of this.chunks) if (this.canRun(c.engine)) await this.run(c);
  }

  interrupt(): Promise<unknown> {
    return this.api.interruptRuns(this.path);
  }

  restart(): Promise<unknown> {
    return this.api.restartRuns(this.path);
  }

  /** The engine whose packages this document's chunks use, if it manages packages. */
  get packageEngine(): string | null {
    const engine = this.info.engines.find((e) => e.packages && this.chunks.some((c) => e.handles.includes(c.engine)));
    return engine?.id ?? null;
  }

  listPackages(engine: string) {
    return this.api.packages(engine);
  }

  installPackages(engine: string, refs: string[]) {
    return this.api.installPackages(engine, refs, this.user());
  }

  removePackages(engine: string, names: string[]) {
    return this.api.removePackages(engine, names, this.user());
  }

  async clear(pos: number): Promise<void> {
    const s = this.state(pos);
    if (!s.last) return;
    for (const [id, r] of this.runs) if (r.id === s.last.id || (r.chunk.codeHash === s.last.chunk.codeHash && FINISHED.has(r.state))) this.runs.delete(id);
    this.emit();
    await this.api.clearRuns(this.path, s.last.chunk);
  }
}

// ---------------------------------------------------------------------------
// Rendering outputs (plain DOM; used inside the chunk's node view)

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
};

const SHOWN_ROWS = 100;

function renderTable(o: Extract<ChunkOutput, { type: 'table' }>): HTMLElement {
  const wrap = el('div', 'out-table');
  const table = el('table');
  const head = el('tr');
  if (o.rownames) head.append(el('th', 'rowname'));
  o.columns.forEach((name, i) => {
    const th = el('th', undefined, name);
    th.append(el('span', 'out-type', o.types[i] ?? ''));
    head.append(th);
  });
  const thead = el('thead');
  thead.append(head);
  table.append(thead);
  const body = el('tbody');
  const rows = Math.min(o.data[0]?.length ?? 0, SHOWN_ROWS);
  for (let r = 0; r < rows; r++) {
    const tr = el('tr');
    if (o.rownames) tr.append(el('th', 'rowname', o.rownames[r] ?? ''));
    for (const col of o.data) {
      const v = col[r] ?? '';
      tr.append(el('td', v === 'NA' ? 'na' : undefined, v));
    }
    body.append(tr);
  }
  table.append(body);
  wrap.append(table);
  const fmt = (n: number) => n.toLocaleString();
  wrap.append(el('div', 'out-table-foot', `${rows < o.nrow ? `${fmt(rows)} of ` : ''}${fmt(o.nrow)} row${o.nrow === 1 ? '' : 's'} · ${fmt(o.ncol)} column${o.ncol === 1 ? '' : 's'}`));
  return wrap;
}

export function renderOutputs(outputs: ChunkOutput[]): HTMLElement[] {
  return outputs.map((o) => {
    switch (o.type) {
      case 'image': {
        const img = el('img', 'out-image');
        // Raster images only: an SVG from a chunk could carry script.
        if (/^image\/(png|jpeg|gif|webp)$/.test(o.mime)) img.src = `data:${o.mime};base64,${o.data}`;
        img.width = o.width;
        img.alt = 'Plot';
        return img;
      }
      case 'table':
        return renderTable(o);
      default:
        return el('pre', `out-${o.type}`, o.text.replace(/\n$/, ''));
    }
  });
}

export function describeRun(r: RunRecord): string {
  const at = new Date(r.finishedAt ?? r.queuedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const took = r.ms === null ? '' : r.ms < 1000 ? ` · ${r.ms} ms` : ` · ${(r.ms / 1000).toFixed(1)} s`;
  return `${r.chunk.partial ? 'Ran part · ' : ''}${r.by.name} · ${at}${took}`;
}
