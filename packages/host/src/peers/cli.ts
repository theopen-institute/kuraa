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
//   kuraa-host relay [--bootstrap host:port]          run a relay (relay.ts) on this computer, and print its key, for
//                                                     others to name (--relay, or Preferences): for computers that cannot
//                                                     connect to each other directly. It passes on what it cannot read.
//
// Every member has the same say (0038): any device may invite people, remove
// devices and revoke links. Each change is signed by the device that made it
// and passed on (records.ts), and every other device takes it.
import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import type { RunComponent } from '@kuraa/run-kit';
import { Git, NON_INTERACTIVE } from '../git.js';
import { loadRunComponents } from '../components.js';
import { Identity, decodeLink, type LinkHints } from './identity.js';
import { readFile } from 'node:fs/promises';
import { joinWorkspace } from './join.js';
import { useDht } from './dht.js';
import { Relay, keptRelayKey } from './relay.js';
import { sshPublicKey } from '../signing.js';
import { WORKSPACE } from './policy.js';
import type { Person } from './person.js';
import type { KeyPair } from '../keys.js';
import { createPerson, exportPerson, importPerson, personFile, readPerson, readRecoveryLine, recoverPerson, recoveryLine, recoverySaved, recoveryState, revokeKey, signingFile, signingKey } from './person.js';

/** Commands, and other names they go by. */
const ALIASES: Record<string, string> = { link: 'invite', links: 'invites', 'revoke-link': 'revoke-invite', backup: 'online' };

export const PEER_COMMANDS = ['invite', 'invites', 'revoke-invite', 'join', 'devices', 'name', 'remove-device', 'people', 'role', 'owner', 'remove-person', 'rules', 'rule', 'group', 'online', 'fork', 'signing-key', 'person', 'relay', ...Object.keys(ALIASES)];

/** The ways into a workspace besides the DHT this device knows (node.ts keeps them in hints.json), for an invite link. */
async function storedHints(dir: string, id: Identity, relays: string[]): Promise<LinkHints> {
  const git = new Git(resolve(dir));
  let h: { tcp?: Record<string, string[]>; relays?: string[] } = {};
  try {
    h = JSON.parse(await readFile(join(await git.gitDir(), 'kuraa', 'hints.json'), 'utf8')) as typeof h;
  } catch { /* none yet */ }
  const members = new Set((await id.members()).map((m) => m.key));
  const tcp = Object.entries(h.tcp ?? {}).filter(([k]) => members.has(k)).flatMap(([k, as]) => as.map((a) => `${k}@${a}`));
  return { relays: [...new Set([...relays, ...(h.relays ?? [])])].filter((k) => /^[0-9a-f]{64}$/.test(k)).slice(0, 4), tcp: tcp.slice(0, 4) };
}

/**
 * You, in this workspace: your identity (made, as the app makes it, if this
 * computer has none) and this computer's signing key, said here; and the
 * workspace's policy written down if it has none (`fresh`: just made here).
 */
async function asPerson(git: Git, id: Identity, fresh: boolean): Promise<{ person: Person; key: KeyPair }> {
  const person = (await readPerson()) ?? (await createPerson((await git.run(['config', 'user.name'], { allowFail: true })).stdout.trim() || (await id.deviceName())));
  const key = await signingKey();
  await id.signsWith(key);
  await id.vouch(person, key);
  await id.ensureGenesis(person.id, key, fresh);
  return { person, key };
}

/** A person of the workspace, by their name or the start of their ID. */
async function personNamed(id: Identity, name: string): Promise<string> {
  const people = (await id.policy()).people();
  const named = await id.people();
  const hits = people.filter((p) => p.id.startsWith(name) || named.find((n) => n.key === p.id)?.name === name);
  if (hits.length !== 1) throw new Error(hits.length ? `More than one person is ${name}: give the start of their ID (kuraa-host people)` : `No one in this workspace is ${name} (kuraa-host people lists them)`);
  return hits[0]!.id;
}

async function identityAt(dir: string): Promise<{ git: Git; id: Identity }> {
  const git = new Git(resolve(dir));
  if (!(await git.isRepo())) throw new Error(`Not a git repository: ${resolve(dir)}`);
  return { git, id: new Identity(git, join(await git.gitDir(), 'kuraa')) };
}

