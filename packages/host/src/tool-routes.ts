// The HTTP routes for tools (decision 0045; tools.ts keeps them, runner.ts
// decides who may), added to http.ts's table. Listing is for everyone; the rest
// fetches from the network or deletes, so only where installs are allowed.
//
//   GET  /api/tools            every tool, its state, size and progress
//   POST /api/tools/download   { id }: starts (or joins) a download: 202
//   POST /api/tools/remove     { id }: removes it once no render uses it: 202
//   POST /api/tools/parts      { id, names, by }: adds parts (LaTeX packages),
//                              recorded in the workspace, crediting `by`
import type { Context, Route } from './http.js';
import { personOf, readBody, send } from './http.js';
import { HttpError } from './errors.js';

const route = (method: Route['method'], path: string, handle: (c: Context) => Promise<void>): Route => ({ method, path, handle });

function idOf(c: Context, v: unknown): string {
  if (typeof v !== 'string' || !c.host.runner.tool(v)) throw new HttpError(404, 'This host has no such tool.');
  return v;
}

function allowed(c: Context): void {
  if (!c.host.runner.enabled) throw new HttpError(403, 'Running code is turned off on this host, and tools are used only where code runs.');
  if (!c.host.runner.allowInstalls) throw new HttpError(403, 'Downloading tools is turned off in this host’s Settings (Let documents install packages and download tools).');
}

export const toolRoutes: Route[] = [
  route('GET', '/api/tools', async (c) => send(c.res, 200, await c.host.runner.listTools())),

  route('POST', '/api/tools/download', async (c) => {
    const body = await readBody(c.req);
    const id = idOf(c, body.id);
    allowed(c);
    const started = await c.host.runner.downloadTool(id);
    if (!started.ok) throw new HttpError(422, started.message);
    send(c.res, 202, { ok: true, message: started.message });
  }),

  route('POST', '/api/tools/remove', async (c) => {
    const body = await readBody(c.req);
    const id = idOf(c, body.id);
    allowed(c);
    const started = await c.host.runner.removeTool(id);
    if (!started.ok) throw new HttpError(422, started.message);
    send(c.res, 202, { ok: true, message: started.message });
  }),

  route('POST', '/api/tools/parts', async (c) => {
    const body = await readBody(c.req);
    const id = idOf(c, body.id);
    allowed(c);
    const names = (Array.isArray(body.names) ? body.names : []).filter((n): n is string => typeof n === 'string' && n.length > 0 && n.length < 100);
    const result = await c.host.runner.addToolParts(id, names, personOf(body.by));
    send(c.res, result.ok ? 200 : 422, result);
  }),
];
