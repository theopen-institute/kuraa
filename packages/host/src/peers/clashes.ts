// Clashes in words (0078): two changes to the policy made at the same time that
// could not both count, of which the one giving less did. Each is said as it
// happened ("Ada added Bo while Chen took Bo out: Bo is out"), for Settings ›
// Workspace, with whether this person may make the one that lost again.
import { WORKSPACE, type ClashWhy, type Policy, type PolicyEntry, type PolicyOp } from './policy.js';

/** A clash as the app shows it. */
export interface ClashInfo {
  /** The change that did not count (or counted narrowed), and the one it lost to (null: none whole). */
  lost: string;
  won: string | null;
  why: ClashWhy;
  words: string;
  /** Whether this person may make the change that lost again, after both. */
  redo: boolean;
}

/** How many clashes are listed, the latest first. */
const SHOWN = 20;

/**
 * The policy's clashes in words, the latest first (by where the change that
 * lost is in the one order). `path`: a permission's path in the clear, where
 * this device knows it (null: a private one).
 */
export async function clashWords(policy: Policy, entries: Map<string, PolicyEntry>, personOf: (key: string) => Promise<string | null>, names: Map<string, string>, me: string | null, path: (key: string) => string | null): Promise<ClashInfo[]> {
  const at = new Map(policy.judged.map((id, i) => [id, i]));
  const list = [...policy.clashes].sort((a, b) => (at.get(b.lost) ?? 0) - (at.get(a.lost) ?? 0)).slice(0, SHOWN);
  const name = (id: string | null) => (!id ? 'someone' : id === me ? 'you' : names.get(id) ?? `${id.slice(0, 8)}…`);
  const out: ClashInfo[] = [];
  for (const c of list) {
    const lost = entries.get(c.lost);
    if (!lost) continue;
    const won = c.won ? entries.get(c.won) : undefined;
    const lostBy = await personOf(lost.signer);
    const wonBy = won ? await personOf(won.signer) : null;
    const said = (e: PolicyEntry, by: string | null) => `${cap(name(by))} ${doing(e.op, by, name, path)}`;
    const what = won ? `${said(lost, lostBy)} while ${said(won, wonBy).replace(/^You /, 'you ')}` : said(lost, lostBy);
    out.push({ lost: c.lost, won: c.won, why: c.why, words: `${what}: ${outcome(c.why, lost, won, lostBy, policy, name, path)}`, redo: mayRedo(policy, lost.op, lostBy, me) });
  }
  return out;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const inGroup = (g: string) => (g === WORKSPACE ? '' : ` of ${g}`);

/** What a change did, after its maker's name: "took Bo out of team". */
function doing(op: PolicyOp, by: string | null, name: (id: string | null) => string, path: (key: string) => string | null): string {
  const who = (w: string) => (w.startsWith('group:') ? `the group ${w.slice(6)}` : name(w));
  const at = (p: string) => (p === '' ? 'everything' : path(p) ?? 'a private file');
  switch (op.t) {
    case 'grant': return op.role === 'admin' ? `made ${who(op.who)} an admin${inGroup(op.group)}` : op.group === WORKSPACE ? `made ${who(op.who)} a member` : `put ${who(op.who)} in ${op.group}`;
    case 'revoke': return op.who === by ? `left${op.group === WORKSPACE ? ' the workspace' : ` ${op.group}`}` : `took ${who(op.who)} out${op.group === WORKSPACE ? '' : ` of ${op.group}`}`;
    case 'join': return `joined${op.group === WORKSPACE ? '' : ` ${op.group}`} by an invite link`;
    case 'owner': return `gave the owner’s role to ${who(op.who)}`;
    case 'rule': return `said who may change ${at(op.path)}`;
    case 'perm': return op.read && !op.write ? `said who reads ${at(op.path)}` : `said who may change ${at(op.path)}`;
    case 'space': return 'said who reads some files';
    case 'drop': return 'removed a computer';
    case 'unlink': return 'revoked an invite link';
    case 'admit': return 'let someone in by an invite link';
    default: return 'made a change';
  }
}

/** What came of it. */
function outcome(why: ClashWhy, lost: PolicyEntry, won: PolicyEntry | undefined, lostBy: string | null, policy: Policy, name: (id: string | null) => string, path: (key: string) => string | null): string {
  const of = lost.op;
  switch (why) {
    case 'less': {
      // Whose place the two disagreed on, and what it is now.
      const op = won?.op;
      const who = op && (op.t === 'grant' || op.t === 'revoke' || op.t === 'owner') ? op.who : lostBy;
      const group = op && (op.t === 'grant' || op.t === 'revoke') ? op.group : WORKSPACE;
      if (!who) return 'the one giving less counts';
      const role = policy.role(who, group);
      return `${cap(name(who))} ${who === lostBy && name(who) === 'you' ? 'are' : 'is'} ${role === 'admin' ? `an admin${inGroup(group)}` : role === 'member' ? `a member${inGroup(group)}` : group === WORKSPACE ? 'out' : `not in ${group}`}`;
    }
    case 'removed': return `what ${name(lostBy)} did then does not count`;
    case 'demoted': return `what ${name(lostBy)} did as an admin then does not count`;
    case 'dropped': return 'what that computer signed then does not count';
    case 'unlinked': return 'no one joins by a revoked link';
    case 'once': return 'a link for one person lets one in';
    case 'owner': return `${cap(name(policy.owner))} ${name(policy.owner) === 'you' ? 'are' : 'is'} the owner`;
    case 'narrower': {
      const key = of.t === 'perm' || of.t === 'rule' ? of.path : null;
      const now = key !== null ? policy.perms.get(key) : of.t === 'space' ? { read: policy.spaces.get(of.id)?.audience } : undefined;
      const list = (l: string[] | undefined) => (l ? l.map((w) => (w === 'admins' ? 'admins' : w.startsWith('group:') ? w.slice(6) : name(w))).join(', ') : 'anyone');
      const where = key !== null ? ` for ${key === '' ? 'everything' : path(key) ?? 'a private file'}` : '';
      return `the narrower counts${where}: ${of.t === 'space' || (of.t === 'perm' && of.read && !of.write) ? `read by ${list(now?.read)}` : `changed by ${list(now?.write)}`}`;
    }
    case 'unfounded': return `${name(lostBy)}’s say came from a change that did not count, so this did not either`;
  }
}

/** Whether a person may make a change again now (the host checks again as it does). */
function mayRedo(policy: Policy, op: PolicyOp, by: string | null, me: string | null): boolean {
  if (!me || !policy.founded) return false;
  const admin = policy.isAdmin(me);
  switch (op.t) {
    case 'owner': return policy.isOwner(me);
    case 'grant': return op.group === WORKSPACE && (op.role === 'admin' || policy.role(op.who) === 'admin') ? policy.mayAssignAdmins(me) : policy.isAdmin(me, op.group);
    case 'join': return op.group === WORKSPACE && op.role === 'admin' ? policy.mayAssignAdmins(me) : !!by && policy.isAdmin(me, op.group);
    case 'revoke': return op.who === me || (op.group === WORKSPACE && policy.role(op.who) === 'admin' ? policy.mayAssignAdmins(me) : policy.isAdmin(me, op.group));
    case 'unlink': return policy.isAdmin(me, op.group);
    case 'space': return admin || policy.spaces.get(op.id)?.by === me;
    case 'drop': case 'rule': case 'perm': return admin;
    default: return false;
  }
}
