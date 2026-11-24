// Who may talk to a host or hub from a web page.
//
// Every API request needs the access code, but a page elsewhere is still kept
// out where it does not need to be in:
//   - A server listening on this computer alone answers only requests that name
//     this computer (localhost, 127.0.0.1, [::1]) in their Host header, so a page
//     at a name made to point here (DNS rebinding) cannot read it as its own.
//   - Pages at other origins are allowed to read answers (CORS) only if the
//     operator named them (--allow-origin). The web client is served by the
//     server itself, and pnpm dev puts the server behind Vite at the page's own
//     origin, so neither needs one; the desktop app's pages are files, whose
//     requests carry no Origin.
//   - A WebSocket (a room) is opened only from the server's own origin, an origin
//     named, or the desktop app's files (file://).
import type { IncomingMessage, ServerResponse } from 'node:http';

/** What a server lets in: whether it listens on this computer alone, and the other origins it lets pages read it from. */
export interface RequestGate {
  loopback: boolean;
  origins: string[];
}

/** Whether an address to listen on is this computer alone. */
export function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h) || /^::ffff:127(\.\d{1,3}){3}$/.test(h);
}

/** The gate for a server listening at `host`, with the origins its operator named (each as an origin: no path). */
export function gateFor(host: string, origins: string[] = []): RequestGate {
  return { loopback: isLoopback(host), origins: origins.map(originOf).filter((o): o is string => o !== null) };
}

function originOf(url: string): string | null {
  try {
    const o = new URL(url).origin;
    return o === 'null' ? null : o;
  } catch {
    return null;
  }
}

/** The name in a Host header, without its port ([::1]:80 is ::1). */
function hostName(header: string): string {
  const m = /^\[([^\]]*)\](?::\d*)?$/.exec(header) ?? /^([^:]*)(?::\d*)?$/.exec(header);
  return (m ? m[1]! : header).toLowerCase();
}

/**
 * Whether a request's Host header may reach this server. Listening on this
 * computer alone, it must name this computer (any port: pnpm dev's proxy passes
 * on the page's). A request without one is not from a browser.
 */
export function hostAllowed(req: IncomingMessage, gate: RequestGate): boolean {
  if (!gate.loopback) return true;
  const host = req.headers.host;
  if (host === undefined) return true;
  const name = hostName(host);
  return isLoopback(name) || name.endsWith('.localhost');
}

/** The page's origin, if it is another than the server's own (as the request names it). */
function otherOrigin(req: IncomingMessage): string | null {
  const origin = req.headers.origin;
  if (origin === undefined) return null;
  const host = req.headers.host;
  if (host && (origin === `http://${host}` || origin === `https://${host}`)) return null;
  return origin;
}

/** Whether a page at the request's origin may read the answer, or open a room. */
export function originAllowed(req: IncomingMessage, gate: RequestGate, o: { files?: boolean } = {}): boolean {
  const other = otherOrigin(req);
  return other === null || gate.origins.includes(other) || (o.files === true && other === 'file://');
}

/** CORS headers for a page at an origin the operator named; none for any other. */
export function corsHeaders(req: IncomingMessage, res: ServerResponse, gate: RequestGate): void {
  const other = otherOrigin(req);
  if (other === null || !gate.origins.includes(other)) return;
  res.setHeader('access-control-allow-origin', other);
  res.setHeader('vary', 'origin');
  res.setHeader('access-control-allow-headers', 'authorization, content-type');
  res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
}

/** A WebSocket's request, checked: a socket refused is closed. */
export function upgradeAllowed(req: IncomingMessage, gate: RequestGate): boolean {
  return hostAllowed(req, gate) && originAllowed(req, gate, { files: true });
}

/** The answer to a request whose Host header names somewhere else. */
export function refuseHost(res: ServerResponse): void {
  res.writeHead(421, { 'content-type': 'text/plain' });
  res.end('This host answers only at localhost (or 127.0.0.1).');
}
