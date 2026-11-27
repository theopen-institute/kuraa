// A workspace's policy: who is in it, in which groups, as admins or members
// (docs/decisions/0066-permissions-without-a-centre.md; how it is worked out:
// docs/policy.md).
//
// The policy is a history of signed operations, each naming the operations its
// maker had seen (its parents), so they form a graph that every device holds
// alike. Each is signed by the signing key of a person (the identity that
// vouched for that key is who made it), and checked against the policy as the
// operations before it left it. Every device puts the same operations in the
// same order (parents first, then by hash) and so reaches the same policy, from
// whatever order they arrived in.
//
// - genesis: the first, naming the workspace's first admin, its owner. A
//   workspace is pinned to its genesis (`kuraa.genesis`, and every invite link
//   carries it): no other counts. Workspaces from before 0066 had none pinned;
//   they are founded again, once (0078: legacy.ts).
// - grant, revoke: a person put in a group (as admin or member) or taken out.
//   An admin of the group, or of the workspace, may. Taking someone out of the
//   workspace takes them out of every group. Anyone may leave a group.
// - join: whoever was let in by an invite link puts themselves in the group the
//   link names, as it says, signed by an admin of it (the link's grant). A link
//   for one person puts one in. A grant signed since links are let in by
//   (`kuraa-grant/3`) counts only for whom a device in the workspace let in by
//   the link (`admit`, in the join's past): that device checked, by its clock,
//   that the link had not expired, so the policy needs none.
// - unlink: an invite link lets no one in any more: no join by it counts but
//   those in the unlink's past. An admin of the link's group's to make.
//
// - rule: who may change what (0066, step 3): a path (the whole workspace `''`,
//   a folder `dir/`, or a file) and who may write there: people, groups
//   (`group:<name>`), or the workspace's admins (`admins`). The most specific
//   rule for a file counts; with none, anyone may. Only the workspace's admins
//   make rules; a rule naming no one is taken away.
//
// - space: who may read a set of files (0066, step 5): a space's ID and its
//   audience (people, `group:<name>`, `admins`), like a rule's. Anyone in the
//   workspace may make one they are in themselves; its audience may be changed
//   by whoever made it, or by the workspace's admins. Files not in a space are
//   the workspace's: everyone in it reads them.
//
// - perm: a file's or folder's permission (0069): who may change it (`write`,
//   as a rule's), and, for a folder, who reads what is made in it (`read`, an
//   audience: its files' space). Either may be absent; with neither, the
//   permission is taken away. The nearest up the tree counts, for each. An
//   admin's to make. A private path (in a space, or under a folder others may
//   not read) is named by its hash (`h:<hex>`, hashedPath): those who know the
//   path match it; others learn only that a permission exists. `rule` is the
//   same as a perm's `write`, as made before perms.
//
// - owner (0070): one person above the admins. Only the owner makes someone an
//   admin, makes an admin a member, or takes an admin out (an invite link that
//   makes admins too); the owner cannot be made a member, taken out, or leave,
//   but gives the role to someone in the workspace (`owner`), staying an admin.
//   The genesis's admin is the first owner.
//
// - drop (0072): a person's signing key (one computer of theirs) no longer counts
//   here, with the commits the dropper had (`cutoff`): its devices stop syncing,
//   and what it signs from then on counts for nothing. Its own person's to make,
//   or an admin's (the owner's, for an admin's computer). For good.
//
// - servers (0099): a key no person vouched for, in the workspace as itself,
//   by its own `join` with an owner's invite link for a server (role `server`,
//   for one). The only operation of a key that is no one's that counts. A
//   server reads the workspace's own files and the spaces whose audiences name
//   it, changes nothing, is in no group, and is taken out by a `drop` of its
//   key, the owner's to make.
//
// Two operations made at the same time that cannot both count: the one that
// gives less counts (0078, clash). Each time that decides, it is on record.
//
// Groups: `workspace` (everyone in it), and any an admin of the workspace makes
// by putting someone in it. A group may hold people (identity IDs) and, as
// members, other groups (`group:<name>`).
import { createHash } from 'node:crypto';
import crypto from 'hypercore-crypto';
import type { KeyPair } from '../keys.js';
import { ownerOf } from '@kuraa/feature-kit';

export type Role = 'admin' | 'member';

/** What an invite link may make its holder (0099): a person in a group, as admin or member; or a server. */
export type JoinRole = Role | 'server';

export type PolicyOp =
  | { t: 'genesis'; admins: string[]; legacy: boolean }
  | { t: 'grant'; group: string; who: string; role: Role }
  | { t: 'revoke'; group: string; who: string; cutoff?: string[] }
  | { t: 'join'; group: string; role: JoinRole; link: string; once: boolean; granter: string; grant: string; /** The link's expiry and maker (0071: signed in the grant, linkGrantMessage); none in a join from before. */ expires?: number; issuer?: string }
  | { t: 'rule'; path: string; by: string[] }
  | { t: 'space'; id: string; audience: string[] }
  | { t: 'perm'; path: string; write?: string[]; read?: string[]; space?: string }
  | { t: 'owner'; who: string }
  | { t: 'drop'; key: string; cutoff?: string[] }
  | { t: 'unlink'; link: string; group: string }
  | { t: 'admit'; link: string; key: string }
  // Made before 0078, and read only so a history that has them stays whole (what came after names them as
  // parents): a seal of a workspace's legacy geneses, a verifier of email checks, a witness of removals
  // (0072, gone since: it decided nothing). They count for nothing.
  | { t: 'witness'; who: string; on: boolean }
  | { t: 'seal'; geneses: string[] }
  | { t: 'verifier'; key: string; url: string };

/**
 * A file's or folder's permission (0069): who may change it, and (a folder's)
 * who reads what is in it; with the space that holds what is in it (0072: the
 * folder's own, whose audience is who reads it).
 */
export interface Perm { write?: string[]; read?: string[]; space?: string }

/** A policy operation as a record carries it (records.ts, kind `policy`). */
export interface PolicyEntry {
  /** Its hash (opHash): what operations after it name as parents. */
  id: string;
  op: PolicyOp;
  parents: string[];
  /** The signing key that signed it: the person's who made it. */
  signer: string;
  proof: string;
}

/**
 * Why an operation made at the same time as another did not count, or counted
 * narrowed (0078):
 * - removed: its maker was taken out of the group it acts in (the workspace:
 *   anything), or left it;
 * - demoted: its maker stopped being an admin there;
 * - dropped: the key it was signed with was dropped;
 * - less: it gave someone more than the other did (out, then member, then admin);
 * - unlinked: a join by a link unlinked;
 * - once: a join by a link for one person, which the other used;
 * - owner: two handovers of the owner's role (the lower ID counts);
 * - narrower: a rule, permission or audience: what both name counts;
 * - unfounded: its maker's say came from an operation that did not count.
 */
export type ClashWhy = 'removed' | 'demoted' | 'dropped' | 'less' | 'unlinked' | 'once' | 'owner' | 'narrower' | 'unfounded';

/** A clash settled (0078): the operation that did not count (or counted narrowed), the one it lost to, and why. */
export interface Clash {
  lost: string;
  /** Null where none counted whole (two rules, narrowed to what both name), or its maker's say did not count. */
  won: string | null;
  why: ClashWhy;
}

export const WORKSPACE = 'workspace';
const hexKey = /^[0-9a-f]{64}$/;
const hexSig = /^[0-9a-f]{128}$/;
const groupName = /^[a-z0-9][a-z0-9-]{0,39}$/;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Whether a name is one a group can have. */
export const isGroupName = (name: string) => groupName.test(name);

