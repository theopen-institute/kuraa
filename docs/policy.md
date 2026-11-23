# The policy: how every device works it out

A workspace's policy says who is in it, in which groups, with which role, and who may read and change
what ([0066](decisions/0066-permissions-without-a-centre.md)). Every device holds the policy's
operations and works the policy out from them alone. Devices that hold the same operations must
reach the same policy, whatever order the operations arrived in. This is the whole of how they do
it; `packages/host/src/peers/policy.ts` is the code, and `packages/host/test/policy-properties.test.ts`
checks what *What always holds* says, over histories made at random.

## Operations

Each operation is signed by a person's signing key, and names the operations its maker had seen
(its *parents*). Its ID is the hash of what it says, its parents and its signer, in this workspace.

| Operation | Says | Who may make it, in the policy its past makes |
| --- | --- | --- |
| `genesis` | the workspace's first admins | no one: it is the root (below) |
| `grant` | someone is in a group, as admin or member | an admin of the group, or of the workspace (a new group: the workspace's admins). Making or unmaking a workspace admin, only the owner (where there is one). Into a group other than the workspace, only someone in it. Never the last admin made a member, nor the owner |
| `revoke` | someone is out of a group (`cutoff`: the commits the remover had) | an admin of the group, or the person themselves (leaving). A workspace admin, only the owner (or themselves). Never the owner, nor the last admin |
| `join` | its signer comes in by an invite link's grant | the person let in, with a grant signed by an admin of the group (making workspace admins: the owner's). A link for one person, once. Not by a link unlinked in its past. A grant signed since links are let in by (`kuraa-grant/3`): only with an `admit` of its signing key by that link in its past |
| `admit` | a device let the holder of a signing key in by an invite link (it checked, by its own clock, that the link had not expired nor been revoked) | anyone in the workspace |
| `unlink` | an invite link lets no one into its group any more | an admin of the group |
| `owner` | someone in the workspace is the owner now | the owner |
| `seal` | (a workspace from before) only these legacy geneses count | an admin, once; where a device keeps to a seal (below), only that one |
| `rule`, `perm` | who may change a path; who reads what is made in a folder | the workspace's admins |
| `space` | a space's audience | anyone in the workspace who is in that audience (to make it); whoever made it, or an admin (to change it) |
| `verifier` | whose email checks count here | the workspace's admins |
| `drop` | a signing key (one computer) no longer counts here (`cutoff`: the commits the dropper had) | its own person; or an admin (the owner, for an admin's or the owner's computer). For good |

## Working it out

1. **Which count at all.** An operation counts only if its signature is good, its signing key is a
   person's (as the identities say), and it descends from a genesis that counts: the one the
   workspace is pinned to (every invite link carries the pin), or, for a workspace from before,
   its legacy geneses until an admin seals them (then those the seal names). A key its person
   revoked (or left behind recovering their identity) is still theirs for what it signed in the
   past of the policy its revokers had (`policyHeads` on the revocation), and no one's for anything
   else; a revocation from before, which says none, leaves all it signed counting.

   **A workspace from before** has no pin, so which legacy geneses are its own is each device's to
   know. A device holds as its own the legacy geneses it held the first time it worked the policy
   out so, those it makes, and, welcomed into one holding none, those it was welcomed with. Of the
   rest, a legacy genesis counts only if signed by someone one that counts names (and so on), never
   one a stranger brings. Once a seal counts on a device, the device keeps to it (`legacy.json`):
   from then on only that seal counts there, and only the geneses it names. So no genesis or seal
   made later, by anyone, takes the workspace over. Devices that hold their geneses differently
   may disagree until a seal reaches them. Two seals made apart, each kept to by the devices that
   saw it first, stay apart: that takes two admins making the workspace's first change at once,
   out of each other's reach.
2. **One order.** Operations are put in one order: parents first, then the lowest ID among those
   ready. One whose parents are not all here waits, left out.
3. **Each judged by its own past.** Going through that order, each operation is judged against the
   policy its past makes (everything it descends from, worked out by these same steps). It counts if
   its maker was allowed to make it there (the table above), and its key was not dropped there. So whether an operation was allowed
   never depends on what was done at the same time, or on what a device happened to hold first.
