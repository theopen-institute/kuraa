// A workspace's policy: who is in it, in which groups, as admins or members
// (docs/decisions/0066-permissions-without-a-centre.md).
//
// The policy is a history of signed operations, each naming the operations its
// maker had seen (its parents), so they form a graph that every device holds
// alike. Each is signed by the signing key of a person (the identity that
// vouched for that key is who made it), and checked against the policy as the
// operations before it left it. Every device puts the same operations in the
// same order (parents first, then by hash) and so reaches the same policy, from
// whatever order they arrived in.
//
// - genesis: the first, naming the workspace's first admins. A workspace made
//   since is pinned to its genesis (`kuraa.genesis`, and every invite link
//   carries it): no other counts. One from before has none pinned: each of its
//   devices writes down, as a legacy genesis, everyone it knows of, and all of
//   them count together (everyone an admin, as every member had the same say:
//   0038), until an admin seals the list: then only the geneses the seal names.
//   Only legacy geneses a device holds as its workspace's own count (`legacy`:
//   those it had or made, and those signed by someone they make an admin), never
//   one a stranger brings; and a device keeps to the seal it first saw count
//   (`seal`), so no seal made later, by anyone, takes the workspace over.
// - grant, revoke: a person put in a group (as admin or member) or taken out.
//   An admin of the group, or of the workspace, may. Taking someone out of the
//   workspace takes them out of every group. The workspace keeps one admin at
//   least; anyone may leave a group.
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
//   A workspace made since 0066 has its genesis's admin as its owner; one from
//   before, the admin whose seal sealed its legacy geneses (the first to make an
//   admin's change). Until it has one, its admins are equal, as they were.
//
// - verifier: a server whose attestations count here (attest.ts, step 6): its
//   key and where it is; an admin's to add, or take away (with no address).
//
// - witness (0072): a person (a server's identity, usually) whose devices'
//   acknowledgements confirm removals, in the app's words; an admin's to name or
//   unname. It decides nothing: removals count without it.
//
// - drop (0072): a person's signing key (one computer of theirs) no longer counts
//   here, with the commits the dropper had (`cutoff`): its devices stop syncing,
//   and what it signs from then on counts for nothing. Its own person's to make,
//   or an admin's (the owner's, for an admin's computer). For good.
//
// Anywhere a person can be named (a group, a rule, an audience), `email:<address>`
// names whoever holds an attestation of that address by a verifier counted here.
//
// Groups: `workspace` (everyone in it), and any an admin of the workspace makes
// by putting someone in it. A group may hold people (identity IDs) and, as
// members, other groups (`group:<name>`).
import { createHash } from 'node:crypto';
import crypto from 'hypercore-crypto';
import type { KeyPair } from '../keys.js';

export type Role = 'admin' | 'member';

export type PolicyOp =
  | { t: 'genesis'; admins: string[]; legacy: boolean }
  | { t: 'grant'; group: string; who: string; role: Role }
  | { t: 'revoke'; group: string; who: string; cutoff?: string[] }
  | { t: 'join'; group: string; role: Role; link: string; once: boolean; granter: string; grant: string; /** The link's expiry and maker (0071: signed in the grant, linkGrantMessage); none in a join from before. */ expires?: number; issuer?: string }
  | { t: 'seal'; geneses: string[] }
  | { t: 'rule'; path: string; by: string[] }
  | { t: 'space'; id: string; audience: string[] }
  | { t: 'verifier'; key: string; url: string }
  | { t: 'perm'; path: string; write?: string[]; read?: string[]; space?: string }
  | { t: 'owner'; who: string }
  | { t: 'drop'; key: string; cutoff?: string[] }
  | { t: 'witness'; who: string; on: boolean }
  | { t: 'unlink'; link: string; group: string }
  | { t: 'admit'; link: string; key: string };

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
export const grantMessage = (workspace: string, genesis: string | null, link: string, group: string, role: Role, once: boolean) =>
  Buffer.from(['kuraa-grant', workspace, genesis ?? '', link, group, role, once ? 'once' : 'anyone'].join('\0'));

/**
 * What an admin's signing key signs to let an invite link's holder into a group
 * (0071): with when the link stops letting people in and the device that made
 * it, so no member can sign the same grant into a link that never expires.
 */
export const linkGrantMessage = (workspace: string, genesis: string | null, link: string, group: string, role: Role, once: boolean, expires: number, issuer: string) =>
  Buffer.from(['kuraa-grant/2', workspace, genesis ?? '', link, group, role, once ? 'once' : 'anyone', String(expires), issuer].join('\0'));

/**
 * What an admin's signing key signs, since links are let in by (`admit`), to let
 * an invite link's holder into a group: as linkGrantMessage, and saying that a
 * join by it counts only for whom a device in the workspace let in by the link.
 * Whether the link had expired is that device's to say, as it lets them in.
 */
export const admittedGrantMessage = (workspace: string, genesis: string | null, link: string, group: string, role: Role, once: boolean, expires: number, issuer: string) =>
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

