// R packages for a workspace: declared per workspace, stored once per host.
//
// On the host, in the engine's data folder:
//   cache/<name>_<version>_<hash>/<name>   each package version, once
//   libs/<workspace>/<name>                links into the cache: the workspace's library
//   downloads/                             pak's download cache
// Inside an environment these are /rpkgs/cache, /rpkgs/libs/w and /rpkgs/downloads.
// Sessions see the library and cache read-only; only the installer writes them.
//
// In the workspace, .kuraa/r-packages.json says what the workspace uses, so a
// fresh clone (or another machine) gets the same library on its first run:
//   { "requested": ["tidyverse"],                       what people asked for
//     "packages": { "dplyr": { "version": "1.1.4", "ref": "dplyr@1.1.4" } },
//     "environment": { "ggplot2": "3.5.1" },          used from the image itself
//     "system": ["libxml2-dev"] }                     system libraries added
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readWorkspaceFile, readWorkspaceFileSync, writeWorkspaceFile, type Mount, type PackageContext, type PackageInfo, type PackageManager, type PackageResult } from '@kuraa/run-kit';
import { R_INSTALLER } from './install-script.js';
import { imageRecipe } from './recipe.js';
import { REPLY_PREFIX } from './driver.js';
import { emptyDir, splitLines, writeIfChanged } from './lines.js';

export const MANIFEST = '.kuraa/r-packages.json';

export interface Manifest {
  requested: string[];
  packages: Record<string, { version: string; ref: string }>;
  environment: Record<string, string>;
  system: string[];
}

const empty = (): Manifest => ({ requested: [], packages: {}, environment: {}, system: [] });

/**
 * The workspace's manifest, with each field of the shape it should have (it is
 * a file anyone editing the workspace can change). Whether the names and refs
 * in it are ones to install is checked where they are used.
 */
export function readManifest(workspace: string): Manifest {
  let m: Record<string, unknown>;
  try {
    // Never through a link (0037): a manifest pointing elsewhere is no manifest.
    m = JSON.parse(readWorkspaceFileSync(workspace, MANIFEST).toString('utf8')) as Record<string, unknown>;
  } catch {
    return empty();
  }
  if (!m || typeof m !== 'object') return empty();
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const record = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.entries(v as Record<string, unknown>) : []);
  return {
    requested: strings(m.requested),
    packages: Object.fromEntries(record(m.packages).flatMap(([name, p]) => {
      const { version, ref } = (p ?? {}) as { version?: unknown; ref?: unknown };
      return typeof version === 'string' && typeof ref === 'string' ? [[name, { version, ref }]] : [];
    })),
    environment: Object.fromEntries(record(m.environment).filter((e): e is [string, string] => typeof e[1] === 'string')),
    system: strings(m.system),
  };
}

/** Sorted keys and a trailing newline, so diffs stay small. */
export function formatManifest(m: Manifest): string {
  const sorted = <T>(o: Record<string, T>) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]!]));
  return `${JSON.stringify({ requested: [...new Set(m.requested)].sort(), packages: sorted(m.packages), environment: sorted(m.environment), system: [...new Set(m.system)].sort() }, null, 2)}\n`;
}

