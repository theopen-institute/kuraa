// The peer commands of kuraa-host, for whoever runs the device (pairing is the
// operator's, not the app's):
//
//   kuraa-host invite   [--dir .] [--hours 24]       an invitation for another device, good once
//   kuraa-host link     [--dir .] [--hours 168 | --forever]   a subscription link, good for anyone, until it expires
//   kuraa-host links    [--dir .]                     the links this device made, and which are revoked
//   kuraa-host revoke-link <id> [--dir .]             no device lets anyone in by it any more
//   kuraa-host join <invitation or link> [--dir path] [--name laptop] [--bootstrap host:port]
//   kuraa-host devices  [--dir .]                     this device, the paired ones, the rules, the sync remote
//   kuraa-host name <name> [--dir .]                  what this device is called
//   kuraa-host remove-device <name> [--dir .]         never sync with it again
//   kuraa-host accept <branch> [--path dir/|file] <device|person|self>... | everyone [--dir .]
//                                                     whose work comes in on its own there
//   kuraa-host accept --membership <device|person|self>... | everyone [--dir .]
//                                                     whose changes to the members this device takes
//   kuraa-host person [create <name> | export | import <line> | use [--dir .] | revoke <key>]
//                                                     your identity, and this computer's signing key (person.ts)
//   kuraa-host sync-remote <remote|none> [--dir .]    the sync remote: the ordinary git remote Sync uses (GitHub, say)
//   kuraa-host fork     [--dir .]                     make this copy a workspace of its own
//   kuraa-host signing-key [--dir .]                  the key this device signs commits with, as an SSH public key
//   kuraa-host backup [add <address|remote> | remove <name> | now] [--dir .]
//                                                     git servers this workspace is pushed to, and only that
//
// Removing a device and revoking a link are signed by this device and passed on
// (records.ts); each other device takes them by its own rule. Whose work and
// whose membership changes this device accepts is its own choice (accept.ts,
// 0032, 0033), published to the others.
import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { Git } from '../git.js';
import { Identity, decodeLink, encodeInvitation } from './identity.js';
import { joinWorkspace } from './join.js';
import { sshPublicKey } from '../signing.js';
import { createPerson, exportPerson, importPerson, personFile, readPerson, revokeKey, signingFile, signingKey } from './person.js';

export const PEER_COMMANDS = ['invite', 'link', 'links', 'revoke-link', 'join', 'devices', 'name', 'remove-device', 'accept', 'sync-remote', 'fork', 'signing-key', 'person', 'backup'];

