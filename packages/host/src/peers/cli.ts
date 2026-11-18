// The peer commands of kuraa-host, for whoever runs the device (pairing is the
// operator's, not the app's):
//
//   kuraa-host invite   [--dir .] [--hours 24]       an invitation for another device, good once
//   kuraa-host link     [--dir .] [--hours 168 | --forever]   a subscription link, good for anyone, until it expires
//   kuraa-host links    [--dir .]                     the links this device made, and which are revoked
//   kuraa-host revoke-link <id> [--dir .]             no device lets anyone in by it any more
//   kuraa-host join <invitation or link> [--dir path] [--name laptop] [--bootstrap host:port]
//   kuraa-host devices  [--dir .]                     this device, the paired ones, the upstream
//   kuraa-host name <name> [--dir .]                  what this device is called
//   kuraa-host remove-device <name> [--dir .]         never sync with it again
//   kuraa-host upstream <device|self|remote|none> [--gate main]... [--dir .]
//   kuraa-host fork     [--dir .]                     make this copy a workspace of its own
import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { Git } from '../git.js';
import { Identity, decodeLink, encodeInvitation } from './identity.js';
import { joinWorkspace } from './join.js';

export const PEER_COMMANDS = ['invite', 'link', 'links', 'revoke-link', 'join', 'devices', 'name', 'remove-device', 'upstream', 'fork'];

async function identityAt(dir: string): Promise<{ git: Git; id: Identity }> {
  const git = new Git(resolve(dir));
  if (!(await git.isRepo())) throw new Error(`Not a git repository: ${resolve(dir)}`);
  return { git, id: new Identity(git, join(await git.gitDir(), 'kuraa')) };
}

