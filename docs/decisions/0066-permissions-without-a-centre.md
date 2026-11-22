# 0066 · Who may read and change what, without a centre

**Status: being built, in the order below. Built: 1 (identities), 2 (the policy, groups, roles) and 3 (write rules, suggestions); see *Built so far* at the end.**
This is the redesign [0038](0038-equal-peers.md) left for later.
When built, it replaces 0038's model (every member has total control), extends
[0031](0031-signed-membership.md) (signed records) and [0035](0035-identities-and-signing-keys.md)
(identities), and brings back, in shared form, parts of [0032](0032-accepting-work.md) and
[0033](0033-document-rules-and-people.md) (rules by path, documents opening read-only).

The owner's direction:

> "The base model here is git. Everybody can do whatever they want to their own copies of files.
> 'Permissions' aren't about attempting to block that but instead come down to how each user handles
> merges from each other… The app should provide cues that a document isn't editable, but actual
> enforcement is handled by the individuals deciding to merge or not to merge."

> "In addition to write permissions, I would like it to be possible to set read permissions as well,
> similar to how something like Notion does it with both user and group-level permissions."

And, after a first sketch: read boundaries must be possible for a single file; groups have admins
and members, only admins change membership and every admin has full control; recovering a lost
owner's key matters.

## The idea: the agreement is shared data

0032 and 0033 made permissions each device's own rules. Devices with different rules kept different
versions of a file, the workspace parted silently, and nobody could say what "the" document was.

Here the agreement is a **policy**, signed by those allowed to change it, synced like everything
else, and applied by every device in exactly the same way, as merges already are ([0025](0025-merging.md)).
Any device may still ignore it: that is forking, in the open, as git always allows. What the policy
decides is what everyone *else* takes.

Write and read are different in kind:

- **Write** rests on agreement. Everyone may have the bytes; the policy decides whose changes are
  merged.
- **Read** cannot rest on agreement: what was sent cannot be unsent. It rests on what is sent at all,
  by keeping each audience's files in a repository of their own ("spaces", below).

## Identities: a stable ID, keys that change

Everything below names people, so this comes first. Today rules would name an identity's key; a lost
key means a new identity, and every rule naming the old one rewritten (0033 says so).

- **An identity is an ID**: the hash of its first record (its *inception*), with a signed history of
  its keys after it. Policies, groups and audiences name the ID; changing keys changes no rule.
  Identity records travel as records do now, passed on in every workspace the person is in.
- **The identity's key** vouches for each computer's signing key, as in 0035. Lost computers are
  still handled by revoking that computer's signing key.