/** `components`: the run components the command line loads (@kuraa/run-components), for the online copy (a sync, decision 0059). */
export async function peerCommand(argv: string[], o: { components?: (RunComponent | string)[] } = {}): Promise<void> {
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
      relay: { type: 'string', multiple: true },
      admin: { type: 'boolean', default: false },
    },
  });
  const [given, arg, ...more] = positionals;
  const command = ALIASES[given ?? ''] ?? given;
  const say = (m: string) => console.log(m);
  switch (command) {
    case 'invite': {
      const { git, id } = await identityAt(values.dir!);
      const fresh = !(await id.workspace());
      if (fresh) await id.found();
      const { key } = await asPerson(git, id, fresh);
      const hours = values.forever ? null : Number(values.hours ?? 168);
      if (hours !== null && !(hours > 0)) throw new Error('--hours must be a number of hours');
      // `link` was the name of a link for anyone.
      const once = !values.anyone && given !== 'link';
      // With the ways in this device knows besides the DHT (0053): servers members said take TCP, relays named.
      // As a member, unless --admin (0066).
      const role = values.admin ? 'admin' : 'member';
      const link = await id.createLink(hours, once, await storedHints(values.dir!, id, values.relay ?? []), { key, role });
      say(link);
      const until = hours === null ? 'until it is revoked' : `for ${hours} hours, or until it is revoked`;
      say(`\n${once ? `For one person: the first device it lets in uses it up. It works ${until}.` : `Anyone with this link can join, ${until}.`}`);
      say(role === 'admin' ? 'They join as an admin, able to read and change everything, and to invite and remove others:' : 'They join as a member, able to read and change everything; only admins invite and remove others (--admin makes them one):');
      say('  kuraa-host join <link> --dir <new folder>');
      say('Any running device of the workspace can let them in.');
      say(`Share it only with people who may join. Revoke it: kuraa-host revoke-invite ${decodeLink(link).id}`);
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
      const r = await joinWorkspace({ dir: values.dir === '.' ? 'workspace' : values.dir!, invitation: arg, name: values.name, bootstrap: values.bootstrap, relays: values.relay, log: (m) => say(`[kuraa] ${m}`) });
      say(`Now run: kuraa-host --dir ${r.dir}`);
      return;
    }
    case 'relay': {
      const dht = await useDht(values.bootstrap?.map((b) => ({ host: b.slice(0, b.lastIndexOf(':')), port: Number(b.slice(b.lastIndexOf(':') + 1)) })));
      const relay = new Relay(dht, await keptRelayKey());
      await relay.start();
      await dht.ready();
      say(`Relaying. Its key, to name in Preferences (or kuraa-host --relay):\n${relay.key}`);
      if (dht.randomized) say('This computer\'s network changes its port for each connection: other computers will find it hard to reach this relay. Run it on one with a public address, or a home network.');
      // Until stopped.
      await new Promise<void>((resolve) => {
        const stop = () => void relay.close().then(() => dht.destroy()).then(resolve);
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
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
    case 'people': {
      const { id } = await identityAt(values.dir!);
      const policy = await id.policy();
      if (!policy.founded) return say('This workspace has no policy yet: every member has the same say. A running device writes it down.');
      const named = await id.people();
      for (const p of policy.people()) {
        const n = named.find((x) => x.key === p.id);
        say(`  ${n?.name ?? '(not yet known here)'} ${p.id.slice(0, 12)}…  ${p.id === policy.owner ? 'owner' : p.role}${n?.devices.length ? `  devices ${n.devices.map((d) => d.slice(0, 8)).join(', ')}` : ''}`);
      }
      return;
    }
    case 'role': {
      const role = more[0];
      if (!arg || (role !== 'admin' && role !== 'member')) throw new Error('Usage: kuraa-host role <person> admin|member');
      const { git, id } = await identityAt(values.dir!);
      const { key } = await asPerson(git, id, false);
      await id.adminOp({ t: 'grant', group: WORKSPACE, who: await personNamed(id, arg), role }, key);
      return say(`Done: ${arg} is ${role === 'admin' ? 'an admin' : 'a member'} of this workspace. Other devices learn of it when they next meet this one.`);
    }
    case 'rules': {
      const { id } = await identityAt(values.dir!);
      const policy = await id.policy();
      const named = new Map((await id.people()).map((p) => [p.key, p.name]));
      const words = (w: string) => (w === 'admins' ? 'admins' : w.startsWith('group:') ? `group ${w.slice(6)}` : named.get(w) ?? w.slice(0, 12));
      if (!policy.rules.size) say('No rules: anyone in the workspace can change everything.');
      for (const [path, by] of [...policy.rules].sort()) say(`  ${path || '(everything)'}  ${by.map(words).join(', ')}`);
      for (const [g, entries] of policy.groups) if (g !== WORKSPACE) say(`group ${g}: ${[...entries].map(([w, r]) => `${words(w)} (${r})`).join(', ')}`);
      return;
    }
    case 'rule': {
      // kuraa-host rule <path> [<who>…]: who may change it (people, group:<name>, admins); none takes the rule away.
      if (arg === undefined) throw new Error('Usage: kuraa-host rule <file, folder/ or ""> [<person> | group:<name> | admins]…');
      const { git, id } = await identityAt(values.dir!);
      const { key } = await asPerson(git, id, false);
      const by: string[] = [];
      for (const w of more) by.push(w === 'admins' || w.startsWith('group:') ? w : await personNamed(id, w));
      await id.adminOp({ t: 'rule', path: arg, by: [...new Set(by)].sort() }, key);
      return say(by.length ? `Only ${more.join(', ')} can change ${arg || 'anything'} now; others' changes are kept out.` : `No rule for ${arg || 'everything'} now.`);
    }
    case 'group': {
      // kuraa-host group <name> add|admin|remove <person>
      const [action, who] = more;
      if (!arg || !who || !['add', 'admin', 'remove'].includes(action ?? '')) throw new Error('Usage: kuraa-host group <name> add|admin|remove <person>');
      const { git, id } = await identityAt(values.dir!);
      const { key } = await asPerson(git, id, false);
      const person = await personNamed(id, who);
      await id.adminOp(action === 'remove' ? { t: 'revoke', group: arg, who: person } : { t: 'grant', group: arg, who: person, role: action === 'admin' ? 'admin' : 'member' }, key);
      return say(action === 'remove' ? `Took ${who} out of ${arg}.` : `${who} is ${action === 'admin' ? 'an admin' : 'a member'} of ${arg}.`);
    }
    case 'owner': {
      // kuraa-host owner <person>: give the owner's role to someone in the workspace (0070); you stay an admin.
      if (!arg) throw new Error('Usage: kuraa-host owner <person>');
      const { git, id } = await identityAt(values.dir!);
      const { key } = await asPerson(git, id, false);
      await id.adminOp({ t: 'owner', who: await personNamed(id, arg) }, key);
      return say(`${arg} is the workspace's owner now; you stay an admin. Other devices learn of it when they next meet this one.`);
    }
    case 'remove-person': {
      if (!arg) throw new Error('Usage: kuraa-host remove-person <person>');
      const { git, id } = await identityAt(values.dir!);
      const { key } = await asPerson(git, id, false);
      const who = await personNamed(id, arg);
      const devices = (await id.people()).find((p) => p.key === who)?.devices ?? [];
      const tips = (await git.run(['for-each-ref', '--format=%(objectname)', 'refs/heads', 'refs/spaces/'], { allowFail: true })).stdout.split('\n').filter((l) => /^[0-9a-f]{40,64}$/.test(l.trim())).map((l) => l.trim());
      await id.adminOp({ t: 'revoke', group: WORKSPACE, who, cutoff: [...new Set(tips)].sort() }, key);
      // Their devices are out with them (0072); they knew the workspace's secret: a new one.
      if (devices.length) await id.newSecret();
      return say(`Took ${arg} out of this workspace, with their devices. Other devices learn of it when they next meet this one.`);
    }
    case 'remove-device': {
      const { git, id } = await identityAt(values.dir!);
      const m = (await id.members()).find((x) => x.name === arg || x.key === arg);
      if (!m) throw new Error(`No paired device called ${arg}`);
      // An admin, or whoever it is: one's own lost or retired computer (0068).
      if (!(await id.mayRemove((await id.deviceKey()).publicKey.toString('hex'), m.key))) throw new Error('Only an admin of this workspace, or whoever it is, can remove a computer');
      // Its signing key dropped here (0072), with the commits this device has: what it signed among them still counts.
      const { key } = await asPerson(git, id, false);
      const target = await id.signingKeyOf(m.key);
      if (!target) throw new Error(`${m.name} has said no key it signs with`);
      const tips = (await git.run(['for-each-ref', '--format=%(objectname)', 'refs/heads', 'refs/spaces/'], { allowFail: true })).stdout.split('\n').map((l) => l.trim()).filter((l) => /^[0-9a-f]{40,64}$/.test(l));
      await id.dropKey(target, tips, key);
      // It knew the workspace's secret: a new one, so it can no longer find the others (0050).
      await id.newSecret();
      return say(`Removed ${m.name}, for good: it keeps its copy, but no longer syncs with this workspace, and can no longer find its devices. Other devices learn of it when they next meet this one.`);
    }
    case 'person': {
      const file = personFile();
      const signing = (await signingKey()).publicKey.toString('hex');
      if (!arg) {
        const p = await readPerson(file);
        say(`This computer's signing key, for you: ${signing} (${signingFile()}). It signs the commits you make here.`);
        if (!p) return say(`You have no identity here. kuraa-host person create <your name> makes one (kept in ${file}), which vouches for your signing keys; or import the one from your other computer.`);
        say(`Your identity: ${p.name} ${p.id} (${file}). It vouches for this computer's key when your workspaces next sync.`);
        if ((await recoveryState(file)) === 'here') say('Its recovery key is still on this computer: kuraa-host person recovery prints it, to keep somewhere safe.');
        return;
      }
      if (arg === 'create') {
        const p = await createPerson(more.join(' '), file);
        say(`Made ${p.name}'s identity: ${p.id}, kept in ${file}.`);
        say('It vouches for this computer\'s signing key when your workspaces next sync. On your other computers, import it (kuraa-host person export, then import).');
        return say('Keep its recovery key somewhere safe: kuraa-host person recovery prints it.');
      }
      if (arg === 'export') {
        const p = await readPerson(file);
        if (!p) throw new Error('This computer has no identity to export');
        say(exportPerson(p));
        return say('\nAnyone with this line can vouch for keys as you: keep it private. On your other computer: kuraa-host person import <line>');
      }
      if (arg === 'import') {
        const p = await importPerson(more.join(''), file);
        return say(`Your identity is here now: ${p.name} ${p.id}. It vouches for this computer's signing key when your workspaces next sync.`);
      }
      if (arg === 'recovery') {
        if (more[0] === 'saved') {
          await recoverySaved(file);
          return say('Removed the recovery key from this computer. Keep the copy you saved: it is the only one.');
        }
        const line = await recoveryLine(file);
        if (!line) throw new Error('Your recovery key is not on this computer: you saved it elsewhere when it was made (or this computer has no identity)');
        say(line);
        return say('\nKeep this somewhere safe (printed, or in a password manager): with it you can recover your identity on any computer if its key is lost or stolen. Then remove it from here: kuraa-host person recovery saved');
      }
      if (arg === 'recover') {
        const line = more.find((m) => m.startsWith('kuraa-recovery:'));
        const drop = new Set(more.filter((m) => /^[0-9a-f]{64}$/.test(m)));
        if (!line) throw new Error('Usage: kuraa-host person recover <recovery key> [<signing key to stop counting>…]');
        // The person's keys this workspace knows of stay theirs, but those named.
        const { id } = await identityAt(values.dir!);
        const which = readRecoveryLine(line).id;
        const known = (await id.people()).find((x) => x.key === which)?.keys ?? [];
        const keep = known.filter((k) => !drop.has(k));
        const p = await recoverPerson(line, keep, file);
        say(`Recovered ${p.name}'s identity (${p.id}): its key is now the recovery key, and what the old key signs from now on is no one's.`);
        if (keep.length) say(`Still yours: ${keep.map((k) => k.slice(0, 8)).join(', ')}.`);
        return say('A new recovery key was made: kuraa-host person recovery prints it, to keep somewhere safe. On your other computers, copy your identity again (kuraa-host person export, then import).');
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
      throw new Error('Usage: kuraa-host person [create <name> | export | import <line> | recovery [saved] | recover <recovery key> [<key>…] | use | revoke <key>]');
    }
    case 'online': {
      const { git } = await identityAt(values.dir!);
      const sync = (await loadRunComponents(o.components)).syncs.get('online');
      if (!sync) throw new Error('No online copy component is loaded (@kuraa/sync-git, in @kuraa/run-components).');
      // Merging needs the host's document types: a running host brings the copy's work in, at its next sync (no bringIn).
      const online = sync.open({ git, nonInteractive: NON_INTERACTIVE, delayMs: 0, everyMs: 0, log: () => undefined, serial: (fn) => fn() });
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