4. **Together, by rank.** The operations allowed are then applied together, in the one order. Two
   made at the same time (neither in the other's past) may not both be able to count:
   - one takes the other's maker out of a group, or out of being its admin, and the other acts in
     that group (for the workspace: anything), unless the other is its maker leaving a group; or one
     drops the key the other is signed with;
   - or they say different things of one person's place in one group: out, member, admin (an
     `owner` says *admin* of whom it names; a `join` says *in*, which differs only from *out*).

   Then the one ranked first counts, the other not. Ranked first: leaving oneself; then the maker
   with the higher **rank**, in the policy their operation was made under; then the one that gives
   less (out, then member, then admin); then the lower ID. They are taken in that order, each
   counting if none already counting rules it out.

   Two seals made at the same time: the one naming the most of the geneses that count (taking the
   fewest out) counts; then by rank; then the lower ID.

   **Rank**: the owner; then the workspace's admins, the longest an admin first; then its members,
   the longest in first; then everyone else. *How long* is the position, in the one order, of the
   operation that gave them their place (the geneses: first of all); ties by ID.
5. **Cutoffs.** Whatever else someone taken out did at the same time as the removal that counts
   (in that group; in the workspace, anything) counts for nothing, but their leaving a group; and
   whatever was signed with a dropped key at the same time as the drop; and any join by a link
   made at the same time as an unlink of it that counts.
6. **Founded on what counts.** Each operation that counts must still be allowed by what counts of
   its past (applied in the one order). One whose maker had their say only through an operation
   that does not count (a grant that was cut off, a handover that lost to its taker leaving) does
   not count either, and steps 4 to 6 are done again without it, until none is left so.
7. **An admin always.** If no owner is left, and what counts would leave the workspace with no
   admin, the highest-ranked of the admins taken out at the same time as another stays: their
   removals do not count, and steps 4 to 7 are done again. It is on record (`disputes`).

The result: groups and roles, the owner, permissions, spaces and their audiences, verifiers, the
links for one person used, the operations that counted, the heads (what a new operation names), and
each person out of the workspace with their cutoff (the commits of theirs that still count: the
write gate refuses any other).

## What always holds

Checked over histories made at random, on every device whatever each holds, and on all of them
together:

- **The same everywhere.** The same operations, in any order, any repeated, make the same policy
  (in a workspace from before: on devices holding the same legacy geneses as their own, and keeping
  to the same seal).
- **An admin always.** The workspace has at least one admin; with an owner, the owner is one.
- **Groups inside the workspace.** No one outside the workspace is in any group.
- **Only people's word.** No operation by a key that is no one's counts.
- **Nothing after one is out.** Of someone out of the workspace, nothing counts that is not in the
  past of a removal of them that counts, but their leaving.
- **Nothing after a key is dropped.** Nothing signed with a dropped key counts that is not in the
  drop's past.
- **Nothing by a link unlinked.** No join counts that is not in the past of every unlink of its
  link that counts; and none by a grant signed since links are let in by without an `admit` of
  its signer by that link in its past.

## Which devices are in

Not an operation of its own ([0072](decisions/0072-ranks-devices-and-changes-not-kept.md)): a device
is in the workspace where it signs with a key (its `signs` record), a person vouched for that key,
the policy has that person in the workspace, and the key is neither dropped nor revoked. It is out
where its key is dropped or revoked, or its person was taken out (or left); a device whose person is
not known, or not in yet, is neither. Removals of devices made before 0072 still count.

## No clock

Nothing here reads a device's clock: devices that read theirs differently would reach different
policies. An invite link's expiry is checked by the device that lets its holder in, by its clock,
when it does (`admit`), and a link revoked is unlinked. An email attested (`email:` entries)
counts until its verifier has made another attestation, of anyone, dated after it ran out, that
the device holds: its verifier's clock, as its records say.

## What it does not decide

How identities' keys change (`kel.ts`), and which commits come in (`gate.ts`), build on the policy
and are described in the decisions that made them.