function encodeOp(op: PolicyOp): string {
  switch (op.t) {
    case 'genesis': return ['genesis', op.admins.join(','), op.legacy ? 'legacy' : ''].join('\0');
    case 'grant': return ['grant', op.group, op.who, op.role].join('\0');
    case 'revoke': return ['revoke', op.group, op.who, ...(op.cutoff ? [op.cutoff.join(',')] : [])].join('\0');
    case 'join': return ['join', op.group, op.role, op.link, op.once ? 'once' : 'anyone', op.granter, op.grant, ...(op.issuer !== undefined ? [String(op.expires ?? 0), op.issuer] : [])].join('\0');
    case 'seal': return ['seal', op.geneses.join(',')].join('\0');
    case 'rule': return ['rule', op.path, op.by.join(',')].join('\0');
    case 'space': return ['space', op.id, op.audience.join(',')].join('\0');
    case 'verifier': return ['verifier', op.key, op.url].join('\0');
    case 'perm': return ['perm', op.path, op.write ? op.write.join(',') : '-', op.read ? op.read.join(',') : '-', ...(op.space ? [op.space] : [])].join('\0');
    case 'owner': return ['owner', op.who].join('\0');
    case 'drop': return ['drop', op.key, ...(op.cutoff ? [op.cutoff.join(',')] : [])].join('\0');
    case 'witness': return ['witness', op.who, op.on ? 'on' : 'off'].join('\0');
    case 'unlink': return ['unlink', op.link, op.group].join('\0');
    case 'admit': return ['admit', op.link, op.key].join('\0');
  }
}

/** What a person's signing key signs to make an operation, in one workspace. */
export const policyMessage = (workspace: string, op: PolicyOp, parents: string[], signer: string) =>
  Buffer.from(['kuraa-policy', workspace, encodeOp(op), [...parents].sort().join(','), signer].join('\0'));

/** An operation's hash. */
export const opHash = (workspace: string, op: PolicyOp, parents: string[], signer: string) => sha256(policyMessage(workspace, op, parents, signer).toString('latin1'));

/** What an admin's signing key signed, before 0071, to let an invite link's holder into a group (the link's grant): not its expiry, nor its maker. */
export const grantMessage = (workspace: string, genesis: string | null, link: string, group: string, role: JoinRole, once: boolean) =>
  Buffer.from(['kuraa-grant', workspace, genesis ?? '', link, group, role, once ? 'once' : 'anyone'].join('\0'));

/**
 * What an admin's signing key signs to let an invite link's holder into a group
 * (0071): with when the link stops letting people in and the device that made
 * it, so no member can sign the same grant into a link that never expires.
 */
export const linkGrantMessage = (workspace: string, genesis: string | null, link: string, group: string, role: JoinRole, once: boolean, expires: number, issuer: string) =>
  Buffer.from(['kuraa-grant/2', workspace, genesis ?? '', link, group, role, once ? 'once' : 'anyone', String(expires), issuer].join('\0'));

/**
 * What an admin's signing key signs, since links are let in by (`admit`), to let
 * an invite link's holder into a group: as linkGrantMessage, and saying that a
 * join by it counts only for whom a device in the workspace let in by the link.
 * Whether the link had expired is that device's to say, as it lets them in.
 */
export const admittedGrantMessage = (workspace: string, genesis: string | null, link: string, group: string, role: JoinRole, once: boolean, expires: number, issuer: string) =>
  Buffer.from(['kuraa-grant/3', workspace, genesis ?? '', link, group, role, once ? 'once' : 'anyone', String(expires), issuer].join('\0'));

/** Make an operation, signed with a person's signing key. */
export function makeOp(workspace: string, op: PolicyOp, parents: string[], key: KeyPair): PolicyEntry {
  const signer = key.publicKey.toString('hex');
  const sorted = [...new Set(parents)].sort();
  return { id: opHash(workspace, op, sorted, signer), op, parents: sorted, signer, proof: crypto.sign(policyMessage(workspace, op, sorted, signer), key.secretKey).toString('hex') };
}

const sortedUnique = (list: unknown, test: RegExp): string[] | null => {
  if (!Array.isArray(list) || list.length > 1000 || !list.every((x) => typeof x === 'string' && test.test(x))) return null;
  const s = [...new Set(list as string[])].sort();
  return s.join() === (list as string[]).join() ? s : null;
};

// An email entry (`email:<address>`) was a way to name someone before 0078: read, so a history that has one
// stays whole, but an operation naming one counts for nothing (retired).
const emailEntry = 'email:[^\\s@,]{1,64}@[^\\s@,]{1,190}\\.[^\\s@,.A-Z]{2,63}';
const whoTest = new RegExp(`^(?:[0-9a-f]{64}|group:[a-z0-9][a-z0-9-]{0,39}|${emailEntry})$`);
const writerTest = new RegExp(`^(?:[0-9a-f]{64}|group:[a-z0-9][a-z0-9-]{0,39}|admins|${emailEntry})$`);
const entryTest = /^(?:[0-9a-f]{64}|group:[a-z0-9][a-z0-9-]{0,39}|admins)$/;

/** Whether a string names someone in a group, rule or audience: an identity, a group, or the admins. */
export const isWriter = (w: string) => entryTest.test(w);

/** Whether an operation is one made before that counts for nothing now: a seal, a verifier, a witness, a legacy genesis, or one naming someone by email. */
export function retired(op: PolicyOp): boolean {
  const email = (list: string[] | undefined) => !!list?.some((w) => w.startsWith('email:'));
  switch (op.t) {
    case 'seal': case 'verifier': case 'witness': return true;
    case 'genesis': return op.legacy;
    case 'grant': case 'revoke': return op.who.startsWith('email:');
    case 'rule': return email(op.by);
    case 'space': return email(op.audience);
    case 'perm': return email(op.write) || email(op.read);
    default: return false;
  }
}

/** Whether a path is in a folder named as one beside a document is (`<document>.<suffix>/`): its last part has a dot past its start. */
export function companionShaped(path: string): boolean {
  const folder = path.slice(0, Math.max(0, path.lastIndexOf('/')));
  const name = folder.slice(folder.lastIndexOf('/') + 1);
  return name.indexOf('.', 1) > 0;
}

/** The documents a companion folder could be beside: its name with each of its dotted endings taken off (`a.md.notes` → `a.md`, `a`). */
export function documentsBeside(path: string): string[] {
  const folder = path.slice(0, Math.max(0, path.lastIndexOf('/')));
  const start = folder.lastIndexOf('/') + 1;
  const out: string[] = [];
  for (let i = folder.indexOf('.', start + 1); i > 0; i = folder.indexOf('.', i + 1)) out.push(folder.slice(0, i));
  return out;
}

/** A private path, as a permission names it: its hash, in this workspace (0069). */
export const hashedPath = (workspace: string, path: string) => `h:${sha256(`kuraa-path\0${workspace}\0${path}`)}`;

/** The paths whose permissions count for a file or folder, nearest first: itself, each folder it is in, and everything (''). */
export function pathsAbove(path: string): string[] {
  const out = [path];
  const parts = path.replace(/\/$/, '').split('/');
  for (let i = parts.length - 1; i > 0; i--) out.push(`${parts.slice(0, i).join('/')}/`);
  if (path !== '') out.push('');
  return [...new Set(out)];
}

/** Whether a path is one a rule can name: `''` (everything), `dir/` (a folder), or a file; relative, with no `.` or `..` parts. */
export function isRulePath(path: string): boolean {
  if (path === '') return true;
  if (path.length > 500 || path.startsWith('/') || path.includes('\0') || path.includes('\\')) return false;
  const parts = (path.endsWith('/') ? path.slice(0, -1) : path).split('/');
  return parts.every((p) => p !== '' && p !== '.' && p !== '..');
}

