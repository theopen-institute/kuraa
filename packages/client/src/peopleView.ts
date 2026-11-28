// What Workspace settings' People and a person's or server's own view (0111)
// say of who is in the workspace: whose each computer is, whether someone is
// online (from their computers), how a computer is connected, and who may do
// what (change a role, remove someone, say a computer is lost or stolen). The
// same rules for the list and for each one's view.
import type { PeersInfo } from './api.js';
import { time } from './labels.js';
import { S } from './strings.js';

export type Info = Extract<PeersInfo, { enabled: true }>;
export type Device = Info['devices'][number];
export type Someone = NonNullable<Info['people']>['people'][number];
export type Server = NonNullable<NonNullable<Info['people']>['servers']>[number];
/** Someone in the workspace, as People lists them: a person, or a server. */
export type Member = { kind: 'person'; id: string; p: Someone } | { kind: 'server'; id: string; s: Server };
/** Which one a view is of: a person by their identity ID, a server by its key. */
export type Who = { kind: 'person' | 'server'; id: string };

/** A device as people know it: whose it is, and which computer. */
export const label = (d: { name: string; person: string | null }) => (d.person ? S.devices.on(d.person, d.name) : d.name);
export const nameOf = (p: Someone) => p.name ?? S.people.unknown;

/** A person's computers known here, but this one (said apart, as this computer). */
export const devicesOf = (i: Info, p: Someone) => i.devices.filter((d) => p.devices.includes(d.key));
/** A server's devices known here (its one for this workspace, or one before it). */
export const serverDevices = (i: Info, s: Server) => i.devices.filter((d) => s.devices.includes(d.key));
/** Computers no person here is known to be, nor a server (all of them, where there is no policy). */
export const others = (i: Info) => i.devices.filter((d) => !d.server && !(i.people?.founded && i.people.people.some((p) => p.devices.includes(d.key))));

