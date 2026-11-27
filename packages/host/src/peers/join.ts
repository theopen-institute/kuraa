// Joining a workspace on a device that does not have it yet (CLI: kuraa-host
// join <invite link>): make the folder a repository of the workspace, find a
// device of it, be let in, learn the other members, fetch, and check out the
// branch.
//
// Any device of the workspace that the link's maker vouches for may let this
// one in, so whichever answers first does, and the device that made the link
// need not be there. A link for one person is used up by the first device it
// lets in.
//
// With `keep`, the node that joined is handed back still connected, for the
// workspace's host to go on with (PeerNode.becomeMember) rather than connect to
// every device anew. Steps are told to `progress` as they happen.
import { mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Git } from '../git.js';
import { decodeLink } from './identity.js';
import { PeerNode } from './node.js';
import type { PeerOptions } from './peers.js';
import { createOnly, keyJson, type KeyPair } from '../keys.js';

export interface JoinOptions {
  /** Where the workspace goes: a folder that is empty or does not exist. */
  dir: string;
  /** An invite link (kuraa-invite:…). */
  invitation: string;
  /** What this device is called (default: KURAA_DEVICE_NAME, else the computer's name). */
  name?: string;
  bootstrap?: PeerOptions['bootstrap'];
  /** Relays run by someone, by key (relay.ts): a way in when no device of the workspace can be reached directly. */
  relays?: string[];
  /** Look on the local network too (lan.ts). Default: yes. */
  lan?: boolean;
  /**
   * A server's ways in (0053, 0099): with `keep`, the node joining goes on as
   * the workspace's, and its TCP listener and DHT node are the process's, so they
   * take these ports now, or keep the ones they open with until a restart.
   */
  peerPort?: number;
  publicAddress?: string;
  dhtPort?: number;
  serveDht?: boolean;
  /** How long to look for a device to let this one in. Default 2 minutes. */
  timeoutMs?: number;
  log?: (m: string) => void;
  /** Hand back the node that joined, still connected (the caller closes it), instead of closing it. */
  keep?: boolean;
  /** Each step, as it is reached (and again, while looking, when more is known about the network). */
  progress?: (p: JoinProgress) => void;
  /**
   * The device key to join as (a server's, kept apart from the folder: 0099), so a
   * join tried again is the same device; else one made for the new folder.
   */
  deviceKey?: KeyPair;
  /** Who joins, and this computer's signing key for them: the ones this computer keeps, unless given (tests). */
  person?: PeerOptions['person'];
  signing?: PeerOptions['signing'];
}

/**
 * How a join is going: looking for a device of the workspace; connected to one,
 * being let in; copying the workspace from it. `slowNetwork`: this computer's
 * router makes direct connections take a few tries (PeerNode.slowNetwork).
 */
export interface JoinProgress {
  step: 'looking' | 'letting-in' | 'copying';
  slowNetwork: boolean;
  /** The device copied from, once there is one. */
  from?: string;
  /** Copying: how far, as git says it (`Receiving objects:  45% (450/1000), 12.30 MiB | 1.20 MiB/s`). */
  copied?: string;
}

export interface Joined {
  dir: string;
  branch: string;
  inviter: string;
  /** With `keep`: the node that joined, still connected. */
  node?: PeerNode;
}

