# The policy: how every device works it out

A workspace's policy says who is in it, in which groups, with which role, and who may read and change
what ([0066](decisions/0066-permissions-without-a-centre.md)). Every device holds the policy's
operations and works the policy out from them alone. Devices that hold the same operations must
reach the same policy, whatever order the operations arrived in. This is the whole of how they do
it; `packages/host/src/peers/policy.ts` is the code, and `packages/host/test/policy-properties.test.ts`
checks what *What always holds* says, over histories made at random, honest and adversarial.

## Operations

Each operation is signed by a person's signing key, and names the operations its maker had seen
(its *parents*). Its ID is the hash of what it says, its parents and its signer, in this workspace.
The exceptions are a server's own join, a server's `admit` ([0099](decisions/0099-servers.md)), and
a server's `drop` of its own key ([0112](decisions/0112-server-hardening.md)), signed by the
server's own key, which no person vouched for (a key that signed a server's join is never a
person's, whatever vouches for it).

| Operation | Says | Who may make it, in the policy its past makes |
| --- | --- | --- |
| `genesis` | the workspace's first admin, its owner | no one: it is the root (below) |
| `grant` | someone is in a group, as admin or member | an admin of the group, or of the workspace (a new group: the workspace's admins). Making or unmaking a workspace admin, only the owner. Into a group other than the workspace, only someone in it. Never the owner made a member |
| `revoke` | someone is out of a group (`cutoff`: the commits the remover had); or a server out of the workspace | an admin of the group, or the person themselves (leaving). A workspace admin, only the owner (or themselves). Never the owner. A server, only the owner |
| `join` | its signer comes in by an invite link's grant | the person let in, with a grant signed by an admin of the group (making workspace admins: the owner's). A link for one person, once. Not by a link unlinked in its past. A grant signed since links are let in by (`kuraa-grant/3`): only with an `admit` of its signing key by that link in its past. A grant signed since links have keys of their own (`kuraa-grant/4`, [0121](decisions/0121-server-review.md)): with that too, and the link key's signature of the join's signing key. With role `server`: the server let in, by its own key (no one's), for the workspace, with the owner's grant for one, let in by (`admit`), reading everything (`reads: 'all'`); a key not a server already (one taken out may come back so, by a new link) |
| `admit` | a device let the holder of a signing key in by an invite link (it checked, by its own clock, that the link had not expired nor been revoked) | anyone in the workspace; or a server (0099), whose admit counts only for a link for one person (0112) |
| `unlink` | an invite link lets no one into its group any more | an admin of the group |
| `owner` | someone in the workspace is the owner now | the owner |
| `rule`, `perm` | who may change a path; who reads what is made in a folder | the workspace's admins |
| `space` | a space's audience | anyone in the workspace who is in that audience (to make it: with a `nonce`, only where the space's ID is the hash of the workspace, its maker and the nonce; once a space was made so, never again without one: 0121); whoever made it, or the owner (to change it; [0110](decisions/0110-the-owner-reads-everything.md)) |
| `drop` | a signing key (one computer, or a server) no longer counts here (`cutoff`: the commits the dropper had) | its own person; or an admin (the owner, for an admin's or the owner's computer; for a server's key, the owner alone, or the server itself: 0112). For good |
| `rules` | the version of these rules the workspace is judged by (13; none: 12) | the owner ([0121](decisions/0121-server-review.md)) |

Made before [0078](decisions/0078-restrictive-wins.md) and read only so a history that has them stays
whole (what came after names them as parents), counting for nothing: `seal`, `verifier`, `witness`
(retired after 0078: it decided nothing), a legacy genesis, and any operation naming someone by email (`email:`). Records that are not operations of
the policy and are no longer taken: attestations (`attest`) and trustee rotations (`trot`).

## Working it out

1. **Which count at all.** An operation counts only if its signature is good, its signing key is a
   person's (as the identities say; or it is a server's join, by the key itself), and it descends from the genesis the workspace is pinned to
   (every invite link carries the pin). A key its person revoked (or left behind recovering their
   identity) is still theirs for what it signed in the past of the policy its revokers had
   (`policyHeads` on the revocation), and no one's for anything else; a revocation from before,
   which says none, leaves all it signed counting. One whose parents are not all here waits, left
   out, as does everything after it.