/** Devices and people by name (or key): `self` for this device. */
async function keysFor(id: Identity, names: string[]): Promise<string[]> {
  const self = (await id.deviceKey()).publicKey.toString('hex');
  const members = await id.members();
  const people = await id.people();
  return names.map((n) => {
    const key = n === 'self' ? self : members.find((m) => m.name === n || m.key === n)?.key ?? people.find((p) => p.name === n || p.key === n)?.key;
    if (!key) throw new Error(`No paired device or person called ${n} (kuraa-host devices lists them)`);
    return key;
  });
}

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
      membership: { type: 'boolean', default: false },
      path: { type: 'string', default: '' },
    },
  });
  const [command, arg, ...more] = positionals;
  const say = (m: string) => console.log(m);
  switch (command) {
    case 'invite': {
      const { id } = await identityAt(values.dir!);
      const ws = (await id.workspace()) ?? (await id.found());
      const key = (await id.deviceKey()).publicKey.toString('hex');
      const hours = Number(values.hours ?? 24);
      const token = await id.invite(hours);
      say(encodeInvitation({ workspace: ws, inviter: { key, name: await id.deviceName() }, token, rules: await id.rules() }));
      say(`\nGood once, for ${hours} hours. On the other device: kuraa-host join <invitation> --dir <new folder>`);
      say('This device must be running its host with --peer when the other joins.');
      return;
    }
    case 'link': {
      const { id } = await identityAt(values.dir!);
      if (!(await id.workspace())) await id.found();
      const hours = values.forever ? null : Number(values.hours ?? 168);
      if (hours !== null && !(hours > 0)) throw new Error('--hours must be a number of hours');
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
      await id.decide('revoke-link', arg);
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
      const members = await id.members();
      const people = await id.people();
      const self = (await id.deviceKey()).publicKey.toString('hex');
      const nameOf = (k: string) => (k === self ? 'this device' : members.find((m) => m.key === k)?.name ?? people.find((p) => p.key === k)?.name ?? k.slice(0, 8));
      for (const m of members) say(`  ${m.name} ${m.key}${(await id.personOf(m.key)) ? ` (${(await id.personOf(m.key))!.name})` : ''}`);
      const mine = await id.personOf(self);
      const myKey = await id.signingKeyOf(self);
      if (myKey) say(`this device signs with ${myKey}${mine ? `, ${mine.name}'s` : ''}`);
      for (const p of people) say(`${p.name} ${p.key}: keys ${p.keys.map((k) => k.slice(0, 8)).join(', ')}`);
      const rules = await id.rules();
      for (const r of rules.rules) say(`on ${r.branch}${r.path ? `, ${r.path}` : ''}: work comes in on its own only from ${r.from.map(nameOf).join(', ') || 'no one'}`);
      say(`changes to the members taken from: ${rules.membership ? rules.membership.map(nameOf).join(', ') : 'every member'}`);
      const remote = await id.syncRemote();
      if (remote) say(`sync remote: ${remote}`);
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
      await id.decide('remove', m.key);
      return say(`Removed ${m.name}. Other devices learn of it when they next meet this one.`);
    }
    case 'accept': {
      const names = values.membership ? [arg, ...more].filter((x): x is string => !!x) : more;
      if ((!values.membership && !arg) || !names.length) {
        throw new Error('Usage: kuraa-host accept <branch> [--path dir/|file] <device|person|self>... | everyone, or kuraa-host accept --membership <device|person|self>... | everyone');
      }
      const { id } = await identityAt(values.dir!);
      const keys = names.includes('everyone') ? null : await keysFor(id, names);
      const who = keys ? names.map((n) => (n === 'self' ? 'this device' : n)).join(', ') : 'every member';
      if (values.membership) {
        await id.acceptMembershipFrom(keys);
        return say(`This device now takes changes to the members from ${who}. Other devices choose for themselves.`);
      }
      const where = values.path ? `${values.path} on ${arg}` : arg;
      await id.acceptOn(arg!, values.path!, keys);
      const others = values.path ? 'others\' changes to it come into the history, but this device keeps its own version, and can take theirs' : 'others\' waits as a proposal, to accept or leave';
      say(`In ${where}, work now comes in on its own from ${who}${keys ? `; ${others}` : ''}.`);
      return say('Other devices choose for themselves, and see these rules; devices that join by an invitation or link from this one start with the same.');
    }
    case 'person': {
      const file = personFile();
      const signing = (await signingKey()).publicKey.toString('hex');
      if (!arg) {
        const p = await readPerson(file);
        say(`This computer's signing key, for you: ${signing} (${signingFile()}). It signs the commits you make here.`);
        if (!p) return say(`You have no identity here. kuraa-host person create <your name> makes one (kept in ${file}), which vouches for your signing keys; or import the one from your other computer.`);
        return say(`Your identity: ${p.name} ${p.publicKey.toString('hex')} (${file}). It vouches for this computer's key when your workspaces next sync.`);
      }
      if (arg === 'create') {
        const p = await createPerson(more.join(' '), file);
        say(`Made ${p.name}'s identity: ${p.publicKey.toString('hex')}, kept in ${file}.`);
        return say('It vouches for this computer\'s signing key when your workspaces next sync. On your other computers, import it (kuraa-host person export, then import).');
      }
      if (arg === 'export') {
        const p = await readPerson(file);
        if (!p) throw new Error('This computer has no identity to export');
        say(exportPerson(p));
        return say('\nAnyone with this line can vouch for keys as you: keep it private. On your other computer: kuraa-host person import <line>');
      }
      if (arg === 'import') {
        const p = await importPerson(more.join(''), file);
        return say(`Your identity is here now: ${p.name} ${p.publicKey.toString('hex')}. It vouches for this computer's signing key when your workspaces next sync.`);
      }
      if (arg === 'use') {
        const { id } = await identityAt(values.dir!);
        const p = await readPerson(file);
        const key = await signingKey();
        await id.signsWith(key);
        if (p) await id.vouch(p, key);
        return say(p ? `This workspace now says that this device signs with your key, and that it is ${p.name}'s.` : 'This workspace now says which key this device signs with.');
      }
      if (arg === 'revoke') {
        const key = more[0];
        if (!key || !/^[0-9a-f]{64}$/.test(key)) throw new Error('Usage: kuraa-host person revoke <signing key> (kuraa-host devices lists them)');
        await revokeKey(key, file);
        return say(`${key.slice(0, 8)}… is no longer yours: what it signs no longer counts as yours on each device as this reaches it (what a device already has stays yours). Each of your workspaces says so when it next syncs.`);
      }
      throw new Error('Usage: kuraa-host person [create <name> | export | import <line> | use | revoke <key>]');
    }
    case 'backup': {
      const { git } = await identityAt(values.dir!);
      const { Backups } = await import('../backups.js');
      const backups = new Backups(git, { delayMs: 0, log: say, serial: (fn) => fn() });
      if (arg === 'add') {
        const name = await backups.add(more.join(' '));
        await backups.push(name);
        const b = (await backups.list()).find((x) => x.name === name)!;
        return say(b.error ? `Added ${name} (${b.url}); its first push did not go through: ${b.error}` : `Added ${name} (${b.url}), and pushed to it. A running host pushes to it after each save.`);
      }
      if (arg === 'remove') {
        await backups.remove(more[0] ?? '');
        return say(`${more[0]} is no longer a backup; the repository there is as it was.`);
      }
      if (arg === 'now') {
        for (const b of await backups.pushAll()) say(`${b.name} ${b.url}: ${b.error ?? 'up to date'}`);
        return;
      }
      if (arg) throw new Error('Usage: kuraa-host backup [add <address|remote> | remove <name> | now]');
      const list = await backups.list();
      if (!list.length) return say('No backups. kuraa-host backup add <address> pushes this workspace to a git server (GitHub, GitLab, any).');
      for (const b of list) say(`${b.name} ${b.url}`);
      return;
    }
    case 'sync-remote': {
      if (!arg) throw new Error('Usage: kuraa-host sync-remote <remote|none>');
      const { git, id } = await identityAt(values.dir!);
      if (arg === 'none') await id.setSyncRemote(null);
      else {
        if ((await id.members()).some((m) => m.name === arg) || arg === 'self') {
          throw new Error(`${arg} is a device of this workspace: devices sync with each other already`);
        }
        if (!(await git.out(['remote'])).split('\n').includes(arg)) throw new Error(`No remote called ${arg}`);
        if ((await git.run(['config', '--get-all', 'kuraa.backup'], { allowFail: true })).stdout.split('\n').includes(arg)) {
          throw new Error(`${arg} is a backup: it is only pushed to. To sync with it, remove it as a backup first.`);
        }
        await id.setSyncRemote(arg);
      }
      return say(`Sync now uses ${arg === 'none' ? 'origin, if there is one' : `the remote ${arg}`}.`);
    }
    case 'fork': {
      const { git, id } = await identityAt(values.dir!);
      const ws = await id.fork(await git.out(['rev-parse', 'HEAD']));
      return say(`This copy is now workspace ${ws.id}, forked from ${ws.forkedFrom}. Its devices stay as remotes to fetch from by hand.`);
    }
    case 'signing-key': {
      const { id } = await identityAt(values.dir!);
      say(`${sshPublicKey((await id.deviceKey()).publicKey)} kuraa-${await id.deviceName()}`);
      say('\nThis device signs the commits it makes for people\'s edits with this key, once it syncs with other devices.');
      say('To have GitHub show them as verified, add it there as a signing key (Settings → SSH and GPG keys → New SSH key, type: Signing Key).');
      return;
    }
    default:
      throw new Error(`Unknown command ${command}. Commands: ${PEER_COMMANDS.join(', ')}`);
  }
}
