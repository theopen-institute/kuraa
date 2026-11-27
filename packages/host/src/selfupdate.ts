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

async function download(url: string): Promise<Buffer> {
  const r = await fetch(url, { headers: { 'user-agent': 'kuraa-server' }, redirect: 'follow' });
  if (!r.ok) throw new Error(`Downloading ${basename(new URL(url).pathname)} failed (${r.status})`);
  return Buffer.from(await r.arrayBuffer());
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
export function installArchive(root: string, archive: Buffer, version: string): void {
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
  const before = existsSync(join(root, 'current')) ? currentVersion(root) : null;
  setCurrent(root, version);
  writeMark(root, 'tries', '0');
  prune(root, [version, ...(before && before !== version ? [before] : [])]);
}

/**
 * Look for a newer release and put it in place. Returns the version put in
 * place, or null if this one is the latest.
 */
export async function updateFrom(o: {
  root: string;
  build: ServerBuild;
  latest?: () => Promise<Release | null>;
  fetch?: (url: string) => Promise<Buffer>;
}): Promise<string | null> {
  const get = o.fetch ?? download;
  const r = await (o.latest ?? (() => latestRelease(o.build.repo!)))();
  if (!r) return null;
  const running = currentVersion(o.root);
  if (compareVersions(r.version, running) <= 0) return null;
  // One that did not start here (the launcher went back from it): not again; a later one, yes.
  if (r.version === readMark(o.root, 'failed')) return null;
  const archive = await get(r.archive);
  const why = checkArchive(archive, {
    publicKey: o.build.publicKey,
    signature: r.signature ? await get(r.signature) : null,
    checksum: r.checksum,
  });
  if (why) throw new Error(`Not updating to ${r.version}: ${why}`);
  installArchive(o.root, archive, r.version);
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
 * (kept in the service, so it stays the same across restarts). Returns what to
 * tell the person.
 */
export function installServer(o: { here: string; version: string; root: string; service: boolean; args: string[]; platform?: NodeJS.Platform; home?: string; node?: string }): string[] {
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
  const argv = [node, join(root, 'kuraa-host.mjs'), '--auto-update', ...o.args];
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
 */
export function autoUpdate(o: {
  here: string;
  build: ServerBuild;
  log(m: string): void;
  restart(): void;
  /** A device speaks a newer protocol: not syncing until updated, so at once. */
  newer(fn: () => void): void;
  /** A device runs a newer release, speaking the same protocol (0099): looked for now, restarting at night. */
  newerRelease?(fn: (version: string) => void): void;
  /** Where the latest release is found (tests); default: the build's repository. */
  latest?: () => Promise<Release | null>;
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
  o.newer(() => {
    outdated = true;
    restartSoon();
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
      const v = await updateFrom({ root, build: o.build, ...(o.latest ? { latest: o.latest } : {}) });
      if (v) {
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