- **Recovery key, committed in advance (pre-rotation).** The inception names the *hash* of a second
  key, kept offline (printed, a password manager). To change the identity's key, the person reveals
  that key and names the hash of the next. Someone who has stolen the current key cannot do this.
  ([KERI](https://keri.one) is the reference design.)
- **Trustees.** An identity may name trustees ("any 2 of these 3 people") whose signatures together
  can change its keys when both are lost.
- **Server escrow, optional.** A server may hold the recovery key encrypted with a passphrase,
  released after the person proves an email or other attestation (below). Opt-in, and a person may
  require more than email (a passphrase, or one trustee as well).
- **A key change has a cutoff.** Whatever the old key signs that is not already known when the change
  is made (see *Cutoffs*) is no one's, on every device. This covers a stolen key, not only a lost one.

### Attestations: email and other proofs

Signed statements about an identity: "X controls `bo@uni.edu`", "X is GitHub user `bo`", "X has
ORCID …", "X controls `lab.org`". A **verifier** (a server, after a code or magic link; OpenID
Connect for ORCID or a university's sign-in; DNS or `.well-known` for a domain) signs
`{identity, claim, verifier, date}`.

- **No global authority.** Each workspace's policy names the verifiers it believes.
- **Uses:** names people are known by in the interface (0035 left names as free text);
  finding someone to share with; inviting by email before the person has an identity (an audience
  or group may hold `email:bob@uni.edu`, waiting for a matching attestation from a trusted verifier);
  recovery through escrow.
- **Attestations expire and can be withdrawn** (people leave institutions). Losing an email never
  loses the identity, which was never the email.
- **Privacy:** an attestation shows the email to everyone it reaches. Publish only its hash for
  matching invites, or show attestations only to people who share a space with the person.

### People who only use a browser

A browser user on a shared server who signs in by email may have an identity **the server holds
for them**, so they can work at once. Because keys change, they can **take custody later**: change
the server's key for one on their own device, after which the server cannot act for them. A
**passkey** can keep a browser's signing key encrypted (the WebAuthn PRF extension gives a key to
encrypt it with); passkeys cannot sign git commits themselves.

## The workspace's root and policy

- **Genesis.** Whoever makes a workspace signs its first policy record. The workspace's ID is that
  record's hash; invite links carry it, and a device takes a policy only if it descends from that
  genesis. (Radicle's repository identity works the same way.)
- **The policy is a signed history on its own ref**, `refs/kuraa/access`, as outputs have
  `refs/kuraa/outputs/*` ([0058](0058-shared-outputs.md)): each change a commit, signed by someone
  the policy before it allowed to make it. History, signatures, audit and sync come with git.
- **Content commits say which policy they were made under**, in a trailer
  (`Kuraa-Policy: <hash>`), so whether a commit counts depends on the commit and the policy history
  alone, not on the order a device happened to receive things.

### Groups: admins and members

Every group has **admins** and **members**. Only admins change a group's membership, and every admin
of a group has full control of it. The workspace is itself a group: its admins change the policy
(rules, verifiers, spaces, and any group). Groups may contain identities, other groups, and
`email:` entries waiting for an attestation.

```yaml
workspace: { admins: [ada], members: [group:editors, group:readers] }
groups:
  editors: { admins: [ada], members: [bo, chen] }
  readers: { admins: [ada, bo], members: [dee, email:eve@uni.edu] }
verifiers: [<this workspace's server>]
write:                                   # most specific path wins
  - path: ""          by: [group:workspace.admins]
  - path: chapters/   by: [group:editors]
```

An invite link adds its holder to a named group, as a member unless it says admin. A link no longer
gives full power (0038's first weakness).

The two common shapes:

| | Admins | Write |
| --- | --- | --- |
| **Equal group** | everyone | everyone, everywhere |
| **Owned workspace** | the owner (and a second admin, for safety) | the owner everywhere; groups or people on chosen paths |

### Concurrent changes, resolved the same everywhere

No admin outranks another, so conflicts are resolved by rules every device applies alike:

- **Removal wins.** An add and a remove of the same person at once: removed.
- **Nothing a removed admin does after their cutoff counts.**
- **Mutual removal removes both**, unless that would leave the group with no admin; then neither
  stands, and the group's members are told of the conflict. (A stolen admin key is not settled
  here but by its owner changing the key, whose cutoff voids what the thief did.)
- **The last admin cannot leave** without naming another.
- Otherwise changes made at once all apply.

### Cutoffs

A removal (or a key change) names the heads the person making it had seen: of the policy, and of
each space they can read. Whatever the removed person (or old key) signs that is not reachable from
those heads does not count, on every device. Without this, the removed person could backdate work by
building on old commits and naming an old policy. 0035 counted a revocation "from when each device
takes it", which differs by device; a cutoff is the same everywhere.

For spaces the remover cannot read, the first member of each to see the removal signs a cutoff for
it; several at once count as the union of their heads. *(To settle when built.)*

The cost: the removed person's edits in flight are dropped. Anyone who may write there can take
them up as a suggestion.

## Write: rules by path, enforced in the merge

- Rules name paths (a whole space, a folder, a file) and the identities or groups who may write
  there; the most specific counts. Rules about a private space's files are kept in that space, so
  even their paths stay private.
- **Merging applies them, identically on every device.** Work touching a path its signer may not
  write: its history comes in, the merge keeps the earlier version of that path (0033's "kept this
  version", now the same everywhere, so nothing parts), and the refused change becomes a
  **suggestion**.
- **Suggestions** are shown to those who may write there, with **Accept**, which commits it again
  under their own signature (a pull request, made of what the app already has). Anyone who can read
  a file may suggest; a suggestion is kept in the file's own space, so only its readers see it.
- **Rooms follow the rules.** A room takes live edits only from connections whose person may write
  the document; otherwise rooms would be a way round the policy. The editor opens such a document
  read-only, with a line saying who may edit it and a **Suggest** mode. A browser user on a shared
  server counts as whoever signed in.
- **Merges stay no one's** (0035): any device makes a merge again to check it; a "merge" that differs
  is its signer's own commit, and judged as theirs.
- You can write only what you can read: a space that never reaches you cannot be edited by you.

## Read: spaces, one per audience

A **space** is a git repository of its own whose files are readable by one **audience**: a rule
naming identities and groups (`group:team + dee`), not a fixed list. A device syncs, stores and
joins rooms of only the spaces its person is in the audience of. Adding someone to `team` gives them
every space whose audience includes `team`; no file moves.

### Siblings laid over one another, not submodules

A submodule is a pointer in its parent's history, so everyone who reads the parent knows the child
exists, where, and when it changed; and its boundary is a whole folder. Spaces are **siblings**: none
refers to another, and each holds its files at their full workspace paths. The app lays the spaces a
person can read over one another into one tree (a union mount where no file is in two layers):

```
space A (everyone)        space B (editors)        space C (Ada)
  README.md                 chapters/03-draft.md     chapters/notes.md
  chapters/01-intro.md      data/survey.csv          ideas.md
```

Ada sees all seven files; Bo, an editor, five; Chen three, with no gap, placeholder or history entry
where the others are. Repositories grow with the number of distinct audiences, not files: a team area
and a few private drafts is a handful of spaces, whatever the number of files.

### On disk, one ordinary folder

Several git directories share one working folder, each tracking only its own files (as
[vcsh](https://github.com/RichiH/vcsh) does for `$HOME`):

```
my-workspace/                      plain files, as now
  .git/                            space A, the one everyone reads
  .git/kuraa/spaces/<B>/           space B's git directory
  .git/kuraa/spaces/<C>/           space C's
```

The host knows which space owns each file and runs git against that one. Space A's local exclude
file (never committed or synced) lists the others' files, so plain `git status` stays clean. Finder,
RStudio and other editors see files; plain git sees the public layer; the private layers are reached
through Kuraa, or by pointing git at their directories.

### What a person sees

One folder, every file of every space they can read at its own path. The app shows **who can read**
each file (a badge: "Editors", "Only you"), not spaces; the share dialog changes it, and that is what
moves a file between spaces. New files go where the folder's default audience says; a file may
override it, as Notion pages do. A folder's default is a small record kept where everyone who sees
the folder can read it, and not in the public layer if the default is itself sensitive.

### Each space is a whole workspace

Its own history, merges, write rules, online copy ([0039](0039-online-copy.md); or none: a git
server counts as a reader of what is pushed to it), and sync topic ([0050](0050-networking-review.md)),
so devices outside its audience never find it. The workspace's policy lists spaces only as entries
encrypted to their audience (or not at all, each space's invitation going directly), so outsiders do
not learn that a private audience exists; a space's name is kept inside it.

### Consequences

- **Commits split by space.** One editing session across a public and a private file is a commit in
  each. Automatic commit messages, which name documents and headings ([0026](0026-commit-messages-and-history.md)),
  stay within the audience.
- **Histories differ by person.** A person's workspace history is their spaces' commits, interleaved
  by time.
- **Changing a file's audience** moves it: narrowing leaves its history with the old audience, who
  have seen it; widening asks whether to share its history or only its version from now on. A move
  is "add to the new space, then delete from the old", not atomic; the tree hides the moment it is in
  both.
- **The same path in two spaces** (two people, unaware of each other, making `ideas.md`): both
  stay; someone who reads both sees both, the narrower labelled. No one renames a file in a space
  they cannot write.
- **Branches span spaces by name**: switching to `draft` switches each space that has one; one
  without stays on `main`.
- **Search, rooms and sync are per space** and come out right with no more.
- **What belongs to a document goes with it**: pasted images and bibliographies go into its space.
- **Code may read only what is at least as widely readable.** A code session mounts only files
  whose audience includes everyone in the document's audience; its outputs are kept in the
  document's space. Data flows from public into private, never back, so a public document's output
  cannot carry private data.

### Why not encrypt files inside one repository

Considered and declined: commits span files and their messages name documents and headings, so one
shared history leaks even with contents encrypted; devices that cannot read a file cannot merge it,
breaking the same merge everywhere; and losing a key would lose data, where with spaces it loses only
authority. Encryption may come later on top of spaces, for servers to hold a copy of a space they are
not in.

## Servers

None of this needs one. A server can be given, in the policy, granted and revocable roles: an
always-on member that holds and passes on the policy, suggestions and its spaces while people are
away; a verifier for attestations; an escrow for recovery keys; a holder of identities for browser
users; and a **sequencer for policy changes**, putting them in one order so conflicts do not arise,
every device still checking each change. No role makes a server an authority.

## Limits, accepted

- What has been read cannot be unread, and a reader can always copy.
- Anyone can still edit their own copy and fork; the policy decides what others take.
- With every admin equal, one admin's key, stolen, is full control until its owner changes it.
- Every device must apply the policy identically, so its rules are part of the protocol version
  ([0051](0051-the-app-updates-itself.md)).
- Plain git outside the app sees only the public layer.

## Elsewhere

A web check (November 2026) found each part done elsewhere, and nothing doing the whole: stores by
audience laid over one another into one tree differing by reader, with no central server.

- **Store per audience:** Keybase's filesystem names a private folder by its readers and writers
  (`/keybase/private/alice,bob`, `alice#bob` for a read-only Bob), membership fixed by the name and
  each folder backed by an implicit team; shown as separate folders, not laid over one another
  ([KBFS](https://book.keybase.io/docs/files/details)).
- **Repository as read boundary, without a centre:** Radicle's private repositories replicate only
  to delegates and allowed peers; its identity document names delegates and a threshold, and a
  canonical branch is what a threshold of delegates agree on
  ([canonical references](https://radicle.xyz/2025/08/12/canonical-references)).
- **Several repositories, one folder:** [vcsh](https://github.com/RichiH/vcsh), using "fake bare"
  repositories whose work tree is `$HOME`. Git itself treats this as unsupported, so the host must
  keep each space's files to itself.
- **Groups and access control for local-first data:** Ink & Switch's
  [Keyhive](https://www.inkandswitch.com/project/keyhive/) (convergent capabilities; groups as a CRDT
  that handles concurrent changes and revocation; a group per document, groups within groups; meant
  for Automerge and git); [p2panda-auth](https://docs.rs/p2panda-auth) (decentralised groups with
  per-member permissions). p2panda uses *spaces* for encryption contexts within groups, a different
  thing by the same name.
- **Research:** [GUARDTs](https://arxiv.org/abs/2611.08083) (decentralised access control for
  replicated data types, with policies that change and replicas that may lie) and
  [formal verification of local-first access control](https://arxiv.org/abs/2604.23560) (delegation
  and revocation; Keyhive and p2panda as subjects). Both work on data types, not files; worth reading
  before the cutoff and conflict rules are fixed.
- **Per-path read rules with a centre:** Perforce's protections, Google's Piper. **Encrypted files
  in one repository:** git-crypt; Peergos.

The new parts carry the risk: the same path in two spaces, moves that are not atomic, histories that
differ by person, and how usable plain git is with only the public layer.

## Order of work

1. Identities with stable IDs, pre-rotation and key changes with cutoffs.
2. Genesis, the policy history, groups with admins and members (everyone an admin: today's
   behaviour, written down); invite links that add to a group.
3. Write rules by path, the same merge filtering everywhere, suggestions, read-only rooms.
4. Conflict rules and cutoffs.
5. Spaces: audiences, laying them over one another, saving and committing by space, moving between
   audiences, the rule for what code reads. This changes saving and committing; settle it before 3
   is built far.
6. Attestations and invites by email (could follow 2), trustees, escrow, server-held identities,
   passkeys, server roles.

## Open

- Cutoffs for spaces the remover cannot read (above).
- How audiences are named and shown, and whether "Only you" files are a space per person.
- Whether people working outside the app accept seeing only the public layer, or Kuraa should offer
  a command that shows all a person's spaces to plain git.
- Where attestations are visible, and whether hashes suffice for invites by email.
- Several people on one server, each with their own keys there (0035 left it open), as the home
  of server-held identities.

## Built so far

### 1 · Identities (`peers/kel.ts`, `peers/person.ts`)

- **The log.** An identity is an inception (its first key, the hash of its recovery key) and
  rotations (each revealing the key the last committed to, naming the hash of the next, and listing
  the signing keys still the person's: `keep`). The ID is the inception's hash. Followed from the
  inception whatever order events arrive in; two different events at one place leave it in dispute,
  and nothing its keys sign counts.
- **On record.** Each event travels as a `key-event` record (passed on by any member, once). A
  `vouch` or `revoke-key` names the identity's ID (`person`) and which of its keys signed
  (`personKey`); records from before, without one, are not records, and each computer vouches again
  as its workspaces next sync. A vouch counts if signed by the identity's key now, or by an earlier
  key and every later rotation keeps its subject; a revocation counts if by the key now, or by an
  earlier one that no later rotation contradicts. Vouches and revocations are kept once per signing
  identity key, and the name said with the latest key wins, so what a stolen key signs, however it
  is dated, never pushes out the person's own word.
- **The recovery key** is made with the identity and kept beside it (`recovery.json`) until the
  person says it is saved elsewhere (**I've saved it** in Settings, `person recovery saved`), then
  removed. Its line (`kuraa-recovery:`) carries the identity's log, which cannot change without it,
  so recovering needs nothing else. Recovering makes it the identity's key, makes a new recovery key
  to save, and keeps the signing keys the workspaces know to be the person's, less those unticked
  (a hub asks all its workspaces). A computer whose copy of the identity was recovered elsewhere
  vouches for nothing until it is copied there again, and says so in its log.
- **Identities kept before logs** are given one from their key, with a recovery key made then; the
  same for every process upgrading at once (the recovery key made once, the inception dated 0).
  Identity lines copied from an older kuraa are refused, to be copied again.
- **Not yet:** trustees, escrow and attestations (step 6); cutoffs for content commits signed by a
  revoked signing key (step 4: until then a revocation counts from when a device takes it, as 0035
  had it). The protocol version is unchanged: an older kuraa and this one still sync, but neither
  takes the other's vouches, so each names the other's people only once both are updated.

### 2 · The policy, groups, admins and members (`peers/policy.ts`)

- **Records, not a git ref (a deviation from *The workspace's root and policy* above).** Each
  operation is a `policy` record, signed by the person's signing key (the identity that vouched for
  it made it) and naming the operations its maker had seen (`parents`), so they form a graph every
  device holds alike, passed on as membership records always were (0050: by hash, only what is
  missing). A git ref would have needed its own fetching and merging for no gain: what makes it a
  history is the parents and signatures, which records carry as well. Commits naming the policy
  they were made under (`Kuraa-Policy`) come with step 3; `Policy.version` is the hash they will name.
- **The same everywhere.** Operations are put in one order (parents first, then by hash); each is
  checked against the policy as those before it left it; one whose parents are not all known
  waits. Operations are `genesis`, `grant`, `revoke`, `join` and `seal`.
- **Genesis.** A workspace made now is pinned to its genesis (`kuraa.genesis`), naming whoever made
  it its admin; every invite link carries it, and a device joining takes it from the link, so no
  later genesis counts. The workspace's ID stays what it was (random): the pin, not the ID, is what
  proves the root.
- **A workspace from before** has no pin: each of its devices, when it starts, writes down a
  legacy genesis naming everyone it knows of, and all of them count together (everyone an admin, as
  everyone had the same say: 0038). The first change an admin makes seals them (a `seal`
  operation naming those that count); a legacy genesis made after counts for nothing. Until that
  first change, a member could still name more admins by a legacy genesis of their own, as anyone
  could do anything before. A device joining never writes one.
- **Groups**: `workspace`, and any its admins make. Admins of a group change it, and the
  workspace's admins change any. Out of the workspace is out of every group; the workspace keeps an
  admin; anyone may leave. A group may hold groups, as members.
- **What admins alone do, now:** make invite links (a link carries a *grant*, the group and role
  its holder gets, signed by an admin's signing key with the genesis; a device letting someone in
  checks it, and the person let in records a `join` with it, once for a link for one person),
  remove devices and make the secret anew (a device takes `remove` and `secret` records only from a
  device whose person is an admin, once there is a policy), and change who is in groups. Links made
  before carry no grant and let no one into a workspace with a policy. Anyone still reads and
  changes everything (step 3), renames their own device, and leaves.
- **Every computer that syncs has an identity**: one is made for whoever runs a host, named as git
  names them, else after the device, where none was (servers included), since roles are people's.
- **Where it shows.** Workspace settings list the people with their roles; admins see **Make
  admin**/**Make member**, **Remove…** (the person and their devices) and **Invite people…**, whose
  dialog makes a member unless **They can invite and remove people too** is ticked; others are
  told only admins invite and remove. CLI: `people`, `role <person> admin|member`,
  `remove-person`, `invite --admin`. HTTP: `POST`/`DELETE /api/peers/people/<id>`, `role` on
  `POST /api/peers/links`, `people` in `GET /api/peers`.
- **Protocol 3.** A device that holds to the policy and one that does not would disagree about who
  is in the workspace, so they do not sync until both are updated (0051).
- **Not yet:** concurrent changes are settled only by the order above (removal-wins and cutoffs
  are step 4); group management in the app beyond the workspace's roles comes with step 3, where
  groups first matter.

### 3 · Who may change what, and suggestions (`peers/gate.ts`, `peers/suggestions.ts`)

- **Rules** are `rule` operations (a path: `''`, `dir/` or a file; and who: people, `group:<name>`,
  `admins`); only the workspace's admins make them; a rule naming no one is taken away. The most
  specific counts; with none, anyone may change a file, so a workspace without rules works as before.
- **Where work comes in** (every merge the host makes: from devices and from the online copy),
  each commit new to this side, merges left out, is judged by the person whose signing key signed
  it (an unsigned one is no one's). A file whose last such change is by someone who may not change
  it keeps this side's version (or stays away); the merge says so in words ("Kept chapters/two.md
  as it was: not Bo to change") and keeps the change on record (`Kuraa-Refused: <commit> <path>`).
  Where the other side holds this one, a merge is made all the same. A later change by someone who
  may takes the file up, refused change and all. The merge brings the refusal back to the device
  that made the change, so its copy comes back into step too.
- **Which policy judges** (a deviation from *Content commits say which policy they were made
  under*): signed commits name the policy's heads (`Kuraa-Policy`), and a device that does not hold
  them yet waits before bringing that work in (tried again every few seconds; records come with
  every hello). It then judges by the policy it holds, which is that much or more: a rule made at
  the same time as someone's edit applies to it, as yet unmerged, which is the outcome wanted. Two
  devices holding different amounts of policy may make different merges, but every merge brings
  what was kept to the other side, so they end the same; the stricter judgement holds once any device
  has made it.
- **Merges are trusted**, still: one carrying changes of its own beyond its parents' would slip
  them past the rules. Checking merges by making them again is for step 4, with the cutoffs.
- **Live rooms**: a device takes edits only from devices whose person may change the document,
  and sends its own to every device with it open, so all read along; of the devices that may, the
  lowest key commits it, and one that may not never does; a device that may not takes the room of
  one that may, never the other way round, and never takes a room's state from one that may not.
- **On this person's own copy** nothing is held back: the editor opens a document they may not
  change read only, saying who may (the rich view and Source), and their app sends no edits; one
  made anyway (another editor, plain git) is committed as theirs, and becomes a suggestion on
  every other device, and leaves their copy when the merge that kept it comes back.
- **Suggestions** are read from the branch's history: commits refused by a merge, and commits made
  as suggestions. **Suggest a change…** (or `POST /api/suggestions`) commits the text as the
  person's, marked `Kuraa-Suggestion`, then at once commits the file back as it was, marked
  `Kuraa-Suggested` (so their copy does not change, and every device bringing the two in keeps its
  own version and has the suggestion on record). A suggestion stays open until seen to: a commit
  that changes nothing, `Kuraa-Resolved: <commit> <path>`, by someone who may change the file
  (Accept, which first puts its text in the live document as their edit; or Dismiss) or by whoever
  suggested it (taking it back); or until the file has that text anyway. A document's open
  suggestions are listed above it; each opens like a past version, compared with now as a change
  (what it takes out, what it puts in).
- **Where it shows**: Workspace settings' **Who can change what** lists the rules and the groups;
  admins add and remove rules (a path, and who, from the admins, the groups and the people) and make
  groups and change who is in them. CLI: `rules`, `rule <path> [<who>…]`, `group <name>
  add|admin|remove <person>`. HTTP: `GET /api/access?path=`, `POST /api/suggestions`, `POST
  /api/suggestions/resolve`, `GET`/`POST /api/rules`, `POST /api/groups/<name>`.
- **Not yet:** checking merges (step 4); rules kept inside private spaces (step 5); suggestions
  are of whole files, on the branch checked out, and suggesting is done on the document's source
  text, not in the rich view.
