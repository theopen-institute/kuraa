import { randomBytes } from 'node:crypto';
import { Host, type HostOptions } from './host.js';
import { localUrl } from './http.js';

export { Host, DEFAULT_TIMINGS, type HostOptions, type HostTimings, type TreeEntry } from './host.js';
export { HttpError } from './errors.js';
export { useGit } from './git.js';
export { gitIdentity, initWorkspace, inspectFolder, type FolderInfo } from './workspace.js';
export { defaultDataDir, type RunOptions, type RunDescription } from './runner.js';
export { loadRunComponents, type RunComponents } from './components.js';
export type { JoinOptions } from './peers/join.js';
export { Hub, startHub, slugOf, type HubOptions, type HubWorkspace, type RunningHub } from './hub.js';
export type { PeerOptions, PeersStatus, DeviceInfo, LinkInfo } from './peers/peers.js';

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
