// The host's HTTP API. Client and host meet only over HTTP and WebSocket.
import type { ChunkRef, RunRecord, RunSessionInfo } from '@kuraa/session/model';

export interface WorkspaceInfo {
  name: string; branch: string; head: string | null; types: { id: string; label: string; version: number }[];
  /** Whether this host runs code chunks: with which engines, in which environment. */
  run?: RunInfo;
}
export interface RunInfo {
  enabled: boolean;
  engines: { id: string; label: string; handles: string[]; packages: boolean }[];
  /** Whether people may install packages here. */
  allowInstalls: boolean;
  /** Where this workspace's code runs, and whether that is available. */
  environment: { id: string; label: string; sandboxed: boolean; available: boolean; message: string } | null;
}
/** Which components the host has and which are on: set by the host's flags, shown read-only. */
export interface ComponentsInfo {
  engines: { id: string; label: string; description: string; on: boolean }[];
  /** Places code can run; the one in use is on. */
  environments: { id: string; label: string; description: string; sandboxed: boolean; on: boolean; available: boolean; message: string }[];
  formats: { id: string; label: string; description: string; extensions: string[]; on: boolean }[];
}
export interface PackageInfo { name: string; version: string; source: 'workspace' | 'environment' }
export interface PackageResult { ok: boolean; message: string; log: string; restart: boolean }
export interface RunRequest { path: string; engine: string; code: string; header: string; chunk: ChunkRef; by: { name: string; email: string; color: string } }
/** A file in the workspace. A document has a title (null if it has none yet); other files have no `title`. */
export interface TreeFile {
  path: string;
  type: string | null;
  title?: string | null;
  /** Conflicts a merge kept in it, to choose between: absent if none. */
  conflicts?: number;
}
export interface RoomInfo {
  room: string; path: string; branch: string; type: string; generation: string; baseCommit: string | null;
  lastFlushAt: string | null; lastCommitAt: string | null; lastCommit: string | null; dirty: boolean; uncommitted: boolean;
}
export interface CommitInfo {
  hash: string; author: string; email: string; date: string; subject: string; coAuthors: { name: string; email: string }[];
  /** The file's path in this commit; differs from the current path before a rename. */
  path: string;
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export class HostApi {
  constructor(readonly baseUrl: string, private readonly token: string) {}

  get collabUrl(): string {
    return this.baseUrl.replace(/\/$/, '').replace(/^http/, 'ws') + '/collab';
  }

  private async req(path: string, init: RequestInit = {}): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(this.baseUrl.replace(/\/$/, '') + path, {
        ...init,
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
      });
    } catch (err) {
      throw new ApiError(0, `Cannot reach the host at ${this.baseUrl}: ${(err as Error).message}`);
    }
    if (!res.ok) {
      let msg = res.statusText;
      try {
        const body = (await res.json()) as { error?: string; message?: string };
        msg = body.error ?? body.message ?? msg;
      } catch { /* not JSON */ }
      throw new ApiError(res.status, msg);
    }
    return res;
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    return (await (await this.req(path, init)).json()) as T;
  }

  workspace() { return this.json<WorkspaceInfo>('/api/workspace'); }
  tree() { return this.json<{ files: TreeFile[] }>('/api/tree').then((r) => r.files); }
  room(path: string) { return this.json<RoomInfo>(`/api/rooms?path=${encodeURIComponent(path)}`); }
  async fileText(path: string) { return (await this.req(`/api/files?path=${encodeURIComponent(path)}`)).text(); }
  createFolder(path: string) { return this.json('/api/folders', { method: 'POST', body: JSON.stringify({ path }) }); }
  createFile(path: string, content = '') { return this.json('/api/files', { method: 'POST', body: JSON.stringify({ path, content }) }); }
  /** Rename or move a file or folder; for a document, `title` also gives it a new title (`to` may then equal `from`). */
  renameFile(from: string, to: string, title?: string) { return this.json('/api/files', { method: 'PATCH', body: JSON.stringify({ from, to, title }) }); }
  deleteFile(path: string) { return this.json(`/api/files?path=${encodeURIComponent(path)}`, { method: 'DELETE' }); }
  version(path: string | null, message: string) { return this.json<{ commit: string | null }>('/api/versions', { method: 'POST', body: JSON.stringify({ path, message }) }); }
  history(path: string) { return this.json<{ commits: CommitInfo[] }>(`/api/history?path=${encodeURIComponent(path)}`).then((r) => r.commits); }
  async textAt(commit: string, path: string) { return (await this.req(`/api/history/${commit}?path=${encodeURIComponent(path)}`)).text(); }
  components() { return this.json<ComponentsInfo>('/api/components'); }
  sync() { return this.json<{ ok: boolean; message: string }>('/api/sync', { method: 'POST' }); }
  runs(path: string) { return this.json<{ runs: RunRecord[]; pending: RunRecord[]; session: RunSessionInfo }>(`/api/runs?path=${encodeURIComponent(path)}`); }
  run(req: RunRequest) { return this.json<RunRecord>('/api/runs', { method: 'POST', body: JSON.stringify(req) }); }
  interruptRuns(path: string) { return this.json('/api/runs/interrupt', { method: 'POST', body: JSON.stringify({ path }) }); }
  restartRuns(path: string) { return this.json('/api/runs/restart', { method: 'POST', body: JSON.stringify({ path }) }); }
  packages(engine: string) { return this.json<{ packages: PackageInfo[] }>(`/api/packages?engine=${encodeURIComponent(engine)}`).then((r) => r.packages); }
  installPackages(engine: string, refs: string[], by: { name: string; email: string; color: string }) { return this.json<PackageResult>('/api/packages/install', { method: 'POST', body: JSON.stringify({ engine, refs, by }) }); }
  removePackages(engine: string, names: string[], by: { name: string; email: string; color: string }) { return this.json<PackageResult>('/api/packages/remove', { method: 'POST', body: JSON.stringify({ engine, names, by }) }); }
  clearRuns(path: string, chunk?: ChunkRef) { return this.json('/api/runs/clear', { method: 'POST', body: JSON.stringify({ path, chunk }) }); }
}
