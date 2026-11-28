// The server as released, updating itself (decision 0052).
//
// Each release carries kuraa-server-<version>.tar.gz (scripts/build-server.mjs):
// the server and the web client in one folder, needing only Node and git. It is
// signed with the release key (Ed25519; the private key is the release
// workflow's secret, and the public key is built into every server), and a
// server takes an update only if the signature is good.
//
// Installed (`kuraa-host install`), it lives in a folder of its own:
//
//   <root>/kuraa-host.mjs        starts the version `current` names, or goes back to the last
//                                good one if it fails to start three times (rewritten by a
//                                version that has run well, when it is not the launcher it has)
//   <root>/kuraa-host, .cmd      the same, for the shell and for Windows
//   <root>/current               the version to run
//   <root>/good                  the last version that ran well (for two minutes)
//   <root>/tries                 how often `current` has been started since it last ran well
//   <root>/failed                a version that did not start: never taken again
//   <root>/versions/<version>/   each version, as released (this one, and the good one)
//
// `kuraa-host update` puts the latest release beside the others and names it in
// `current`, which takes effect when the server next starts. With
// `--auto-update`, the server looks every six hours, and once it has put one in
// place, stops (saving everything) for its service manager to start it again:
// at night (between 3 and 5), or at once if a device of a workspace already runs
// a newer kuraa, as the two do not sync until then. `install --service` writes
// the service (systemd on Linux, launchd on macOS) that does the starting.
import { createHash, createPublicKey, verify as verifySignature, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, closeSync, cpSync, existsSync, openSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { PROTOCOL } from './peers/link.js';

/** What a server build knows of itself (scripts/build-server.mjs). */
export interface ServerBuild {
  version: string;
  /** Where its releases are: `owner/repo` on GitHub; null: nowhere. */
  repo: string | null;
  /** The release key's public half (PEM); null: built without one, so updates are checked only by checksum. */
  publicKey: string | null;
}

/** A release, as found: its version and the archive's address and signature's. */
export interface Release {
  version: string;
  archive: string;
  signature: string | null;
  /** The archive's SHA-256 (hex), as GitHub lists it for the asset. */
  checksum: string | null;
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** Whether a string is a version (semver, as releases are named): what a device says it runs is taken only so. */
export const isVersion = (v: string) => v.length <= 64 && SEMVER.test(v);

/** Compare two versions as semver does (a pre-release comes before its release). */
export function compareVersions(a: string, b: string): number {
  const x = SEMVER.exec(a);
  const y = SEMVER.exec(b);
  if (!x || !y) throw new Error(`Not a version: ${!x ? a : b}`);
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) - Number(y[i]);
  if (!x[4] || !y[4]) return (x[4] ? -1 : 0) - (y[4] ? -1 : 0);
  const p = x[4].split('.');
  const q = y[4].split('.');
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1;
    if (q[i] === undefined) return 1;
    const n = /^\d+$/.test(p[i]!) && /^\d+$/.test(q[i]!) ? Number(p[i]) - Number(q[i]) : p[i]!.localeCompare(q[i]!);
    if (n) return n;
  }
  return 0;
}

/** The archive's name in a release. */
export const archiveName = (version: string) => `kuraa-server-${version}.tar.gz`;