export async function peerCommand(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dir: { type: 'string', default: '.' },
      hours: { type: 'string' },
      forever: { type: 'boolean', default: false },
      name: { type: 'string' },
      bootstrap: { type: 'string', multiple: true },
      gate: { type: 'string', multiple: true },
    },
  });
  const [command, arg] = positionals;
  const say = (m: string) => console.log(m);
  switch (command) {
    case 'invite': {
      const { id } = await identityAt(values.dir!);
      const ws = (await id.workspace()) ?? (await id.found());
      const key = (await id.deviceKey()).publicKey.toString('hex');
      const hours = Number(values.hours ?? 24);
      const token = await id.invite(hours);
      say(encodeInvitation({ workspace: ws, inviter: { key, name: await id.deviceName() }, token }));
      say(`\nGood once, for ${hours} hours. On the other device: kuraa-host join <invitation> --dir <new folder>`);
      say('This device must be running its host with --peer when the other joins.');
      return;
    }
    case 'link': {
      const { id } = await identityAt(values.dir!);
      if (!(await id.workspace())) await id.found();
      const hours = values.forever ? null : Number(values.hours ?? 168);
      if (hours !== null && !(hours > 0)) throw new Error('--hours must be a number of hours');
      const up = await id.upstream();
      if (up && up !== 'self' && (await id.members()).some((m) => m.name === up)) {
        say(`Note: the upstream is ${up}, and devices take links only from the upstream. Make the link there.`);
      }
      const link = await id.createLink(hours);
      say(link);
      say(`\nAnyone with this link can join the workspace as a full device, ${hours === null ? 'until it is revoked' : `for ${hours} hours, or until it is revoked`}:`);
      say('  kuraa-host join <link> --dir <new folder>');
      say('Any device of the workspace running its host with --peer can let them in.');
      say(`It carries the workspace's secret: share it only with people who may join. Revoke it: kuraa-host revoke-link ${decodeLink(link).id}`);
      return;
    }
    case 'links': {
      const { id } = await identityAt(values.dir!);
      const revoked = await id.revokedLinks();
      const links = await id.links();
      if (!links.length) say('This device has made no subscription links.');
      for (const l of links) {
        const state = revoked.includes(l.id) ? 'revoked' : l.expires && l.expires < Date.now() ? 'expired' : l.expires ? `until ${new Date(l.expires).toLocaleString()}` : 'no expiry';
        say(`  ${l.id}  made ${new Date(l.created).toLocaleString()}  ${state}`);
      }
      const others = revoked.filter((r) => !links.some((l) => l.id === r));
      if (others.length) say(`revoked elsewhere: ${others.join(', ')}`);
      return;
    }
    case 'revoke-link': {
      if (!arg) throw new Error('Usage: kuraa-host revoke-link <id> (kuraa-host links lists them)');
      const { id } = await identityAt(values.dir!);
      await id.revokeLink(arg);
      return say(`Revoked ${arg}. Devices that joined by it stay; other devices learn of it when they next meet this one.`);
    }
    case 'join': {
      if (!arg) throw new Error('Usage: kuraa-host join <invitation> --dir <new folder>');
      const r = await joinWorkspace({ dir: values.dir === '.' ? 'workspace' : values.dir!, invitation: arg, name: values.name, bootstrap: values.bootstrap, log: (m) => say(`[kuraa] ${m}`) });
      say(`Now run: kuraa-host --dir ${r.dir} --peer`);
      return;
    }
    case 'devices': {
      const { id } = await identityAt(values.dir!);
      const ws = await id.workspace();
      if (!ws) return say('This repository is not shared between devices (kuraa-host invite makes it so).');
      say(`workspace ${ws.id}${ws.forkedFrom ? ` (forked from ${ws.forkedFrom})` : ''}`);
      say(`this device: ${await id.deviceName()} ${(await id.deviceKey()).publicKey.toString('hex')}`);
      const up = await id.upstream();
      for (const m of await id.members()) say(`  ${m.name}${m.name === up ? ' (upstream)' : ''} ${m.key}`);
      if (up === 'self') say('this device is the upstream');
      else if (up && !(await id.members()).some((m) => m.name === up)) say(`upstream: the remote ${up}`);
      const gated = await id.gated();
      if (gated.length) say(`gated branches: ${gated.join(', ')}`);
      const removed = await id.removed();
      if (removed.length) say(`removed: ${removed.join(', ')}`);
      return;
    }
    case 'name': {
      if (!arg) throw new Error('Usage: kuraa-host name <name>');
      const { id } = await identityAt(values.dir!);
      await id.setDeviceName(arg);
      return say(`This device is now called ${await id.deviceName()}.`);
    }
    case 'remove-device': {
      const { id } = await identityAt(values.dir!);
      const m = (await id.members()).find((x) => x.name === arg || x.key === arg);
      if (!m) throw new Error(`No paired device called ${arg}`);
      await id.removeMember(m.key);
      return say(`Removed ${m.name}. Other devices learn of it when they next meet this one.`);
    }
    case 'upstream': {
      if (!arg) throw new Error('Usage: kuraa-host upstream <device|self|remote|none> [--gate main]');
      const { git, id } = await identityAt(values.dir!);
      if (arg === 'none') await id.setUpstream(null);
      else {
        const remotes = (await git.out(['remote'])).split('\n');
        if (arg !== 'self' && !remotes.includes(arg)) throw new Error(`No remote or paired device called ${arg}`);
        await id.setUpstream(arg);
      }
      if (values.gate) await id.setGated(values.gate);
      return say(`Upstream: ${arg}${values.gate?.length ? `; gated: ${values.gate.join(', ')}` : ''}. Other devices learn it when they next meet this one.`);
    }
    case 'fork': {
      const { git, id } = await identityAt(values.dir!);
      const ws = await id.fork(await git.out(['rev-parse', 'HEAD']));
      return say(`This copy is now workspace ${ws.id}, forked from ${ws.forkedFrom}. Its devices stay as remotes to fetch from by hand.`);
    }
    default:
      throw new Error(`Unknown command ${command}. Commands: ${PEER_COMMANDS.join(', ')}`);
  }
}
