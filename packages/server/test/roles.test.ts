// One program, two roles (decision 0099): `kuraa-host` a host, `kuraa-host server` a server; a service runs it
// with --auto-update before its flags, and it is still the role asked for, updating itself.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installServer } from '@kuraa/host';
import { roleOf } from '../src/roles.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('one program, by role (0099)', () => {
  it('is a server with `server` first, after --auto-update if any; else a host, as it was', () => {
    expect(roleOf([])).toEqual({ role: 'host', args: [], autoUpdate: false, autoUpdateAll: false });
    expect(roleOf(['--workspaces', '/srv/notes'])).toEqual({ role: 'host', args: ['--workspaces', '/srv/notes'], autoUpdate: false, autoUpdateAll: false });
    expect(roleOf(['--auto-update', '--workspaces', 'server'])).toMatchObject({ role: 'host', autoUpdate: true });
    expect(roleOf(['invite'])).toMatchObject({ role: 'host', args: ['invite'] });
    expect(roleOf(['server'])).toEqual({ role: 'server', args: [], autoUpdate: false, autoUpdateAll: false });
    expect(roleOf(['server', 'join', 'kuraa-invite:x'])).toEqual({ role: 'server', args: ['join', 'kuraa-invite:x'], autoUpdate: false, autoUpdateAll: false });
    // As its service runs it.
    expect(roleOf(['--auto-update', 'server', '--public-address', 'kuraa.example.org', '--peer-port', '443'])).toEqual({ role: 'server', args: ['--public-address', 'kuraa.example.org', '--peer-port', '443'], autoUpdate: true, autoUpdateAll: false });
    // Taking releases that change the protocol at once (0112): updating itself, all the same.
    expect(roleOf(['--auto-update', '--auto-update-all', 'server'])).toEqual({ role: 'server', args: [], autoUpdate: true, autoUpdateAll: true });
  });

  it('installs as a server’s service: run in the server role, updating itself, restarted when it stops', () => {
    const home = mkdtempSync(join(tmpdir(), 'kuraa-roles-'));
    dirs.push(home);
    const here = join(home, 'release');
    mkdirSync(here);
    writeFileSync(join(here, 'kuraa-host.mjs'), '');
    const root = join(home, 'server');
    const said = installServer({ here, version: '0.1.0', root, service: true, args: ['server', '--public-address', 'kuraa.example.org', '--peer-port', '443'], platform: 'linux', home, node: '/usr/bin/node' });
    const unit = readFileSync(join(home, '.config', 'systemd', 'user', 'kuraa.service'), 'utf8');
    const exec = /^ExecStart=(.*)$/m.exec(unit)![1]!.split(' ');
    expect(exec.slice(0, 2)).toEqual(['/usr/bin/node', join(root, 'kuraa-host.mjs')]);
    expect(roleOf(exec.slice(2))).toEqual({ role: 'server', args: ['--public-address', 'kuraa.example.org', '--peer-port', '443'], autoUpdate: true, autoUpdateAll: false });
    expect(unit).toContain('Restart=always');
    // Room for a connection and git processes for each member of each workspace (0112).
    expect(unit).toContain('LimitNOFILE=65536');
    // Not updating itself, as its operator may choose (0112: the release key reads every space, as servers do).
    installServer({ here, version: '0.1.0', root, service: true, updates: 'off', args: ['server'], platform: 'linux', home, node: '/usr/bin/node' });
    const off = /^ExecStart=(.*)$/m.exec(readFileSync(join(home, '.config', 'systemd', 'user', 'kuraa.service'), 'utf8'))![1]!.split(' ');
    expect(roleOf(off.slice(2))).toEqual({ role: 'server', args: [], autoUpdate: false, autoUpdateAll: false });
    expect(said.join('\n')).toContain('kuraa-host server join <invite link for a server>');
  });
});
