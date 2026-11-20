// The peer commands of kuraa-host, for whoever runs the device:
//
//   kuraa-host invite   [--dir .] [--anyone] [--hours 168 | --forever]
//                                                     an invite link: for one person (the first device it lets in
//                                                     uses it up), or anyone with it; a week, unless said (link: --anyone)
//   kuraa-host invites  [--dir .]                     the invite links this device made, and which still work (links)
//   kuraa-host revoke-invite <id> [--dir .]           no device lets anyone in by it any more (revoke-link)
//   kuraa-host join <invite link> [--dir path] [--name laptop] [--bootstrap host:port]
//   kuraa-host devices  [--dir .]                     this device and the others in the workspace, and whose they are
//   kuraa-host name <name> [--dir .]                  what this device is called
//   kuraa-host remove-device <name> [--dir .]         out of the workspace for good (it keeps its copy)
//   kuraa-host person [create <name> | export | import <line> | use [--dir .] | revoke <key>]
//                                                     your identity, and this computer's signing key (person.ts)
//   kuraa-host online [add <address|remote> | remove <name>] [--dir .]
//                                                     the online copy: a git server synced with (backup)
//   kuraa-host fork     [--dir .]                     make this copy a workspace of its own
//   kuraa-host signing-key                            the key commits made on this computer are signed with, for GitHub
//
// Every member has the same say (0038): any device may invite people, remove
// devices and revoke links. Each change is signed by the device that made it
// and passed on (records.ts), and every other device takes it.
import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { Git } from '../git.js';
import { Identity, decodeLink } from './identity.js';
import { joinWorkspace } from './join.js';
import { sshPublicKey } from '../signing.js';
import { createPerson, exportPerson, importPerson, personFile, readPerson, revokeKey, signingFile, signingKey } from './person.js';

/** Commands, and other names they go by. */
const ALIASES: Record<string, string> = { link: 'invite', links: 'invites', 'revoke-link': 'revoke-invite', backup: 'online' };

