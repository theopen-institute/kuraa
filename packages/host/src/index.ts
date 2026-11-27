import { randomBytes } from 'node:crypto';
import { Host, type HostOptions } from './host.js';
import { localUrl } from './http.js';

export { Host, DEFAULT_TIMINGS, type HostOptions, type HostTimings, type TreeEntry } from './host.js';
export { HttpError } from './errors.js';
export { useGit } from './git.js';
export { lastResort, type LastResortOptions } from './lastresort.js';
export { gitIdentity, initWorkspace, inspectFolder, type FolderInfo } from './workspace.js';
export { defaultDataDir, type RunOptions, type RunDescription } from './runner.js';
export { loadRunComponents, type RunComponents } from './components.js';
/** The program as released, updating itself (0052), in either role (0099: @kuraa/server's release.ts). */
export { autoUpdate, currentVersion, defaultServerRoot, installServer, installedRoot, runsAsService, updateFrom, type ServerBuild } from './selfupdate.js';
/** A key pair kept in a file, made the first time (keys.ts): a server's own signing key (@kuraa/server, 0099). */
export { keptKey, type KeyPair } from './keys.js';
export type { JoinOptions, JoinProgress, Joined } from './peers/join.js';
export { Hub, startHub, slugOf, defaultWorkspacesFolder, isLoopback, OWNER_OFF, type HubOptions, type HubWorkspace, type HubList, type FolderListing, type RunningHub } from './hub.js';
export { SettingsStore, DEFAULT_SETTINGS, DATA_MARKER, settingsFrom, readSettings, writeSettings, checkDataDir, fromSettings, type Settings, type SettingsView } from './settings.js';
export type { PeerOptions, PeersStatus, DeviceInfo, LinkInfo } from './peers/peers.js';

/** Call `fn` when a device of a workspace runs a newer kuraa than this one (it will not sync until this one is updated). */
export async function onNewerVersion(fn: () => void): Promise<() => void> {
  const { versionNews } = await import('./peers/node.js');
  versionNews.on('newer', fn);
  return () => versionNews.off('newer', fn);
}

/** A person's key on this computer: make, read, export, import (peers/person.ts; loaded only when called). */
export function personKeys() {
  return import('./peers/person.js');
}
export type { Person } from './peers/person.js';

/** Join a workspace from an invite link (loads the peer layer, and Hyperswarm with it, only when called). */
export async function joinWorkspace(o: import('./peers/join.js').JoinOptions) {
  return (await import('./peers/join.js')).joinWorkspace(o);
}

export interface RunningHost {
  host: Host;
  url: string;
  token: string;
  close(): Promise<void>;
}

/** Start a host on a git working tree. */
export async function startHost(options: Omit<HostOptions, 'token'> & { token?: string }): Promise<RunningHost> {
  const token = options.token ?? randomBytes(18).toString('base64url');
  const host = new Host({ ...options, token });
  return { host, url: localUrl(await host.start()), token, close: () => host.close() };
}