/** An operation from elsewhere, checked for shape (not for who may make it); null if it is not one. */
export function readOp(v: unknown): PolicyOp | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const role = (r: unknown): r is Role => r === 'admin' || r === 'member';
  switch (o.t) {
    case 'genesis': {
      const admins = sortedUnique(o.admins, hexKey);
      return admins && typeof o.legacy === 'boolean' ? { t: 'genesis', admins, legacy: o.legacy } : null;
    }
    case 'grant':
      return typeof o.group === 'string' && groupName.test(o.group) && typeof o.who === 'string' && whoTest.test(o.who) && role(o.role)
        ? { t: 'grant', group: o.group, who: o.who, role: o.role } : null;
    case 'revoke': {
      if (typeof o.group !== 'string' || !groupName.test(o.group) || typeof o.who !== 'string' || !whoTest.test(o.who)) return null;
      if (o.cutoff === undefined) return { t: 'revoke', group: o.group, who: o.who };
      const cutoff = sortedUnique(o.cutoff, /^[0-9a-f]{40,64}$/);
      return cutoff ? { t: 'revoke', group: o.group, who: o.who, cutoff } : null;
    }
    case 'join':
      // A server's join (0099): for the workspace alone.
      return typeof o.group === 'string' && groupName.test(o.group) && (role(o.role) || (o.role === 'server' && o.group === WORKSPACE)) && typeof o.link === 'string' && /^[0-9a-f]{16}$/.test(o.link)
        && typeof o.once === 'boolean' && typeof o.granter === 'string' && hexKey.test(o.granter) && typeof o.grant === 'string' && hexSig.test(o.grant)
        && (o.issuer === undefined || (typeof o.issuer === 'string' && hexKey.test(o.issuer) && typeof o.expires === 'number' && Number.isSafeInteger(o.expires) && o.expires >= 0))
        ? { t: 'join', group: o.group, role: o.role as JoinRole, link: o.link, once: o.once, granter: o.granter, grant: o.grant, ...(typeof o.issuer === 'string' ? { expires: o.expires as number, issuer: o.issuer } : {}) } : null;
    case 'seal': {
      const geneses = sortedUnique(o.geneses, hexKey);
      return geneses && geneses.length ? { t: 'seal', geneses } : null;
    }
    case 'rule': {
      const by = sortedUnique(o.by, writerTest);
      return typeof o.path === 'string' && isRulePath(o.path) && by ? { t: 'rule', path: o.path, by } : null;
    }
    case 'space': {
      const audience = sortedUnique(o.audience, writerTest);
      return typeof o.id === 'string' && /^[0-9a-f]{32}$/.test(o.id) && audience && audience.length ? { t: 'space', id: o.id, audience } : null;
    }
    case 'verifier':
      return typeof o.key === 'string' && hexKey.test(o.key) && typeof o.url === 'string' && o.url.length <= 500 && (o.url === '' || /^https?:\/\/\S+$/.test(o.url))
        ? { t: 'verifier', key: o.key, url: o.url } : null;
    case 'owner':
      return typeof o.who === 'string' && hexKey.test(o.who) ? { t: 'owner', who: o.who } : null;
    case 'witness':
      return typeof o.who === 'string' && hexKey.test(o.who) && typeof o.on === 'boolean' ? { t: 'witness', who: o.who, on: o.on } : null;
    case 'drop': {
      if (typeof o.key !== 'string' || !hexKey.test(o.key)) return null;
      if (o.cutoff === undefined) return { t: 'drop', key: o.key };
      const cutoff = sortedUnique(o.cutoff, /^[0-9a-f]{40,64}$/);
      return cutoff ? { t: 'drop', key: o.key, cutoff } : null;
    }
    case 'unlink':
      return typeof o.link === 'string' && /^[0-9a-f]{16}$/.test(o.link) && typeof o.group === 'string' && groupName.test(o.group) ? { t: 'unlink', link: o.link, group: o.group } : null;
    case 'admit':
      return typeof o.link === 'string' && /^[0-9a-f]{16}$/.test(o.link) && typeof o.key === 'string' && hexKey.test(o.key) ? { t: 'admit', link: o.link, key: o.key } : null;
    case 'perm': {
      if (typeof o.path !== 'string' || !(isRulePath(o.path) || /^h:[0-9a-f]{64}$/.test(o.path))) return null;
      const write = o.write === undefined ? undefined : sortedUnique(o.write, writerTest);
      const read = o.read === undefined ? undefined : sortedUnique(o.read, writerTest);
      if (write === null || read === null || (write && !write.length) || (read && !read.length)) return null;
      // A folder's own space (0072): only with who reads it.
      if (o.space !== undefined && (typeof o.space !== 'string' || !/^[0-9a-f]{32}$/.test(o.space) || !read)) return null;
      return { t: 'perm', path: o.path, ...(write ? { write } : {}), ...(read ? { read } : {}), ...(typeof o.space === 'string' ? { space: o.space } : {}) };
    }
    default:
      return null;
  }
}

/** Whether an entry is as its signer made it, for this workspace: shape, hash and signature. */
export function entrySigned(workspace: string, e: PolicyEntry): boolean {
  if (!hexKey.test(e.signer) || !hexSig.test(e.proof) || !e.parents.every((p) => hexKey.test(p))) return false;
  if ([...new Set(e.parents)].sort().join() !== e.parents.join()) return false;
  if (e.id !== opHash(workspace, e.op, e.parents, e.signer)) return false;
  return crypto.verify(policyMessage(workspace, e.op, e.parents, e.signer), Buffer.from(e.proof, 'hex'), Buffer.from(e.signer, 'hex'));
}

/**
 * What several lists of whom made at the same time (who may change a path, who
 * reads it) say together (0078): the entries all of them name. Of two where one
 * names some of what the other does, that one: the narrower. Where they name
 * none in common, the admins (who could say either). A list absent (no rule:
 * everyone) names everyone; all absent, absent.
 */
export function narrower(lists: (string[] | undefined)[]): string[] | undefined {
  const said = lists.filter((l): l is string[] => !!l);
  if (!said.length) return undefined;
  const all = said[0]!.filter((w) => said.every((l) => l.includes(w)));
  return all.length ? [...new Set(all)].sort() : ['admins'];
}

export interface PolicyContext {
  workspace: string;
  /** The genesis this workspace is pinned to; null: none (a workspace from before 0066, until founded again: legacy.ts). */
  pin: string | null;
  /** The person (identity ID) a signing key is, as the records show; null if no one's (a server's key is no one's: 0099). */
  personOf(signingKey: string): string | null;
  /**
   * A signing key its person revoked (0072): the policy operations its revoker
   * had seen, of which those it signed still count, and nothing else it signs;
   * null where no revocation said (one from before: all it signed counts);
   * undefined, not revoked.
   */
  cutKey?: (signingKey: string) => string[] | null | undefined;
}

/** What a Policy is made of. */
export interface PolicyParts {
  /** Each group's people and groups, by role. */
  groups: Map<string, Map<string, Role>>;
  /** The genesis that counts (the pin), if any. */
  geneses: string[];
  /** The operations that counted and changed something, in the order they were applied. */
  applied: string[];
  /** The operations no other names as a parent: what a new one names. */
  heads: string[];
  /** Links for one person that let someone in. */
  usedLinks?: Set<string>;
  /** Files' and folders' permissions (0069): path (or its hash) → who may change it, and who reads what is made in it. */
  perms?: Map<string, Perm>;
  /** Clashes settled (0078): operations made at the same time of which one counted, the other not (or narrowed). */
  clashes?: Clash[];
  /** People out of the workspace, and the commits they had made that still count (their removals' cutoffs, gate.ts). */
  cutoffs?: Map<string, string[]>;
  /** Spaces (step 5): ID → who may read it, and who made it ('' where two made it at once: only admins change it). */
  spaces?: Map<string, { audience: string[]; by: string }>;
  /** The workspace's owner (0070); null where there is no policy. */
  owner?: string | null;
  /** Signing keys dropped here (0072): key → the commits they signed that still count (their cutoff, gate.ts). */
  dropped?: Map<string, string[]>;
  /** Operations allowed in their own past, whether or not they counted (in the one order). */
  judged?: string[];
  /** Operations that counted (changing something or not). */
  counted?: Set<string>;
  /** Invite links unlinked: they let no one in. */
  unlinked?: Set<string>;
  /** The workspace it is of: what private paths are hashed with. */
  workspace?: string;
  /** Servers in the workspace (0099): their signing keys. */
  servers?: Set<string>;
}

