// Joining a workspace from an invitation, on a device that does not have it
// yet (CLI: kuraa-host join <invitation>): make the folder a repository of the
// workspace, find the inviting device, present the invitation, learn the other
// members and the upstream from it, fetch from it, and check out its branch.
import { mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Git } from '../git.js';
import { decodeInvitation } from './identity.js';
import { PeerNode } from './node.js';
import type { PeerOptions } from './peers.js';

export interface JoinOptions {
  /** Where the workspace goes: a folder that is empty or does not exist. */
  dir: string;
  /** The invitation (kuraa-invite:…). */
  invitation: string;
  /** What this device is called (default: the computer's name). */
  name?: string;
  bootstrap?: PeerOptions['bootstrap'];
  /** How long to look for the inviting device. Default 2 minutes. */
  timeoutMs?: number;
  log?: (m: string) => void;
}

export async function joinWorkspace(o: JoinOptions): Promise<{ dir: string; branch: string; inviter: string }> {
  const inv = decodeInvitation(o.invitation);
  const dir = resolve(o.dir);
  const log = o.log ?? (() => undefined);
  await mkdir(dir, { recursive: true });
  if ((await readdir(dir)).length) throw new Error(`${dir} is not empty: join into a new folder`);
  const git = new Git(dir);
  await git.run(['init', '-q']);
  const stateDir = join(await git.gitDir(), 'kuraa');
  const node = new PeerNode({ dir, git, stateDir, bootstrap: o.bootstrap, branch: async () => 'main', log, invite: { key: inv.inviter.key, token: inv.token } });
  await node.identity.adopt(inv.workspace);
  if (o.name) await node.identity.setDeviceName(o.name);
  const inviter = (await node.identity.addMember(inv.inviter.key, inv.inviter.name))!;
  const welcomed = new Promise<{ branch: string }>((resolveWelcome, reject) => {
    const timer = setTimeout(() => reject(new Error(`Could not reach ${inv.inviter.name}: is its host running, with --peer?`)), o.timeoutMs ?? 120_000);
    node.events.welcome = (link, m) => {
      if (link.key !== inv.inviter.key) return;
      clearTimeout(timer);
      void (async () => {
        for (const member of m.members) await node.identity.addMember(member.key, member.name);
        if (m.upstream) {
          const up = m.upstream === inv.inviter.key ? inviter : (await node.identity.members()).find((x) => x.key === m.upstream)?.name;
          if (up) await node.identity.setUpstream(up);
        }
        await node.refresh();
        resolveWelcome({ branch: m.branch });
      })().catch(reject);
    };
  });
  try {
    await node.start(false);
    log(`looking for ${inv.inviter.name}…`);
    const { branch } = await welcomed;
    if (!(await node.fetch(inviter))) throw new Error(`Could not fetch from ${inv.inviter.name}`);
    await git.run(['checkout', '-q', '-B', branch, `refs/remotes/${inviter}/${branch}`]);
    log(`joined: ${dir} on ${branch}, from ${inv.inviter.name}`);
    return { dir, branch, inviter };
  } finally {
    await node.close();
  }
}
