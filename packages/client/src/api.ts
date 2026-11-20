// The host's HTTP API. Client and host meet only over HTTP and WebSocket.
import type { ChunkRef, RunRecord, RunSessionInfo } from '@kuraa/session/model';
import type { PersonInfo } from './shell.js';

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
/** The workspace's devices, as the host reports them (pairing is done with kuraa-host, not here). */
export type PeersInfo =
  | { enabled: false; canInvite: boolean }
  | {
      enabled: true;
      /** People may make invitations and links here (the operator allows it). */
      canInvite: boolean;
      device: { name: string; key: string };
      workspace: { id: string; forkedFrom: string | null };
      /** The sync remote: the ordinary git remote Sync uses (GitHub, say), if any. */
      remote: string | null;
      /** Where this device accepts only some devices' or people's work on its own ('' the whole branch, 'dir/' a folder, else a file), and whose. */
      rules: { branch: string; path: string; from: string[] }[];
      /** Files where another device's version differs and this device keeps its own. */
      declined: { device: string; branch: string; path: string }[];
      /** Whose changes to the members it takes; null: every member's. */
      membership: string[] | null;
      devices: { name: string; key: string; online: boolean; related: boolean; /** It merges differently (another version of kuraa, or other document types). */ otherVersion: boolean }[];
      proposals: { device: string; branch: string; commits: number; subject: string }[];
    };

/** A git server this workspace is pushed to (the host's backups.ts). */
export interface BackupInfo {
  name: string;
  /** Where, with any password left out. */
  url: string;
  lastPush: string | null;
  error: string | null;
  pushing: boolean;
}

/** A subscription link this device made. */
export interface SubscriptionLinkInfo {
  id: string;
  created: number;
  /** When it stops working (ms since 1970); 0: never. */
  expires: number;
  state: 'active' | 'expired' | 'revoked';
}

