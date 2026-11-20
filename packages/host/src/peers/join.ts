// Joining a workspace on a device that does not have it yet (CLI: kuraa-host
// join <invite link>): make the folder a repository of the workspace, find a
// device of it, be let in, learn the other members, fetch, and check out the
// branch.
//
// Any device of the workspace that the link's maker vouches for may let this
// one in, so whichever answers first does, and the device that made the link
// need not be there. A link for one person is used up by the first device it
// lets in.
import { mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Git } from '../git.js';
import { decodeLink } from './identity.js';
import { PeerNode } from './node.js';
import type { PeerOptions } from './peers.js';

export interface JoinOptions {
  /** Where the workspace goes: a folder that is empty or does not exist. */
  dir: string;
  /** An invite link (kuraa-invite:…). */
  invitation: string;
  /** What this device is called (default: the computer's name). */
  name?: string;
  bootstrap?: PeerOptions['bootstrap'];
  /** How long to look for a device to let this one in. Default 2 minutes. */
  timeoutMs?: number;
  log?: (m: string) => void;
}

export async function joinWorkspace(o: JoinOptions): Promise<{ dir: string; branch: string; inviter: string }> {
  const link = o.invitation.trim();
  const l = decodeLink(link);
  if (l.expires !== 0 && l.expires < Date.now()) throw new Error('This invite link has expired');
  const dir = resolve(o.dir);
  const log = o.log ?? (() => undefined);
  await mkdir(dir, { recursive: true });
  if ((await readdir(dir)).length) throw new Error(`${dir} is not empty: join into a new folder`);
  const git = new Git(dir);
  await git.run(['init', '-q']);
  const stateDir = join(await git.gitDir(), 'kuraa');
  const node = new PeerNode({ dir, git, stateDir, bootstrap: o.bootstrap, branch: async () => 'main', log, joining: true, ticket: link });
  await node.identity.adopt(l.workspace);
  if (o.name) await node.identity.setDeviceName(o.name);
  // The device that made the link is the first to look for.
  await node.identity.addMember(l.issuer.key, l.issuer.name);
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
    node.events.welcome = (from, m) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(refusal);
      void (async () => {
        for (const member of m.members) await node.identity.addMember(member.key, member.name);
        await node.refresh();
        resolveWelcome({ branch: m.branch, remote: from.remote!, from: m.name });
      })().catch(reject);
    };
  });
  try {
    await node.start(false);
    log('looking for a device of the workspace…');
    const { branch, remote, from } = await welcomed;
    if (!(await node.fetch(remote))) throw new Error(`Could not fetch from ${from}`);
    await git.run(['checkout', '-q', '-B', branch, `refs/remotes/${remote}/${branch}`]);
    await node.identity.setJoinedLink(link);
    log(`joined: ${dir} on ${branch}, let in by ${from}`);
    return { dir, branch, inviter: remote };
  } finally {
    await node.close();
  }
}