/** The order of People (0111): the owner, the admins, the members, then the servers; by name within each. */
const RANK = { owner: 0, admin: 1, member: 2 } as const;
export function members(i: Info): Member[] {
  const people = [...(i.people?.people ?? [])].sort((a, b) => RANK[a.role] - RANK[b.role] || nameOf(a).localeCompare(nameOf(b)));
  const servers = [...(i.people?.servers ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  return [...people.map((p) => ({ kind: 'person' as const, id: p.id, p })), ...servers.map((s) => ({ kind: 'server' as const, id: s.key, s }))];
}
export const memberName = (m: Member) => (m.kind === 'person' ? nameOf(m.p) : m.s.name);
/** What kind of member, in a word: owner, admin, member, server. */
export const kindWord = (m: Member) => (m.kind === 'server' ? S.people.server : m.p.role === 'owner' ? S.people.owner : m.p.role === 'admin' ? S.people.admin : S.people.member);

/**
 * Whether someone is online, from their computers: this one (you, or this
 * server), any online, or reached through another; else when one was last seen.
 */
export function stateOf(ds: Device[], here: boolean): { dot: 'online' | 'through' | null; text: string } {
  if (here) return { dot: 'online', text: S.devices.isOnline };
  if (ds.some((d) => d.online)) return { dot: 'online', text: S.devices.isOnline };
  if (ds.some((d) => d.through.length)) return { dot: 'through', text: S.devices.isOnline };
  const seen = Math.max(0, ...ds.map((d) => d.lastSeen ?? 0));
  return { dot: null, text: seen ? S.devices.lastSeen(time(new Date(seen).toISOString())) : S.devices.isOffline };
}
export const memberDevices = (i: Info, m: Member) => (m.kind === 'person' ? devicesOf(i, m.p) : serverDevices(i, m.s));
export const memberState = (i: Info, m: Member) => stateOf(memberDevices(i, m), m.kind === 'person' ? m.p.you : m.s.you);
/** A computer of someone's running another Kuraa, that does not sync with this one: said on their line. */
export const kuraaOf = (ds: Device[]) => ds.find((d) => d.kuraa)?.kuraa ?? null;

/** The devices a device not connected here is reached through, by name. */
export const via = (i: Info, d: Device) => d.through.map((k) => i.devices.find((x) => x.key === k)).filter((x) => !!x).map(label).join(', ');
/** How a computer is now, in words (0053): how it is connected, or when it was last seen. */
export function deviceState(i: Info, d: Device): { text: string; title?: string } {
  if (d.online) {
    return d.via === 'lan' ? { text: S.devices.viaLan, title: S.devices.viaLanTitle }
      : d.via === 'tcp' ? { text: S.devices.viaTcp, title: S.devices.viaTcpTitle }
      : d.via === 'tunnel' ? { text: S.devices.viaTunnel, title: S.devices.viaTunnelTitle }
      : { text: S.devices.isOnline };
  }
  if (d.through.length) return { text: S.devices.through(via(i, d)), title: S.devices.throughTitle(via(i, d)) };
  return { text: d.lastSeen ? S.devices.lastSeen(time(new Date(d.lastSeen).toISOString())) : S.devices.isOffline };
}

/** Behind for this long, a server is said to be (0112): a moment's delay is only work on its way. */
const SAY_BEHIND_MS = 2 * 60_000;
/** Behind for this long, members no longer rely on it to pass work on (peers.ts, SERVER_BEHIND_MS). */
export const LONG_BEHIND_MS = 10 * 60_000;
/**
 * Whether a server holds this device's latest work (0112), from its devices
 * connected here: 'holds', 'behind' (since when) once for more than a moment, or
 * null where none of its devices is connected.
 */
export function serverHolds(ds: Device[], now = Date.now()): { state: 'holds' } | { state: 'behind'; since: number; long: boolean } | null {
  const on = ds.filter((d) => d.online && d.holdsMine !== undefined);
  if (!on.length) return null;
  if (on.some((d) => d.holdsMine)) return { state: 'holds' };
  const since = Math.min(...on.map((d) => d.behindSince ?? now));
  return now - since < SAY_BEHIND_MS ? { state: 'holds' } : { state: 'behind', since, long: now - since >= LONG_BEHIND_MS };
}

/** How a server says it stands (0115), from its devices connected here: the latest said; null where none said. */
export function serverHealth(ds: Device[]): NonNullable<Device['health']> | null {
  const said = ds.filter((d) => d.online && d.health).map((d) => d.health!);
  if (!said.length) return null;
  return said.reduce((a, b) => ((b.lastFetch ?? 0) > (a.lastFetch ?? 0) ? b : a));
}

/** Whether you may invite here: an admin, or anyone where there is no policy yet. */
export const isAdmin = (i: Info) => i.people?.admin ?? true;
/** Whether you may change this person's role, or take them out: admins are the owner's to make and unmake (0070); the owner is no one's. */
export const mayManagePerson = (i: Info, p: Someone) => isAdmin(i) && i.canInvite && !i.removed && !p.you && p.role !== 'owner' && (p.role === 'member' || !!i.people?.assignsAdmins);
/** Whether you add and remove servers: the owner (0099), on a device still in. */
export const managesServers = (i: Info) => !!i.people?.managesServers && i.canInvite && !i.removed;

export type RoleChoice = 'member' | 'admin' | 'owner';
/**
 * The roles you may choose for this person from their role's menu: admins are
 * the owner's to make and unmake (0070), and the owner hands over theirs. None:
 * their role is shown, not offered.
 */
export function rolesFor(i: Info, p: Someone): RoleChoice[] {
  if (p.you || p.role === 'owner' || i.removed || !i.canInvite) return [];
  const mine = i.people?.owner && i.people.owner === i.people.people.find((x) => x.you)?.id;
  const out: RoleChoice[] = [];
  if (isAdmin(i) && i.people?.assignsAdmins) out.push('member', 'admin');
  if (mine) out.push('owner');
  return out;
}

/**
 * Whether you may say a person's computer is lost or stolen (blocking its
 * key): it is yours, or you are an admin (the owner, for an admin's: 0068,
 * 0070). Never this computer: another says so of it.
 */
export function mayBlock(i: Info, p: Someone | undefined, d: Device): boolean {
  if (!i.canInvite || i.removed || d.server) return false;
  if (p?.you) return true;
  return isAdmin(i) && (!p || p.role === 'member' || !!i.people?.assignsAdmins);
}
