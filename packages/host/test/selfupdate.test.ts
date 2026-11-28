// The server as released updating itself (selfupdate.ts, decision 0052): it
// takes a newer release only if signed with the release key, puts it beside the
// one running, names it as the one to run, keeps the one before, and installs
// with a service that starts it again when it stops to update.
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { MAX_SIGNATURE_BYTES, autoUpdate, checkArchive, compareVersions, currentVersion, download, installServer, installedRoot, markGood, runsAsService, untilNight, updateFrom, type Release, type ServerBuild } from '../src/selfupdate.js';
import { PROTOCOL } from '../src/peers/link.js';

const temps: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'kuraa-selfupdate-'));
  temps.push(d);
  return d;
};
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const PUBLIC = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const other = generateKeyPairSync('ed25519').privateKey;

/** A release's folder, as build-server.mjs makes it (the little of it that matters here). */
function releaseDir(version: string, protocol?: number): string {
  const dir = join(temp(), `kuraa-server-${version}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'kuraa-host.mjs'), `console.log(${JSON.stringify(version)});\n`);
  writeFileSync(join(dir, 'VERSION'), `${version}\n`);
  if (protocol !== undefined) writeFileSync(join(dir, 'PROTOCOL'), `${protocol}\n`);
  return dir;
}

/** A release as published: its archive, signed (with the release key unless said), and the checksum GitHub lists. */
function published(version: string, key = privateKey, protocol?: number): { release: Release; files: Map<string, Buffer> } {
  const dir = releaseDir(version, protocol);
  const archive = join(dir, '..', `kuraa-server-${version}.tar.gz`);
  execFileSync('tar', ['-czf', archive, '-C', join(dir, '..'), `kuraa-server-${version}`]);
  const bytes = readFileSync(archive);
  const files = new Map<string, Buffer>([
    ['archive', bytes],
    ['sig', Buffer.from(sign(null, bytes, key).toString('base64'))],
  ]);
  return { release: { version, archive: 'archive', signature: 'sig', checksum: createHash('sha256').update(bytes).digest('hex') }, files };
}

const build = (o: Partial<ServerBuild> = {}): ServerBuild => ({ version: '0.1.0', repo: 'someone/kuraa', publicKey: PUBLIC, ...o });

/** A server installed at 0.1.0, as `kuraa-host install` leaves it. */
function installed(): string {
  const root = join(temp(), 'server');
  installServer({ here: releaseDir('0.1.0'), version: '0.1.0', root, service: false, args: [] });
  return root;
}

const update = (root: string, p: ReturnType<typeof published>, b = build()) =>
  updateFrom({ root, build: b, latest: async () => p.release, fetch: async (url) => p.files.get(url)! });

describe('a released server', () => {
  it('installs in a folder of its own, from which it runs the version named', () => {
    const root = installed();
    expect(currentVersion(root)).toBe('0.1.0');
    expect(readdirSync(join(root, 'versions'))).toEqual(['0.1.0']);
    expect(installedRoot(join(root, 'versions', '0.1.0'))).toBe(root);
    expect(installedRoot(temp())).toBeNull();
    // Its launcher runs whatever `current` names.
    expect(execFileSync(process.execPath, [join(root, 'kuraa-host.mjs')], { encoding: 'utf8' }).trim()).toBe('0.1.0');
  });

  it('takes a newer release signed with the release key, keeping the one before', async () => {
    const root = installed();
    expect(await update(root, published('0.2.0'))).toBe('0.2.0');
    expect(currentVersion(root)).toBe('0.2.0');
    expect(execFileSync(process.execPath, [join(root, 'kuraa-host.mjs')], { encoding: 'utf8' }).trim()).toBe('0.2.0');
    expect(readdirSync(join(root, 'versions')).sort()).toEqual(['0.1.0', '0.2.0']);
    // The next: the one before it is kept, the one before that goes.
    expect(await update(root, published('0.3.0'))).toBe('0.3.0');
    expect(readdirSync(join(root, 'versions')).sort()).toEqual(['0.2.0', '0.3.0']);
    // The same, or older: nothing.
    expect(await update(root, published('0.3.0'))).toBeNull();
    expect(await update(root, published('0.2.5'))).toBeNull();
  });

  it('refuses a release not signed with the release key, and one not signed at all', async () => {
    const root = installed();
    await expect(update(root, published('0.2.0', other))).rejects.toThrow('its signature is not the release key’s');
    const unsigned = published('0.2.0');
    await expect(update(root, { ...unsigned, release: { ...unsigned.release, signature: null } })).rejects.toThrow('the release is not signed');
    expect(currentVersion(root)).toBe('0.1.0');
    expect(existsSync(join(root, 'versions', '0.2.0'))).toBe(false);
    // Built without a key: the checksum the release lists, at least.
    expect(await update(root, published('0.2.0', other), build({ publicKey: null }))).toBe('0.2.0');
    expect(checkArchive(Buffer.from('x'), { publicKey: null, signature: null, checksum: '00' })).toBe('its checksum does not match');
  });

  it('refuses an archive that is not the version it says', async () => {
    const root = installed();
    const p = published('0.2.0');
    await expect(update(root, { ...p, release: { ...p.release, version: '0.4.0' } })).rejects.toThrow();
    expect(currentVersion(root)).toBe('0.1.0');
  });

  it('installs with a service that runs it updating itself, with an access code that stays', () => {
    const home = temp();
    const root = join(home, 'server');
    const said = installServer({ here: releaseDir('0.1.0'), version: '0.1.0', root, service: true, args: ['--workspaces', '/srv/notes', '--host', '0.0.0.0'], platform: 'linux', home, node: '/usr/bin/node' });
    const unit = join(home, '.config', 'systemd', 'user', 'kuraa.service');
    const text = readFileSync(unit, 'utf8');
    expect(text).toContain(`ExecStart=/usr/bin/node ${join(root, 'kuraa-host.mjs')} --auto-update --workspaces /srv/notes --host 0.0.0.0`);
    expect(text).toContain('Restart=always');
    expect(text).toMatch(/Environment=KURAA_TOKEN=[\w-]{20,}/);
    if (process.platform !== 'win32') expect(statSync(unit).mode & 0o077).toBe(0);
    expect(said.join('\n')).toContain('systemctl --user enable --now kuraa');
    // On macOS, launchd.
    installServer({ here: releaseDir('0.1.0'), version: '0.1.0', root, service: true, args: [], platform: 'darwin', home, node: '/usr/bin/node' });
    const plist = readFileSync(join(home, 'Library', 'LaunchAgents', 'org.kuraa.server.plist'), 'utf8');
    expect(plist).toContain('<string>--auto-update</string>');
    expect(plist).toContain('<key>KeepAlive</key><true/>');
  });

  it('keeps the service and its log, which hold its access code, for this user alone, even written over ones there before', () => {
    if (process.platform === 'win32') return;
    const home = temp();
    const root = join(home, 'server');
    const plist = join(home, 'Library', 'LaunchAgents', 'org.kuraa.server.plist');
    const unit = join(home, '.config', 'systemd', 'user', 'kuraa.service');
    for (const file of [plist, unit, join(root, 'kuraa.log')]) {
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, 'before', { mode: 0o644 });
    }
    installServer({ here: releaseDir('0.1.0'), version: '0.1.0', root, service: true, args: [], platform: 'darwin', home, node: '/usr/bin/node' });
    installServer({ here: releaseDir('0.1.0'), version: '0.1.0', root, service: true, args: [], platform: 'linux', home, node: '/usr/bin/node' });
    for (const file of [plist, unit, join(root, 'kuraa.log')]) expect(statSync(file).mode & 0o077).toBe(0);
    // The log is kept, not emptied; and the service says it is one, so the server does not print its code there.
    expect(readFileSync(join(root, 'kuraa.log'), 'utf8')).toBe('before');
    expect(readFileSync(plist, 'utf8')).toContain('<key>KURAA_SERVICE</key><string>1</string>');
    expect(readFileSync(unit, 'utf8')).toContain('Environment=KURAA_SERVICE=1');
    expect(runsAsService({ KURAA_SERVICE: '1' })).toBe(true);
    expect(runsAsService({ XPC_SERVICE_NAME: 'org.kuraa.server' })).toBe(true);
    expect(runsAsService({ XPC_SERVICE_NAME: '0' })).toBe(false);
  });

  it('restarts to update at night, between 3 and 5', () => {
    const evening = new Date(2026, 10, 21, 22, 30);
    for (let i = 0; i < 20; i++) {
      const at = new Date(evening.getTime() + untilNight(evening));
      expect(at.getDate()).toBe(22);
      expect(at.getHours() >= 3 && at.getHours() < 5).toBe(true);
    }
    const early = new Date(2026, 10, 21, 1, 0);
    expect(new Date(early.getTime() + untilNight(early)).getDate()).toBe(21);
  });

  it('looks for an update at once when a device runs a newer release, at most once an hour; not for one older or the same (0099)', async () => {
    const root = installed();
    let looked = 0;
    let told: ((version: string) => void) | null = null;
    autoUpdate({
      here: join(root, 'versions', '0.1.0'), build: build(), log: () => undefined, restart: () => undefined, newer: () => undefined,
      newerRelease: (fn) => void (told = fn),
      latest: async () => {
        looked++;
        return null;
      },
    });
    expect(told).not.toBeNull();
    told!('0.1.0');
    told!('0.0.9');
    told!('not a version');
    await new Promise((r) => setTimeout(r, 10));
    expect(looked).toBe(0);
    told!('0.2.0');
    await new Promise((r) => setTimeout(r, 10));
    expect(looked).toBe(1);
    // Within the hour, not again, whatever a device says.
    told!('0.3.0');
    await new Promise((r) => setTimeout(r, 10));
    expect(looked).toBe(1);
  });

  it('holds a release that changes how devices sync, until a device runs it; takes one that does not at once (0112)', async () => {
    const root = installed();
    const holds: [string, number | null][] = [];
    const hold = (v: string, p: number | null) => void holds.push([v, p]);
    const same = published('0.2.0', privateKey, PROTOCOL);
    expect(await updateFrom({ root, build: build(), latest: async () => same.release, fetch: async (url) => same.files.get(url)!, hold })).toBe('0.2.0');
    expect(currentVersion(root)).toBe('0.2.0');
    // The next changes the protocol: unpacked beside, not put in place, and said.
    const next = published('0.3.0', privateKey, PROTOCOL + 1);
    let fetched = 0;
    const fetchNext = async (url: string) => (fetched++, next.files.get(url)!);
    expect(await updateFrom({ root, build: build(), latest: async () => next.release, fetch: fetchNext, hold })).toBeNull();
    expect(currentVersion(root)).toBe('0.2.0');
    expect(existsSync(join(root, 'versions', '0.3.0', 'kuraa-host.mjs'))).toBe(true);
    expect(holds).toEqual([['0.3.0', PROTOCOL + 1]]);
    // Held: not downloaded again.
    fetched = 0;
    expect(await updateFrom({ root, build: build(), latest: async () => next.release, fetch: fetchNext, hold, held: '0.3.0' })).toBeNull();
    expect(fetched).toBe(0);
    // Asked for (kuraa-host update, no hold): put in place whatever it speaks.
    expect(await updateFrom({ root, build: build(), latest: async () => next.release, fetch: fetchNext })).toBe('0.3.0');
    expect(currentVersion(root)).toBe('0.3.0');
  });

  it('puts a held release in place, and restarts at once, when a device runs the newer protocol (0112)', async () => {
    const root = installed();
    const next = published('0.2.0', privateKey, PROTOCOL + 1);
    let newer: (() => void) | null = null;
    let release: ((v: string) => void) | null = null;
    let restarted = 0;
    const said: string[] = [];
    autoUpdate({
      here: join(root, 'versions', '0.1.0'), build: build(), log: (m) => void said.push(m), restart: () => void restarted++,
      newer: (fn) => void (newer = fn), newerRelease: (fn) => void (release = fn),
      latest: async () => next.release, fetch: async (url) => next.files.get(url)!,
    });
    // A device says a newer release is out: looked for, found, held (it changes the protocol).
    release!('0.2.0');
    for (let i = 0; i < 50 && !said.some((m) => m.includes('held until')); i++) await new Promise((r) => setTimeout(r, 20));
    expect(currentVersion(root)).toBe('0.1.0');
    expect(said.some((m) => m.includes('kuraa 0.2.0 changes how devices sync'))).toBe(true);
    // A device runs the newer protocol: in place, and restarted at once.
    newer!();
    await new Promise((r) => setTimeout(r, 30));
    expect(currentVersion(root)).toBe('0.2.0');
    expect(restarted).toBe(1);
  });

  it('switches to a held release only once devices of two of its workspaces run its protocol, and keeps it held across a restart (0115)', async () => {
    const root = installed();
    const next = published('0.2.0', privateKey, PROTOCOL + 1);
    const start = () => {
      let newer: ((p?: number, w?: string) => void) | null = null;
      let release: ((v: string) => void) | null = null;
      let restarted = 0;
      let fetched = 0;
      const said: string[] = [];
      autoUpdate({
        here: join(root, 'versions', '0.1.0'), build: build(), log: (m) => void said.push(m), restart: () => void restarted++,
        newer: (fn) => void (newer = fn), newerRelease: (fn) => void (release = fn), workspaces: () => 3,
        latest: async () => next.release, fetch: async (url) => (fetched++, next.files.get(url)!),
      });
      return { newer: (p: number, w: string) => newer!(p, w), release: (v: string) => release!(v), restarted: () => restarted, fetched: () => fetched, said };
    };
    const first = start();
    first.release('0.2.0');
    for (let i = 0; i < 50 && !first.said.some((m) => m.includes('held until')); i++) await new Promise((r) => setTimeout(r, 20));
    // One workspace's device runs it: not enough, of three.
    first.newer(PROTOCOL + 1, 'ws-a');
    first.newer(PROTOCOL + 1, 'ws-a');
    await new Promise((r) => setTimeout(r, 30));
    expect(currentVersion(root)).toBe('0.1.0');
    expect(first.restarted()).toBe(0);
    // Restarted meanwhile: still held, not fetched again.
    const second = start();
    second.release('0.2.0');
    await new Promise((r) => setTimeout(r, 100));
    expect(second.fetched()).toBe(0);
    // Two workspaces' devices: in place, and restarted at once.
    second.newer(PROTOCOL + 1, 'ws-a');
    second.newer(PROTOCOL + 1, 'ws-b');
    await new Promise((r) => setTimeout(r, 30));
    expect(currentVersion(root)).toBe('0.2.0');
    expect(second.restarted()).toBe(1);
  });

  it('downloads no more than it may, and from GitHub or where it was asked (0112)', async () => {
    const body = Buffer.alloc(MAX_SIGNATURE_BYTES + 1, 'x');
    const server = createServer((req, res) => {
      if (req.url === '/away') return void res.writeHead(302, { location: 'http://example.invalid/x' }).end();
      // No length said: read with a limit all the same.
      res.writeHead(200);
      res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const at = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      await expect(download(`${at}/sig`, MAX_SIGNATURE_BYTES)).rejects.toThrow('larger than');
      expect((await download(`${at}/sig`, body.length)).length).toBe(body.length);
      await expect(download(`${at}/away`, 100)).rejects.toThrow();
    } finally {
      server.close();
    }
  });

  it('goes back to the last good version when a new one does not start three times, and never takes that one again (0099)', async () => {
    const root = installed();
    // 0.1.0 ran well; 0.2.0, put in place by an update, throws as it starts.
    markGood(root, '0.1.0');
    const bad = releaseDir('0.2.0');
    writeFileSync(join(bad, 'kuraa-host.mjs'), "throw new Error('broken');\n");
    execFileSync('cp', ['-R', bad, join(root, 'versions', '0.2.0')]);
    writeFileSync(join(root, 'current'), '0.2.0\n');
    const start = () => {
      try {
        return { ok: true, out: execFileSync(process.execPath, [join(root, 'kuraa-host.mjs')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() };
      } catch {
        return { ok: false, out: '' };
      }
    };
    for (let i = 0; i < 3; i++) expect(start().ok).toBe(false);
    expect(currentVersion(root)).toBe('0.2.0');
    // The fourth start: back to 0.1.0, which runs; 0.2.0 marked failed.
    expect(start()).toEqual({ ok: true, out: '0.1.0' });
    expect(currentVersion(root)).toBe('0.1.0');
    expect(readFileSync(join(root, 'failed'), 'utf8').trim()).toBe('0.2.0');
    // An update offering 0.2.0 again is passed over; a later one is taken.
    expect(await update(root, published('0.2.0'))).toBeNull();
    expect(await update(root, published('0.3.0'))).toBe('0.3.0');
  });

  it('rewrites a launcher from before (one that never goes back) once a version has run well', () => {
    const root = installed();
    writeFileSync(join(root, 'kuraa-host.mjs'), '// an older launcher\n');
    expect(markGood(root, '0.1.0')).toBe(true);
    expect(readFileSync(join(root, 'kuraa-host.mjs'), 'utf8')).toContain('going back to');
    expect(markGood(root, '0.1.0')).toBe(false);
    expect(readFileSync(join(root, 'good'), 'utf8').trim()).toBe('0.1.0');
  });

  it('does not put in place a release that needs a newer Node than runs it', async () => {
    const root = installed();
    const p = published('0.2.0');
    // The same release, saying it needs Node 999.
    const dir = releaseDir('0.2.0');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ engines: { node: '>=999' } }));
    const archive = join(dir, '..', 'kuraa-server-0.2.0.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', join(dir, '..'), 'kuraa-server-0.2.0']);
    const bytes = readFileSync(archive);
    p.files.set('archive', bytes);
    p.files.set('sig', Buffer.from(sign(null, bytes, privateKey).toString('base64')));
    await expect(update(root, p)).rejects.toThrow('needs Node 999');
    expect(currentVersion(root)).toBe('0.1.0');
  });

  it('compares versions as semver does', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-beta.2', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0-beta.10', '1.0.0-beta.9')).toBeGreaterThan(0);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });
});