export class Policy {
  readonly groups: Map<string, Map<string, Role>>;
  readonly geneses: string[];
  readonly applied: string[];
  readonly heads: string[];
  readonly usedLinks: Set<string>;
  readonly perms: Map<string, Perm>;
  readonly clashes: Clash[];
  readonly cutoffs: Map<string, string[]>;
  readonly spaces: Map<string, { audience: string[]; by: string }>;
  readonly owner: string | null;
  readonly dropped: Map<string, string[]>;
  readonly judged: string[];
  readonly counted: Set<string>;
  readonly unlinked: Set<string>;
  readonly workspace: string;
  readonly servers: Set<string>;

  constructor(p: PolicyParts) {
    this.groups = p.groups;
    this.geneses = p.geneses;
    this.applied = p.applied;
    this.heads = p.heads;
    this.usedLinks = p.usedLinks ?? new Set();
    this.perms = p.perms ?? new Map();
    this.clashes = p.clashes ?? [];
    this.cutoffs = p.cutoffs ?? new Map();
    this.spaces = p.spaces ?? new Map();
    this.owner = p.owner ?? null;
    this.dropped = p.dropped ?? new Map();
    this.judged = p.judged ?? [];
    this.counted = p.counted ?? new Set(p.applied);
    this.unlinked = p.unlinked ?? new Set();
    this.workspace = p.workspace ?? '';
    this.servers = p.servers ?? new Set();
  }

  /** Whether a key is a server's in the workspace (0099): in as itself, no person's. */
  isServer(id: string | null): boolean {
    return !!id && this.servers.has(id);
  }

  /** Whether a person is the workspace's owner. */
  isOwner(id: string | null): boolean {
    return !!id && id === this.owner;
  }

  /** Whether a person may make or unmake admins (0070): the owner. */
  mayAssignAdmins(id: string | null): boolean {
    return this.isOwner(id);
  }

  /** Whether an audience entry (a person, `group:<name>`, `admins`) holds a person. */
  private holds(entry: string, id: string): boolean {
    return entry === id || (entry === 'admins' && this.isAdmin(id)) || (entry.startsWith('group:') && this.role(id, entry.slice(6)) !== null);
  }

  /**
   * Whether a person may read a space (null: the workspace's own files, which
   * everyone in it reads; anyone, where there is no policy). A space unknown
   * here (its operation not yet come) is read by no one.
   */
  mayRead(id: string | null, space: string | null): boolean {
    if (!this.founded) return space === null;
    // A server (0099): the workspace's own files, and a space whose audience names it.
    if (this.isServer(id)) return space === null || !!this.spaces.get(space)?.audience.includes(id!);
    if (!id || !this.role(id)) return false;
    if (space === null) return true;
    const s = this.spaces.get(space);
    return !!s && s.audience.some((e) => this.holds(e, id));
  }

  /** Everyone in the workspace who may read a space now: for whether one audience holds another (what code may read). */
  readers(space: string | null): Set<string> {
    return new Set([...(this.groups.get(WORKSPACE)?.keys() ?? [])].filter((id) => /^[0-9a-f]{64}$/.test(id) && this.mayRead(id, space)));
  }

  /** Who may change where, as rules: path (or its hash) → who; the permissions that say who may change. */
  get rules(): Map<string, string[]> {
    return new Map([...this.perms].filter(([, p]) => p.write).map(([k, p]) => [k, p.write!]));
  }

  /** A path's own permission, named in the clear or by its hash; with which. */
  permAt(path: string): { key: string; perm: Perm } | null {
    const plain = this.perms.get(path);
    if (plain) return { key: path, perm: plain };
    const key = hashedPath(this.workspace, path);
    const hashed = this.perms.get(key);
    return hashed ? { key, perm: hashed } : null;
  }

  /** The nearest permission up the tree that says something of a kind: its path (in the clear, as the caller knows it), its key, and what it says. */
  private nearest(path: string, kind: 'write' | 'read', from = 0): { path: string; key: string; who: string[] } | null {
    for (const p of pathsAbove(path).slice(from)) {
      const at = this.permAt(p);
      if (at?.perm[kind]) return { path: p, key: at.key, who: at.perm[kind]! };
    }
    return null;
  }

  /** The rule that counts for a file or folder: the nearest permission up the tree that says who may change it; null if none. */
  ruleFor(path: string): { path: string; by: string[]; key: string } | null {
    const n = this.nearest(path, 'write');
    return n && { path: n.path, by: n.who, key: n.key };
  }

  /**
   * Who reads what is made at a path, as the folders above it say (0069): the
   * nearest folder's read audience, and its space (0072: whose audience it is,
   * where the folder has one); null if none (everyone in the workspace). For a
   * folder, its own counts.
   */
  readFor(path: string): { path: string; audience: string[]; key: string; space?: string } | null {
    const n = this.nearest(path, 'read', path.endsWith('/') ? 0 : 1);
    if (!n) return null;
    const space = this.permAt(n.path)?.perm.space;
    const own = space ? this.spaces.get(space) : undefined;
    return { path: n.path, audience: own?.audience ?? n.who, key: n.key, ...(space ? { space } : {}) };
  }

  /** Whether a space is a folder's own (0072): named by a folder's permission. */
  isFolderSpace(space: string): boolean {
    return [...this.perms.values()].some((p) => p.space === space);
  }

  /**
   * Whether a person (null: no one's, as an unsigned commit) may change a file:
   * by its rule, or anyone if it has none. A person's own file (0082: named
   * `@<identity ID>`, in a folder beside a document, `p01.md.annotations/`) is
   * theirs alone, wherever they read it (`space`: the history it is in; null,
   * the workspace's own), whatever the rules say. `beside`: whether it is beside
   * a document that is there (the gate looks); by its name alone if not given.
   * A file so named anywhere else is judged by the rules, as any other.
   */
  mayWrite(id: string | null, path: string, space: string | null = null, beside?: boolean): boolean {
    // A server changes nothing (0099), whatever the rules say, or where they say nothing.
    if (this.isServer(id)) return false;
    const owner = ownerOf(path);
    if (owner && (beside ?? companionShaped(path))) return !this.founded || (id === owner && this.mayRead(id, space));
    const rule = this.ruleFor(path);
    if (!rule) return true;
    if (!id) return false;
    return rule.by.some((w) => this.holds(w, id));
  }

  /** Whether there is a policy at all (a genesis that counts). */
  get founded(): boolean {
    return this.geneses.length > 0;
  }

  /** A person's role in a group: by their own entry, or (as a member) through a group in it. Outside the workspace, in none. */
  role(id: string, group: string = WORKSPACE): Role | null {
    if (group !== WORKSPACE && !this.roleIn(id, WORKSPACE, new Set())) return null;
    return this.roleIn(id, group, new Set());
  }

