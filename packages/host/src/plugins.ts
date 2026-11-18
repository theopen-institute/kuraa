// Run plugins: engines (languages). The host ships R, which does nothing until
// the operator turns it on; more can be loaded by path or package name. A plugin
// runs inside the host process with the host's rights, so only the operator
// names plugins (flags), never a workspace or a person using the app.
//
// Where code runs is not a plugin: always the Podman sandbox (env-podman).
// A plugin that brings environments of its own is refused.
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RUN_API_VERSION, type Engine, type RunPlugin } from '@kuraa/run-kit';
import rPlugin from '@kuraa/engine-r';

export const BUILTIN_PLUGINS: RunPlugin[] = [rPlugin];

export interface RunPlugins {
  engines: Map<string, Engine>;
}

function check(plugin: unknown, from: string): RunPlugin {
  const p = plugin as Partial<RunPlugin> | null;
  if (!p || typeof p !== 'object' || typeof p.apiVersion !== 'number') throw new Error(`${from} is not a kuraa run plugin: it should export one made with definePlugin().`);
  if (p.apiVersion !== RUN_API_VERSION) throw new Error(`${from} was written for version ${p.apiVersion} of the run plugin API; this host speaks version ${RUN_API_VERSION}.`);
  for (const e of p.engines ?? []) {
    if (typeof e?.id !== 'string' || !Array.isArray(e.handles) || typeof e.open !== 'function') throw new Error(`${from}: an engine needs an id, handles and open().`);
  }
  if ('environments' in p && p.environments !== undefined) {
    throw new Error(`${from} brings environments of its own. Code runs only in the host's Podman sandbox; a plugin can add engines, not places to run them.`);
  }
  return p as RunPlugin;
}

/** Load a plugin by path (relative to the working folder) or package name. */
async function importPlugin(spec: string): Promise<unknown> {
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
    throw new Error(`Could not load the run plugin ${spec}: ${(e as Error).message}`, { cause: e });
  }
}

export async function loadRunPlugins(specs: string[] = [], builtins: RunPlugin[] = BUILTIN_PLUGINS): Promise<RunPlugins> {
  const out: RunPlugins = { engines: new Map() };
  const add = (plugin: RunPlugin, from: string) => {
    for (const e of plugin.engines ?? []) {
      if (out.engines.has(e.id)) throw new Error(`Two run plugins define the engine "${e.id}" (the second is ${from}).`);
      out.engines.set(e.id, e);
    }
  };
  for (const p of builtins) add(check(p, p.name), p.name);
  for (const spec of specs) add(check(await importPlugin(spec), spec), spec);
  return out;
}