export const PEER_COMMANDS = ['invite', 'invites', 'revoke-invite', 'join', 'devices', 'name', 'remove-device', 'online', 'fork', 'signing-key', 'person', ...Object.keys(ALIASES)];

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
      anyone: { type: 'boolean', default: false },
      name: { type: 'string' },
      bootstrap: { type: 'string', multiple: true },
    },
  });
  const [given, arg, ...more] = positionals;
  const command = ALIASES[given ?? ''] ?? given;
  const say = (m: string) => console.log(m);
  switch (command) {
    case 'invite': {
      const { id } = await identityAt(values.dir!);
      if (!(await id.workspace())) await id.found();
      const hours = values.forever ? null : Number(values.hours ?? 168);
      if (hours !== null && !(hours > 0)) throw new Error('--hours must be a number of hours');
      // `link` was the name of a link for anyone.
      const once = !values.anyone && given !== 'link';
      const link = await id.createLink(hours, once);
      say(link);
      const until = hours === null ? 'until it is revoked' : `for ${hours} hours, or until it is revoked`;
      say(`\n${once ? `For one person: the first device it lets in uses it up. It works ${until}.` : `Anyone with this link can join, ${until}.`}`);
      say('They join as a full member, able to read and change everything, and to invite and remove others:');
      say('  kuraa-host join <link> --dir <new folder>');
      say('Any device of the workspace running its host with --peer can let them in.');
      say(`It carries the workspace's secret: share it only with people who may join. Revoke it: kuraa-host revoke-invite ${decodeLink(link).id}`);
      return;
    }
    case 'invites': {
      const { id } = await identityAt(values.dir!);
      const revoked = await id.revokedLinks();
      const used = await id.usedLinks();
      const links = await id.links();
      if (!links.length) say('This device has made no invite links.');
      for (const l of links) {
        const state = used.includes(l.id) ? 'used' : revoked.includes(l.id) ? 'revoked' : l.expires && l.expires < Date.now() ? 'expired' : l.expires ? `until ${new Date(l.expires).toLocaleString()}` : 'no expiry';
        say(`  ${l.id}  ${l.once ? 'one person' : 'anyone'}  made ${new Date(l.created).toLocaleString()}  ${state}`);
      }
      const others = revoked.filter((r) => !links.some((l) => l.id === r));
      if (others.length) say(`revoked or used elsewhere: ${others.join(', ')}`);
      return;
    }
    case 'revoke-invite': {
      if (!arg) throw new Error('Usage: kuraa-host revoke-invite <id> (kuraa-host invites lists them)');
      const { id } = await identityAt(values.dir!);
      await id.revokeLink(arg);
      return say(`Revoked ${arg}. Devices that joined by it stay; other devices learn of it when they next meet this one.`);
    }
    case 'join': {
      if (!arg) throw new Error('Usage: kuraa-host join <invite link> --dir <new folder>');
      const r = await joinWorkspace({ dir: values.dir === '.' ? 'workspace' : values.dir!, invitation: arg, name: values.name, bootstrap: values.bootstrap, log: (m) => say(`[kuraa] ${m}`) });
      say(`Now run: kuraa-host --dir ${r.dir} --peer`);
      return;
    }
    case 'devices': {
      const { id } = await identityAt(values.dir!);
      const ws = await id.workspace();
      if (!ws) return say('This repository is not shared between devices (kuraa-host invite makes it so).');
      say(`workspace ${ws.id}${ws.forkedFrom ? ` (forked from ${ws.forkedFrom})` : ''}`);
      const self = (await id.deviceKey()).publicKey.toString('hex');
      const whose = async (k: string) => {
        const p = await id.personOf(k);
        return p ? ` (${p.name})` : '';
      };
      say(`this device: ${await id.deviceName()} ${self}${await whose(self)}`);
      for (const m of await id.members()) say(`  ${m.name} ${m.key}${await whose(m.key)}`);
      for (const p of await id.people()) say(`${p.name} ${p.key}: keys ${p.keys.map((k) => k.slice(0, 8)).join(', ')}`);
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
      return say(`Removed ${m.name}, for good: it keeps its copy, but no longer syncs with this workspace. Other devices learn of it when they next meet this one.`);
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
    case 'online': {
      const { git } = await identityAt(values.dir!);
      const { OnlineCopies } = await import('../backups.js');
      // Merging needs the host's document types: a running host brings the copy's work in, at its next sync.
      const online = new OnlineCopies(git, { delayMs: 0, everyMs: 0, log: () => undefined });
      if (arg === 'add') {
        const name = await online.add(more.join(' '));
        const said = await online.sync(name, false);
        const c = (await online.list()).find((x) => x.name === name)!;
        return say(said ? `Added ${name} (${c.url}), and pushed to it. A running host pushes each save to it, and fetches and merges from it on Sync and every few minutes.` : `Added ${name} (${c.url}); the first push did not go through: ${c.error}`);
      }
      if (arg === 'remove') {
        await online.remove(more[0] ?? '');
        return say(`${more[0]} is no longer an online copy; the repository there is as it was.`);
      }
      if (arg) throw new Error('Usage: kuraa-host online [add <address|remote> | remove <name>]');
      const list = await online.list();
      if (!list.length) return say('No online copy. kuraa-host online add <address> keeps this workspace on a git server (GitHub, GitLab, any), synced with it.');
      for (const c of list) say(`${c.name} ${c.url}`);
      return;
    }
    case 'fork': {
      const { git, id } = await identityAt(values.dir!);
      const ws = await id.fork(await git.out(['rev-parse', 'HEAD']));
      return say(`This copy is now workspace ${ws.id}, forked from ${ws.forkedFrom}. Its devices stay as remotes to fetch from by hand.`);
    }
    case 'signing-key': {
      // Commits are signed with this computer's signing key for its person (0035), not the device's connection key.
      say(`${sshPublicKey((await signingKey()).publicKey)} kuraa-${(await readPerson())?.name.replace(/\s+/g, '-') || 'signing-key'}`);
      say('\nThe commits made on this computer, in workspaces that sync with other devices, are signed with this key.');
      say('To have GitHub show them as verified, add it there as a signing key (Settings → SSH and GPG keys → New SSH key, type: Signing Key).');
      return;
    }
    default:
      throw new Error(`Unknown command ${given}. Commands: ${PEER_COMMANDS.join(', ')}`);
  }
}