  private roleIn(id: string, group: string, seen: Set<string>): Role | null {
    if (seen.has(group)) return null;
    seen.add(group);
    const g = this.groups.get(group);
    if (!g) return null;
    const own = g.get(id);
    if (own) return own;
    for (const who of g.keys()) if (who.startsWith('group:') && this.roleIn(id, who.slice(6), seen)) return 'member';
    return null;
  }

  isAdmin(id: string | null, group: string = WORKSPACE): boolean {
    return !!id && (this.role(id, WORKSPACE) === 'admin' || (group !== WORKSPACE && this.role(id, group) === 'admin'));
  }

  /** The people (not groups) with an entry in a group, and their roles. */
  people(group: string = WORKSPACE): { id: string; role: Role }[] {
    return [...(this.groups.get(group) ?? new Map<string, Role>())].filter(([who]) => /^[0-9a-f]{64}$/.test(who)).map(([id, role]) => ({ id, role }));
  }

  /** A short name for the policy as it is: the hash of its heads (what a commit made under it names, later). */
  get version(): string {
    return sha256(`kuraa-policy-version\0${this.heads.join(',')}`);
  }
}

/** The policy the operations make, in this workspace (see the top of this file, and docs/policy.md). */
export function evaluate(entries: PolicyEntry[], ctx: PolicyContext): Policy {
  const byId = new Map<string, PolicyEntry>();
  for (const e of entries) if (!byId.has(e.id)) byId.set(e.id, e);
  const order = linearize(byId);
  const genesis = ctx.pin ? order.find((e) => e.id === ctx.pin && e.op.t === 'genesis' && !e.op.legacy) : undefined;
  if (!genesis) return new Policy({ groups: new Map([[WORKSPACE, new Map()]]), geneses: [], applied: [], heads: [], workspace: ctx.workspace });
  return apply(order, genesis, ctx);
}

/** Parents first, then by hash; operations whose parents are not all known wait (left out). */
function linearize(byId: Map<string, PolicyEntry>): PolicyEntry[] {
  // How many of each one's parents are not in the order yet, and which name each as a parent.
  const missing = new Map<PolicyEntry, number>();
  const children = new Map<string, PolicyEntry[]>();
  const ready = new Heap<PolicyEntry>((a, b) => a.id < b.id);
  for (const e of byId.values()) {
    if ((e.op.t === 'genesis') !== (e.parents.length === 0)) continue;
    const parents = [...new Set(e.parents)];
    missing.set(e, parents.length);
    if (!parents.length) ready.push(e);
    for (const p of parents) {
      const list = children.get(p);
      if (list) list.push(e);
      else children.set(p, [e]);
    }
  }
  const out: PolicyEntry[] = [];
  // One at a time, the lowest of those ready first: an operation that becomes ready meanwhile is sorted with the rest.
  for (let next = ready.pop(); next; next = ready.pop()) {
    out.push(next);
    for (const c of children.get(next.id) ?? []) {
      const left = missing.get(c)! - 1;
      missing.set(c, left);
      if (left === 0) ready.push(c);
    }
  }
  return out;
}

/** A binary heap, the least on top: so the one order takes time growing with its length, not its square. */
class Heap<T> {
  private readonly items: T[] = [];
  constructor(private readonly less: (a: T, b: T) => boolean) {}

  push(x: T): void {
    const a = this.items;
    a.push(x);
    for (let i = a.length - 1; i > 0;) {
      const up = (i - 1) >> 1;
      if (!this.less(a[i]!, a[up]!)) break;
      [a[i], a[up]] = [a[up]!, a[i]!];
      i = up;
    }
  }

  pop(): T | undefined {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (!a.length || last === undefined) return top;
    a[0] = last;
    for (let i = 0; ;) {
      const l = 2 * i + 1;
      let m = i;
      if (l < a.length && this.less(a[l]!, a[m]!)) m = l;
      if (l + 1 < a.length && this.less(a[l + 1]!, a[m]!)) m = l + 1;
      if (m === i) break;
      [a[i], a[m]] = [a[m]!, a[i]!];
      i = m;
    }
    return top;
  }
}

/** What a policy is made of, as operations are applied to it. */
interface State {
  groups: Map<string, Map<string, Role>>;
  perms: Map<string, Perm>;
  spaces: Map<string, { audience: string[]; by: string }>;
  owner: string;
  /** Links for one person used: by which join. */
  usedLinks: Map<string, string>;
  applied: string[];
  /** Signing keys dropped (0072), and their cutoffs. */
  dropped: Map<string, string[]>;
  /** Invite links unlinked, as `<link> <group>`. */
  unlinked: Set<string>;
  /** Whom a device in the workspace let in by a link, as `<link> <signing key>`. */
  admitted: Set<string>;
  /** A path's permissions made at the same time, none after another, that count together (narrower): each with its operation. */
  permFront: Map<string, { id: string; perm: Perm }[]>;
  /** Likewise a space's audiences; and who made it, by which operation. */
  spaceFront: Map<string, { id: string; audience: string[] }[]>;
  spaceMade: Map<string, { by: string; op: string }>;
  /** Joins by a link for one person that another used at the same time. */
  once: Clash[];
  /** Servers' signing keys (0099). */
  servers: Set<string>;
}

/** A view of a state to judge by. */
const view = (s: State, workspace: string) => new Policy({ groups: s.groups, geneses: ['-'], applied: s.applied, heads: [], perms: s.perms, spaces: s.spaces, owner: s.owner, workspace, servers: s.servers });

function freshState(genesis: PolicyEntry): State {
  const groups = new Map<string, Map<string, Role>>([[WORKSPACE, new Map()]]);
  const admins = genesis.op.t === 'genesis' ? genesis.op.admins : [];
  for (const id of admins) groups.get(WORKSPACE)!.set(id, 'admin');
  // The genesis names its first admin, the owner (0070).
  return {
    groups, perms: new Map(), spaces: new Map(), owner: admins[0] ?? '', usedLinks: new Map(), applied: [genesis.id], dropped: new Map(),
    unlinked: new Set(), admitted: new Set(), permFront: new Map(), spaceFront: new Map(), spaceMade: new Map(), once: [], servers: new Set(),
  };
}

/** What judging operations needs: their order, their pasts, who made each, the policy each was made under. */
interface Env {
  genesis: PolicyEntry;
  order: PolicyEntry[];
  anc: Map<string, Set<string>>;
  by: Map<string, string>;
  /** The policy as each operation's past made it (what it was judged by). */
  before: Map<string, State>;
  /** Removals (0078): whom each takes out of a group (or unmakes an admin of it), and where. */
  removal: Map<string, { person: string; group: string; kind: 'out' | 'demote' }>;
  ctx: PolicyContext;
  /** Grants in joins, checked once each: whether by a link let in by (`/3`), and whether signed at all. */
  grants: Map<string, { admitted: boolean; ok: boolean }>;
}

/** A join's grant, checked once. */
function grantOf(e: PolicyEntry, env: Pick<Env, 'grants' | 'ctx'>): { admitted: boolean; ok: boolean } {
  const had = env.grants.get(e.id);
  if (had) return had;
  const op = e.op;
  if (op.t !== 'join') return { admitted: false, ok: false };
  const ctx = env.ctx;
  const signed = (m: Buffer) => crypto.verify(m, Buffer.from(op.grant, 'hex'), Buffer.from(op.granter, 'hex'));
  const admitted = op.issuer !== undefined && signed(admittedGrantMessage(ctx.workspace, ctx.pin, op.link, op.group, op.role, op.once, op.expires ?? 0, op.issuer));
  const ok = admitted || signed(op.issuer !== undefined
    ? linkGrantMessage(ctx.workspace, ctx.pin, op.link, op.group, op.role, op.once, op.expires ?? 0, op.issuer)
    : grantMessage(ctx.workspace, ctx.pin, op.link, op.group, op.role, op.once));
  const out = { admitted, ok };
  env.grants.set(e.id, out);
  return out;
}