const emailEntry = 'email:[^\\s@,]{1,64}@[^\\s@,]{1,190}\\.[^\\s@,.A-Z]{2,63}';
const whoTest = new RegExp(`^(?:[0-9a-f]{64}|group:[a-z0-9][a-z0-9-]{0,39}|${emailEntry})$`);
const writerTest = new RegExp(`^(?:[0-9a-f]{64}|group:[a-z0-9][a-z0-9-]{0,39}|admins|${emailEntry})$`);

/** Whether a string names someone in a group, rule or audience: an identity, a group, the admins, or an email (step 6). */
export const isWriter = (w: string) => writerTest.test(w);

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
      return typeof o.group === 'string' && groupName.test(o.group) && role(o.role) && typeof o.link === 'string' && /^[0-9a-f]{16}$/.test(o.link)
        && typeof o.once === 'boolean' && typeof o.granter === 'string' && hexKey.test(o.granter) && typeof o.grant === 'string' && hexSig.test(o.grant)
        && (o.issuer === undefined || (typeof o.issuer === 'string' && hexKey.test(o.issuer) && typeof o.expires === 'number' && Number.isSafeInteger(o.expires) && o.expires >= 0))
        ? { t: 'join', group: o.group, role: o.role, link: o.link, once: o.once, granter: o.granter, grant: o.grant, ...(typeof o.issuer === 'string' ? { expires: o.expires as number, issuer: o.issuer } : {}) } : null;
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

export interface PolicyContext {
  workspace: string;
  /** The genesis this workspace is pinned to; null: one from before, whose legacy geneses count. */
  pin: string | null;
  /**
   * One from before: the legacy geneses this device holds as its workspace's
   * own (those it held when it first worked the policy out so, made, or was
   * welcomed with). With them count those signed by someone they (or those so
   * counted) name, and no other. Undefined: every legacy genesis.
   */
  legacy?: string[];
  /** One from before, sealed: the seal this device keeps to (the first it saw count); no other counts. */
  seal?: string | null;
  /** The person (identity ID) a signing key is, as the records show; null if no one's. */
  personOf(signingKey: string): string | null;
  /** The emails attested of a person by verifiers this workspace counts (step 6). */
  claimsOf?: (id: string) => string[];
  /** Every email attested of anyone by those verifiers (who has been invited by email and is in: step 6). */
  claimed?: Set<string>;
  /**
   * A signing key its person revoked (0072): the policy operations its revoker
   * had seen, of which those it signed still count, and nothing else it signs;
   * null where no revocation said (one from before: all it signed counts);
   * undefined, not revoked.
   */
  cutKey?: (signingKey: string) => string[] | null | undefined;
}

export class Policy {
  constructor(
    /** Each group's people and groups, by role. */
    readonly groups: Map<string, Map<string, Role>>,
    /** The geneses that count. */
    readonly geneses: string[],
    /** The operations that counted, in the order they were applied. */
    readonly applied: string[],
    /** The operations no other names as a parent: what a new one names. */
    readonly heads: string[],
    /** Links for one person that let someone in. */
    readonly usedLinks: Set<string>,
    /** A workspace from before: an admin sealed its legacy geneses. */
    readonly sealed = false,
    /** Files' and folders' permissions (0069): path (or its hash) → who may change it, and who reads what is made in it. */
    readonly perms = new Map<string, Perm>(),
    /** Removals of admins made at the same time that would have left none, so none stood (step 4): who, and the operations. */
    readonly disputes: { people: string[]; ops: string[] }[] = [],
    /** People out of the workspace, and the commits they had made that still count (their removals' cutoffs, gate.ts). */
    readonly cutoffs = new Map<string, string[]>(),
    /** Spaces (step 5): ID → who may read it, and who made it. */
    readonly spaces = new Map<string, { audience: string[]; by: string }>(),
    /** Verifiers whose attestations count here (step 6): key → where it is. */
    readonly verifiers = new Map<string, string>(),
    /** The emails attested of a person (by verifiers counted here). */
    readonly claimsOf: (id: string) => string[] = () => [],
    /** Every email attested of anyone (by verifiers counted here). */
    readonly claimed = new Set<string>(),
    /** The workspace's owner (0070); null: one from before that has none yet, its admins equal. */
    readonly owner: string | null = null,
    /** Signing keys dropped here (0072): key → the commits they signed that still count (their cutoff, gate.ts). */
    readonly dropped = new Map<string, string[]>(),
    /** People whose devices' acknowledgements confirm removals (0072). */
    readonly witnesses = new Set<string>(),
  ) {}

  /** Whether a person is the workspace's owner. */
  isOwner(id: string | null): boolean {
    return !!id && id === this.owner;
  }

  /** Whether a person may make or unmake admins (0070): the owner; where there is none yet, any admin, as before. */
  mayAssignAdmins(id: string | null): boolean {
    return this.owner ? this.isOwner(id) : this.isAdmin(id);
  }

