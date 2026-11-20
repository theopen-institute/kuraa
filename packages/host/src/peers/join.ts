// Joining a workspace on a device that does not have it yet (CLI: kuraa-host
// join <invitation or link>): make the folder a repository of the workspace,
// find a device of it, be let in, learn the other members,
// fetch, and check out the branch.
//
// An invitation is good once, with the device that made it. A subscription link
// is good any number of times, with any device of the workspace that takes
// links from the device that made it; so whichever answers first lets this one
// in, and the device that made the link need not be there.
import { mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Git } from '../git.js';
import { decodeInvitation, decodeLink, type Member, type WorkspaceIdentity } from './identity.js';
import type { AcceptRules } from './accept.js';
import { PeerNode } from './node.js';
import type { PeerOptions } from './peers.js';

export interface JoinOptions {
  /** Where the workspace goes: a folder that is empty or does not exist. */
  dir: string;
  /** An invitation (kuraa-invite:…) or a subscription link (kuraa-link:…). */
  invitation: string;
  /** What this device is called (default: the computer's name). */
  name?: string;
  bootstrap?: PeerOptions['bootstrap'];
  /** How long to look for a device to let this one in. Default 2 minutes. */
  timeoutMs?: number;
  log?: (m: string) => void;
}

type Ticket =
  | { kind: 'invite'; workspace: WorkspaceIdentity; from: Member; token: string; rules: AcceptRules }
  | { kind: 'link'; workspace: WorkspaceIdentity; from: Member; link: string; expires: number; rules: AcceptRules };

function readTicket(code: string): Ticket {
  const text = code.trim();
  if (text.startsWith('kuraa-link:')) {
    const l = decodeLink(text);
    if (l.expires !== 0 && l.expires < Date.now()) throw new Error('This subscription link has expired');
    return { kind: 'link', workspace: l.workspace, from: l.issuer, link: text, expires: l.expires, rules: l.rules };
  }
  const inv = decodeInvitation(text);
  return { kind: 'invite', workspace: inv.workspace, from: inv.inviter, token: inv.token, rules: inv.rules };
}

export async function joinWorkspace(o: JoinOptions): Promise<{ dir: string; branch: string; inviter: string }> {
  const ticket = readTicket(o.invitation);
  const dir = resolve(o.dir);
  const log = o.log ?? (() => undefined);
  await mkdir(dir, { recursive: true });
  if ((await readdir(dir)).length) throw new Error(`${dir} is not empty: join into a new folder`);
  const git = new Git(dir);
  await git.run(['init', '-q']);
  const stateDir = join(await git.gitDir(), 'kuraa');
  const node = new PeerNode({
    dir, git, stateDir, bootstrap: o.bootstrap, branch: async () => 'main', log, joining: true,
    ticket: ticket.kind === 'invite' ? { kind: 'invite', key: ticket.from.key, token: ticket.token } : { kind: 'link', link: ticket.link },
  });
  await node.identity.adopt(ticket.workspace);
  if (o.name) await node.identity.setDeviceName(o.name);
  // The device that made the invitation or link is the first to look for.
  await node.identity.addMember(ticket.from.key, ticket.from.name);
  // This device starts out accepting work as the device that made the invitation or link does (its own
  // to change), as the invitation or link says: not as whatever device lets it in says.
  // (Older invitations and links do not say: then it accepts every member's work.)
  await node.identity.setRules(ticket.rules);
  const welcomed = new Promise<{ branch: string; remote: string; from: string }>((resolveWelcome, reject) => {
    const timer = setTimeout(() => reject(new Error(ticket.kind === 'invite'
      ? `Could not reach ${ticket.from.name}: is its host running, with --peer?`
      : 'Could not reach a device of the workspace that takes this link: is one running, with --peer?')), o.timeoutMs ?? 120_000);
    let done = false;
    // Turned away (a revoked or expired link, an invitation used up): another device may
    // still let this one in, so wait a little for one before saying why.
    let refusal: NodeJS.Timeout | undefined;
    node.events.refused = (link, reason) => {
      if (done || refusal || (ticket.kind === 'invite' && link.key !== ticket.from.key)) return;
      const why = reason.replace(/^not paired with this device, and /, '').replace(/^not paired with this device$/, ticket.kind === 'invite' ? 'the invitation was used, or has expired' : 'the link was not accepted');
      refusal = setTimeout(() => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(new Error(`Could not join: ${why}`));
      }, ticket.kind === 'invite' ? 0 : 8000);
    };
    node.events.welcome = (link, m) => {
      if (done || (ticket.kind === 'invite' && link.key !== ticket.from.key)) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(refusal);
      void (async () => {
        for (const member of m.members) await node.identity.addMember(member.key, member.name);
        await node.refresh();
        resolveWelcome({ branch: m.branch, remote: link.remote!, from: m.name });
      })().catch(reject);
    };
  });
  try {
    await node.start(false);
    log(ticket.kind === 'invite' ? `looking for ${ticket.from.name}…` : 'looking for a device of the workspace…');
    const { branch, remote, from } = await welcomed;
    if (!(await node.fetch(remote))) throw new Error(`Could not fetch from ${from}`);
    await git.run(['checkout', '-q', '-B', branch, `refs/remotes/${remote}/${branch}`]);
    if (ticket.kind === 'link') await node.identity.setJoinedLink(ticket.link);
    log(`joined: ${dir} on ${branch}, let in by ${from}`);
    return { dir, branch, inviter: remote };
  } finally {
    await node.close();
  }
}