2. **One order.** Operations are put in one order: parents first, then the lowest ID among those
   ready.
3. **Each judged by its own past.** Going through that order, each operation is judged against the
   policy its past makes (everything it descends from, worked out by these same steps). It counts if
   its maker was allowed to make it there (the table above), and its key was not dropped there. So
   whether an operation was allowed never depends on what was done at the same time, or on what a
   device happened to hold first. Under rules 13 (below), one more thing is judged over the whole
   history rather than the operation's past: whom anyone ever made an admin, or the owner. A
   `grant`, `revoke` or `drop` naming such a person (or their key) counts only from the owner, or
   from that person themselves.
4. **Restrictive wins.** Two operations made at the same time (neither in the other's past) may not
   both be able to count. Then one *beats* the other, and it is always the one that gives less:
   - **a removal beats what the one it removes did there at the same time**: taking someone out of
     a group, making an admin of it a member, or their leaving it, beats every operation of theirs
     acting in that group (for the workspace: any operation of theirs), but their leaving a group;
   - **a drop beats what its key signed** at the same time;
   - **out beats member beats admin**: of two that say different things of one person's place in
     one group, the one that gives less (a `grant` says its role; a `revoke`, out; an `owner`, admin
     of whom it names; a `join`, its role in its group and *in* the workspace, which differs only
     from out);
   - **an unlink beats a join by its link**;
   - **of two handovers of the owner's role, the lower ID** (only the owner makes them, so they
     settle the owner's own two computers: there is always one owner).

   Under rules 13, one beats the other only where its maker may override what it beats: where the
   one beaten is about someone ever an admin (or the owner), or makes a workspace admin or the
   owner, only the owner (as their operation's own past has them) or that person themselves. An
   operation's maker chooses its parents, and so what it was made at the same time as: else an admin
   could, with old parents, demote another admin, undo a handover or unlink a server's link after
   the fact.

   An operation nothing counting beats counts; one something counting beats does not. Removals that
   beat each other in a ring (two group admins taking each other out at once) all count: everyone
   in the ring is out. (Precisely: settle those beaten only by what does not count, or by nothing,
   until nothing changes; then the rings of what is left that nothing undecided outside them beats
   all count; and again.) No rank, no seniority: whoever made it, the one giving less counts.
5. **Narrower.** Rules, permissions and audiences made at the same time on one path (or one space)
   all count, narrowed together. The one counting for a path is what its latest permissions say
   (those not in the past of another for it), each part separately:
   - who may change it: the entries (people, `group:<name>`, `admins`) all of them name. Where one
     names only some of what the other names, that one: **the narrower**. Where they name none in
     common, `admins`, who could have made either. One with no rule names everyone (so one taken
     away at the same time as one made: the one made);
   - who reads a folder, likewise; its space is the one of the narrowest whose readers are the
     result, if any (lowest ID first), else none (its readers then are the list itself);
   - a space's audience: the entries all of them name; where they name none in common, no one but
     the owner (and servers) reads it, not the admins (0112: else anyone could "make" a space again at
     the same time, naming the admins). A space made by two at once has no maker: only the owner
     changes it. A space made with a nonce (0121) is made by its maker alone, so this is for spaces
     made before.
6. **Founded on what counts.** Each operation that counts must still be allowed by what counts of
   its past (applied in the one order). One whose maker had their say only through an operation
   that does not count (a grant beaten by a removal, a handover that lost) does not count either,
   and steps 4 to 6 are done again without it, until none is left so.
7. **A clash is shown.** Each operation allowed in its own past that did not count lost to one that
   did, and it is on record (`clashes`): the one that lost, the one it lost to (none, for one
   narrowed to what both name, or one whose say did not count), and why (`removed`, `demoted`,
   `dropped`, `less`, `unlinked`, `once`, `owner`, `narrower`, `unfounded`). So is a join by a link
   for one person that another used at the same time (`once`: the first in the one order counts),
   and each permission narrowed.

The result: groups and roles, the owner, the servers, permissions, spaces and their audiences, the links for one
person used, the operations allowed (`judged`), that counted (`counted`) and that changed something
(`applied`), the clashes, the heads (what a new operation names), and each person out of the
workspace with their cutoff (the commits of theirs that still count: the write gate refuses any
other).

There is no step for keeping an admin: the owner cannot be made a member, taken out or leave, so the
workspace always has one ([0070](decisions/0070-an-owner.md)).

## Versions of these rules

The rules above change now and then; each change applies to the whole history. Which the workspace
is judged by is its owner's to say, by a `rules` operation ([0121](decisions/0121-server-review.md));
where none counts, 12. The policy is worked out by 12; then, where the owner said a later version, the
whole history again by that one, as far as the device knows it. (Judging only what comes after the
`rules` operation by it would not do: an operation's maker could choose parents from before it.) A
device that does not know the version said shows that it is to be updated. The owner's device says
the latest it knows once it runs it.

What rules 13 adds: the override rules in steps 3 and 4; a `space` made with a nonce; links with
keys of their own preferred, every admin's device unlinking each link for anyone without one while it
could still let anyone in.

## What always holds

Checked over histories made at random, honest and with adversaries (strangers' keys, someone with an
identity never let in, people taken out going on, operations on an old view of the policy, parents no
one holds, grants and handovers made again by others, a rival genesis), on every device whatever each
holds, and on all of them together:

- **The same everywhere.** The same operations, in any order, any repeated, make the same policy,
  clashes and all.
- **One owner, an admin.** The workspace has exactly one owner, an admin; so always an admin. The
  owner reads every space ([0110](decisions/0110-the-owner-reads-everything.md)).
- **Groups inside the workspace.** No one outside the workspace is in any group; no one never let in
  is in any.
- **Only people's word.** No operation by a key that is no one's counts, but a server's own join, a
  server's admit, and a server's drop of its own key;
  nor one by someone never let in, nor one naming a parent no one holds; nor a server's join signed
  by a person's key.
- **Servers.** Each server has a join of its own counting, by a link for one server, for the
  workspace, with someone in letting it in first. A server is in no group, its key is no person's
  and not dropped; it may change no file, and reads every space (0110). One
  taken out is a server again only by a join of its own after the taking out; out, its cutoff is on
  record.
- **Nothing after one is out.** Of someone out of the workspace, nothing counts that is not in the
  past of a removal of them that counts, but their leaving (or a ring of removals).
- **Removals stand.** Nothing counts that a removal or drop counting at the same time beats, but in
  a ring of them.
- **What gives less.** No two operations counting at the same time say different things of one
  person's place in one group; no two handovers of the owner's role made at once both count.
- **Nothing after a key is dropped.** Nothing signed with a dropped key counts that is not in the
  drop's past.
- **Nothing by a link unlinked.** No join counts that is not in the past of every unlink of its
  link that counts; and none by a grant signed since links are let in by without an `admit` of
  its signer by that link in its past.
- **Clashes on record.** Every operation allowed in its own past that did not count is on record as
  having lost; and each that lost (but narrowed, or by a used link) did not count, to one that did.

## Servers

A server ([0099](decisions/0099-servers.md)) is a key no person vouched for, in the workspace as
itself by its own `join` (role `server`). It reads everything in the workspace, every space too
([0110](decisions/0110-the-owner-reads-everything.md): before, only a space whose audience named its
key); it may change nothing, whatever the rules say
or where they say nothing, not even a file named for it; it is in no group (a grant naming it counts
for nothing, and its join takes it out of any a grant made at the same time put it in). Nothing else
its key signs counts, but its `admit`: it lets people in by their links while every member is away
(the link's grant, an admin's, is what lets them in; the admit says only that the link held when it
did), by a link for one person only (0112); and its `drop` of its own key, given up (0112). The owner takes it out as a person is taken out, a `revoke` of the workspace
naming its key: it is out, with its cutoff on record, and may be invited back, its join by a new link
counting again. A `drop` of its key (lost or stolen), the owner's too, is for good: no join by it
counts again. Restrictive wins as for anyone: a taking out or a drop beats what its key did at the same
time, its join included, as does an unlink of the link.

## A document's own files

A path in a folder named as a file with an extension, then `.files` (`ch/report.md.files/bay.jpg`), is
one of that document's own files ([0109](decisions/0109-a-documents-own-files.md)). Who may change it is
worked out up the tree as for any path, with the document counted between its files' folder and the
folder the two are in (`permissionPaths`: itself, `ch/report.md.files/`, `ch/report.md`, `ch/`, `''`).
So whoever may change a document may change its files, and a document's own permission is theirs. It
is known by name alone, whether or not the document is there, so every device works it out the same.
Who reads one is its space's, as for any file: the host keeps a document's own files in its space.

## A person's own files

A file whose name is `@` and an identity ID, with any extension (`@7f3a…e1.jsonld`), in a folder
beside a document (`p01.md.annotations/`: the document's name and a dotted ending, the document
there), is that person's own ([0082](decisions/0082-annotations.md): annotations are their
authors'). The policy needs no operation for it, and knows no feature: `mayWrite` says that only
its owner may change it, wherever they read it (in the workspace's own files: anyone in the
workspace; in a space's history, its audience), and that no one else may, whatever the rules say,
admins and the owner included. A file so named anywhere else (beside no document) is judged by the
rules, as any file. Where there is no policy (one computer), anyone may, as with every file.

The gate judges a commit touching anyone's own file even where there are no rules: whether it is
beside a document it looks in the commit (or, a document deleted with it, its first parent). It
takes one more thing, from anyone: a move of someone's own file, unchanged, with its document (the
file taken away and the same content put under the same name beside the document's new name, the
document taken away and put there, in the same commit), so a document renamed carries everyone's
files beside it. A change to one, or a move of it elsewhere, by anyone but its owner is refused, and
their version kept.

Live rooms keep to the same where it can be told (rooms.ts, `takes`): an edit to a person's feature
state only as its maker's own; a sync, which holds anyone's, whole from someone who may change the
document. What protects a person's file is that each host writes into it only what its own person
did in the room (their clients' changes, their own devices' edits, and their seeding from the
file): whatever else is in their state is shown, never signed as theirs.

## Making one again

A clash's losing operation is made again on purpose by someone who may make it now (an admin, as the
change needs): the same operation, as theirs, naming the current heads, so it comes after both and
counts (a `join`, which only its maker makes, as a `grant` of the same place; a removal or drop with
the commits the device has now as its cutoff).

## Which devices are in

Not an operation of its own ([0072](decisions/0072-ranks-devices-and-changes-not-kept.md)): a device
is in the workspace where it signs with a key (its `signs` record), a person vouched for that key,
the policy has that person in the workspace, and the key is neither dropped nor revoked; or where it
signs with a key the policy has as a server (and no person vouched for it). Who a server's device is,
where a person's has its person: the server's key. It is out
where its key is dropped or revoked, or its person was taken out (or left); a device whose person is
not known, or not in yet, is neither. Removals of devices made before 0072 still count. A removal
counts on each device as soon as it holds it, and its links to the devices out close then: nothing
that takes away ever waits.

## No clock

Nothing here reads a device's clock: devices that read theirs differently would reach different
policies. An invite link's expiry is checked by the device that lets its holder in, by its clock,
when it does (`admit`), and a link revoked is unlinked.

## A workspace from before 0066

One with no genesis pinned counts no operation here. Each device works out its legacy policy the one
last time, as it did before (`legacy.ts`, with its `legacy.json`), and keeps it (`legacy-last.json`):
until the workspace is founded again, that is its policy, as it was, nothing new counting. Its owner
(where it has none, one of its admins; with no policy at all, anyone in it) founds it again: a new
genesis naming them, then everyone, every permission and space, every computer dropped and every
person taken out (with their cutoffs) put back as their device had them. Each device pins to such a
genesis once it holds one signed by whoever its own last legacy policy lets, naming its signer (the
lowest, if more than one); never to any other ([0078](decisions/0078-restrictive-wins.md)).

## What it does not decide

How identities' keys change (`kel.ts`), and which commits come in (`gate.ts`), build on the policy
and are described in the decisions that made them.
