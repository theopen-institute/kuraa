// Who a workspace is, which device this is, and which devices it is paired
// with: all kept on the device, never in the files people commit, as git keeps
// its remotes (see docs/decisions/0028-peers.md).
//
// - The workspace's id and secret, and this device's name: git config (`kuraa.*`).
// - This device's key pair: .git/kuraa/device.json, readable only by its owner.
// - Paired devices: git remotes whose URL is `kuraa://<device key>`, so
//   `git fetch laptop` works and their branches are `laptop/main`.
// - Devices removed from the workspace: `kuraa.removed`, never accepted again.
// - Invitations not yet used: .git/kuraa/invites.json.
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import crypto from 'hypercore-crypto';
import type { Git } from '../git.js';

export interface DeviceKey { publicKey: Buffer; secretKey: Buffer }

export interface Member {
  /** The remote's name: `laptop`. */
  name: string;
  /** The device's public key, hex. */
  key: string;
}

export interface WorkspaceIdentity {
  /** The workspace's id, hex: names it to people and peers; not a secret. */
  id: string;
  /** The workspace's secret, hex: devices find each other by it. */
  secret: string;
  /** The workspace this one was forked from (`<id>@<commit>`), if any. */
  forkedFrom: string | null;
}

export const KURAA_SCHEME = 'kuraa://';

const hex = /^[0-9a-f]+$/;

/** The swarm topic for a workspace: derived from its secret, so only devices that know it find each other. */
export function topicFor(secret: string): Buffer {
  return createHash('sha256').update(`kuraa workspace topic\0${secret}`).digest();
}

/** A name a git remote can have: letters, digits, dots, dashes; not empty. */
export function remoteName(name: string): string {
  const clean = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return clean || 'device';
}

export class Identity {
  constructor(private readonly git: Git, private readonly stateDir: string) {}

  private async get(key: string): Promise<string | null> {
    const r = await this.git.run(['config', '--get', key], { allowFail: true });
    return r.code === 0 ? r.stdout.trim() : null;
  }

  private async getAll(key: string): Promise<string[]> {
    const r = await this.git.run(['config', '--get-all', key], { allowFail: true });
    return r.code === 0 ? r.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
  }

  /** The workspace's identity, or null if this repository is not yet a peer workspace. */
  async workspace(): Promise<WorkspaceIdentity | null> {
    const id = await this.get('kuraa.workspace');
    const secret = await this.get('kuraa.secret');
    if (!id || !secret) return null;
    return { id, secret, forkedFrom: await this.get('kuraa.forkedfrom') };
  }

  /** Make this repository a workspace of its own (the first device): a new id and secret. */
  async found(): Promise<WorkspaceIdentity> {
    const ws = { id: randomBytes(16).toString('hex'), secret: randomBytes(32).toString('hex'), forkedFrom: null };
    await this.adopt(ws);
    return ws;
  }

  /**
   * Make this copy a workspace of its own, forked from the one it was: a new id
   * and secret, the original's id and the commit it was forked at kept, and its
   * devices kept as remotes to fetch from (never merged from on their own).
   */
  async fork(commit: string): Promise<WorkspaceIdentity> {
    const old = await this.workspace();
    if (!old) throw new Error('This repository is not a workspace shared between devices, so there is nothing to fork from');
    const ws = { id: randomBytes(16).toString('hex'), secret: randomBytes(32).toString('hex'), forkedFrom: `${old.id}@${commit}` };
    await this.adopt(ws);
    await this.git.run(['config', 'kuraa.originsecret', old.secret]);
    await this.setUpstream(null);
    await this.setGated([]);
    return ws;
  }

  /** The secret of the workspace this one was forked from, to meet its devices. */
  async originSecret(): Promise<string | null> {
    return this.get('kuraa.originsecret');
  }

  /** Take on a workspace's identity (a device joining it). */
  async adopt(ws: WorkspaceIdentity): Promise<void> {
    if (!hex.test(ws.id) || !hex.test(ws.secret)) throw new Error('Not a workspace identity');
    await this.git.run(['config', 'kuraa.workspace', ws.id]);
    await this.git.run(['config', 'kuraa.secret', ws.secret]);
    if (ws.forkedFrom) await this.git.run(['config', 'kuraa.forkedfrom', ws.forkedFrom]);
    else await this.git.run(['config', '--unset', 'kuraa.forkedfrom'], { allowFail: true });
  }

  /** What this device is called to its peers. */
  async deviceName(): Promise<string> {
    return (await this.get('kuraa.devicename')) ?? remoteName(hostname().replace(/\.local$/, ''));
  }

  async setDeviceName(name: string): Promise<void> {
    await this.git.run(['config', 'kuraa.devicename', remoteName(name)]);
  }

  /** This device's key pair, made the first time it is asked for. */
  async deviceKey(): Promise<DeviceKey> {
    const file = join(this.stateDir, 'device.json');
    try {
      const k = JSON.parse(await readFile(file, 'utf8')) as { publicKey: string; secretKey: string };
      return { publicKey: Buffer.from(k.publicKey, 'hex'), secretKey: Buffer.from(k.secretKey, 'hex') };
    } catch {
      const k = crypto.keyPair();
      await mkdir(this.stateDir, { recursive: true });
      await writeFile(file, JSON.stringify({ publicKey: k.publicKey.toString('hex'), secretKey: k.secretKey.toString('hex') }), { mode: 0o600 });
      await chmod(file, 0o600);
      return k;
    }
  }

