// Run components: engines (languages), environments (places processes run),
// tools (toolchains processes may use, downloaded on request: tools.ts),
// syncs (places the workspace keeps a copy: the online copy, decision 0059) and
// renderers (documents rendered with no environment: decision 0107),
// separate components that meet only through @kuraa/run-kit. The host imports
// none: whoever starts it passes them (the command line, the desktop app and
// `pnpm dev` pass @kuraa/run-components, plus any named with --component). A component
// runs inside the host process with the host's rights, so only the operator
// names components, never a workspace or a person using the app.
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RUN_API_VERSION, type Engine, type Environment, type Renderer, type RunComponent, type Sync, type Tool } from '@kuraa/run-kit';

export interface RunComponents {
  engines: Map<string, Engine>;
  environments: Map<string, Environment>;
  tools: Map<string, Tool>;
  syncs: Map<string, Sync>;
  renderers: Map<string, Renderer>;
}

function check(component: unknown, from: string): RunComponent {
  const p = component as Partial<RunComponent> | null;
  if (!p || typeof p !== 'object' || typeof p.apiVersion !== 'number') throw new Error(`${from} is not a Kuraa run component: it should export one made with defineRunComponent().`);
  if (p.apiVersion !== RUN_API_VERSION) throw new Error(`${from} was written for version ${p.apiVersion} of the run component API; this host speaks version ${RUN_API_VERSION}.`);
  for (const e of p.engines ?? []) {
    if (typeof e?.id !== 'string' || !Array.isArray(e.handles) || typeof e.open !== 'function') throw new Error(`${from}: an engine needs an id, handles and open().`);
  }
  for (const e of p.environments ?? []) {
    if (typeof e?.id !== 'string' || typeof e.check !== 'function' || typeof e.start !== 'function') throw new Error(`${from}: an environment needs an id, check() and start().`);
    if (typeof e.sandboxed !== 'boolean') throw new Error(`${from}: the environment "${e.id}" must say whether it is sandboxed.`);
  }
  for (const t of p.tools ?? []) {
    // Its id and version name folders in the data folder.
    if (typeof t?.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(t.id)) throw new Error(`${from}: a tool needs an id of lower-case letters, digits and dashes.`);
    if (typeof t.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/.test(t.version)) throw new Error(`${from}: the tool "${t.id}" needs a version of letters, digits, dots and dashes.`);
    if (!t.installer || typeof t.installer.install !== 'function' || typeof t.path !== 'function' || !t.inside?.startsWith('/')) throw new Error(`${from}: the tool "${t.id}" needs an installer, path() and the folder it is seen at inside.`);
    if (t.parts && !/^\.kuraa\/[A-Za-z0-9._-]+\.json$/.test(t.parts.record)) throw new Error(`${from}: the tool "${t.id}" must record its parts in a .json file in .kuraa/.`);
  }
  for (const s of p.syncs ?? []) {
    // Its id names it in the API's paths.
    if (typeof s?.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(s.id)) throw new Error(`${from}: a sync needs an id of lower-case letters, digits and dashes.`);
    if (typeof s.label !== 'string' || typeof s.open !== 'function') throw new Error(`${from}: the sync "${s.id}" needs a label and open().`);
  }
  for (const r of p.renderers ?? []) {
    if (typeof r?.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(r.id)) throw new Error(`${from}: a renderer needs an id of lower-case letters, digits and dashes.`);
    if (!Array.isArray(r.extensions) || !Array.isArray(r.formats) || typeof r.render !== 'function' || typeof r.unavailable !== 'function') throw new Error(`${from}: the renderer "${r.id}" needs extensions, formats, unavailable() and render().`);
  }
  return p as RunComponent;
}

/** Load a component by path (relative to the working folder) or package name. */
async function importComponent(spec: string): Promise<unknown> {
  let target: string;
  if (spec.startsWith('.') || isAbsolute(spec)) target = pathToFileURL(resolve(spec)).href;
  else {
    // A package installed where the host is run from, else wherever Node finds it.
    try {
      target = pathToFileURL(createRequire(join(process.cwd(), 'noop.js')).resolve(spec)).href;
    } catch {
      target = spec;
    }
  }
  try {
    const mod = (await import(target)) as { default?: unknown };
    return mod.default ?? mod;
  } catch (e) {
    throw new Error(`Could not load the run component ${spec}: ${(e as Error).message}`, { cause: e });
  }
}

/** Components given as modules already loaded, or as a path or package name to load. */
export async function loadRunComponents(components: (RunComponent | string)[] = []): Promise<RunComponents> {
  const out: RunComponents = { engines: new Map(), environments: new Map(), tools: new Map(), syncs: new Map(), renderers: new Map() };
  for (const entry of components) {
    const from = typeof entry === 'string' ? entry : (entry as Partial<RunComponent>)?.name ?? 'a run component';
    const component = check(typeof entry === 'string' ? await importComponent(entry) : entry, from);
    for (const e of component.engines ?? []) {
      if (out.engines.has(e.id)) throw new Error(`Two run components define the engine "${e.id}" (the second is ${from}).`);
      out.engines.set(e.id, e);
    }
    for (const e of component.environments ?? []) {
      if (out.environments.has(e.id)) throw new Error(`Two run components define the environment "${e.id}" (the second is ${from}).`);
      out.environments.set(e.id, e);
    }
    for (const t of component.tools ?? []) {
      if (out.tools.has(t.id)) throw new Error(`Two run components define the tool "${t.id}" (the second is ${from}).`);
      out.tools.set(t.id, t);
    }
    for (const s of component.syncs ?? []) {
      if (out.syncs.has(s.id)) throw new Error(`Two run components define the sync "${s.id}" (the second is ${from}).`);
      out.syncs.set(s.id, s);
    }
    for (const r of component.renderers ?? []) {
      if (out.renderers.has(r.id)) throw new Error(`Two run components define the renderer "${r.id}" (the second is ${from}).`);
      out.renderers.set(r.id, r);
    }
  }
  return out;
}
