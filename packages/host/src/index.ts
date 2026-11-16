import { randomBytes } from 'node:crypto';
import { Host, type HostOptions } from './host.js';

export { Host, HttpError, DEFAULT_TIMINGS, type HostOptions, type HostTimings } from './host.js';
export { gitIdentity, initWorkspace, inspectFolder, type FolderInfo } from './workspace.js';

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