/** Whether `by` may make operation `e`, with the policy as `s` (its past) has it. */
function allowed(e: PolicyEntry, by: string, s: State, env: Pick<Env, 'grants' | 'ctx'>): boolean {
  const now = view(s, env.ctx.workspace);
  const ws = s.groups.get(WORKSPACE)!;
  const op = e.op;
  // Signed by a key dropped in its past: no one's word (0072). Made before 0078, of a kind that counts for nothing now.
  if (s.dropped.has(e.signer) || retired(op)) return false;
  switch (op.t) {
    case 'grant': {
      const nested = op.who.startsWith('group:');
      // A server is no person: in no group (0099).
      if (s.servers.has(op.who)) return false;
      if (nested && (op.group === WORKSPACE || op.role !== 'member' || op.who.slice(6) === op.group)) return false;
      // A new group is the workspace's admins' to make.
      const may = s.groups.has(op.group) ? now.isAdmin(by, op.group) : now.isAdmin(by);
      // Admins are the owner's to make and unmake; the owner is not made a member (0070).
      if (op.group === WORKSPACE && (op.role === 'admin' || ws.get(op.who) === 'admin') && !now.mayAssignAdmins(by)) return false;
      if (op.group === WORKSPACE && op.who === s.owner && op.role !== 'admin') return false;
      // Into another group, only someone in the workspace.
      return may && (op.group === WORKSPACE || nested || ws.has(op.who));
    }
    case 'revoke': {
      const may = now.isAdmin(by, op.group) || op.who === by;
      // The owner does not leave, nor is taken out (they give the role first); an admin is taken out by the owner, or leaves (0070).
      if (op.group === WORKSPACE && op.who === s.owner) return false;
      if (op.group === WORKSPACE && ws.get(op.who) === 'admin' && op.who !== by && !now.mayAssignAdmins(by)) return false;
      return may && !!s.groups.get(op.group)?.has(op.who);
    }
    case 'join': {
      // Not by a link unlinked in its past.
      if (s.unlinked.has(`${op.link} ${op.group}`)) return false;
      const grant = grantOf(e, env);
      // A grant since links are let in by: only for whom a device in the workspace let in by it, in its past.
      if (grant.admitted && !s.admitted.has(`${op.link} ${e.signer}`)) return false;
      const granter = grant.ok ? env.ctx.personOf(op.granter) : null;
      // A server (0099): by the owner's link for one server, let in by a device in the workspace, signed by a key no
      // one's (made by the key itself: by), not one already.
      if (op.role === 'server') {
        return grant.admitted && op.group === WORKSPACE && op.once && by === e.signer && now.isOwner(granter) && !s.servers.has(e.signer) && !s.usedLinks.has(op.link);
      }
      // A link that makes admins of the workspace, only the owner's (0070).
      if (op.group === WORKSPACE && op.role === 'admin' && !now.mayAssignAdmins(granter)) return false;
      return !!granter && s.groups.has(op.group) && now.isAdmin(granter, op.group) && !(op.once && s.usedLinks.has(op.link));
    }
    case 'owner':
      // The owner gives the role to someone in the workspace.
      return by === s.owner && op.who !== by && ws.has(op.who);
    case 'drop': {
      // One's own computer; or an admin, a member's (the owner, anyone's: 0070).
      if (s.dropped.has(op.key) || !now.role(by)) return false;
      // A server's key: the owner's to drop (0099).
      if (s.servers.has(op.key)) return now.isOwner(by);
      const whose = env.ctx.personOf(op.key);
      if (whose === by) return true;
      const ofAdmin = !!whose && (ws.get(whose) === 'admin' || whose === s.owner);
      return now.isAdmin(by) && (!ofAdmin || now.mayAssignAdmins(by));
    }
    case 'unlink':
      return now.isAdmin(by, op.group);
    case 'admit':
      // Anyone in the workspace lets someone in by a link, as a device of theirs checks it.
      return !!now.role(by);
    case 'rule':
    case 'perm':
      return now.isAdmin(by);
    case 'space': {
      // Made by anyone in the workspace who is in it themselves; changed by whoever made it, or an admin.
      const had = s.spaces.get(op.id);
      if (!now.role(by)) return false;
      const holdsMaker = op.audience.some((w) => w === by || (w === 'admins' && now.isAdmin(by)) || (w.startsWith('group:') && now.role(by, w.slice(6)) !== null));
      return had ? had.by === by || now.isAdmin(by) : holdsMaker;
    }
    case 'genesis':
    case 'seal':
    case 'verifier':
    case 'witness':
      return false;
  }
}

const sameList = (a: string[] | undefined, b: string[] | undefined) => (a ?? null)?.join() === (b ?? null)?.join();

/** A path's permission from those counting together (narrower): who may change it and who reads it, each narrowed; a folder's space, of the one whose readers it is. */
function combinePerms(front: { id: string; perm: Perm }[]): Perm | null {
  if (front.length === 1) {
    const p = front[0]!.perm;
    return p.write || p.read ? p : null;
  }
  const write = narrower(front.map((f) => f.perm.write));
  const read = narrower(front.map((f) => f.perm.read));
  const whose = read ? [...front].sort((a, b) => (a.id < b.id ? -1 : 1)).find((f) => sameList(f.perm.read, read)) : undefined;
  const space = whose?.perm.space;
  if (!write && !read) return null;
  return { ...(write ? { write } : {}), ...(read ? { read } : {}), ...(read && space ? { space } : {}) };
}

/** Apply an operation that counts to a policy, at its place in the one order; whether it changed anything it could. */
function effect(e: PolicyEntry, by: string, s: State, env: Env): boolean {
  const op = e.op;
  const group = (name: string) => {
    let g = s.groups.get(name);
    if (!g) s.groups.set(name, (g = new Map()));
    return g;
  };
  const ws = group(WORKSPACE);
  const past = env.anc.get(e.id)!;
  switch (op.t) {
    case 'grant':
      // Into another group, only someone (still) in the workspace; never a server (0099: one made at the same time).
      if (op.group !== WORKSPACE && !op.who.startsWith('group:') && !ws.has(op.who)) return false;
      if (s.servers.has(op.who)) return false;
      group(op.group).set(op.who, op.role);
      return true;
    case 'revoke':
      if (!s.groups.get(op.group)?.has(op.who)) return false;
      s.groups.get(op.group)!.delete(op.who);
      // Out of the workspace: out of every group.
      if (op.group === WORKSPACE) for (const g of s.groups.values()) g.delete(op.who);
      return true;
    case 'join': {
      // A link for one person puts one in: the first, in the order every device puts them in (one made at the same time, not).
      const used = op.once ? s.usedLinks.get(op.link) : undefined;
      if (used) {
        s.once.push({ lost: e.id, won: used, why: 'once' });
        return false;
      }
      if (op.once) s.usedLinks.set(op.link, e.id);
      // A server (0099): one of the servers, in no group; not a key dropped before.
      if (op.role === 'server') {
        if (s.dropped.has(by)) return false;
        s.servers.add(by);
        // Named in a group by a grant made at the same time as this join: in none, as a server.
        for (const g of s.groups.values()) g.delete(by);
        return true;
      }
      if (op.group !== WORKSPACE && !ws.has(by)) ws.set(by, 'member');
      // Never less than they are already.
      if (group(op.group).get(by) !== 'admin') group(op.group).set(by, op.role);
      return true;
    }
    case 'owner':
      s.owner = op.who;
      ws.set(op.who, 'admin');
      return true;
    case 'rule':
    case 'perm': {
      // As a rule: its writers, and what the path's permission said of reading in its own past.
      const had = op.t === 'rule' ? env.before.get(e.id)?.perms.get(op.path) : undefined;
      const perm: Perm = op.t === 'perm'
        ? { ...(op.write ? { write: op.write } : {}), ...(op.read ? { read: op.read } : {}), ...(op.space ? { space: op.space } : {}) }
        : { ...(op.by.length ? { write: op.by } : {}), ...(had?.read ? { read: had.read } : {}), ...(had?.space ? { space: had.space } : {}) };
      // What it comes after, it says instead of; what was made at the same time counts with it, narrowed (0078).
      const front = [...(s.permFront.get(op.path) ?? []).filter((f) => !past.has(f.id)), { id: e.id, perm }];
      s.permFront.set(op.path, front);
      const now = combinePerms(front);
      if (now) s.perms.set(op.path, now);
      else s.perms.delete(op.path);
      return true;
    }
    case 'space': {
      const made = s.spaceMade.get(op.id);
      // Made by two at once (only by a stranger's design, IDs being random): by no one, its audience the admins' to change.
      if (!made) s.spaceMade.set(op.id, { by, op: e.id });
      else if (made.by !== by && !past.has(made.op) && !env.before.get(e.id)?.spaces.has(op.id)) s.spaceMade.set(op.id, { by: '', op: made.op });
      const front = [...(s.spaceFront.get(op.id) ?? []).filter((f) => !past.has(f.id)), { id: e.id, audience: op.audience }];
      s.spaceFront.set(op.id, front);
      s.spaces.set(op.id, { audience: narrower(front.map((f) => f.audience))!, by: s.spaceMade.get(op.id)!.by });
      return true;
    }
    case 'drop':
      s.dropped.set(op.key, op.cutoff ?? []);
      s.servers.delete(op.key);
      return true;
    case 'unlink':
      s.unlinked.add(`${op.link} ${op.group}`);
      return true;
    case 'admit':
      s.admitted.add(`${op.link} ${op.key}`);
      return true;
    case 'genesis':
    case 'seal':
    case 'verifier':
    case 'witness':
      return false;
  }
}