export interface RoomInfo {
  room: string; path: string; branch: string; type: string; generation: string; baseCommit: string | null;
  lastFlushAt: string | null; lastCommitAt: string | null; lastCommit: string | null; dirty: boolean; uncommitted: boolean;
  /** Devices or people that would not take edits made here to it, by their rules. */
  declinedBy: string[];
}
export interface CommitInfo {
  hash: string; author: string; email: string; date: string; subject: string; coAuthors: { name: string; email: string }[];
  /** The file's path in this commit; differs from the current path before a rename. */
  path: string;
  /** A save the host made on its own, a merge it made, or any other commit (a named version, one made outside). */
  kind: 'autosave' | 'merge' | 'commit';
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export class HostApi {
  constructor(readonly baseUrl: string, protected readonly token: string) {}

  get collabUrl(): string {
    return this.baseUrl.replace(/\/$/, '').replace(/^http/, 'ws') + '/collab';
  }

  protected async req(path: string, init: RequestInit = {}): Promise<Response> {
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

  protected async json<T>(path: string, init?: RequestInit): Promise<T> {
    return (await (await this.req(path, init)).json()) as T;
  }

  workspace() { return this.json<WorkspaceInfo>('/api/workspace'); }
  tree() { return this.json<{ files: TreeFile[] }>('/api/tree').then((r) => r.files); }
  room(path: string) { return this.json<RoomInfo>(`/api/rooms?path=${encodeURIComponent(path)}`); }
  async fileText(path: string) { return (await this.req(`/api/files?path=${encodeURIComponent(path)}`)).text(); }
  /** A workspace file as it is (an image to show), with its type. */
  async rawFile(path: string) { return (await this.req(`/api/raw?path=${encodeURIComponent(path)}`)).blob(); }
  /** Keep an image beside a document (in images/ next to it); its path, and its address relative to the document. */
  uploadImage(doc: string, name: string, image: Blob, by: { name: string; email: string }) {
    const q = new URLSearchParams({ doc, name, by: by.name, email: by.email });
    return this.json<{ path: string; src: string }>(`/api/images?${q}`, { method: 'POST', body: image, headers: { 'content-type': image.type || 'application/octet-stream' } });
  }
  /** Who made a commit, and when (ISO). */
  commitInfo(hash: string) { return this.json<{ author: string; date: string }>(`/api/commits/${encodeURIComponent(hash)}`); }
  createFolder(path: string) { return this.json('/api/folders', { method: 'POST', body: JSON.stringify({ path }) }); }
  createFile(path: string, content = '') { return this.json('/api/files', { method: 'POST', body: JSON.stringify({ path, content }) }); }
  /** Rename or move a file or folder; for a document, `title` also gives it a new title (`to` may then equal `from`). */
  renameFile(from: string, to: string, title?: string) { return this.json('/api/files', { method: 'PATCH', body: JSON.stringify({ from, to, title }) }); }
  deleteFile(path: string) { return this.json(`/api/files?path=${encodeURIComponent(path)}`, { method: 'DELETE' }); }
  version(path: string | null, message: string) { return this.json<{ commit: string | null }>('/api/versions', { method: 'POST', body: JSON.stringify({ path, message }) }); }
  history(path: string) { return this.json<{ commits: CommitInfo[] }>(`/api/history?path=${encodeURIComponent(path)}`).then((r) => r.commits); }
  async textAt(commit: string, path: string) { return (await this.req(`/api/history/${commit}?path=${encodeURIComponent(path)}`)).text(); }
  components() { return this.json<ComponentsInfo>('/api/components'); }
  peers() { return this.json<PeersInfo>('/api/peers'); }
  peerLinks() { return this.json<{ links: SubscriptionLinkInfo[] }>('/api/peers/links').then((r) => r.links); }
  /** A subscription link lasting `hours` (null: no expiry). Turns syncing on if it is not. */
  createLink(hours: number | null) { return this.json<SubscriptionLinkInfo & { link: string }>('/api/peers/links', { method: 'POST', body: JSON.stringify({ hours }) }); }
  /** A one-time invitation, good for a day. Turns syncing on if it is not. */
  createInvitation() { return this.json<{ invitation: string }>('/api/peers/invitations', { method: 'POST' }).then((r) => r.invitation); }
  revokeLink(id: string) { return this.json(`/api/peers/links/${id}`, { method: 'DELETE' }); }
  /** Git servers this workspace is pushed to (backups), and whether people here may add and remove them. */
  backups() { return this.json<{ canManage: boolean; backups: BackupInfo[] }>('/api/backups'); }
  addBackup(target: string) { return this.json<{ backups: BackupInfo[] }>('/api/backups', { method: 'POST', body: JSON.stringify({ target }) }).then((r) => r.backups); }
  removeBackup(name: string) { return this.json<{ backups: BackupInfo[] }>(`/api/backups/${encodeURIComponent(name)}`, { method: 'DELETE' }).then((r) => r.backups); }
  backUpNow() { return this.json<{ backups: BackupInfo[] }>('/api/backups/now', { method: 'POST' }).then((r) => r.backups); }
  /** You on this computer (keys), where the host lets people using the app manage them (else a 404). */
  person() { return this.json<{ person: PersonInfo }>('/api/person').then((r) => r.person); }
  revokeKey(key: string) { return this.json('/api/person/revoke', { method: 'POST', body: JSON.stringify({ key }) }); }
  createPerson(name: string) { return this.json('/api/person', { method: 'POST', body: JSON.stringify({ name }) }); }
  importPerson(line: string) { return this.json('/api/person/import', { method: 'POST', body: JSON.stringify({ line }) }); }
  exportPerson() { return this.json<{ line: string }>('/api/person/export').then((r) => r.line); }
  /** Take another device's version of a file this device keeps its own of. */
  takeVersion(device: string, branch: string, path: string) { return this.json('/api/peers/take', { method: 'POST', body: JSON.stringify({ device, branch, path }) }); }
  acceptProposal(device: string, branch: string) { return this.json('/api/peers/accept', { method: 'POST', body: JSON.stringify({ device, branch }) }); }
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

/** A workspace of a hub (a server holding many; see the host's hub.ts). */
export interface HubWorkspace {
  id: string;
  name: string;
  /** Its folder, on the hub's computer. */
  path: string;
  /** It syncs with other devices. */
  peers: boolean;
  /** Why it is not open, if it is not. */
  error?: string;
}

/** A hub's workspaces, and what people may do with them. */
export interface HubList {
  workspaces: HubWorkspace[];
  /** People may add workspaces, and take them off the list. */
  canAdd: boolean;
  /** People may invite others to its workspaces. */
  canInvite: boolean;
}

/** A hub's own API: its workspaces, and adding them. Each workspace is a host at `<hub>/w/<id>`. */
export class HubApi extends HostApi {
  /**
   * The hub's workspaces; null if the address is a host started on its own,
   * not a hub.
   */
  async workspaces(): Promise<HubList | null> {
    try {
      return await this.json<HubList>('/hub/api/workspaces');
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  }

  /** A new workspace: a folder made a git repository. */
  async create(name: string): Promise<HubWorkspace> {
    return (await this.json<{ workspace: HubWorkspace }>('/hub/api/workspaces', { method: 'POST', body: JSON.stringify({ kind: 'new', name }) })).workspace;
  }

  /** A workspace joined from an invitation or subscription link. */
  async join(invitation: string, name: string): Promise<HubWorkspace> {
    return (await this.json<{ workspace: HubWorkspace }>('/hub/api/workspaces', { method: 'POST', body: JSON.stringify({ kind: 'join', invitation, name }) })).workspace;
  }

  /** Take a workspace off the list (its folder stays). */
  remove(id: string) {
    return this.json(`/hub/api/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  /** The API of one of the hub's workspaces. */
  workspaceApi(id: string): HostApi {
    return new HostApi(`${this.baseUrl.replace(/\/$/, '')}/w/${encodeURIComponent(id)}`, this.token);
  }
}