  /** Whether an entry naming someone (`email:` included) names this person. */
  private names(entry: string, id: string): boolean {
    return entry === id || (entry.startsWith('email:') && this.claimsOf(id).includes(entry.slice(6)));
  }

  /** Whether an audience entry (a person, `group:<name>`, `admins`) holds a person. */
  private holds(entry: string, id: string): boolean {
    return this.names(entry, id) || (entry === 'admins' && this.isAdmin(id)) || (entry.startsWith('group:') && this.role(id, entry.slice(6)) !== null);
  }

  /**
   * Whether a person may read a space (null: the workspace's own files, which
   * everyone in it reads; anyone, where there is no policy). A space unknown
   * here (its operation not yet come) is read by no one.
   */
  mayRead(id: string | null, space: string | null): boolean {
    if (!this.founded) return space === null;
    if (!id || !this.role(id)) return false;
    if (space === null) return true;
    const s = this.spaces.get(space);
    return !!s && s.audience.some((e) => this.holds(e, id));
  }

  /** Everyone in the workspace who may read a space now: for whether one audience holds another (what code may read). */
  readers(space: string | null): Set<string> {
    return new Set([...(this.groups.get(WORKSPACE)?.keys() ?? [])].filter((id) => /^[0-9a-f]{64}$/.test(id) && this.mayRead(id, space)));
  }

  /** The workspace it is of: what private paths are hashed with (set as it is made). */
  workspace = '';

  /** A workspace from before: the seal that sealed it, which a device keeps to (set as it is made). */
  sealId: string | null = null;

  /** Invite links unlinked (set as it is made): they let no one in. */
  unlinked = new Set<string>();

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