/** The group an operation acts in, for a removal's cutoff: what it changes there. */
const groupOf = (e: PolicyEntry): string | null => {
  const op = e.op;
  return op.t === 'grant' || op.t === 'join' || op.t === 'revoke' ? op.group : null;
};

/**
 * What an operation says of someone's place in a group: taken out, a member,
 * an admin, or in (as they are, or more: a join). Two made at the same time
 * that say different things of the same place clash: the one giving less counts.
 */
type Place = 'out' | 'member' | 'admin' | 'in';
interface Claim { group: string; who: string; place: Place }

function claimsOf(e: PolicyEntry, by: string): Claim[] {
  const op = e.op;
  switch (op.t) {
    case 'grant': return [{ group: op.group, who: op.who, place: op.role }];
    case 'revoke': return [{ group: op.group, who: op.who, place: 'out' }];
    case 'owner': return [{ group: WORKSPACE, who: op.who, place: 'admin' }];
    // A server's says nothing of a place in a group (0099).
    case 'join': return op.role === 'server' ? [] : op.group === WORKSPACE
      ? [{ group: WORKSPACE, who: by, place: op.role }]
      : [{ group: op.group, who: by, place: op.role }, { group: WORKSPACE, who: by, place: 'in' }];
    default: return [];
  }
}

const differ = (a: Place, b: Place) => a !== b && !((a === 'in' && b !== 'out') || (b === 'in' && a !== 'out'));
/** Less first: of two at once that say different things of one place, the one that gives less counts. */
const PLACE_ORDER: Record<Place, number> = { out: 0, member: 1, in: 2, admin: 3 };

/**
 * Which of the operations, each allowed in its own past, count together (0078).
 * Two made at the same time (neither in the other's past) beat one another:
 * - a removal (taking someone out of a group, unmaking an admin of it, or
 *   their leaving it) beats what the one it takes out does there at the same
 *   time (in the workspace: anything), but their leaving; a drop of a key,
 *   what that key signs;
 * - of two that say different things of one person's place in one group (out,
 *   member, admin), the one that gives less;
 * - an unlink, a join by its link;
 * - of two handovers of the owner's role, the one with the lower ID.
 * One that nothing counting beats counts; one that something counting beats
 * does not. Removals that beat one another in a ring (two group admins taking
 * each other out at once) all count: everyone in it is out.
 */
function settle(live: PolicyEntry[], env: Env): { counted: Set<string>; lost: Map<string, { won: string; why: ClashWhy }> } {
  const concurrent = (a: string, b: string) => a !== b && !env.anc.get(a)!.has(b) && !env.anc.get(b)!.has(a);
  const beaters = new Map<string, { from: string; why: ClashWhy }[]>();
  const beats = new Map<string, Set<string>>();
  const edge = (from: string, to: string, why: ClashWhy) => {
    if (!concurrent(from, to)) return;
    let list = beaters.get(to);
    if (!list) beaters.set(to, (list = []));
    if (list.some((x) => x.from === from)) return;
    list.push({ from, why });
    let out = beats.get(from);
    if (!out) beats.set(from, (out = new Set()));
    out.add(to);
  };
  const byMaker = new Map<string, PolicyEntry[]>();
  const bySigner = new Map<string, PolicyEntry[]>();
  const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => {
    const list = m.get(k);
    if (list) list.push(v);
    else m.set(k, [v]);
  };
  for (const e of live) {
    push(byMaker, env.by.get(e.id)!, e);
    push(bySigner, e.signer, e);
  }
  // Removals first: what the one taken out did there at the same time (a drop: what its key signed).
  for (const r of live) {
    if (r.op.t === 'drop') {
      for (const e of bySigner.get(r.op.key) ?? []) if (e !== r) edge(r.id, e.id, 'dropped');
      continue;
    }
    const m = env.removal.get(r.id);
    if (!m) continue;
    for (const e of byMaker.get(m.person) ?? []) {
      if (e === r) continue;
      // Their leaving a group stands.
      if (e.op.t === 'revoke' && e.op.who === m.person) continue;
      if (m.group === WORKSPACE || groupOf(e) === m.group) edge(r.id, e.id, m.kind === 'out' ? 'removed' : 'demoted');
    }
  }
  // Then places: of two at once saying different things of one person in one group, the one giving less.
  const places = new Map<string, { e: PolicyEntry; place: Place }[]>();
  for (const e of live) for (const c of claimsOf(e, env.by.get(e.id)!)) {
    push(places, `${c.group}\0${c.who}`, { e, place: c.place });
  }
  for (const list of places.values()) for (const a of list) for (const b of list) {
    if (differ(a.place, b.place) && PLACE_ORDER[a.place] < PLACE_ORDER[b.place]) edge(a.e.id, b.e.id, 'less');
  }
  // An unlink, a join by its link; of two handovers, the lower ID.
  const unlinks = live.filter((u) => u.op.t === 'unlink');
  for (const j of live) {
    const op = j.op;
    if (op.t === 'join') for (const u of unlinks) if (u.op.t === 'unlink' && u.op.link === op.link && u.op.group === op.group) edge(u.id, j.id, 'unlinked');
  }
  const owners = live.filter((o) => o.op.t === 'owner');
  for (const a of owners) for (const b of owners) if (a.id < b.id) edge(a.id, b.id, 'owner');

  const counted = new Set<string>();
  const out = new Set<string>();
  const undecided = new Set(live.map((e) => e.id));
  const ground = () => {
    for (let changed = true; changed;) {
      changed = false;
      for (const id of undecided) {
        const bs = beaters.get(id) ?? [];
        if (bs.some((b) => counted.has(b.from))) out.add(id);
        else if (bs.every((b) => out.has(b.from))) counted.add(id);
        else continue;
        undecided.delete(id);
        changed = true;
      }
    }
  };
  ground();
  // What is left beats one another in rings (removals of each other): the rings nothing outside them beats all count.
  while (undecided.size) {
    for (const ring of rings(undecided, beats)) {
      const inside = new Set(ring);
      if (ring.every((id) => (beaters.get(id) ?? []).every((b) => inside.has(b.from) || out.has(b.from)))) for (const id of ring) {
        counted.add(id);
        undecided.delete(id);
      }
    }
    ground();
  }
  // Each that did not count, with the one it lost to (the lowest ID of those counting that beat it).
  const lost = new Map<string, { won: string; why: ClashWhy }>();
  for (const id of out) {
    const winner = (beaters.get(id) ?? []).filter((b) => counted.has(b.from)).sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))[0]!;
    lost.set(id, { won: winner.from, why: winner.why });
  }
  return { counted, lost };
}

