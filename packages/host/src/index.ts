import { randomBytes } from 'node:crypto';
import { Host, type HostOptions } from './host.js';

export { Host, HttpError, DEFAULT_TIMINGS, type HostOptions, type HostTimings } from './host.js';
export { gitIdentity, initWorkspace, inspectFolder, type FolderInfo } from './workspace.js';
export { defaultDataDir, type RunOptions, type RunDescription } from './runner.js';
export { loadRunComponents, type RunComponents } from './components.js';
export type { JoinOptions } from './peers/join.js';
export { Hub, startHub, slugOf, type HubOptions, type HubWorkspace, type RunningHub } from './hub.js';
export type { PeerOptions, PeersStatus, DeviceInfo, Proposal } from './peers/peers.js';

/** Join a workspace from an invitation (loads the peer layer, and Hyperswarm with it, only when called). */
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
  const addr = await host.start();
  const hostname = addr.address.includes(':') ? `[${addr.address}]` : addr.address;
  return { host, url: `http://${hostname === '0.0.0.0' ? '127.0.0.1' : hostname}:${addr.port}`, token, close: () => host.close() };
}