  /** The devices this one is paired with: its kuraa:// remotes. */
  async members(): Promise<Member[]> {
    const r = await this.git.run(['config', '--get-regexp', '^remote\\..*\\.url$'], { allowFail: true });
    const out: Member[] = [];
    for (const line of r.stdout.split('\n')) {
      const m = /^remote\.(.+)\.url (.*)$/.exec(line.trim());
      if (m && m[2]!.startsWith(KURAA_SCHEME)) {
        const key = m[2]!.slice(KURAA_SCHEME.length).replace(/\/$/, '');
        if (hex.test(key) && key.length === 64) out.push({ name: m[1]!, key });
      }
    }
    return out;
  }

  /** Pair with a device: add it as a remote (under a free name), unless it was removed. Returns its remote name. */
  async addMember(key: string, name: string): Promise<string | null> {
    if (!hex.test(key) || key.length !== 64) throw new Error('Not a device key');
    if ((await this.removed()).includes(key)) return null;
    const members = await this.members();
    const known = members.find((m) => m.key === key);
    if (known) return known.name;
    const remotes = (await this.git.out(['remote'])).split('\n').filter(Boolean);
    const base = remoteName(name);
    let pick = base;
    for (let i = 2; remotes.includes(pick); i++) pick = `${base}-${i}`;
    await this.git.run(['remote', 'add', pick, `${KURAA_SCHEME}${key}`]);
    return pick;
  }

  /** Remove a device from the workspace: forget it, and never accept it again. */
  async removeMember(key: string): Promise<void> {
    const m = (await this.members()).find((x) => x.key === key);
    if (m) await this.git.run(['remote', 'remove', m.name]);
    if (!(await this.removed()).includes(key)) await this.git.run(['config', '--add', 'kuraa.removed', key]);
  }

  async removed(): Promise<string[]> {
    return this.getAll('kuraa.removed');
  }

  /** The remote that is the workspace's upstream (a device or an ordinary remote), if one is set. */
  async upstream(): Promise<string | null> {
    return this.get('kuraa.upstream');
  }

  async setUpstream(remote: string | null): Promise<void> {
    if (remote === null) await this.git.run(['config', '--unset', 'kuraa.upstream'], { allowFail: true });
    else await this.git.run(['config', 'kuraa.upstream', remote]);
  }

  /** Branches whose changes from other devices wait for the upstream to accept them. */
  async gated(): Promise<string[]> {
    return this.getAll('kuraa.gated');
  }

  async setGated(branches: string[]): Promise<void> {
    await this.git.run(['config', '--unset-all', 'kuraa.gated'], { allowFail: true });
    for (const b of branches) await this.git.run(['config', '--add', 'kuraa.gated', b]);
  }

  // Invitations ------------------------------------------------------------

  private get invitesFile(): string {
    return join(this.stateDir, 'invites.json');
  }

  private async invites(): Promise<{ token: string; expires: number }[]> {
    try {
      return (JSON.parse(await readFile(this.invitesFile, 'utf8')) as { token: string; expires: number }[]).filter((i) => i.expires > Date.now());
    } catch {
      return [];
    }
  }

  /** Make a one-time invitation, good for `hours`. Returns its token. */
  async invite(hours = 24): Promise<string> {
    const token = randomBytes(16).toString('hex');
    const list = await this.invites();
    // Only a hash is kept: the file does not let anyone join.
    list.push({ token: createHash('sha256').update(token).digest('hex'), expires: Date.now() + hours * 3600_000 });
    await mkdir(this.stateDir, { recursive: true });
    await writeFile(this.invitesFile, JSON.stringify(list), { mode: 0o600 });
    return token;
  }

  /** Use up an invitation; whether it was good. */
  async redeem(token: string): Promise<boolean> {
    const hash = createHash('sha256').update(token).digest('hex');
    const list = await this.invites();
    const left = list.filter((i) => i.token !== hash);
    if (left.length === list.length) return false;
    await writeFile(this.invitesFile, JSON.stringify(left), { mode: 0o600 });
    return true;
  }
}

/** What an invitation carries: the workspace, who invited, and the one-time token. */
export interface Invitation {
  workspace: WorkspaceIdentity;
  /** The inviting device's key, hex, and name. */
  inviter: Member;
  token: string;
}

export function encodeInvitation(inv: Invitation): string {
  const payload = [inv.workspace.id, inv.workspace.secret, inv.workspace.forkedFrom ?? '', inv.inviter.key, inv.inviter.name, inv.token].join('|');
  return `kuraa-invite:${Buffer.from(payload, 'utf8').toString('base64url')}`;
}

export function decodeInvitation(code: string): Invitation {
  const m = /^kuraa-invite:([A-Za-z0-9_-]+)$/.exec(code.trim());
  if (!m) throw new Error('Not an invitation (it starts with kuraa-invite:)');
  const [id, secret, forkedFrom, key, name, token] = Buffer.from(m[1]!, 'base64url').toString('utf8').split('|');
  if (!id || !secret || !key || !name || !token || !hex.test(id) || !hex.test(secret) || !hex.test(key) || !hex.test(token)) throw new Error('This invitation is damaged');
  return { workspace: { id, secret, forkedFrom: forkedFrom || null }, inviter: { key, name }, token };
}
