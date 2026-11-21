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
import { checkArchive, compareVersions, currentVersion, installServer, installedRoot, untilNight, updateFrom, type Release, type ServerBuild } from '../src/selfupdate.js';

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
function releaseDir(version: string): string {
  const dir = join(temp(), `kuraa-server-${version}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'kuraa-host.mjs'), `console.log(${JSON.stringify(version)});\n`);
  writeFileSync(join(dir, 'VERSION'), `${version}\n`);
  return dir;
}

/** A release as published: its archive, signed (with the release key unless said), and its checksum. */
function published(version: string, key = privateKey): { release: Release; files: Map<string, Buffer> } {
  const dir = releaseDir(version);
  const archive = join(dir, '..', `kuraa-server-${version}.tar.gz`);
  execFileSync('tar', ['-czf', archive, '-C', join(dir, '..'), `kuraa-server-${version}`]);
  const bytes = readFileSync(archive);
  const files = new Map<string, Buffer>([
    ['archive', bytes],
    ['sig', Buffer.from(sign(null, bytes, key).toString('base64'))],
    ['sum', Buffer.from(`${createHash('sha256').update(bytes).digest('hex')}  x\n`)],
  ]);
  return { release: { version, archive: 'archive', signature: 'sig', checksum: 'sum' }, files };
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
    expect(checkArchive(Buffer.from('x'), { publicKey: null, signature: null, checksum: '00 x' })).toBe('its checksum does not match');
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

  it('compares versions as semver does', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-beta.2', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0-beta.10', '1.0.0-beta.9')).toBeGreaterThan(0);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });
});