  /** Whether a person (null: no one's, as an unsigned commit) may change a file: by its rule, or anyone if it has none. */
  mayWrite(id: string | null, path: string): boolean {
    const rule = this.ruleFor(path);
    if (!rule) return true;
    if (!id) return false;
    return rule.by.some((w) => this.names(w, id) || (w === 'admins' && this.isAdmin(id)) || (w.startsWith('group:') && this.role(id, w.slice(6)) !== null));
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
    const own = g.get(id) ?? [...g].find(([who]) => who.startsWith('email:') && this.names(who, id))?.[1];
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

  /** People named by email in a group whom no identity here is attested to be yet: invited, not (yet) in (step 6). */
  invited(group: string = WORKSPACE): { email: string; role: Role }[] {
    return [...(this.groups.get(group) ?? new Map<string, Role>())]
      .filter(([who]) => who.startsWith('email:') && !this.claimed.has(who.slice(6)))
      .map(([who, role]) => ({ email: who.slice(6), role }));
  }

  /** A short name for the policy as it is: the hash of its heads (what a commit made under it names, later). */
  get version(): string {
    return sha256(`kuraa-policy-version\0${this.heads.join(',')}`);
  }
}

/** The policy the operations make, in this workspace (see the top of this file). */
export function evaluate(entries: PolicyEntry[], ctx: PolicyContext): Policy {
  const byId = new Map<string, PolicyEntry>();
  for (const e of entries) if (!byId.has(e.id)) byId.set(e.id, e);
  const order = linearize(byId);
  if (ctx.pin) return apply(order, order.filter((e) => e.op.t === 'genesis' && e.id === ctx.pin && !e.op.legacy).map((e) => e.id), ctx).policy;
  const legacy = countedLegacy(order, ctx);
  // Kept to a seal (the first this device saw count): only the geneses it names, and no other seal.
  const kept = ctx.seal ? byId.get(ctx.seal) : undefined;
  if (kept?.op.t === 'seal') {
    const named = kept.op.geneses;
    return apply(order, legacy.filter((g) => named.includes(g)), ctx).policy;
  }
  // (Kept to a seal this device no longer holds: no other counts meanwhile.)
  const first = apply(order, legacy, ctx);
  // A workspace from before: once an admin sealed its legacy geneses, only those the seal names, and only that seal.
  if (first.seal) {
    const named = first.seal.geneses;
    return apply(order, legacy.filter((g) => named.includes(g)), { ...ctx, seal: first.seal.id }).policy;
  }
  return first.policy;
}

/**
 * The legacy geneses that count (a workspace from before), in the one order:
 * those this device holds as its own (`ctx.legacy`), and those signed by
 * someone they, or those so counted, name; every one, where it says none.
 */
function countedLegacy(order: PolicyEntry[], ctx: PolicyContext): string[] {
  const legacy = order.filter((e) => e.op.t === 'genesis' && e.op.legacy);
  if (!ctx.legacy) return legacy.map((e) => e.id);
  const own = new Set(ctx.legacy);
  const counted = new Set<string>();
  const admins = new Set<string>();
  for (let grew = true; grew;) {
    grew = false;
    for (const e of legacy) {
      if (counted.has(e.id) || e.op.t !== 'genesis') continue;
      const signer = ctx.personOf(e.signer);
      if (!own.has(e.id) && !(signer && admins.has(signer))) continue;
      counted.add(e.id);
      for (const a of e.op.admins) admins.add(a);
      grew = true;
    }
  }
  return legacy.filter((e) => counted.has(e.id)).map((e) => e.id);
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
  verifiers: Map<string, string>;
  owner: string | null;
  usedLinks: Set<string>;
  seal: { id: string; geneses: string[] } | null;
  applied: string[];
  /** When each person took the place they have in the workspace: the position, in the one order, of the operation that gave it them (0072: seniority). */
  since: Map<string, number>;
  /** When the owner became the owner. */
  ownerSince: number;
  /** Signing keys dropped (0072), and their cutoffs. */
  dropped: Map<string, string[]>;
  /** Witnesses (0072). */
  witnesses: Set<string>;
  /** Invite links unlinked, as `<link> <group>`. */
  unlinked: Set<string>;
  /** Whom a device in the workspace let in by a link, as `<link> <signing key>`. */
  admitted: Set<string>;
}

/** An operation that takes someone out of a group, or makes them no longer its admin: what its cutoff is about (step 4). */
interface Removal {
  /** Who. */
  person: string;
  group: string;
  kind: 'out' | 'demote';
  /** They were an admin of the group before it. */
  wasAdmin: boolean;
}

const view = (s: State, claims?: (id: string) => string[]) => new Policy(s.groups, [], s.applied, [], s.usedLinks, !!s.seal, s.perms, [], new Map(), s.spaces, s.verifiers, claims, undefined, s.owner);

function freshState(order: PolicyEntry[], counted: Set<string>): State {
  const groups = new Map<string, Map<string, Role>>([[WORKSPACE, new Map()]]);
  const since = new Map<string, number>();
  for (const e of order) if (counted.has(e.id) && e.op.t === 'genesis') for (const id of e.op.admins) {
    groups.get(WORKSPACE)!.set(id, 'admin');
    since.set(id, 0);
  }
  // A workspace's own genesis names its first admin, its owner (0070); legacy geneses name none.
  const own = order.find((e) => counted.has(e.id) && e.op.t === 'genesis' && !e.op.legacy);
  const owner = own && own.op.t === 'genesis' ? own.op.admins[0] ?? null : null;
  return { groups, perms: new Map(), spaces: new Map(), verifiers: new Map(), owner, usedLinks: new Set(), seal: null, applied: order.filter((e) => counted.has(e.id)).map((e) => e.id), since, ownerSince: 0, dropped: new Map(), witnesses: new Set(), unlinked: new Set(), admitted: new Set() };
}

const adminCount = (s: State) => [...s.groups.get(WORKSPACE)!].filter(([, r]) => r === 'admin').length;

/**
 * A person's rank in a policy (0072), as a key to sort by, the highest first:
 * the owner; then the workspace's admins, the longest an admin first; then its
 * members, the longest in first; then everyone else. Ties (people given their
 * place by one operation) by ID.
 */
function rankKey(s: State, id: string): [number, number, string] {
  if (id === s.owner) return [0, s.ownerSince, id];
  const role = s.groups.get(WORKSPACE)!.get(id);
  if (role) return [role === 'admin' ? 1 : 2, s.since.get(id) ?? Number.MAX_SAFE_INTEGER, id];
  return [3, 0, id];
}

const compareKeys = (a: [number, number, string], b: [number, number, string]) =>
  a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0);

