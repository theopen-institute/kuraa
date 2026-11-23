# 0072 · Ranks, devices that follow their people, folders that hold their space, removals confirmed, and changes not kept

*Since [0078](0078-restrictive-wins.md):* changes made at the same time are no longer settled by rank: the one that gives less counts, whoever made it, and each clash is shown; with an owner always an admin, the rule keeping an admin (and its disputes) is gone.

> Changes [0066](0066-permissions-without-a-centre.md) (how changes made at the same time are
> settled; suggestions; which devices are in; spaces), [0068](0068-people-and-their-computers.md)
> (removing a computer) and [0071](0071-network-review.md) (pairing). `PROTOCOL` is now 5.

The owner asked for a review of the model ("does this design make sense? Is there a better way?"),
then for what it recommended: a written account of how the policy is worked out, checked over
histories made at random; changes made at the same time settled by rank; devices that follow from
people, with no pairing of their own; spaces that are containers whose readers change; removals
confirmed; and a plan for encryption (0073). And, along the way:

> "Get rid of 'suggestion' edits. That's way down the line. For right now, if a user doesn't have
> authorization to edit a document, it should display in the app as read only."

> "I would, however, like to make sure that 'rolled back' changes aren't completely lost."

> "I don't want to introduce timestamps, at least not yet."

## The policy, written down and checked

[docs/policy.md](../policy.md) says how every device works the policy out, and what always holds.
`policy-properties.test.ts` plays histories made at random on three devices passing what they hold
to one another, and checks that the same operations in any order make the same policy, and that on
every device, whatever it holds: there is an admin; the owner is one; no one outside the workspace
is in a group; no key that is no one's has a say; nothing someone out of the workspace did after (or
at the same time as) being taken out counts; nothing signed by a dropped key after the drop counts.
A test checks the histories are worth checking (most have operations made at the same time that
count).

On its first runs it found what the special cases of 0066 step 4 left open: the owner giving the
workspace to someone who left it at the same time (an owner not in the workspace); someone leaving
on one computer while acting on another (the act counted); one of two equal admins taking out the
other, who at the same time did something (it counted); and, later, an admin made by a grant that
was cut off, whose acts counted, and an owner who left after handing over to someone who left at
the same time.

## Changes at the same time, settled by rank

One rule in place of removal-wins, both-out and neither-stands. Two operations made at the same time
may not both be able to count: one takes the other's maker out (of the group the other acts in; of
the workspace: anything), or drops the key it is signed with; or they say different things of one
person's place in one group. Then the one ranked first counts: leaving oneself; then by its maker's
**rank** in the policy it was made under (the owner; then admins, the longest an admin first; then
members, the longest in first); then the one that gives less; then by hash. Whatever else someone
taken out did at the same time counts for nothing, and what counts must be allowed by what counts
of its past: what someone did with a say given by an operation that did not count does not count
either. Where there is no owner and what counts would
leave no admin, the highest-ranked of those taken out stays (on record, and said in the app).

## No suggestions

Suggesting a change, the list of open suggestions, and accepting or dismissing them are gone (the
app, `/api/suggestions`, `Kuraa-Suggestion`, `Kuraa-Suggested`, `Kuraa-Resolved`). A document a
person may not change opens read only, saying who may, with nothing to edit it by. A change made
anyway (another editor, plain git) is kept out where it comes in, as before.

## Changes not kept are not lost

A change kept out is in the history every device holds: the merge that kept it out has it as a
parent and names it (`Kuraa-Refused: <commit> <path>`). The file's history lists it, *Changes by Bo,
not kept*, among its versions; it opens as a past version does, read only, to compare with now and
copy from; someone who may change the document can **Restore** it, as their edit. The person whose
change it was is told once, above the document: *Your changes of … were not kept*, with **Show
them**. Only the file's readers see it: its history is in its space. Not inline (that would put it
in the document) nor a file beside it (which no one could write, everyone would see, and someone
would have to delete).

A rule made while someone was offline still applies to what they changed meanwhile: whoever may
change the file cannot be told apart from someone claiming not to have seen the rule. A server
putting changes in order would let the first to reach it count; that waits (no timestamps yet).

## Devices are in as their people are

There is no pairing any more. A device is in the workspace where it signs with a key (`signs`), a
person vouched for the key, the policy has that person in the workspace, and the key is neither
dropped nor revoked; out where its key is dropped or revoked, or its person was taken out. Git
remotes follow the records. What a device says of itself and its person (key events, `signs`,
`vouch`, policy operations, attestations) is signed in itself and taken whoever passes it on; links,
secrets and acknowledgements only from a device in.

- **Removing a computer** is a policy operation, `drop`, of its signing key, with the commits the
  remover's device has as its cutoff: its own person's to make, or an admin's (the owner's, for an
  admin's or the owner's computer). One's own computer, where one's identity is here, has its key
  revoked as before (in every workspace).
- **Joining:** a device let in by an invite link is in for as long as it is connected; it is in for
  good once its person's `join`, with the link's grant, reaches the policy. A device joining is let
  in only by the link's maker, or by a device the records it is sent show to be in, under the
  genesis the link names. It says who it is as soon as it has the workspace's secret.
- **Hellos carry proof:** a device that may not be known to be in yet sends, with its hello, the
  records that show it is (its person's key events, its key and its vouch, the policy operations it
  signed). So a device whose join reached the others only through a third, or whose records came
  after its first hello, is not turned away.
- **A fork** meets the devices of the workspace it came from as the records of that workspace say.
- **From before:** pairing records (`add`) are kept and say nothing; removals (`remove`) still
  count; none of either is made.
- **Refusals reach a device joining**, which has taken no one in yet: a link used or revoked says so
  instead of *could not reach*.

## A revoked key's past word stands

Revoking a key made it no one's, so every policy operation it had signed stopped counting: revoking
a lost laptop's key undid every grant made from it. Now a key revoked (or left behind recovering an
identity) is still its person's for the policy operations in the past of what its revoker's device
had (`policyHeads`, signed with the revocation), and no one's for anything after. A revocation from
before, which says none, leaves all it signed counting.

## Folders hold their space

A folder read by fewer has a space of its own, which its permission names (`perm`'s `space`); who
reads the folder is that space's audience. Changing who reads it changes the space's audience: no
file moves, whoever is added is sent its files and their history, whoever is taken out keeps what
they had and gets nothing new. Setting a folder's readers for the first time makes its space and
moves its files in; taking them away moves them back out. A file given readers of its own gets a
space of its own, changed in place the same way after; given the readers its folder has, it goes
into the folder's space. Spaces are no longer shared by files that happen to have the same readers.
Folders whose permission names no space (made before) are found by their audience, as before.

## Removals confirmed

Each device says how much of the policy it holds (`ack`: the policy's heads, the latest of each
device kept), whenever that changes. Workspace settings list the latest removals (people taken out,
computers removed), each *confirmed by* those, but the remover and the removed, whose devices hold
it, or *not confirmed by anyone else yet*: until it reaches the others, a device that has not heard
of it may still sync with whoever was removed. Admins may name **witnesses** (`witness`: usually a
server's identity, always on); a removal a witness holds says so. Nothing is judged by any of this,
and nothing is put in order.

## Not yet

A server that puts changes in order (no timestamps yet); encryption (0073); cutoffs for spaces the
remover cannot read (0066).