// Refs a person may ask for. Anything else (URLs, paths, options) is refused: the
// installer has the network, so what it fetches must come from known places.
const REF = [
  /^(cran::)?[A-Za-z][A-Za-z0-9.]*(@[0-9][0-9A-Za-z.-]*)?$/,
  /^bioc::[A-Za-z][A-Za-z0-9.]*$/,
  /^(github::)?[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+(@[A-Za-z0-9._\/-]+)?$/,
];

const isRef = (r: string) => REF.some((re) => re.test(r));
/** An R package name, as R allows them. */
const NAME = /^[A-Za-z][A-Za-z0-9.]*$/;
const VERSION = /^[0-9][0-9.-]*$/;

export function checkRefs(refs: string[]): string | null {
  if (!refs.length) return 'Name at least one package.';
  const bad = refs.filter((r) => !isRef(r));
  return bad.length
    ? `Not a package name this host installs: ${bad.join(', ')}. Use a CRAN name (dplyr, dplyr@1.1.4), bioc::name, or owner/repo for GitHub.`
    : null;
}

/** Where things are, on the host and inside. */
export function layout(ctx: { dataDir: string; workspaceKey: string }) {
  const lib = join(ctx.dataDir, 'libs', ctx.workspaceKey);
  const cache = join(ctx.dataDir, 'cache');
  const downloads = join(ctx.dataDir, 'downloads');
  const inside = { lib: '/rpkgs/libs/w', cache: '/rpkgs/cache', downloads: '/rpkgs/downloads' };
  const mounts = (access: Mount['access']): Mount[] => [
    { host: lib, inside: inside.lib, access },
    { host: cache, inside: inside.cache, access },
    ...(access === 'read-write' ? [{ host: downloads, inside: inside.downloads, access }] : []),
  ];
  return { lib, cache, downloads, inside, mounts };
}

/** The workspace's library, read on the host (the links resolve here too). */
function libraryNow(lib: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(lib)) return out;
  for (const name of readdirSync(lib)) {
    try {
      const desc = readFileSync(join(lib, name, 'DESCRIPTION'), 'utf8');
      const version = /^Version:\s*(.+)$/m.exec(desc)?.[1]?.trim();
      if (version) out[name] = version;
    } catch { /* a dangling link or stray file */ }
  }
  return out;
}

interface InstallerResult {
  ok: boolean;
  message?: string;
  system?: string[];
  installed?: string[];
  packages?: { name: string; version: string; ref: string }[];
  /** Asked for, and provided by the environment itself: recorded as used from it. */
  environment?: { name: string; version: string }[];
}

/** The longest an install may take (a package's build script that never ends, say). */
const INSTALL_MS = 30 * 60_000;
/** The end of the installer's output kept for people to read when something went wrong. */
const MAX_LOG = 200_000;

/** Run the installer: the network, no workspace, the library and cache writable. */
async function runInstaller(ctx: PackageContext, request: { refs: string[]; environment?: { name: string; version: string }[] }): Promise<{ result: InstallerResult; log: string }> {
  const where = layout(ctx);
  // Its own scratch, per workspace (installs for one workspace run one at a time), emptied first.
  const scratch = join(ctx.dataDir, 'tmp', ctx.workspaceKey);
  await Promise.all([where.lib, where.cache, where.downloads, ctx.files, scratch].map((d) => mkdir(d, { recursive: true })));
  await emptyDir(scratch);
  await writeIfChanged(join(ctx.files, 'install.R'), R_INSTALLER);
  const proc = await ctx.environment.start({
    name: 'r-install',
    workspace: ctx.workspace, scratch, files: ctx.files,
    mounts: where.mounts('read-write'),
    policy: { ...ctx.policy, workspace: 'none', network: true },
    image: imageRecipe(ctx.requirements, ctx.workspace, ctx.options),
    command: (view) => ({
      argv: ['Rscript', '--no-save', '--no-restore', `${view.files}/install.R`],
      cwd: view.inside(where.lib),
      env: {
        KURAA_INSTALL: JSON.stringify({ lib: view.inside(where.lib), cache: view.inside(where.cache), refs: request.refs, environment: request.environment ?? [] }),
        R_USER_CACHE_DIR: view.inside(where.downloads),
      },
    }),
    log: ctx.log,
    status: ctx.status,
  }, ctx.environmentOptions);
  // The result is the last prefixed line: packages' build scripts run before it, and could print one.
  let reply: string | null = null;
  let log = '';
  const keep = (text: string) => (log = (log + text).slice(-MAX_LOG));
  let shown = 0;
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', splitLines((line) => {
    const at = line.indexOf(REPLY_PREFIX);
    if (at >= 0) reply = line.slice(at + REPLY_PREFIX.length);
    else keep(`${line}\n`);
  }, (partial) => keep(`${partial.slice(0, 1000)}…\n`)));
  proc.stderr.on('data', (d: string) => {
    keep(d);
    const last = d.trim().split('\n').pop();
    // Progress for everyone with the workspace open, a few times a second at most.
    if (last && Date.now() - shown > 250) {
      shown = Date.now();
      ctx.status(`Installing: ${last.slice(0, 120)}`);
    }
  });
  proc.stdin.on('error', () => undefined);
  proc.stdin.end();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, INSTALL_MS);
  const { reason } = await proc.exited;
  clearTimeout(timer);
  log = log.trim();
  if (reason) return { result: { ok: false, message: `The install was stopped. ${reason}` }, log };
  if (timedOut) return { result: { ok: false, message: `The install was stopped after ${INSTALL_MS / 60_000} minutes.` }, log };
  if (reply === null) return { result: { ok: false, message: 'The installer stopped without saying why.' }, log };
  try {
    return { result: JSON.parse(reply) as InstallerResult, log };
  } catch {
    return { result: { ok: false, message: 'The installer gave an answer that could not be read.' }, log };
  }
}

