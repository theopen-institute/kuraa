// The host's HTTP API. Client and host meet only over HTTP and WebSocket.
import type { ChunkRef, MadeFrom, RunRecord, RunSessionInfo } from '@kuraa/session/model';
import type { PersonInfo } from './shell.js';
import type { FeatureSettings, FeatureStatus, Json } from '@kuraa/feature-kit';
import type { BookContent, WordsDay } from '@kuraa/feature-kit/client';

export interface WorkspaceInfo {
  /** What the workspace is called: its own name, the same on every device (0061), else what this device calls it. */
  name: string;
  /** Whether the workspace has a name of its own yet (0061). */
  named?: boolean;
  branch: string; head: string | null; types: { id: string; label: string; version: number }[];
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
/** A tool (TeX, say): downloaded on request, kept once per computer (the host's tools.ts). */
export interface ToolInfo {
  id: string;
  label: string;
  description: string;
  version: string;
  downloadBytes: number;
  state: 'absent' | 'downloading' | 'ready' | 'adding' | 'removing';
  progress: string | null;
  error: string | null;
  size: number | null;
  installedAt: string | null;
  /** Why it cannot be downloaded here (no build for this kind of computer). */
  unavailable: string | null;
  note: string | null;
  parts: { label: string; added: number } | null;
}
export interface ToolsInfo {
  /** People here may download tools and remove them. */
  allowInstalls: boolean;
  arch: string | null;
  tools: ToolInfo[];
}
export interface PackageResult { ok: boolean; message: string; log: string; restart: boolean }
export interface RunRequest { path: string; engine: string; code: string; header: string; chunk: ChunkRef; by: { name: string; email: string; color: string } }
/** A file in the workspace. A document has a title (null if it has none yet); other files have no `title`. */
export interface TreeFile {
  path: string;
  type: string | null;
  title?: string | null;
  /** Conflicts a merge kept in it, to choose between: absent if none. */
  conflicts?: number;
  /** Why the app does not open it (a link, a file not in UTF-8): its type is then null. */
  cannotOpen?: string;
  /** Who reads it, in words, if not everyone in the workspace (a space's file, 0066). */
  readers?: string;
  /** Who may change it, in words, if not anyone (a rule, 0069). */
  writers?: string;
  /** A companion (0082): the document it is kept beside, which the file list shows it with. */
  of?: string;
}
/** The workspace's devices, as the host reports them: every member has the same say. */
export type PeersInfo =
  | { enabled: false; canInvite: boolean }
  | {
      enabled: true;
      /** People here may make invite links, remove devices and rename this one (the operator allows it). */
      canInvite: boolean;
      /** This device, and whose it is (null if no identity says). */
      device: { name: string; key: string; person: string | null };
      /** What this computer's network is like for connecting (0053). */
      network?: { kind: 'starting' | 'open' | 'router' | 'hard' | 'unreachable'; tcp: string | null; lan: boolean };
      workspace: { id: string; forkedFrom: string | null };
      devices: { name: string; key: string; person: string | null; online: boolean; /** Not connected here, but to these devices (keys), which say so. */ through: string[]; related: boolean; /** It merges differently (another version of kuraa, or other document types). */ otherVersion: boolean; /** It runs a kuraa that does not sync with this one until one of them is updated. */ kuraa?: 'newer' | 'older' | null; /** How it is connected here (0053). */ via?: 'lan' | 'tcp' | 'tunnel' | 'internet' | null; /** When it was last connected here (ms since 1970). */ lastSeen?: number | null; /** A server's device (0099): in as itself, no person's. */ server?: boolean }[];
      /** This device was removed from the workspace, and no longer syncs. */
      removed?: boolean;
      /** Since when no other device has been connected here (ms since 1970); null while one is, or if there are none. */
      noContactSince?: number | null;
      /** The workspace's people, as its policy says (0066). */
      people?: PeopleInfo;
    };

/** Who may change a file (0066): whether you may, and the rule that says so. */
export interface FileAccess {
  canWrite: boolean;
  rule: { path: string; by: string[]; who: string[] } | null;
  /** Whether you may make rules (an admin of the workspace). */
  admin?: boolean;
  you: string | null;
  /** Your changes to it that were not kept (0072: you could not change it), newest first. */
  notKept?: { commit: string; date: string }[];
  /** Who reads it: null for everyone in the workspace; else its audience, and that in words (0066). */
  readers?: { audience: string[]; words: string } | null;
}

/** A file's or folder's permissions (0069), for its Permissions… dialog. */
export interface PermissionsInfo {
  path: string;
  folder: boolean;
  own: { write: string[] | null; read: string[] | null } | null;
  fromAbove: { write: { path: string; by: string[] } | null; read: { path: string; audience: string[] } | null };
  readers: string[] | null;
  admin: boolean;
  canWrite: boolean;
  /** Its readers are a space's that someone else chose, which only they or the owner change (0110). */
  readersLocked?: boolean;
}

/** The workspace's write rules and groups (0066). */
export interface RulesInfo {
  admin: boolean;
  rules: { path: string; by: string[] }[];
  groups: { name: string; entries: { who: string; role: 'admin' | 'member'; name: string | null }[] }[];
  /** Every file's and folder's permission (0069): its path (null: private, not one you know). */
  permissions?: { path: string | null; private: boolean; write: string[] | null; read: string[] | null }[];
  /** Changes made at the same time of which the one giving less counted (0078), the latest first: in words, and whether you may make the one that lost again. */
  clashes?: { lost: string; won: string | null; why: string; words: string; redo: boolean }[];
  /** A workspace from before 0066, to be founded again (0078): its owner's name (null: any admin may), and whether you may. Null: founded. */
  refound?: { owner: string | null; may: boolean } | null;
}

/** The workspace's people, by its policy (0066). */
export interface PeopleInfo {
  /** Whether the workspace has a policy yet (no: every member has the same say). */
  founded: boolean;
  /** Whether you may invite people, remove devices and change who is in it. */
  admin: boolean;
  /** The workspace's owner (0070); null: one from before with none. */
  owner?: string | null;
  /** Whether you make, unmake and take out admins: the owner. */
  assignsAdmins?: boolean;
  people: { id: string; role: 'owner' | 'admin' | 'member'; name: string | null; devices: string[]; you: boolean }[];
  /** The servers in the workspace (0099): each by its key, what its devices call themselves, its devices, and whether this is one. */
  servers?: { key: string; name: string; devices: string[]; you: boolean }[];
  /** Whether you invite and remove servers: the owner (0099). */
  managesServers?: boolean;
  /** The latest removals (0072): people taken out, computers dropped, servers removed (0099); who has confirmed each so far. */
  removals?: { kind: 'person' | 'computer' | 'server' | 'server-out'; who: string; by: string | null; confirmedBy: string[] }[];
}

/** A place this workspace keeps a copy on and syncs with: an online copy's git server (a sync's target, decision 0059). */
export interface SyncTargetInfo {
  name: string;
  /** Where, with any password left out. */
  url: string;
  lastSync: string | null;
  error: string | null;
  busy: boolean;
  /** Saves here it does not have yet (as far as this device knows); null if unknown. */
  pending?: number | null;
}
/** A sync the host's components bring (the online copy, @kuraa/sync-git), and its targets. */
export interface SyncInfo {
  id: string;
  label: string;
  description: string;
  /** For the form that adds a target: an example address, and how to get one. */
  placeholder: string;
  help: string;
  targets: SyncTargetInfo[];
}

/** An invite link this device made. */
export interface InviteLinkInfo {
  id: string;
  created: number;
  /** When it stops working (ms since 1970); 0: never. */
  expires: number;
  /** For one person: the first device it lets in uses it up. */
  once: boolean;
  state: 'active' | 'expired' | 'revoked' | 'used';
}

export interface RoomInfo {
  room: string; path: string; branch: string; type: string; generation: string; baseCommit: string | null;
  lastFlushAt: string | null; lastCommitAt: string | null; lastCommit: string | null; dirty: boolean; uncommitted: boolean;
}
export interface CommitInfo {
  hash: string; author: string; email: string; date: string; subject: string; coAuthors: { name: string; email: string }[];
  /** The file's path in this commit; differs from the current path before a rename. */
  path: string;
  /**
   * A save the host made on its own, a merge it made, any other commit (a named
   * version, one made outside), or changes not kept (0072: made by someone who
   * may not change the file; in its history only).
   */
  kind: 'autosave' | 'merge' | 'commit' | 'not-kept';
}

export type RenderFormat = 'html' | 'docx' | 'pdf';
/** A document's latest render in one format (the host's renders.ts). */
export interface RenderState {
  path: string;
  format: RenderFormat;
  state: 'rendering' | 'done' | 'failed';
  message: string;
  progress: string | null;
  log: string;
  by: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** The latest output, and what it was made from (0081; absent on renders from before). */
  output: { at: string; size: number; madeFrom?: MadeFrom } | null;
  /** A tool the document needs that this computer lacks, and people may download. */
  needs?: { tool: string; label: string; downloadBytes: number } | null;
}
export interface RenderInfo {
  /** Formats the document can be rendered to here; none if it cannot be. */
  formats: RenderFormat[];
  /** Why it cannot be rendered now, if it cannot. */
  unavailable: string | null;
  renders: RenderState[];
}
/** Where a phrase was found (the host's search.ts). */
export interface SearchMatch { line: number; column: number; text: string; at: number }
export interface SearchFile { path: string; type: string | null; title?: string | null; live: boolean; matches: SearchMatch[] }
export interface SearchResult { files: SearchFile[]; truncated: boolean }

export class ApiError extends Error {
  /** `body`: the whole answer, where it says more than its message. */
  constructor(readonly status: number, message: string, readonly body?: unknown) { super(message); }
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
      let body: unknown;
      try {
        body = await res.json();
        const b = body as { error?: string; message?: string };
        msg = b.error ?? b.message ?? msg;
      } catch { /* not JSON */ }
      throw new ApiError(res.status, msg, body);
    }
    return res;
  }

  protected async json<T>(path: string, init?: RequestInit): Promise<T> {
    return (await (await this.req(path, init)).json()) as T;
  }

  workspace() { return this.json<WorkspaceInfo>('/api/workspace'); }
  /** Rename the workspace for everyone (0061): committed, and synced to every device. */
  async renameWorkspace(name: string, by: { name: string; email: string }) {
    return (await this.json<{ name: string }>('/api/workspace/name', { method: 'PATCH', body: JSON.stringify({ name, by }) })).name;
  }
  tree() { return this.json<{ files: TreeFile[]; folders?: { path: string; readers?: string; writers?: string }[]; orders?: Record<string, string[]> }>('/api/tree'); }
  /** A folder's order (0093): its files' and folders' names as arranged ('' the top level; none: by name). */
  /** A document's header fields set, open or not (0096). */
  setHeader(path: string, fields: Record<string, unknown>, by: { name: string; email: string; color: string }) { return this.json<{ path: string; commit: string | null }>('/api/documents/header', { method: 'POST', body: JSON.stringify({ path, fields, by }) }); }
  setOrder(folder: string, names: string[]) { return this.json<{ folder: string; names: string[] }>('/api/order', { method: 'POST', body: JSON.stringify({ folder, names }) }); }
  /** A file's or folder's permissions (0069). */
  permissions(path: string) { return this.json<PermissionsInfo>(`/api/permissions?path=${encodeURIComponent(path)}`); }
  /** Say a file's or folder's permissions: who may change it, who reads it (null: as its folder says; omitted: as it is). */
  setPermissions(path: string, change: { write?: string[] | null; read?: string[] | null }) { return this.json<PermissionsInfo>('/api/permissions', { method: 'POST', body: JSON.stringify({ path, ...change }) }); }
  /** A document's room; with `draft`, one with no file yet may open, empty (0097). */
  room(path: string, draft = false) { return this.json<RoomInfo>(`/api/rooms?path=${encodeURIComponent(path)}${draft ? '&draft=1' : ''}`); }
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
  /** Tools, and how each stands on the host's computer. */
  tools() { return this.json<ToolsInfo>('/api/tools'); }
  /** Start downloading a tool (or join its download); follow it with tools(). */
  downloadTool(id: string) { return this.json<{ ok: boolean; message: string }>('/api/tools/download', { method: 'POST', body: JSON.stringify({ id }) }); }
  removeTool(id: string) { return this.json<{ ok: boolean; message: string }>('/api/tools/remove', { method: 'POST', body: JSON.stringify({ id }) }); }
  peers() { return this.json<PeersInfo>('/api/peers'); }
  peerLinks() { return this.json<{ links: InviteLinkInfo[] }>('/api/peers/links').then((r) => r.links); }
  /** An invite link: for one person (`once`) or anyone, lasting `hours` (null: no expiry). Turns syncing on if it is not. */
  /** Who may change a file (0066). */
  access(path: string) { return this.json<FileAccess>(`/api/access?path=${encodeURIComponent(path)}`); }
  rules() { return this.json<RulesInfo>('/api/rules'); }
  /** Make a clash's losing change again, on purpose, after both (0078). */
  redoClash(op: string) { return this.json<RulesInfo>(`/api/clashes/${op}/redo`, { method: 'POST' }); }
  /** Found a workspace from before 0066 again, as its owner (0078). */
  refound() { return this.json<RulesInfo>('/api/peers/refound', { method: 'POST' }); }
  /** Who reads a file: everyone in the workspace (null), or an audience (people's IDs, `group:<name>`, `admins`) (0066). */
  setAudience(path: string, audience: string[] | null) { return this.json<FileAccess>('/api/audience', { method: 'POST', body: JSON.stringify({ path, audience }) }); }
  /** Say who may change a path (people's IDs, `group:<name>`, `admins`); none takes the rule away. */
  setRule(path: string, by: string[]) { return this.json<RulesInfo>('/api/rules', { method: 'POST', body: JSON.stringify({ path, by }) }); }
  /** Put someone in a group as admin or member, or take them out (null). */
  setGroupRole(group: string, who: string, role: 'admin' | 'member' | null) { return this.json<RulesInfo>(`/api/groups/${group}`, { method: 'POST', body: JSON.stringify({ who, role }) }); }
  /** Make someone of the workspace an admin or a member (an admin's to do, 0066). */
  setRole(id: string, role: 'admin' | 'member') { return this.json<PeopleInfo>(`/api/peers/people/${id}`, { method: 'POST', body: JSON.stringify({ role }) }); }
  /** Give the owner's role to someone in the workspace (the owner's to do, 0070). */
  makeOwner(id: string) { return this.json<PeopleInfo>(`/api/peers/owner/${id}`, { method: 'POST' }); }
  /** Take someone out of the workspace, with their devices (an admin's to do; or yourself). */
  removePerson(id: string) { return this.json<PeopleInfo>(`/api/peers/people/${id}`, { method: 'DELETE' }); }
  createLink(o: { hours: number | null; once: boolean; role?: 'admin' | 'member' | 'server' }) { return this.json<InviteLinkInfo & { link: string }>('/api/peers/links', { method: 'POST', body: JSON.stringify(o) }); }
  revokeLink(id: string) { return this.json(`/api/peers/links/${id}`, { method: 'DELETE' }); }
  /** Remove a device from the workspace, for good (it keeps its copy). */
  /** Take a server out of the workspace, for good (0099): the owner's. */
  /** Take a server out (0099): invited back by a new link; `forGood` (its key lost or stolen), never with that key again. The owner's. */
  removeServer(key: string, forGood = false) { return this.json<PeopleInfo>(`/api/peers/servers/${key}${forGood ? '?for-good=1' : ''}`, { method: 'DELETE' }); }
  removeDevice(key: string) { return this.json<{ ok: boolean; revoked?: boolean }>(`/api/peers/devices/${key}`, { method: 'DELETE' }); }
  renameDevice(name: string) { return this.json<{ name: string }>('/api/peers/name', { method: 'POST', body: JSON.stringify({ name }) }); }
  /** The syncs the host's components bring (the online copy), their targets, and whether people here may add and remove them. */
  syncs() { return this.json<{ canManage: boolean; syncs: SyncInfo[] }>('/api/syncs'); }
  addSyncTarget(sync: string, target: string) { return this.json<SyncInfo>(`/api/syncs/${encodeURIComponent(sync)}`, { method: 'POST', body: JSON.stringify({ target }) }); }
  removeSyncTarget(sync: string, name: string) { return this.json<SyncInfo>(`/api/syncs/${encodeURIComponent(sync)}/${encodeURIComponent(name)}`, { method: 'DELETE' }); }
  /** You on this computer (keys), where the host lets people using the app manage them (else a 404). */
  person() { return this.json<{ person: PersonInfo }>('/api/person').then((r) => r.person); }
  revokeKey(key: string) { return this.json('/api/person/revoke', { method: 'POST', body: JSON.stringify({ key }) }); }
  createPerson(name: string) { return this.json('/api/person', { method: 'POST', body: JSON.stringify({ name }) }); }
  importPerson(line: string) { return this.json('/api/person/import', { method: 'POST', body: JSON.stringify({ line }) }); }
  exportPerson() { return this.json<{ line: string }>('/api/person/export').then((r) => r.line); }
  recoveryLine() { return this.json<{ line: string }>('/api/person/recovery').then((r) => r.line); }
  recoverySaved() { return this.json('/api/person/recovery/saved', { method: 'POST' }); }
  previewRecovery(line: string) { return this.json<{ id: string; name: string; keys: string[] }>('/api/person/recover/preview', { method: 'POST', body: JSON.stringify({ line }) }); }
  recover(line: string, drop: string[]) { return this.json('/api/person/recover', { method: 'POST', body: JSON.stringify({ line, drop }) }); }
  /** Sync; how many changes came in, and how many conflicts their merges kept. */
  sync() { return this.json<{ ok: boolean; message: string; brought?: number; conflicts?: number }>('/api/sync', { method: 'POST' }); }
  runs(path: string) { return this.json<{ runs: RunRecord[]; pending: RunRecord[]; session: RunSessionInfo }>(`/api/runs?path=${encodeURIComponent(path)}`); }
  run(req: RunRequest) { return this.json<RunRecord>('/api/runs', { method: 'POST', body: JSON.stringify(req) }); }
  interruptRuns(path: string) { return this.json('/api/runs/interrupt', { method: 'POST', body: JSON.stringify({ path }) }); }
  restartRuns(path: string) { return this.json('/api/runs/restart', { method: 'POST', body: JSON.stringify({ path }) }); }
  packages(engine: string) { return this.json<{ packages: PackageInfo[] }>(`/api/packages?engine=${encodeURIComponent(engine)}`).then((r) => r.packages); }
  installPackages(engine: string, refs: string[], by: { name: string; email: string; color: string }) { return this.json<PackageResult>('/api/packages/install', { method: 'POST', body: JSON.stringify({ engine, refs, by }) }); }
  removePackages(engine: string, names: string[], by: { name: string; email: string; color: string }) { return this.json<PackageResult>('/api/packages/remove', { method: 'POST', body: JSON.stringify({ engine, names, by }) }); }
  /** What a document can be rendered to here, and its latest renders. */
  renders(path: string) { return this.json<RenderInfo>(`/api/renders?path=${encodeURIComponent(path)}`); }
  /** Render a document (or join its render under way); a failure to start comes back as a failed state. */
  async render(path: string, format: RenderFormat, by: { name: string; email: string; color: string }, compile?: { exclude?: string[]; noHeading?: string[]; title?: string }): Promise<RenderState> {
    try {
      return await this.json<RenderState>('/api/renders', { method: 'POST', body: JSON.stringify({ path, format, by, ...compile }) });
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) return { path, format, state: 'failed', message: e.message, progress: null, log: '', by: by.name, startedAt: '', finishedAt: null, output: null };
      throw e;
    }
  }
  /** A document's latest output in a format. */
  async renderOutput(path: string, format: RenderFormat): Promise<Blob> {
    return (await this.req(`/api/renders/file?path=${encodeURIComponent(path)}&format=${format}`)).blob();
  }
  /** Words written each day from a day on, by person (0094). */
  async wordsByDay(since: string): Promise<WordsDay[]> {
    return (await this.json<{ days: WordsDay[] }>(`/api/words?since=${encodeURIComponent(since)}`)).days;
  }
  /** What a folder's book could have (0093): its folders and documents in the file tree's order, each at its depth. */
  async bookContents(folder: string): Promise<BookContent[]> {
    return (await this.json<{ items: BookContent[] }>(`/api/renders/contents?path=${encodeURIComponent(folder)}`)).items;
  }
  /** The files a document's latest output in a format was made from, as they were, in a zip (0081). */
  async renderMadeFrom(path: string, format: RenderFormat): Promise<Blob> {
    return (await this.req(`/api/renders/made-from?path=${encodeURIComponent(path)}&format=${format}`)).blob();
  }
  /** Search the workspace's text files, and open documents as they are now. */
  search(query: string, caseSensitive: boolean) { return this.json<SearchResult>(`/api/search?q=${encodeURIComponent(query)}${caseSensitive ? '&case=1' : ''}`); }
  /** Features (0082): how each the host has stands for this workspace. */
  features() { return this.json<{ features: FeatureStatus[] }>('/api/features').then((r) => r.features); }
  /** Turn a feature on or off for this workspace, or change its settings there: committed, for everyone in it. */
  setFeature(id: string, change: { on?: boolean; settings?: FeatureSettings }, by: { name: string; email: string; color: string }) {
    return this.json<FeatureStatus>(`/api/features/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ ...change, by }) });
  }
  /** Everyone's own files beside a document by a companion suffix (0082), as they are or at a commit. */
  companions(path: string, suffix: string, commit?: string) {
    return this.json<{ companions: { person: string; path: string; text: string }[] }>(`/api/companions?path=${encodeURIComponent(path)}&suffix=${encodeURIComponent(suffix)}${commit ? `&commit=${commit}` : ''}`).then((r) => r.companions);
  }
  /** One of a feature's own routes (/api/features/<id>/<path>), as the person asking. */
  featureRequest(id: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body: Json | undefined, by: { name: string; email: string; color: string }) {
    const url = `/api/features/${encodeURIComponent(id)}/${path.replace(/^\/+/, '')}`;
    return this.json<Json>(url, method === 'GET' ? {} : { method, body: JSON.stringify({ body, by }) });
  }
  clearRuns(path: string, chunk?: ChunkRef) { return this.json('/api/runs/clear', { method: 'POST', body: JSON.stringify({ path, chunk }) }); }
}

/** A workspace of a hub (a host holding many; see the host's hub.ts). */
export interface HubWorkspace {
  id: string;
  name: string;
  /** Its folder, on the hub's computer. */
  path: string;
  /** It syncs with other devices. */
  peers: boolean;
  /** Why it is not open, if it is not. */
  error?: string;
  /** It is still opening (0103): what is asked of it waits until it has. */
  opening?: boolean;
  /** The cloud storage service keeping its folder ("iCloud Drive"), if one does (0103). */
  cloud?: string;
}

/**
 * How a join is going (the host's hub.ts, JoinStatus): waiting for the hub to
 * finish adding another workspace; looking for a computer the workspace is on;
 * connected to one and being let in; copying the workspace from it; opening it.
 * `slowNetwork`: this computer's network makes direct connections take a few tries.
 */
export interface JoinStatus {
  step: 'waiting' | 'looking' | 'letting-in' | 'copying' | 'opening';
  slowNetwork: boolean;
  from?: string;
}

/** A hub's workspaces, and what people may do with them. */
export interface HubList {
  workspaces: HubWorkspace[];
  /** People may add workspaces, and take them off the list. */
  canAdd: boolean;
  /** People may invite others to its workspaces. */
  canInvite: boolean;
  /** Any folder on the host's computer may be opened as a workspace. */
  canOpenFolder?: boolean;
  /** The Preferences may be changed here. */
  canChangeSettings?: boolean;
  /** Why Preferences, opening folders and your identity are not available here, if they are not. */
  ownerOff?: string;
  /** Where new workspaces go (and one moved out of a cloud service's folder), where people may add them. */
  folder?: string;
}

/** The owner's settings (the host's settings.ts), as the Preferences dialog edits them. */
export interface HubSettings {
  bootstrap: string[];
  /** Relays to go through to computers that cannot be reached directly, by key. */
  relays: string[];
  runCode: boolean;
  environment: string | null;
  rImages: string[];
  memory: string | null;
  cpus: number | null;
  disk: string | null;
  allowWrite: boolean;
  allowNetwork: boolean;
  allowInstalls: boolean;
  dataDir: string | null;
  formats: string[] | null;
  /** Features on, by id (0082); null for all. */
  features: string[] | null;
  saveSeconds: number | null;
  versionSeconds: number | null;
  workspaces: string | null;
}

/** What the Preferences dialog shows. */
export interface SettingsView {
  settings: HubSettings;
  /** Those set by flags, which win over the settings. */
  fromFlags: (keyof HubSettings)[];
  defaults: { memory: string; cpus: number; disk: string; saveSeconds: number; versionSeconds: number };
  defaultWorkspaces: string;
  defaultDataDir: string;
  environments: { id: string; label: string; available: boolean; message: string }[];
  formats: { id: string; label: string }[];
  /** The features the host has loaded (0082). */
  features: { id: string; label: string; description: string }[];
  /** New workspaces can be added (where they go is a setting). */
  canAdd: boolean;
}

/** The folders in one of the host's computer's folders, to choose one. */
export interface FolderListing {
  path: string;
  parent: string | null;
  home: string;
  folders: { name: string; path: string }[];
}

/** Opening a folder that is not yet a git repository: what to ask before making it one. */
export interface NotRepository {
  name: string;
  path: string;
  entries: number;
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

  /** A workspace joined from an invite link, called what it calls itself (0061); `progress`: an id to ask how it is going by (joinStatus) meanwhile. */
  async join(invitation: string, progress?: string): Promise<HubWorkspace> {
    return (await this.json<{ workspace: HubWorkspace }>('/hub/api/workspaces', { method: 'POST', body: JSON.stringify({ kind: 'join', invitation, progress }) })).workspace;
  }

  /** How a join is going, by the id given to join; null if it is not under way (yet, or any more). */
  async joinStatus(progress: string): Promise<JoinStatus | null> {
    try {
      return await this.json<JoinStatus>(`/hub/api/joins/${encodeURIComponent(progress)}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  }

  /**
   * Open a folder of the host's computer as a workspace. One that is not yet a
   * repository is made one only with `init`; without, the answer is what to ask first.
   */
  async openFolder(path: string, init = false): Promise<{ workspace: HubWorkspace } | { notRepository: NotRepository }> {
    try {
      return await this.json<{ workspace: HubWorkspace }>('/hub/api/workspaces/open', { method: 'POST', body: JSON.stringify({ path, init }) });
    } catch (e) {
      const notRepository = e instanceof ApiError && e.status === 409 ? (e.body as { notRepository?: NotRepository } | undefined)?.notRepository : undefined;
      if (notRepository) return { notRepository };
      throw e;
    }
  }

  /** The folders in a folder of the host's computer (from home, if none is given). */
  folders(path: string | null, hidden = false) {
    return this.json<FolderListing>(`/hub/api/folders?${new URLSearchParams({ ...(path ? { path } : {}), ...(hidden ? { hidden: '1' } : {}) })}`);
  }

  /** The owner's settings, for Preferences. */
  settings() { return this.json<SettingsView>('/hub/api/settings'); }
  /** Save the settings; answers once every workspace has reopened with them. */
  saveSettings(s: HubSettings) { return this.json<SettingsView>('/hub/api/settings', { method: 'PUT', body: JSON.stringify(s) }); }

  /** Take a workspace off the list (its folder stays). */
  remove(id: string) {
    return this.json(`/hub/api/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  /** Move a workspace's folder out of one a cloud storage service keeps, into the hub's folder for new workspaces (0103). */
  async move(id: string): Promise<HubWorkspace> {
    return (await this.json<{ workspace: HubWorkspace }>(`/hub/api/workspaces/${encodeURIComponent(id)}/move`, { method: 'POST' })).workspace;
  }

  /** The API of one of the hub's workspaces. */
  workspaceApi(id: string): HostApi {
    return new HostApi(`${this.baseUrl.replace(/\/$/, '')}/w/${encodeURIComponent(id)}`, this.token);
  }
}
