# 0078 · Restrictive wins, clashes shown, workspaces from before founded again, and four features gone

> Changes how changes made at the same time are settled ([0072](0072-ranks-devices-and-changes-not-kept.md):
> by rank; [0066](0066-permissions-without-a-centre.md) step 4), how a workspace from before 0066 is
> kept ([0075](0075-review-fixes.md): legacy geneses and seals), who owns one ([0070](0070-an-owner.md)),
> and removes trustees, escrow, verifiers with their attestations, and email invites ([0066](0066-permissions-without-a-centre.md)
> step 6, [0068](0068-people-and-their-computers.md), [0076](0076-a-quieter-sidebar.md)).
> [docs/policy.md](../policy.md) says it all exactly. `PROTOCOL` is now 7: devices running an older
> kuraa work the policy out differently, so they do not sync with these until updated.

The owner was shown a simplification of the policy: the one that gives less counts, always, and
every time that decides something it is shown, not settled silently. Their answer:

> "Yes, this is good. Implement both."

And of trustees, server escrow, verifiers (with their attestations and email checks) and email
invites, they chose full removal, not hiding.

## Restrictive wins

Two changes made at the same time (neither in the other's past) that cannot both count: the one that
gives less counts. There is no rank and no seniority: who made it does not matter.

- **Out beats member beats admin**, for one person's place in one group.
- **A removal beats what the one removed did there at the same time** (in the workspace: anything),
  but their leaving. A drop of a key beats what that key signed at the same time.
- **An unlink beats a join by its link.**
- **Rules, permissions and audiences on one path (or space): the narrower.** What both name; where one
  names some of what the other does, that one; where they name no one in common, the admins, who
  could have made either. No rule at all is everyone, so a rule taken away as another is made: the
  one made.
- **Two handovers of the owner's role at once** (only the owner makes them: their own two computers):
  the lower ID. There is always exactly one owner.
- **Removals that beat each other in a ring** (two group admins taking each other out at once): all
  count. Settling such a ring by ID would let someone being taken out keep their place by making
  removals of the remover until one hashed lower; everyone out cannot be won that way.

What someone did with a say that came from a change that did not count does not count either, as
before. The owner cannot be taken out (0070), so the workspace always has an admin: 0072's rule
keeping one (and its *disputes*) is gone. Nothing in the policy reads a clock (0075).

Removals count on each device as soon as it holds them: what takes away never waits. Its links to
the devices out close then, as before.

## A clash is shown

Each time the rule above decides between two changes, the policy says which counted, which did not,
and why (`clashes`). Settings › Workspace lists the latest in words (*Ada made Bo an admin while you
took Bo out: Bo is out*). Everyone in the workspace sees them: every device holds the changes anyway,
and a member whose place one decided should see why. Whoever may make the change that lost (an admin,
or the owner, as it needs) has **Make it again**: the same change, as theirs, after both, so it counts
(`POST /api/clashes/<id>/redo`; a join, which only its maker makes, as a grant of the same place).
`kuraa-host rules` says how many there are.

## Workspaces from before 0066, founded again

A workspace with no genesis pinned counted legacy geneses that each device held differently, and
seals it kept to. That is gone from how the policy is worked out. Instead:

- **Once,** the first time a device of this version holds such a workspace, it works its legacy
  policy out the one last time, as it did before (`legacy.ts`, frozen, with its `legacy.json`; email
  entries aside), keeps it (`legacy-last.json`), and removes `legacy.json`.
- **Until it is founded again,** that is its policy, as it was: who is in, groups, permissions and
  spaces stay; nothing new counts and nothing about them can be changed; files still sync. Invite
  links cannot be made, and old ones let no one in.
- **Its owner founds it again** (where it has none, any of its admins, who becomes its owner; with
  no policy at all, anyone in it, as everyone had the same say): a new pinned genesis naming them,
  then everyone, every permission and space, every computer dropped and every person taken out (with
  their cutoffs), as their device had them. Settings › Workspace says so, with **Found this
  workspace again** for whoever may; `kuraa-host refound`; `POST /api/peers/refound`.
- **Each other device** pins to such a genesis once it holds one signed by whoever its own last
  legacy policy lets, naming its signer (the lowest, if more than one), and to no other.

Not automatic: each device founding its own would split the workspace. Two admins of an ownerless
one founding it at once, apart, stay apart, as two seals made apart did (0075).

## Gone

- **Trustees**: naming them, asking them, vouching as one, recovering through them (`person.ts`,
  `kel.ts`'s trustee rotations, `/api/person/trustees…`). A trustee rotation (`trot`) is no longer an
  event; a rotation from before that named trustees is read as it was signed, and they say nothing.
- **Server escrow** of recovery keys (`/api/person/escrow/…`, a verifier's `/verify/escrow/…`).
- **Verifiers and attestations**: the `verifier` operation, `attest.ts`, `verifier.ts` (it served
  nothing else) and `--verify-emails`, `--verifier-name`, `--escrow`; `attest` records; `email:`
  entries in groups, rules and audiences; emails in people listings; `/api/verifiers`,
  `/api/person/email/…`.
- **Email invites**: an invite link's email.

Later, on the owner's word ("remove it to streamline the current core build, then add it back
incrementally with everything else (especially server architecture)"): **witnesses** (0072) too. A
`witness` operation is read and counts for nothing; removals are still listed with who has confirmed
them, which needs no witness.

Settings › You › Account recovery holds the recovery key alone (`PersonMore.vue` is gone). Kept: a
person's identity with its recovery key (committed in advance, recovering with it), device keys,
owner, admins and members, groups, write rules by path, permissions and spaces for reading, invite
links (with `unlink` and `admit`), and dropping a computer.

An attestation an older device passes on is refused, as any record of no known kind. A `verifier` or
`seal` operation, a legacy genesis, and an operation naming someone by email, already in a history,
are read (what came after names them as parents) and count for nothing.

## Tested

`policy-properties.test.ts` now plays adversaries too, with fixed seeds: strangers' keys, an identity
never let in, people taken out going on, operations on an old view of the policy, parents no one
holds, grants and handovers made again by others, a rival genesis. It checks the same policy in any
order, exactly one owner (an admin), no stranger in a group or counting, nothing by someone out or a
dropped key after, no two at once counting that say different places, and every operation that lost
on record. On the code before, its checks of what gives less fail at once (an owner's grant beat an
admin's removal by rank).

## Not done

- A grant from before links were let in by (`kuraa-grant/2`), for anyone, can be made into a join
  by whoever holds the policy, until it is unlinked (0075).
- Clashes list the latest twenty, with nothing saying when one was made again: an old one stays
  listed.