/** The latest published release on GitHub (pre-releases are never latest), or null if there is none. */
export async function latestRelease(repo: string): Promise<Release | null> {
  const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'kuraa-server' } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub answered ${r.status} when asked for the latest release`);
  const body = (await r.json()) as { tag_name?: string; assets?: { name: string; browser_download_url: string; digest?: string | null }[] };
  const version = String(body.tag_name ?? '').replace(/^v/, '');
  if (!SEMVER.test(version)) return null;
  const asset = (name: string) => body.assets?.find((a) => a.name === name);
  const archive = asset(archiveName(version));
  if (!archive) return null;
  const digest = /^sha256:([0-9a-f]{64})$/i.exec(archive.digest ?? '');
  return { version, archive: archive.browser_download_url, signature: asset(`${archiveName(version)}.sig`)?.browser_download_url ?? null, checksum: digest ? digest[1]! : null };
}

/** The most an archive, and a signature, may be (0112): checked before the signature is, so read with a limit. */
export const MAX_ARCHIVE_BYTES = 1024 ** 3;
export const MAX_SIGNATURE_BYTES = 4096;

/**
 * Download a release's file, at most `max` bytes (0112: whoever could change
 * what is published could else make every server read without end before the
 * signature is checked), from where it was asked for, or GitHub's own hosts for
 * its downloads, where GitHub sends them.
 */
export async function download(url: string, max: number): Promise<Buffer> {
  const name = basename(new URL(url).pathname);
  const r = await fetch(url, { headers: { 'user-agent': 'kuraa-server' }, redirect: 'follow' });
  if (!r.ok) throw new Error(`Downloading ${name} failed (${r.status})`);
  const to = new URL(r.url || url).hostname;
  if (to !== new URL(url).hostname && to !== 'github.com' && !to.endsWith('.githubusercontent.com')) throw new Error(`Downloading ${name}: sent to ${to}, which is not GitHub`);
  if (Number(r.headers.get('content-length') ?? 0) > max) throw new Error(`Downloading ${name}: larger than ${max} bytes`);
  const parts: Buffer[] = [];
  let size = 0;
  const reader = r.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`Downloading ${name}: larger than ${max} bytes`);
    }
    parts.push(Buffer.from(value));
  }
  return Buffer.concat(parts);
}

/**
 * Whether an archive is the release's: signed with the release key, if this
 * server was built with one (anyone could make one that passes a checksum from
 * the same place, so a server with a key takes nothing unsigned); else the
 * checksum the release lists.
 */
export function checkArchive(archive: Buffer, o: { publicKey: string | null; signature: Buffer | null; checksum: string | null }): string | null {
  if (o.publicKey) {
    if (!o.signature) return 'the release is not signed';
    const ok = verifySignature(null, archive, createPublicKey(o.publicKey), Buffer.from(o.signature.toString('utf8').trim(), 'base64'));
    return ok ? null : 'its signature is not the release key’s';
  }
  if (!o.checksum) return 'the release lists no checksum';
  return createHash('sha256').update(archive).digest('hex') === o.checksum.trim().toLowerCase() ? null : 'its checksum does not match';
}

/** An installed server's folder, if this build runs from one (versions/<version>/ under it). */
export function installedRoot(here: string): string | null {
  const versions = dirname(here);
  const root = dirname(versions);
  return basename(versions) === 'versions' && existsSync(join(root, 'current')) ? root : null;
}

/** The version `current` names. */
export const currentVersion = (root: string) => readFileSync(join(root, 'current'), 'utf8').trim();

/** Name a version as the one to run: the next start runs it. Written whole, then put in place. */
function setCurrent(root: string, version: string): void {
  writeFileSync(join(root, 'current.next'), `${version}\n`);
  renameSync(join(root, 'current.next'), join(root, 'current'));
}

/** Keep the version to run, the one before it and the last good one; remove the rest. */
function prune(root: string, keep: string[]): void {
  const good = readMark(root, 'good');
  const kept = good ? [...keep, good] : keep;
  for (const v of readdirSync(join(root, 'versions'))) if (!kept.includes(v)) rmSync(join(root, 'versions', v), { recursive: true, force: true });
}

/** One of the folder's marks (`good`, `failed`, `tries`), or null. */
function readMark(root: string, name: string): string | null {
  try {
    return readFileSync(join(root, name), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** Write a mark whole. */
function writeMark(root: string, name: string, value: string): void {
  writeFileSync(join(root, `${name}.next`), `${value}\n`);
  renameSync(join(root, `${name}.next`), join(root, name));
}

/**
 * This version has run well (0052, 0099): the one to go back to should a later
 * one fail to start; and the launcher made the one that goes back, if it is an
 * older one that never does (installed before it could). Whether the launcher
 * was rewritten.
 */
export function markGood(root: string, version: string): boolean {
  writeMark(root, 'good', version);
  writeMark(root, 'tries', '0');
  const file = join(root, 'kuraa-host.mjs');
  if (readMark(root, 'kuraa-host.mjs') === LAUNCHER.trim()) return false;
  writeFileSync(`${file}.next`, LAUNCHER);
  renameSync(`${file}.next`, file);
  return true;
}

/** The major version of Node a release says it needs (its package.json's engines.node: `>=24`), or null. */
function nodeNeeded(dir: string): number | null {
  try {
    const wants = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { engines?: { node?: string } }).engines?.node;
    const m = wants ? /^>=\s*(\d+)/.exec(wants) : null;
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Put a release's archive in place under the server's folder, and name it in
 * `current`. The archive holds one folder, kuraa-server-<version>, with
 * kuraa-host.mjs and VERSION in it.
 */
/** How a release's devices speak to each other (its PROTOCOL file, 0112); null for one from before that says none. */
export function protocolOf(dir: string): number | null {
  try {
    const n = Number(readFileSync(join(dir, 'PROTOCOL'), 'utf8').trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * This start does not count against the version (0115): it stopped for a
 * reason not its own (another server holds its folder), so the launcher does
 * not go back from it, nor mark it failed, for that. Run from an installed
 * release (`here`), else nothing.
 */
export function uncountStart(here: string): void {
  const root = installedRoot(here);
  if (!root) return;
  const tries = Number(readMark(root, 'tries')) || 0;
  if (tries > 0) writeMark(root, 'tries', String(tries - 1));
}

/** Name an installed version as the one to run from the next start, its tries counted afresh, the old ones let go of. */
export function placeVersion(root: string, version: string): void {
  // Not one that is not there (0115): named, it would not start, and the launcher would go back from it, marked failed.
  if (!existsSync(join(root, 'versions', version, 'kuraa-host.mjs'))) throw new Error(`kuraa ${version} is not in place to run`);
  const before = existsSync(join(root, 'current')) ? currentVersion(root) : null;
  setCurrent(root, version);
  writeMark(root, 'tries', '0');
  prune(root, [version, ...(before && before !== version ? [before] : [])]);
}

/**
 * Unpack a release beside the others and (`place`) name it as the one to run.
 * Not placed: held there, to be placed later (placeVersion).
 */
export function installArchive(root: string, archive: Buffer, version: string, place = true): void {
  const tmp = mkdtempSync(join(root, 'versions', '.incoming-'));
  try {
    const file = join(tmp, archiveName(version));
    writeFileSync(file, archive);
    execFileSync('tar', ['-xzf', file, '-C', tmp]);
    const unpacked = join(tmp, `kuraa-server-${version}`);
    if (!existsSync(join(unpacked, 'kuraa-host.mjs')) || readFileSync(join(unpacked, 'VERSION'), 'utf8').trim() !== version) throw new Error('The archive is not the server it says it is');
    // One that needs a newer Node than runs it would not start (the service names this Node): not put in place.
    const needs = nodeNeeded(unpacked);
    const have = Number(process.versions.node.split('.')[0]);
    if (needs !== null && have < needs) throw new Error(`kuraa ${version} needs Node ${needs} or later, and this is Node ${process.versions.node}: update Node, then run kuraa-host install again`);
    const to = join(root, 'versions', version);
    rmSync(to, { recursive: true, force: true });
    renameSync(unpacked, to);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  if (place) placeVersion(root, version);
}

/**
 * Look for a newer release and put it in place. Returns the version put in
 * place, or null if this one is the latest.
 */
export async function updateFrom(o: {
  root: string;
  build: ServerBuild;
  latest?: () => Promise<Release | null>;
  fetch?: (url: string, max: number) => Promise<Buffer>;
  /**
   * A release that changes how devices speak to each other (its PROTOCOL, 0112)
   * is unpacked but not placed, and this told of it; null is returned. None: placed
   * as any other (an operator's update).
   */
  hold?: (version: string, protocol: number | null) => void;
  /** A version held already: not downloaded again. */
  held?: string | null;
}): Promise<string | null> {
  const get = o.fetch ?? download;
  const r = await (o.latest ?? (() => latestRelease(o.build.repo!)))();
  if (!r) return null;
  const running = currentVersion(o.root);
  if (compareVersions(r.version, running) <= 0) return null;
  // One that did not start here (the launcher went back from it): not again; a later one, yes.
  if (r.version === readMark(o.root, 'failed')) return null;
  if (o.held && r.version === o.held) return null;
  const archive = await get(r.archive, MAX_ARCHIVE_BYTES);
  const why = checkArchive(archive, {
    publicKey: o.build.publicKey,
    signature: r.signature ? await get(r.signature, MAX_SIGNATURE_BYTES) : null,
    checksum: r.checksum,
  });
  if (why) throw new Error(`Not updating to ${r.version}: ${why}`);
  installArchive(o.root, archive, r.version, !o.hold);
  if (o.hold) {
    const protocol = protocolOf(join(o.root, 'versions', r.version));
    if (protocol !== PROTOCOL) {
      o.hold(r.version, protocol);
      return null;
    }
    placeVersion(o.root, r.version);
  }
  return r.version;
}

// Installing -----------------------------------------------------------------

const LAUNCHER = `// Starts the kuraa version named in ./current (kuraa-host update changes it). If that one has
// been started three times without running well (the version writes ./good once it has, for two
// minutes), goes back to the last good one, and marks the other ./failed, never to be taken again
// (selfupdate.ts, decisions 0052 and 0099).
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
const read = (name) => { try { return readFileSync(join(root, name), 'utf8').trim() || null; } catch { return null; } };
const write = (name, value) => { writeFileSync(join(root, name + '.next'), value + '\\n'); renameSync(join(root, name + '.next'), join(root, name)); };
let version = read('current');
const good = read('good');
if (version && good && version !== good) {
  const tries = (Number(read('tries')) || 0) + 1;
  if (tries > 3 && existsSync(join(root, 'versions', good, 'kuraa-host.mjs'))) {
    console.error('[kuraa] kuraa ' + version + ' did not start three times: going back to ' + good);
    write('failed', version);
    write('current', good);
    write('tries', '0');
    version = good;
  } else write('tries', String(tries));
}
await import(pathToFileURL(join(root, 'versions', version, 'kuraa-host.mjs')).href);
`;

/** Set in the environment of the service `install --service` writes. */
export const SERVICE_ENV = 'KURAA_SERVICE';

/**
 * Whether this server runs as an installed service, whose output goes to a log
 * (kuraa.log, the journal) rather than to a person: it never prints its access
 * code there. One installed before the service said so is known by launchd's label.
 */
export function runsAsService(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SERVICE_ENV] === '1' || env.XPC_SERVICE_NAME === 'org.kuraa.server';
}

/** Where `install` puts the server unless told. */
export const defaultServerRoot = () => join(homedir(), '.kuraa', 'server');

/**
 * Install this server (an unpacked release, at `here`) in a folder of its own,
 * as the version to run, with its launchers. With `service`, write a service
 * that runs it with `--auto-update` and `args`, with an access code of its own
 * (kept in the service, so it stays the same across restarts). `updates`
 * (0112): `off`, not updating itself (--no-auto-update: whoever runs it updates
 * it, with kuraa-host update); `all`, taking releases that change the protocol
 * at once (--auto-update-all). Returns what to tell the person.
 */
export function installServer(o: { here: string; version: string; root: string; service: boolean; args: string[]; updates?: 'compatible' | 'all' | 'off'; platform?: NodeJS.Platform; home?: string; node?: string }): string[] {
  const root = resolve(o.root);
  const to = join(root, 'versions', o.version);
  mkdirSync(join(root, 'versions'), { recursive: true });
  if (resolve(o.here) !== to) {
    rmSync(to, { recursive: true, force: true });
    cpSync(o.here, to, { recursive: true });
  }
  setCurrent(root, o.version);
  writeFileSync(join(root, 'kuraa-host.mjs'), LAUNCHER);
  const node = o.node ?? process.execPath;
  writeFileSync(join(root, 'kuraa-host'), `#!/bin/sh\nexec "${node}" "$(dirname "$0")/kuraa-host.mjs" "$@"\n`);
  chmodSync(join(root, 'kuraa-host'), 0o755);
  writeFileSync(join(root, 'kuraa-host.cmd'), `@"${node}" "%~dp0kuraa-host.mjs" %*\r\n`);
  const said = [`Installed kuraa ${o.version} in ${root}. Run it with ${join(root, 'kuraa-host')}.`];
  if (!o.service) return said;
  const platform = o.platform ?? process.platform;
  const home = o.home ?? homedir();
  const token = randomBytes(18).toString('base64url');
  const updating = o.updates === 'off' ? [] : o.updates === 'all' ? ['--auto-update', '--auto-update-all'] : ['--auto-update'];
  const argv = [node, join(root, 'kuraa-host.mjs'), ...updating, ...o.args];
  if (platform === 'linux') {
    const file = join(home, '.config', 'systemd', 'user', 'kuraa.service');
    mkdirSync(dirname(file), { recursive: true });
    const quote = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `"${a.replace(/(["\\$`])/g, '\\$1')}"`);
    writeFileSync(file, [
      '[Unit]',
      'Description=kuraa server',
      'After=network-online.target',
      '',
      '[Service]',
      `ExecStart=${argv.map(quote).join(' ')}`,
      `Environment=KURAA_TOKEN=${token}`,
      // So it does not print its access code into the journal (cli.ts).
      `Environment=${SERVICE_ENV}=1`,
      // Stopped to update (or by mistake): started again.
      'Restart=always',
      'RestartSec=10',
      // Stopping: the server is told (it saves everything, then exits), not its git processes, which a stop would
      // otherwise cut off mid-write, leaving locks behind (0099).
      'KillMode=mixed',
      'TimeoutStopSec=90',
      // A connection and git processes for each member of each workspace (0112): more than a user session's defaults.
      'LimitNOFILE=65536',
      'TasksMax=4096',
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n'), { mode: 0o600 });
    // Its access code is in it: for this user alone, even where it was there before (mode applies only to a new file).
    chmodSync(file, 0o600);
    said.push(
      `Wrote ${file} (its access code: ${token}). Start it, now and at every boot:`,
      '  systemctl --user daemon-reload && systemctl --user enable --now kuraa',
      '  loginctl enable-linger "$USER"     # to run when you are not logged in',
      'Its log: journalctl --user -u kuraa -f',
    );
  } else if (platform === 'darwin') {
    const file = join(home, 'Library', 'LaunchAgents', 'org.kuraa.server.plist');
    mkdirSync(dirname(file), { recursive: true });
    const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const log = join(root, 'kuraa.log');
    writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>org.kuraa.server</string>
  <key>ProgramArguments</key><array>${argv.map((a) => `<string>${xml(a)}</string>`).join('')}</array>
  <key>EnvironmentVariables</key><dict><key>KURAA_TOKEN</key><string>${token}</string><key>${SERVICE_ENV}</key><string>1</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`, { mode: 0o600 });
    // Its access code is in it, and the log is the server's own: both for this user alone.
    chmodSync(file, 0o600);
    closeSync(openSync(log, 'a', 0o600));
    chmodSync(log, 0o600);
    said.push(`Wrote ${file} (its access code: ${token}). Start it, now and at every login:`, `  launchctl load -w ${file}`, `Its log: ${log}`);
  } else {
    said.push('No service for this system: run it with --auto-update under whatever starts it again when it stops.');
  }
  // As a server (0099): headless, so workspaces come to it from the shell.
  if (o.args[0] === 'server') said.push(`Then bring a workspace onto it: ${join(root, 'kuraa-host')} server join <invite link for a server>; ${join(root, 'kuraa-host')} server list says what it holds.`);
  return said;
}

// Updating while it runs ---------------------------------------------------------

/** How often a server with --auto-update looks. */
const EVERY_MS = 6 * 3600_000;

/** How long until the next quiet hour to restart in: between 3 and 5 at night, local time. */
export function untilNight(now = new Date()): number {
  const at = new Date(now);
  at.setHours(3, 0, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at.getTime() - now.getTime() + Math.floor(Math.random() * 2 * 3600_000);
}

/**
 * Keep a running server up to date (--auto-update): look a few minutes after
 * starting and every six hours; once an update is in place, `restart` (the
 * server stops, saving everything, for its service manager to start it again),
 * at night, or at once when a device runs a newer kuraa (`newer`).
 *
 * A release that changes how devices speak to each other (its PROTOCOL, 0112)
 * no longer syncs with devices still on an older one: held, not placed, until a
 * device of its workspaces runs it (`newer`), so a server does not leave all its
 * members behind overnight; then placed, and restarted at once. `all`: placed
 * as any other (--auto-update-all).
 */
export function autoUpdate(o: {
  here: string;
  build: ServerBuild;
  log(m: string): void;
  restart(): void;
  /** Take releases that change the protocol at once, not when a device runs them (--auto-update-all). */
  all?: boolean;
  /**
   * A device speaks a newer protocol it does not sync in (0115: with the
   * protocol, and the workspace it is in): a held release that speaks it is put in
   * place once devices of enough of its workspaces do, and restarted to at once.
   */
  newer(fn: (protocol?: number, workspace?: string) => void): void;
  /** How many workspaces it holds (0115): of two, a newer protocol in two of them switches it. */
  workspaces?: () => number;
  /** A device runs a newer release, speaking the same protocol (0099): looked for now, restarting at night. */
  newerRelease?(fn: (version: string) => void): void;
  /** Where the latest release is found (tests); default: the build's repository. */
  latest?: () => Promise<Release | null>;
  /** How its files are fetched (tests); default: downloaded. */
  fetch?: (url: string, max: number) => Promise<Buffer>;
  /** How long it must run before it is the one to go back to (tests); default two minutes. */
  goodAfterMs?: number;
}): void {
  const root = installedRoot(o.here);
  if (!root) return o.log('not updating itself: not run from an installed release (kuraa-host install)');
  // Run well for two minutes: the one to go back to, should a later one not start (and the launcher that would).
  setTimeout(() => {
    try {
      if (markGood(root, o.build.version)) o.log('the launcher now goes back to this version should a later one not start');
    } catch (e) {
      o.log(`could not mark this version as good: ${(e as Error).message}`);
    }
  }, o.goodAfterMs ?? 2 * 60_000).unref();
  if (!o.build.repo) return o.log('not updating itself: built without a place to look for releases');
  // Built without the release key (0052): any archive matching GitHub's checksum would be taken. Not unattended.
  if (!o.build.publicKey) return o.log('not updating itself: built without the release key, so an update could not be checked as the release’s');
  let ready: string | null = null;
  let restartTimer: NodeJS.Timeout | undefined;
  let outdated = false;
  const restartSoon = () => {
    if (!ready) return;
    clearTimeout(restartTimer);
    const ms = outdated ? 0 : untilNight();
    if (ms) o.log(`kuraa ${ready} is in place; restarting to use it in ${Math.round(ms / 60_000)} minutes`);
    restartTimer = setTimeout(() => {
      o.log(`restarting to use kuraa ${ready}`);
      o.restart();
    }, ms);
    restartTimer.unref();
  };
  // A release held for its protocol (0112): placed once devices of its workspaces run the protocol it speaks (0115: of
  // two workspaces, where it holds more than one, so one member saying so cannot switch every other workspace's
  // members off; at once, where they did before it was found). Kept on the disk, so a restart does not fetch it again.
  const heldFile = join(root, 'held');
  let held: { version: string; protocol: number | null } | null = (() => {
    try {
      const h = JSON.parse(readFileSync(heldFile, 'utf8')) as { version?: string; protocol?: number | null };
      return h.version && isVersion(h.version) && existsSync(join(root, 'versions', h.version, 'kuraa-host.mjs')) ? { version: h.version, protocol: h.protocol ?? null } : null;
    } catch {
      return null;
    }
  })();
  const keepHeld = () => {
    try {
      if (held) writeFileSync(heldFile, JSON.stringify(held));
      else rmSync(heldFile, { force: true });
    } catch {
      // Not kept: fetched again after a restart.
    }
  };
  /** The workspaces whose devices were found running each newer protocol. */
  const seen = new Map<number, Set<string>>();
  const enough = (protocol: number | null): boolean => {
    const ws = new Set<string>();
    for (const [p, set] of seen) if (protocol === null || p >= protocol) for (const w of set) ws.add(w);
    return ws.size >= Math.min(2, Math.max(1, o.workspaces?.() ?? 1));
  };
  const placeHeld = (why: string): void => {
    if (!held || ready) return;
    const h = held;
    held = null;
    keepHeld();
    try {
      if (!existsSync(join(root, 'versions', h.version, 'kuraa-host.mjs'))) throw new Error('it is no longer in place');
      placeVersion(root, h.version);
      o.log(`${why}: kuraa ${h.version}, which syncs with them, is in place`);
      ready = h.version;
      outdated = true;
      restartSoon();
    } catch (e) {
      o.log(`could not put kuraa ${h.version} in place: ${(e as Error).message}`);
    }
  };
  o.newer((protocol, workspace) => {
    // Told without a protocol (an older caller): as before, at once.
    if (protocol === undefined || !workspace) {
      outdated = true;
      placeHeld('a device runs a newer kuraa');
      restartSoon();
      void look();
      return;
    }
    const set = seen.get(protocol) ?? new Set<string>();
    set.add(workspace);
    seen.set(protocol, set);
    if (held && enough(held.protocol)) placeHeld('devices of its workspaces run a newer kuraa');
    void look();
  });
  let looking = false;
  let lookedAt = 0;
  o.newerRelease?.((version) => {
    if (!isVersion(version) || compareVersions(version, o.build.version) <= 0 || Date.now() - lookedAt < 3600_000) return;
    o.log(`a device runs kuraa ${version}: looking for it now`);
    void look();
  });
  const look = async () => {
    if (looking || ready) return;
    looking = true;
    lookedAt = Date.now();
    try {
      const hold = (version: string, protocol: number | null) => {
        if (held?.version !== version) o.log(`kuraa ${version} changes how devices sync (${protocol === null ? 'it does not say how' : `protocol ${PROTOCOL} → ${protocol}`}): held until devices of its workspaces run it, as devices on this one would not sync with it (--auto-update-all takes such a release at once; kuraa-host update puts it in place now)`);
        held = { version, protocol };
        keepHeld();
        // Devices of its workspaces ran it before it was found: in place now.
        if (enough(protocol) && seen.size) placeHeld('devices of its workspaces run it already');
      };
      const v = await updateFrom({ root, build: o.build, ...(o.latest ? { latest: o.latest } : {}), ...(o.fetch ? { fetch: o.fetch } : {}), ...(o.all ? {} : { hold, held: held?.version ?? null }) });
      if (v) {
        // One placed lets go of any held before it (placeVersion keeps only the versions it needs).
        held = null;
        keepHeld();
        ready = v;
        restartSoon();
      }
    } catch (e) {
      o.log(`looking for updates: ${(e as Error).message}`);
    } finally {
      looking = false;
    }
  };
  setTimeout(() => void look(), 3 * 60_000).unref();
  setInterval(() => void look(), EVERY_MS).unref();
}