/** Whether `by` may make operation `e`, with the policy as `s` (its past) has it. */
function allowed(e: PolicyEntry, by: string, s: State, ctx: PolicyContext): boolean {
  const now = view(s, ctx.claimsOf);
  const ws = s.groups.get(WORKSPACE)!;
  const op = e.op;
  // Signed by a key dropped in its past: no one's word (0072).
  if (s.dropped.has(e.signer)) return false;
  switch (op.t) {
    case 'grant': {
      const nested = op.who.startsWith('group:');
      const byEmail = op.who.startsWith('email:');
      if (nested && (op.group === WORKSPACE || op.role !== 'member' || op.who.slice(6) === op.group)) return false;
      // A new group is the workspace's admins' to make.
      const may = s.groups.has(op.group) ? now.isAdmin(by, op.group) : now.isAdmin(by);
      const demotesLast = op.group === WORKSPACE && ws.get(op.who) === 'admin' && op.role !== 'admin' && adminCount(s) === 1;
      // Admins are the owner's to make and unmake; the owner is not made a member (0070).
      if (op.group === WORKSPACE && (op.role === 'admin' || ws.get(op.who) === 'admin') && !now.mayAssignAdmins(by)) return false;
      if (op.group === WORKSPACE && op.who === s.owner && op.role !== 'admin') return false;
      // Into another group, only someone in the workspace (or named by email: they come in by being attested).
      return may && !demotesLast && (op.group === WORKSPACE || nested || byEmail || ws.has(op.who));
    }
    case 'revoke': {
      const may = now.isAdmin(by, op.group) || op.who === by;
      const lastAdmin = op.group === WORKSPACE && ws.get(op.who) === 'admin' && adminCount(s) === 1;
      // The owner does not leave, nor is taken out (they give the role first); an admin is taken out by the owner, or leaves (0070).
      if (op.group === WORKSPACE && op.who === s.owner) return false;
      if (op.group === WORKSPACE && ws.get(op.who) === 'admin' && op.who !== by && !now.mayAssignAdmins(by)) return false;
      return may && !lastAdmin && !!s.groups.get(op.group)?.has(op.who);
    }
    case 'join': {
      // Not by a link unlinked in its past.
      if (s.unlinked.has(`${op.link} ${op.group}`)) return false;
      const signed = (m: Buffer) => crypto.verify(m, Buffer.from(op.grant, 'hex'), Buffer.from(op.granter, 'hex'));
      // A grant since links are let in by: only for whom a device in the workspace let in by it, in its past.
      const admitted = op.issuer !== undefined && signed(admittedGrantMessage(ctx.workspace, ctx.pin, op.link, op.group, op.role, op.once, op.expires ?? 0, op.issuer));
      if (admitted && !s.admitted.has(`${op.link} ${e.signer}`)) return false;
      const grantOk = admitted || signed(op.issuer !== undefined
        ? linkGrantMessage(ctx.workspace, ctx.pin, op.link, op.group, op.role, op.once, op.expires ?? 0, op.issuer)
        : grantMessage(ctx.workspace, ctx.pin, op.link, op.group, op.role, op.once));
      const granter = grantOk ? ctx.personOf(op.granter) : null;
      // A link that makes admins of the workspace, only the owner's (0070).
      if (op.group === WORKSPACE && op.role === 'admin' && !now.mayAssignAdmins(granter)) return false;
      return !!granter && s.groups.has(op.group) && now.isAdmin(granter, op.group) && !(op.once && s.usedLinks.has(op.link));
    }
    case 'owner':
      // The owner gives the role to someone in the workspace.
      return !!s.owner && by === s.owner && op.who !== by && ws.has(op.who);
    case 'drop': {
      // One's own computer; or an admin, a member's (the owner, anyone's: 0070).
      if (s.dropped.has(op.key) || !now.role(by)) return false;
      const whose = ctx.personOf(op.key);
      if (whose === by) return true;
      const ofAdmin = !!whose && (ws.get(whose) === 'admin' || whose === s.owner);
      return now.isAdmin(by) && (!ofAdmin || now.mayAssignAdmins(by));
    }
    case 'seal':
      // Where a device keeps to a seal, no other counts.
      return !s.seal && now.isAdmin(by) && (!ctx.seal || e.id === ctx.seal);
    case 'unlink':
      return now.isAdmin(by, op.group);
    case 'admit':
      // Anyone in the workspace lets someone in by a link, as a device of theirs checks it.
      return !!now.role(by);
    case 'rule':
    case 'verifier':
    case 'perm':
    case 'witness':
      return now.isAdmin(by);
    case 'space': {
      // Made by anyone in the workspace who is in it themselves; changed by whoever made it, or an admin.
      const had = s.spaces.get(op.id);
      if (!now.role(by)) return false;
      const holdsMaker = op.audience.some((e) => e === by || (e === 'admins' && now.isAdmin(by)) || (e.startsWith('group:') && now.role(by, e.slice(6)) !== null));
      return had ? had.by === by || now.isAdmin(by) : holdsMaker;
    }
    case 'genesis':
      return false;
  }
}