async function saveManifest(ctx: PackageContext, m: Manifest, message: string): Promise<void> {
  const next = formatManifest(m);
  const now = await readWorkspaceFile(ctx.workspace, MANIFEST).then((b) => b.toString('utf8'), () => '');
  if (now === next) return;
  // Never through a link (0037).
  await writeWorkspaceFile(ctx.workspace, MANIFEST, next);
  await ctx.commit([MANIFEST], message);
}

const verifiedFile = (ctx: PackageContext) => join(layout(ctx).lib, '..', `${ctx.workspaceKey}.verified`);
const fingerprint = (ctx: PackageContext) => createHash('sha1').update(formatManifest(readManifest(ctx.workspace))).update(JSON.stringify(ctx.requirements ?? null)).digest('hex');

export const rPackages: PackageManager = {
  async list(ctx) {
    const lib = libraryNow(layout(ctx).lib);
    const m = readManifest(ctx.workspace);
    const out: PackageInfo[] = Object.entries(lib).map(([name, version]) => ({ name, version, source: 'workspace' }));
    for (const [name, version] of Object.entries(m.environment)) if (!lib[name]) out.push({ name, version, source: 'environment' });
    return out.sort((a, b) => a.name.localeCompare(b.name));
  },

  async install(ctx, refs): Promise<PackageResult> {
    const bad = checkRefs(refs);
    if (bad) return { ok: false, message: bad, log: '', restart: false };
    ctx.status(`Installing ${refs.join(', ')}…`);
    const { result, log } = await runInstaller(ctx, { refs });
    const m = readManifest(ctx.workspace);
    if (!result.ok && result.system?.length) {
      // Record the system libraries: the environment is rebuilt with them, then the install is tried again.
      m.system = [...new Set([...m.system, ...result.system])];
      await saveManifest(ctx, m, `R packages: add system libraries ${result.system.join(', ')}`);
      ctx.status('Rebuilding the environment with the system libraries the packages need…');
      const again = await runInstaller(ctx, { refs });
      if (!again.result.ok) {
        const still = again.result.system?.length ? `These system libraries are still missing after rebuilding the environment: ${again.result.system.join(', ')}.` : (again.result.message ?? 'The install failed.');
        return { ok: false, message: still, log: again.log, restart: false };
      }
      await recordInstall(ctx, refs, again.result);
      return { ok: true, message: `${describe(again.result)} New system libraries were added: restart R to use them.`, log: again.log, restart: true };
    }
    if (!result.ok) return { ok: false, message: result.message ?? 'The install failed.', log, restart: false };
    await recordInstall(ctx, refs, result);
    return { ok: true, message: describe(result), log, restart: false };
  },

  async remove(ctx, names) {
    // Names become paths: only package names, never `../` to a link elsewhere on this computer.
    const bad = names.filter((n) => !NAME.test(n));
    if (bad.length) return { ok: false, message: `Not a package name: ${bad.join(', ')}.`, log: '', restart: false };
    const { lib } = layout(ctx);
    const gone: string[] = [];
    for (const name of names) {
      const at = join(lib, name);
      try {
        // Only the workspace's link: the cache entry may be used by other workspaces.
        if (lstatSync(at).isSymbolicLink()) {
          await unlink(at);
          gone.push(name);
        }
      } catch { /* not installed here */ }
    }
    const m = readManifest(ctx.workspace);
    m.requested = m.requested.filter((r) => !names.includes(r.replace(/^(cran|bioc)::/, '').replace(/@.*$/, '')));
    const now = libraryNow(lib);
    m.packages = Object.fromEntries(Object.entries(m.packages).filter(([name]) => now[name]));
    await saveManifest(ctx, m, `R packages: remove ${names.join(', ')}`);
    return { ok: true, message: gone.length ? `Removed ${gone.join(', ')}. Restart R if it was loaded.` : 'Nothing to remove.', log: '', restart: false };
  },

  async restore(ctx) {
    const m = readManifest(ctx.workspace);
    const lib = libraryNow(layout(ctx).lib);
    // The manifest is a file in the workspace: only refs the host would install if asked for them.
    const wanted = Object.entries(m.packages).filter(([name, p]) => lib[name] !== p.version).map(([, p]) => p.ref);
    const missing = wanted.filter(isRef);
    const env = Object.entries(m.environment).filter(([name, version]) => !lib[name] && NAME.test(name) && VERSION.test(version)).map(([name, version]) => ({ name, version }));
    const skipped = [...wanted.filter((r) => !isRef(r)), ...Object.keys(m.environment).filter((n) => !lib[n] && !env.some((e) => e.name === n))];
    if (skipped.length) ctx.log(`${MANIFEST} lists what this host does not install: ${skipped.join(', ')}`);
    if (!missing.length && !env.length) return null;
    // Environment entries need a look inside the image; do that once per manifest.
    const mark = fingerprint(ctx);
    if (!missing.length && (await readFile(verifiedFile(ctx), 'utf8').catch(() => '')) === mark) return null;
    ctx.status("Installing the workspace's packages…");
    const { result, log } = await runInstaller(ctx, { refs: missing, environment: env });
    if (result.ok) await writeFile(verifiedFile(ctx), mark);
    return result.ok
      ? { ok: true, message: describe(result), log, restart: false }
      : { ok: false, message: result.message ?? "The workspace's packages could not be installed.", log, restart: false };
  },

  async recordUsed(ctx, packages) {
    const m = readManifest(ctx.workspace);
    const lib = libraryNow(layout(ctx).lib);
    const fresh = packages.filter((p) => !lib[p.name] && m.environment[p.name] !== p.version);
    if (!fresh.length) return;
    for (const p of fresh) m.environment[p.name] = p.version;
    await saveManifest(ctx, m, `R packages: record ${fresh.map((p) => p.name).join(', ')} from the environment`);
  },
};