/** The strongly connected parts (Tarjan's) of the graph of what beats what, among `nodes`: rings, and single ones. */
function rings(nodes: Set<string>, beats: Map<string, Set<string>>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const on = new Set<string>();
  const out: string[][] = [];
  let next = 0;
  const visit = (v: string) => {
    index.set(v, next);
    low.set(v, next++);
    stack.push(v);
    on.add(v);
    for (const w of beats.get(v) ?? []) {
      if (!nodes.has(w)) continue;
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (on.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) === index.get(v)) {
      const ring: string[] = [];
      for (let w = ''; w !== v;) {
        w = stack.pop()!;
        on.delete(w);
        ring.push(w);
      }
      out.push(ring.sort());
    }
  };
  for (const v of [...nodes].sort()) if (!index.has(v)) visit(v);
  return out;
}

/** The policy the operations that count make, applied in the one order. */
function build(counting: Set<string>, env: Env): State {
  const s = freshState(env.genesis);
  for (const e of env.order) {
    if (!counting.has(e.id)) continue;
    if (effect(e, env.by.get(e.id)!, s, env)) s.applied.push(e.id);
  }
  return s;
}

interface Folded { state: State; counted: Set<string>; clashes: Clash[] }

/**
 * Apply operations, each allowed in its own past, together (0078): which count
 * (settle), then what counts must be allowed by what counts of its past: an
 * operation whose maker's say came from one that does not count does not count
 * either, and the rest are settled again without it.
 */
function fold(ops: PolicyEntry[], env: Env): Folded {
  const unfounded = new Set<string>();
  for (;;) {
    const live = ops.filter((e) => !unfounded.has(e.id));
    const { counted, lost } = settle(live, env);
    let again = false;
    for (const e of live) {
      if (!counted.has(e.id)) continue;
      const past = env.anc.get(e.id)!;
      const then = build(new Set([...counted].filter((x) => past.has(x))), env);
      if (!allowed(e, env.by.get(e.id)!, then, env)) {
        unfounded.add(e.id);
        again = true;
      }
    }
    if (again) continue;
    const state = build(counted, env);
    const clashes: Clash[] = [...lost].map(([id, l]) => ({ lost: id, won: l.won, why: l.why }));
    for (const id of unfounded) clashes.push({ lost: id, won: null, why: 'unfounded' });
    clashes.push(...state.once);
    // Rules, permissions and audiences made at the same time: those narrowed (0078).
    const narrowed = (front: { id: string; same: boolean }[]) => {
      if (front.length < 2) return;
      const whole = front.filter((f) => f.same).map((f) => f.id).sort();
      for (const f of front) if (!f.same) clashes.push({ lost: f.id, won: whole[0] ?? null, why: 'narrower' });
    };
    for (const [path, front] of state.permFront) {
      const now = state.perms.get(path);
      narrowed(front.map((f) => ({ id: f.id, same: sameList(f.perm.write, now?.write) && sameList(f.perm.read, now?.read) })));
    }
    for (const [id, front] of state.spaceFront) narrowed(front.map((f) => ({ id: f.id, same: sameList(f.audience, state.spaces.get(id)?.audience) })));
    clashes.sort((a, b) => (a.lost < b.lost ? -1 : a.lost > b.lost ? 1 : 0));
    return { state, counted, clashes };
  }
}

function apply(order: PolicyEntry[], genesis: PolicyEntry, ctx: PolicyContext): Policy {
  // Operations that descend from the genesis; each one's past (all it descends from).
  const rooted = new Set([genesis.id]);
  const anc = new Map<string, Set<string>>([[genesis.id, new Set()]]);
  const ops: PolicyEntry[] = [];
  for (const e of order) {
    if (e.op.t === 'genesis' || !e.parents.some((p) => rooted.has(p))) continue;
    rooted.add(e.id);
    const past = new Set<string>();
    for (const p of e.parents) {
      past.add(p);
      for (const x of anc.get(p) ?? []) past.add(x);
    }
    anc.set(e.id, past);
    ops.push(e);
  }
  const env: Env = { genesis, order: [genesis, ...ops], anc, by: new Map(), before: new Map(), removal: new Map(), ctx, grants: new Map() };
  // Each operation, judged by the policy its own past makes (the same wherever it is judged); operations with the same past, by one fold.
  const ok: PolicyEntry[] = [];
  const folds = new Map<string, State>();
  for (const e of ops) {
    // A key that is no one's: its word counts for nothing, but a server's own join (0099), made by the key itself.
    const who = ctx.personOf(e.signer) ?? (e.op.t === 'join' && e.op.role === 'server' ? e.signer : null);
    if (!who) continue;
    // A key its person revoked: only what its revoker had seen of what it signed (0072).
    const cut = ctx.cutKey?.(e.signer);
    if (cut && !cut.some((h) => h === e.id || anc.get(h)?.has(e.id))) continue;
    const past = anc.get(e.id)!;
    const mine = ok.filter((x) => past.has(x.id));
    const key = mine.map((x) => x.id).join();
    let before = folds.get(key);
    if (!before) folds.set(key, (before = fold(mine, env).state));
    if (!allowed(e, who, before, env)) continue;
    env.by.set(e.id, who);
    env.before.set(e.id, before);
    const op = e.op;
    if (op.t === 'revoke') env.removal.set(e.id, { person: op.who, group: op.group, kind: 'out' });
    else if (op.t === 'grant' && op.role === 'member' && before.groups.get(op.group)?.get(op.who) === 'admin') env.removal.set(e.id, { person: op.who, group: op.group, kind: 'demote' });
    ok.push(e);
  }
  const { state, counted, clashes } = fold(ok, env);
  const parents = new Set(order.flatMap((e) => e.parents));
  const heads = order.filter((e) => rooted.has(e.id) && !parents.has(e.id)).map((e) => e.id).sort();
  // Who is out of the workspace, and the content they had seen when taken out (their cutoff: gate.ts).
  const cutoffs = new Map<string, string[]>();
  const appliedSet = new Set(state.applied);
  for (const e of ok) {
    const op = e.op;
    if (op.t !== 'revoke' || op.group !== WORKSPACE || state.groups.get(WORKSPACE)!.has(op.who) || !appliedSet.has(e.id)) continue;
    cutoffs.set(op.who, [...new Set([...(cutoffs.get(op.who) ?? []), ...(op.cutoff ?? [])])].sort());
  }
  return new Policy({
    groups: state.groups, geneses: [genesis.id], applied: state.applied, heads, usedLinks: new Set(state.usedLinks.keys()), perms: state.perms, clashes, cutoffs,
    spaces: state.spaces, owner: state.owner, dropped: state.dropped, judged: ok.map((e) => e.id), counted: new Set([genesis.id, ...counted]),
    unlinked: new Set([...state.unlinked].map((u) => u.split(' ')[0]!)), workspace: ctx.workspace, servers: state.servers,
  });
}