/** Apply an operation allowed in its past to a policy, at its place in the one order; whether it changed anything it could. */
function effect(e: PolicyEntry, by: string, s: State, at: number): boolean {
  const op = e.op;
  const group = (name: string) => {
    let g = s.groups.get(name);
    if (!g) s.groups.set(name, (g = new Map()));
    return g;
  };
  const ws = group(WORKSPACE);
  // A person's place in the workspace, and since when (seniority: 0072).
  const place = (who: string, role: Role) => {
    if (ws.get(who) !== role) s.since.set(who, at);
    ws.set(who, role);
  };
  switch (op.t) {
    case 'grant':
      // Into another group, only someone (still) in the workspace, or named by email.
      if (op.group !== WORKSPACE && !op.who.startsWith('group:') && !op.who.startsWith('email:') && !ws.has(op.who)) return false;
      if (op.group === WORKSPACE) place(op.who, op.role);
      else group(op.group).set(op.who, op.role);
      return true;
    case 'revoke':
      if (!s.groups.get(op.group)?.has(op.who)) return false;
      s.groups.get(op.group)!.delete(op.who);
      // Out of the workspace: out of every group.
      if (op.group === WORKSPACE) {
        for (const g of s.groups.values()) g.delete(op.who);
        s.since.delete(op.who);
      }
      return true;
    case 'join':
      // A link for one person puts one in: the first, in the order every device puts them in.
      if (op.once && s.usedLinks.has(op.link)) return false;
      if (op.once) s.usedLinks.add(op.link);
      if (op.group !== WORKSPACE && !ws.has(by)) place(by, 'member');
      // Never less than they are already.
      if (group(op.group).get(by) !== 'admin') {
        if (op.group === WORKSPACE) place(by, op.role);
        else group(op.group).set(by, op.role);
      }
      return true;
    case 'seal':
      if (s.seal) return false;
      s.seal = { id: e.id, geneses: op.geneses };
      // A workspace from before: whoever sealed it is its owner (0070).
      if (!s.owner) {
        s.owner = by;
        s.ownerSince = at;
      }
      return true;
    case 'owner':
      s.owner = op.who;
      s.ownerSince = at;
      place(op.who, 'admin');
      return true;
    case 'rule': {
      // As a perm's write, keeping what it says of reading.
      const had = s.perms.get(op.path) ?? {};
      const next: Perm = { ...(op.by.length ? { write: op.by } : {}), ...(had.read ? { read: had.read } : {}) };
      if (next.write || next.read) s.perms.set(op.path, next);
      else s.perms.delete(op.path);
      return true;
    }
    case 'perm':
      if (op.write || op.read) s.perms.set(op.path, { ...(op.write ? { write: op.write } : {}), ...(op.read ? { read: op.read } : {}), ...(op.space ? { space: op.space } : {}) });
      else s.perms.delete(op.path);
      return true;
    case 'space':
      s.spaces.set(op.id, { audience: op.audience, by: s.spaces.get(op.id)?.by ?? by });
      return true;
    case 'verifier':
      if (op.url) s.verifiers.set(op.key, op.url);
      else s.verifiers.delete(op.key);
      return true;
    case 'drop':
      s.dropped.set(op.key, op.cutoff ?? []);
      return true;
    case 'witness':
      if (op.on) s.witnesses.add(op.who);
      else s.witnesses.delete(op.who);
      return true;
    case 'unlink':
      s.unlinked.add(`${op.link} ${op.group}`);
      return true;
    case 'admit':
      s.admitted.add(`${op.link} ${op.key}`);
      return true;
    case 'genesis':
      return false;
  }
}

/** The group an operation acts in, for a cutoff: what it changes there. */
const groupOf = (e: PolicyEntry): string | null => {
  const op = e.op;
  return op.t === 'grant' || op.t === 'join' || op.t === 'revoke' ? op.group : null;
};

/**
 * What an operation says of someone's place in a group (0072): taken out,
 * a member, an admin, or in (as they are, or more: a join). Two made at the
 * same time that say different things of the same place are in conflict.
 */
type Place = 'out' | 'member' | 'admin' | 'in';
interface Claim { group: string; who: string; place: Place; leaving: boolean }

function claimsOf(e: PolicyEntry, by: string): Claim[] {
  const op = e.op;
  switch (op.t) {
    case 'grant': return [{ group: op.group, who: op.who, place: op.role, leaving: false }];
    case 'revoke': return [{ group: op.group, who: op.who, place: 'out', leaving: op.who === by }];
    case 'owner': return [{ group: WORKSPACE, who: op.who, place: 'admin', leaving: false }];
    case 'join': return op.group === WORKSPACE
      ? [{ group: WORKSPACE, who: by, place: op.role, leaving: false }]
      : [{ group: op.group, who: by, place: op.role, leaving: false }, { group: WORKSPACE, who: by, place: 'in', leaving: false }];
    default: return [];
  }
}

const differ = (a: Place, b: Place) => a !== b && !((a === 'in' && b !== 'out') || (b === 'in' && a !== 'out'));
/** Less first: of two by the same person at once, the one that gives less stands. */
const PLACE_ORDER: Record<Place, number> = { out: 0, member: 1, in: 2, admin: 3 };

/** What judging operations together needs: their order, their pasts, who made each, and the policy each was made under. */
interface Env {
  counted: Set<string>;
  order: PolicyEntry[];
  at: Map<string, number>;
  anc: Map<string, Set<string>>;
  by: Map<string, string>;
  meta: Map<string, Removal>;
  /** The policy as each operation's past made it (what it was judged by). */
  before: Map<string, State>;
  ctx: PolicyContext;
}

interface Folded { state: State; disputes: { people: string[]; ops: string[] }[] }

/**
 * Apply operations, each allowed in its own past, together (0072). Two made at
 * the same time (neither in the other's past) may not both be able to count:
 * - one takes the other's maker out of a group, or out of being its admin,
 *   and the other acts in that group (in the workspace: anything); their
 *   leaving it themselves excepted;
 * - they say different things of one person's place in one group (taken
 *   out, a member, an admin).
 * Then the one ranked first counts, and the other does not: leaving oneself
 * first; then by its maker's rank (rankKey: the owner, then admins by how
 * long they have been, then members), as the policy it was made under had it;
 * then the one that gives less; then by hash. Taken in that order, each counts
 * if none counting before it rules it out. Whatever else someone taken out did
 * at the same time counts for nothing (their cutoff).
 *
 * What counts must be allowed by what counts of its past: an operation whose
 * maker's say came from one that does not count does not count either, and
 * the rest are settled again without it.
 *
 * The workspace keeps an admin: where it has no owner and what counts would
 * leave it with none, the highest-ranked of the admins taken out at the same
 * time as another stays (on record in `disputes`).
 */