async function recordInstall(ctx: PackageContext, refs: string[], result: InstallerResult): Promise<void> {
  const m = readManifest(ctx.workspace);
  m.requested = [...new Set([...m.requested, ...refs])];
  // The installer always reports the whole library; without a report, keep what is recorded.
  // Packages' own build scripts ran in it, so only entries the host would install go in.
  const fit = (p: { name?: unknown; version?: unknown }) => typeof p?.name === 'string' && NAME.test(p.name) && typeof p.version === 'string' && VERSION.test(p.version);
  if (Array.isArray(result.packages)) m.packages = Object.fromEntries(result.packages.filter((p) => fit(p) && typeof p.ref === 'string' && isRef(p.ref)).map((p) => [p.name, { version: p.version, ref: p.ref }]));
  for (const p of Array.isArray(result.environment) ? result.environment : []) if (fit(p)) m.environment[p.name] = p.version;
  await saveManifest(ctx, m, `R packages: install ${refs.join(', ')}`);
}

function describe(result: InstallerResult): string {
  const n = result.installed?.length ?? 0;
  if (!n) return result.message ?? 'Already installed.';
  const shown = result.installed!.slice(0, 6).join(', ');
  return `Installed ${shown}${n > 6 ? ` and ${n - 6} more` : ''}.`;
}