export async function joinWorkspace(o: JoinOptions): Promise<Joined> {
  const link = o.invitation.trim();
  const l = decodeLink(link);
  if (l.expires !== 0 && l.expires < Date.now()) throw new Error('This invite link has expired');
  // A link for a server (0099) is joined by a server, which has no person: kuraa-server join.
  if (l.grant?.role === 'server' && o.person !== null) throw new Error('This invite link is for a server: give it to kuraa-server join, on the server');
  const dir = resolve(o.dir);
  const log = o.log ?? (() => undefined);
  await mkdir(dir, { recursive: true });
  if ((await readdir(dir)).length) throw new Error(`${dir} is not empty: join into a new folder`);
  const git = new Git(dir);
  await git.run(['init', '-q']);
  // A link in another device's commits is checked out as a file holding where it points, never as a link (gate.ts refuses them too).
  await git.run(['config', 'core.symlinks', 'false']);
  const stateDir = join(await git.gitDir(), 'kuraa');
  if (o.deviceKey) await createOnly(join(stateDir, 'device.json'), keyJson(o.deviceKey));
  // A link carries no secret (0050): the members are found by its own topic, and by dialling the
  // devices it names; the secret comes with the welcome. A link made before carries the secret.
  // Ways in besides the DHT the link names (0053): servers that take TCP, and relays.
  const joinAs = l.topic ? { id: l.workspace.id, forkedFrom: l.workspace.forkedFrom, topic: l.topic, dial: [l.issuer.key, ...l.through], tcp: l.hints?.tcp ?? [] } : undefined;
  const relays = [...new Set([...(o.relays ?? []), ...(l.hints?.relays ?? [])])];
  const node = new PeerNode({ dir, git, stateDir, bootstrap: o.bootstrap, relays, lan: o.lan, branch: async () => 'main', log, joining: true, ticket: link, joinAs, person: o.person, signing: o.signing, peerPort: o.peerPort, publicAddress: o.publicAddress, dhtPort: o.dhtPort, serveDht: o.serveDht });
  let said = '';
  const tell = (p: JoinProgress) => {
    const now = JSON.stringify(p);
    if (now === said) return;
    said = now;
    o.progress?.(p);
    if (p.step === 'letting-in') log('found a device of the workspace; being let in…');
    if (p.step === 'looking' && p.slowNetwork) log('this network makes direct connections take a few tries: this may take a minute or two');
  };
  if (l.workspace.secret) await node.identity.adopt({ ...l.workspace, secret: l.workspace.secret });
  // The workspace's genesis, as the link's grant names it: no other policy counts here (0066).
  if (l.grant?.genesis) await node.identity.setPin(l.grant.genesis);
  if (o.name) await node.identity.setDeviceName(o.name);
  // The device that made the link is the first to look for.
  await node.identity.addRemote(l.issuer.key, l.issuer.name);
  const welcomed = new Promise<{ branch: string; remote: string; from: string }>((resolveWelcome, reject) => {
    const timer = setTimeout(() => reject(new Error('Could not reach a device of the workspace: is one running, with syncing on?')), o.timeoutMs ?? 120_000);
    let done = false;
    // Turned away (a revoked, used or expired link): another device may still
    // let this one in, so wait a little for one before saying why.
    let refusal: NodeJS.Timeout | undefined;
    node.events.refused = (_link, reason) => {
      if (done || refusal) return;
      const why = reason.replace(/^not paired with this device, and /, '').replace(/^not paired with this device$/, 'the link was not accepted');
      refusal = setTimeout(() => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(new Error(`Could not join: ${why}`));
      }, 8000);
    };
    // Out even with its join (0099): said at once, as why.
    node.events.out = (why) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(refusal);
      reject(new Error(`Could not join: ${why}`));
    };
    node.events.welcome = (from, m) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(refusal);
      void (async () => {
        for (const member of m.members) await node.identity.addRemote(member.key, member.name);
        await node.refresh();
        resolveWelcome({ branch: m.branch, remote: from.remote!, from: m.name });
      })().catch(reject);
    };
  });
  // While looking: whether a device has connected yet, and what is known of the network.
  const watch = setInterval(() => tell({ step: node.links.size ? 'letting-in' : 'looking', slowNetwork: node.slowNetwork }), 500);
  let kept = false;
  try {
    tell({ step: 'looking', slowNetwork: false });
    await node.start(false);
    log('looking for a device of the workspace…');
    const { branch, remote, from } = await welcomed;
    clearInterval(watch);
    tell({ step: 'copying', slowNetwork: node.slowNetwork, from });
    // How far, as git says it; in the log at each tenth of each of its stages, so a long copy is not silent.
    let logged = '';
    const copying = (said: string) => {
      tell({ step: 'copying', slowNetwork: node.slowNetwork, from, copied: said });
      const m = /^([A-Za-z ]+):\s+(\d+)%/.exec(said);
      const mark = m ? `${m[1]} ${Math.floor(Number(m[2]) / 10) * 10}` : '';
      if (mark && mark !== logged) {
        logged = mark;
        log(`copying from ${from}: ${said}`);
      }
    };
    if (!(await node.fetch(remote, { progress: copying }))) throw new Error(`Could not copy the workspace from ${from}: the copy stopped (see the log for why)`);
    await git.run(['checkout', '-q', '-B', branch, `refs/remotes/${remote}/${branch}`]);
    await node.identity.setJoinedLink(link);
    log(`joined: ${dir} on ${branch}, let in by ${from}`);
    kept = !!o.keep;
    return { dir, branch, inviter: remote, ...(kept ? { node } : {}) };
  } finally {
    clearInterval(watch);
    if (!kept) await node.close();
  }
}