function fold(ops: PolicyEntry[], env: Env): Folded {
  const concurrent = (a: string, b: string) => a !== b && !env.anc.get(a)!.has(b) && !env.anc.get(b)!.has(a);
  const keyOf = (e: PolicyEntry) => rankKey(env.before.get(e.id)!, env.by.get(e.id)!);
  const leaving = (e: PolicyEntry) => e.op.t === 'revoke' && e.op.who === env.by.get(e.id);
  /** Whether removal `r` cuts off `e`: by the person it takes out (a drop: signed by the key it drops), at the same time, where it applies. */
  const cuts = (r: PolicyEntry, e: PolicyEntry) => {
    if (r.op.t === 'drop') return r !== e && e.signer === r.op.key && concurrent(r.id, e.id);
    const m = env.meta.get(r.id);
    if (!m || env.by.get(e.id) !== m.person || !concurrent(r.id, e.id) || leaving(e)) return false;
    return m.group === WORKSPACE || groupOf(e) === m.group;
  };
  const disputes: Folded['disputes'] = [];
  const excluded = new Set<string>();
  for (;;) {
    const voided = new Set(excluded);
    // The operations that may rule others out: removals, and those that say where someone is.
    const deciding = ops.filter((e) => !excluded.has(e.id) && (env.meta.has(e.id) || e.op.t === 'drop' || claimsOf(e, env.by.get(e.id)!).length))
      .map((e) => ({ e, claims: claimsOf(e, env.by.get(e.id)!), key: keyOf(e), least: Math.min(4, ...claimsOf(e, env.by.get(e.id)!).map((c) => PLACE_ORDER[c.place])) }))
      .sort((a, b) => Number(leaving(b.e)) - Number(leaving(a.e)) || compareKeys(a.key, b.key) || a.least - b.least || (a.e.id < b.e.id ? -1 : a.e.id > b.e.id ? 1 : 0));
    const counting: typeof deciding = [];
    for (const x of deciding) {
      const out = counting.some((s) => cuts(s.e, x.e) || cuts(x.e, s.e)
        || s.claims.some((c) => x.claims.some((d) => c.group === d.group && c.who === d.who && differ(c.place, d.place) && concurrent(s.e.id, x.e.id))));
      if (out) voided.add(x.e.id);
      else counting.push(x);
    }
    // Cutoffs: whatever else those taken out did at the same time.
    const removals = counting.filter((x) => env.meta.has(x.e.id) || x.e.op.t === 'drop').map((x) => x.e);
    for (const e of ops) if (!voided.has(e.id) && removals.some((r) => cuts(r, e))) voided.add(e.id);
    // A link unlinked: no join by it made at the same time counts (one after is not allowed at all).
    const unlinks = ops.filter((u) => u.op.t === 'unlink' && !voided.has(u.id));
    for (const e of ops) {
      const op = e.op;
      if (op.t === 'join' && !voided.has(e.id) && unlinks.some((u) => u.op.t === 'unlink' && u.op.link === op.link && u.op.group === op.group && concurrent(u.id, e.id))) voided.add(e.id);
    }
    // Seals made at the same time (a workspace from before): one counts, the one naming the most of the
    // geneses that count (taking the fewest out), then by its maker's rank, then by hash.
    const named = (e: PolicyEntry) => (e.op.t === 'seal' ? e.op.geneses.filter((g) => env.counted.has(g)).length : 0);
    const seals = ops.filter((e) => e.op.t === 'seal' && !voided.has(e.id))
      .sort((a, b) => named(b) - named(a) || compareKeys(keyOf(a), keyOf(b)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const e of seals.slice(1)) voided.add(e.id);
    // What counts must be allowed by what counts of its past: an operation whose maker had their say from
    // one that does not count (a grant cut off, a handover that lost) does not count either; and so on.
    const kept = ops.filter((e) => !voided.has(e.id));
    let unfounded = false;
    for (const e of kept) {
      const past = env.anc.get(e.id)!;
      const then = freshState(env.order, env.counted);
      for (const x of kept) if (past.has(x.id)) effect(x, env.by.get(x.id)!, then, env.at.get(x.id)!);
      if (!allowed(e, env.by.get(e.id)!, then, env.ctx)) {
        excluded.add(e.id);
        unfounded = true;
      }
    }
    if (unfounded) continue;
    const state = freshState(env.order, env.counted);
    for (const e of ops) {
      if (voided.has(e.id)) continue;
      if (effect(e, env.by.get(e.id)!, state, env.at.get(e.id)!)) state.applied.push(e.id);
    }
    // No admin left, and no owner: the highest-ranked of the admins taken out at the same time as another stays.
    if (adminCount(state) === 0 && !state.owner) {
      const taken = ops.filter((r) => {
        const m = env.meta.get(r.id);
        return m && m.group === WORKSPACE && m.wasAdmin && !voided.has(r.id)
          && ops.some((o) => o !== r && env.meta.get(o.id)?.group === WORKSPACE && env.meta.get(o.id)!.wasAdmin && !voided.has(o.id) && concurrent(o.id, r.id));
      }).map((r) => ({ r, key: rankKey(env.before.get(r.id)!, env.meta.get(r.id)!.person) }))
        .sort((a, b) => compareKeys(a.key, b.key) || (a.r.id < b.r.id ? -1 : 1));
      const keep = taken[0];
      if (keep) {
        const person = env.meta.get(keep.r.id)!.person;
        // Every removal of that person at the same time: they stay.
        const theirs = taken.filter((t) => env.meta.get(t.r.id)!.person === person).map((t) => t.r.id);
        for (const id of theirs) excluded.add(id);
        disputes.push({ people: [person], ops: theirs.sort() });
        continue;
      }
    }
    return { state, disputes };
  }
}

function apply(order: PolicyEntry[], geneses: string[], ctx: PolicyContext): { policy: Policy; seal: { id: string; geneses: string[] } | null } {
  const counted = new Set(geneses);
  // Operations that descend from a genesis that counts; each one's past (all it descends from).
  const rooted = new Set(counted);
  const anc = new Map<string, Set<string>>();
  const ops: PolicyEntry[] = [];
  for (const e of order) {
    if (e.op.t === 'genesis') {
      anc.set(e.id, new Set());
      continue;
    }
    if (!e.parents.some((p) => rooted.has(p))) continue;
    rooted.add(e.id);
    const past = new Set<string>();
    for (const p of e.parents) {
      past.add(p);
      for (const x of anc.get(p) ?? []) past.add(x);
    }
    anc.set(e.id, past);
    ops.push(e);
  }
  const env: Env = { counted, order, at: new Map(order.map((e, i) => [e.id, i + 1])), anc, by: new Map(), meta: new Map(), before: new Map(), ctx };
  // Each operation, judged by the policy its own past makes (the same wherever it is judged); operations with the same past, by one fold.
  const ok: PolicyEntry[] = [];
  const folds = new Map<string, State>();
  for (const e of ops) {
    const who = ctx.personOf(e.signer);
    if (!who) continue;
    // A key its person revoked: only what its revoker had seen of what it signed (0072).
    const cut = ctx.cutKey?.(e.signer);
    if (cut && !cut.some((h) => h === e.id || anc.get(h)?.has(e.id))) continue;
    const past = anc.get(e.id)!;
    const mine = ok.filter((x) => past.has(x.id));
    const key = mine.map((x) => x.id).join();
    let before = folds.get(key);
    if (!before) folds.set(key, (before = fold(mine, env).state));
    if (!allowed(e, who, before, ctx)) continue;
    env.by.set(e.id, who);
    env.before.set(e.id, before);
    const op = e.op;
    if (op.t === 'revoke') env.meta.set(e.id, { person: op.who, group: op.group, kind: 'out', wasAdmin: before.groups.get(op.group)?.get(op.who) === 'admin' });
    else if (op.t === 'grant' && op.role === 'member' && before.groups.get(op.group)?.get(op.who) === 'admin') env.meta.set(e.id, { person: op.who, group: op.group, kind: 'demote', wasAdmin: true });
    ok.push(e);
  }
  const { state, disputes } = fold(ok, env);
  const parents = new Set(order.flatMap((e) => e.parents));
  const heads = order.filter((e) => rooted.has(e.id) && !parents.has(e.id)).map((e) => e.id).sort();
  // Who is out of the workspace, and the content they had seen when taken out (their cutoff: gate.ts).
  const cutoffs = new Map<string, string[]>();
  for (const e of ok) {
    const m = env.meta.get(e.id);
    if (!m || m.group !== WORKSPACE || m.kind !== 'out' || state.groups.get(WORKSPACE)!.has(m.person) || e.op.t !== 'revoke' || !state.applied.includes(e.id)) continue;
    cutoffs.set(m.person, [...new Set([...(cutoffs.get(m.person) ?? []), ...(e.op.cutoff ?? [])])].sort());
  }
  const policy = new Policy(state.groups, [...counted], state.applied, heads, state.usedLinks, !!state.seal, state.perms, disputes, cutoffs, state.spaces, state.verifiers, ctx.claimsOf, ctx.claimed, state.owner, state.dropped, state.witnesses);
  policy.workspace = ctx.workspace;
  policy.sealId = state.seal?.id ?? null;
  policy.unlinked = new Set([...state.unlinked].map((u) => u.split(' ')[0]!));
  return { policy, seal: state.seal };
}
