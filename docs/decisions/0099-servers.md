# 0099 · Servers: always-on devices with no person

**Status: built (the first part).** It adds to the policy ([docs/policy.md](../policy.md)), to which
devices are in ([0072](0072-ranks-devices-and-changes-not-kept.md)) and to the write gate
([0066](0066-permissions-without-a-centre.md)). `PROTOCOL` is now 9: a device running an older kuraa
could not read a server's join, and every operation after it names it, so it would wait for them
for ever.

The owner's direction:

> "I would like to start building in server functionality. Package this into a module, like
> everything else. […] First, it should be able to provide an "always on" node for workspaces.
> Owners should be able to designate one or more servers to act as identity-less nodes."

And, asked whether a server reads what it holds and whether it has one key for all its workspaces:

> "Yes, start with option (2), and we can build more or less secure ways of moving beyond that in
> the future. For keys, also yes. Unless there are any significant security downsides to a common
> key. I want to maintain parallelisms to standard users as much as possible, with the addition of
> necessary constraints and the lack of a personal identity."

A server is a host that is always on, at a public address ([0079](0079-host-not-server.md)). Until
now it could only be in a workspace as someone's computer: its person's, reading what they read, its
commits theirs. Now it can be in as itself.

## A server, as a person's computer is, without the person

| | A person's computer | A server |
| --- | --- | --- |
| Its key | the computer's signing key (`~/.kuraa/signing.json`), one for all its workspaces | the same: the server's signing key, one for all its workspaces |
| Why it counts | the person's identity vouches for the key, and the policy has the person in | the policy names the key itself, as a server |
| Comes in by | an invite link (an admin's), its person's `join` | an invite link for a server (the owner's), its own `join` |
| Reads | what its person reads | the workspace's own files, and each space whose audience names it (since [0106](0106-the-owner-reads-everything.md): everything, every space too) |
| Writes | what its person may change | nothing |
| Acts in the policy | as its person may | never, but its own join |
| Taken out by | its person taken out (a `revoke`), or one computer dropped (a `drop` of its key, for good) | the owner: taken out (a `revoke`, to be invited back), or its key dropped (lost or stolen, for good) |
| Each workspace's device | its own key, which `signs` with the computer's key | the same |

**One key for all its workspaces** is what people's computers have already: anyone in two
workspaces with the same server can tell it is the same one, as they can tell a person is. A key
stolen from a server lets the thief be it everywhere, but whoever can take its key can take what it
holds too, which is everything it is in. The owner of each workspace takes it out with a drop, as a
lost laptop is.

**No identity** means no name of a person, no recovery key, nothing vouched: a server is known by its
key and what its devices call themselves. A computer that keeps a person's identity cannot be a
server (its key is that person's): a server's join signed by a key someone vouched for counts for
nothing, and a server that later gets an identity stops being one.

## In the policy

- **`join` with role `server`.** The owner makes an invite link for a server (the grant says
  `server`, for the workspace, for one); a device in the workspace lets the server in by it
  (`admit`, as for anyone); the server signs its `join` with its key. It counts only if the grant is
  the owner's, the link is neither used nor unlinked, and the key is no one's. Then the key is one of
  the policy's **servers**.
- **A server signs nothing else that counts.** Its key is no person's, so the policy takes no other
  operation of it, as with any key that is no one's. "Only people's word" holds, with the one
  exception of a server's own join.
- **Taken out as a person is**, by the owner: a `revoke` of the workspace naming its key. It is out,
  its cutoff on record, and may be invited back: its join by a new link counts again. (So since
  `PROTOCOL` 10; before, a server was taken out only by a drop.)
- **Its key dropped, for good**, by the owner, when someone else may have it (lost or stolen), as a
  computer's is: no link lets that key in again. A drop, or a taking out, at the same time as its
  join beats it.
- **Not a person in any group.** A grant naming a server's key counts for nothing. Audiences may name
  it, by its key: that is how it reads a space.
- **`mayRead`**: a server reads the workspace's own files, and a space whose audience names it.
  (Changed by [0106](0106-the-owner-reads-everything.md): a server reads every space.)
  Not by `admins` or a group.
- **`mayWrite`**: never. Not by a rule naming it, not where there is no rule, not its own files.

## Devices, commits and rooms

- **A server's devices are in** where they sign with a key the policy has as a server, not dropped.
  Who such a device is (where people's devices have their person's identity): the server's key.
- **It authors nothing.** A commit signed by a server's key changes nothing in anyone's copy: every
  device judges commits wherever the workspace has a server, rule or none, and refuses what a
  server's key signed, keeping its own version, as with anyone who may not change a file.
- **It merges, as any device does.** A merge carries no one's change (0077): every device makes it
  again and judges only what it holds beyond that. So a server brings members' work together while
  they are never online at once: Ana's work reaches it; Bo's, made apart, reaches it; it merges them;
  each takes the merge when they come back.
- **It never leads a room**, nor are its edits taken in one: only devices that may change a document
  lead its room, and a server may change none.
- **A refusal by the policy** anywhere (a new document asked for where one may not make it, say)
  is a 403, not an error.
- **Its devices confirm removals**, as people's do (0072's witnesses, which waited for servers): the
  removal says *confirmed by* the server once it holds it.

## The module: `@kuraa/server`

The rules above are in the host's peer layer (`policy.ts`, `identity.ts`, `node.ts`, `gate.ts`),
because every device must keep them, server or not: they are the published contract. What a server
does is in a package of its own, `packages/server`:

- **`kuraa-server`** (`pnpm server`) runs a host as a server: everything in a folder of its own
  (`~/.kuraa/server-data`, or `--data`), no identity made or used, no code run, and a server's flags
  (`--public-address`, `--peer-port`, `--dht-port`) said up front. **Its key is its own**, kept in
  that folder, not the computer's (`~/.kuraa/signing.json`): run on someone's laptop, that would be
  their person's key, and a server's join signed with it counts for nothing. Where it is reached
  (`server.json`: its address and access code) is written there too, readable by whoever runs it
  alone, for the commands below to ask it.
- **Headless, for now.** The owner, on seeing that the server's page served the app:

  > "I don't want the app served at all right now. The server should be headless for the time
  > being, until we have a chance to set up a user login infrastructure of some sort."

  So a server serves no page and no workspace's API: its port (4322, on 127.0.0.1 unless `--host`
  says otherwise) answers, with its access code, only the list of what it holds and whether each
  workspace took it in (`GET /hub/api/server`), a join by a link for a server (`POST
  /hub/api/workspaces`, kind `join`) and how a join is going; anything else, with the code or
  without, is refused (404), and no WebSocket (rooms) is taken. Each workspace's own host on the
  server (on this computer only, as in any hub) has an access code no one is told. It makes no
  workspace of its own. Members reach it only by the peer network (as any device: the DHT, the local
  network, its TCP address), which carries what devices of the workspace send each other.
- **`kuraa-server join <link>`** brings a workspace onto the server, by an invite link for a server.
- **`kuraa-server list`** says which workspaces it holds, and whether each has taken it in.

## One program, a server by role

The owner, asked how a server is installed and run, and whether it updates itself:

> "Yes, give it functionality as a service, running for production unattended. […] Ultimately, I
> want the "server" to be identical to the base application, but with different constraints and a
> few added functionalities (like relay and multi-user login)."

> "One program with a server mode/role is what I want."

So there is one program, released as before (0052), and a server is that program in a role:

- **`kuraa-host server [flags]`** runs it as a server (`server join`, `server list`, `server key`
  likewise); `kuraa-host [flags]` is a host, as it was. `pnpm server` is the same from the
  repository. The words follow [0079](0079-host-not-server.md): *host* is the program, *server* a
  host in that role.
- **Its names stay** (`kuraa-server-<version>.tar.gz`, `kuraa-host.mjs`, `~/.kuraa/server`, the
  service `kuraa` / `org.kuraa.server`): installed computers look for and run them, and a rename
  would leave them behind, never updating again.
- **As a service, unattended:** `kuraa-host install --service -- server <flags>` writes the service
  (systemd for the user, with lingering; launchd on macOS) that runs `kuraa-host --auto-update server
  <flags>` with an access code of its own (never printed), started again whenever it stops. It takes
  signed releases (0052) and restarts at night, or at once when a device of a workspace runs a newer
  kuraa; a signal saves everything before it stops; an error nothing caught is said and the server
  goes on, and too many in a row stop it for the service to start it again (`lastresort.ts`).
  `install` says how to bring a workspace onto it. One service per computer: a host's or a server's.
- **In the code**, the release's entry is `@kuraa/server`'s `release.ts`: it picks the role
  (`roles.ts`: `server` first, after `--auto-update` where a service puts that), and runs the host's
  command line (`@kuraa/host/cli`) or the server's (`runServerCli`). The host knows nothing of the
  server package; the server package is the host with its constraints and, later, what it adds
  (relaying, signing in).

## Its port: 5872

The owner, asked for a default port: "Not something like 8443 that's used by many other programs."

Members reach a server on **5872** unless told otherwise: TCP for their connections (`--peer-port`),
UDP for its DHT node (`--dht-port`), one number for both, as the two are apart. It spells KURA on a
phone's keys, and IANA's registry has it, and 5871 and 5873 to 5876, assigned to nothing, for TCP or
UDP. It is a registered port (1024 to 49151): a service may listen on it, as it may not on one below
1024 (443, say), and the system never hands it out for its own connections, as it may one above
49151 (the README's example DHT port before, 49737). 0 asks for any free port (the tests do). A server joining its first workspace takes these ports at once: the connection the join makes goes on as the workspace's, and it opens the process's TCP listener and DHT node, so it is given the server's ports too (before, the first workspace joined left them on any port until a restart, `--peer-port` or not). The
host's own ports are unchanged (4321, assigned to `rwhois`; the server's API 4322, to `trim-event`:
both on this computer only).

## In the app

*(Since [0107](0107-people-first.md): **People** › Servers, with **Remove…** only; **Block…**, for a
key someone else may have, under **Lost or stolen computers and servers**, at the end.)*
Workspace settings' **People and computers** has **Servers**, beneath the people: each server by its
devices' name (one online first, of several), how it is connected, and, for the owner, **Remove…**
(taken out; invited back with **Add a server…**) and **Key lost or stolen…** (for good, asking first).
A server's devices are not listed among other computers, so none is removed by "Lost or no longer
used…", which would drop the whole server's key. The owner's **Add a server…** makes an invite link
for one server, for a week, and says to give it to `kuraa-host server join` on the server (`pnpm
server join` from the repository). The sidebar says *Syncing with the server* where it is the only
other device. Removals list *The server … taken out*, or *The server …'s key removed for good*.

## Joining, as it goes

The owner, after a server's join that went quiet, gave up, and was found to have been removed:

> "So, once a server has been removed, it can never be joined again? That seems like a bad design."

So, besides being taken out to be invited back (above):

- **A device joining waits for its own join** before it takes itself to be out. The records it is
  sent first say what was (a server taken out, someone invited back); its join comes after. Out even
  then, the join stops at once and says why: its key removed for good, or a link that did not let it
  back in (it used to stop silently, and the join report a copy that "could not fetch").
- **`kuraa-host server join` waits however long the copy takes** (it gave up after five minutes, the
  join going on unseen), and says how it goes: looking, being let in, copying with git's own words
  (`Receiving objects: 45% (…), 12.3 MiB | 1.2 MiB/s`) at each tenth of each stage, and in the
  server's log too. The first copy is stopped only once it has been quiet for five minutes, not after
  ten minutes, however long it is. `join` and `list` wait a while for a server that is (re)starting.
- **A device on a newer release tells the others** (`version` in its hello, from releases and the
  desktop app; never from `pnpm dev`): a server then looks for the update at once (restarting at
  night, as it is not urgent), and the desktop app checks. Once an hour at most, whatever devices say,
  and only signed releases are taken (0052), so a device that says so falsely makes nothing happen
  but a look.

## An audit, and what it changed

The owner asked for an audit of the whole of it, for security, efficiency and reliability, and then:

> "fix them all, starting with the rollback, before moving forward with the release if possible."

Three reviews, made apart, found about forty-five things; each was checked against the code before it was
fixed, and each fix has a test.

**Updates.** A release that does not start can no longer leave every server that took it stopped for
good. The launcher counts the starts of the version `current` names; a version that runs well for
two minutes writes itself to `good`; three starts without that, and the launcher goes back to the good
one and marks the other `failed`, never to be taken again (a later release is). The launcher, which
never changed before, is rewritten by the first version that runs well with it. A release says the
Node it needs (`engines.node`), and one this Node cannot run is not put in place. A release servers
update to is signed, or not built (`KURAA_UPDATES` without `SERVER_SIGNING_KEY` fails); one built
without the key does not update itself. What a device says of its version, or protocol, counts only
from a device in the workspace, once an hour.

**A server changing nothing, for good.**
- A commit no one known signed (unsigned, or by a key that is no one's here) is the device's it came
  from: from a server, or from a device that is no one in the workspace, refused; from a person's,
  judged as theirs. (Before, a server changed anything where no rule said otherwise by not signing.) A
  device's own commits, on the other side of a merge it makes, are its own.
- A merge's word that it kept a file out ("Kept f as it was: not Bo to change") is taken only where
  this device would keep that change out too; and a merge a server made is made again here whatever
  version of merging it names (else, naming another, it could take one side's text and undo the
  other's change unseen).
- A server lets people in by their links while every member is away, as the owner then asked ("yes,
  do now"), with what it hands over checked: its `admit` counts (the link's grant, an admin's, is what
  lets them in; the admit, only that the link held when it did); the secret it gives must be the
  latest a person's device made, where the records say one; and its first copy is judged as work
  coming in from it. An invite link now carries its maker's branch tip, signed with the rest: the copy
  must hold it; what came before it is the workspace's own history, taken as it is (unsigned commits
  there are not the server's); what came after is judged, what no one known signed being the server's,
  and a copy whose files hold a change so refused is not taken. (A server's merge, which the device
  joining cannot make again yet, having no document types, could still drop one side's change from
  the copy; the members refuse that merge, and the device takes their history back the first time it
  syncs with one.) A link made before this, with no tip, is not joined through a server.
- A device that is no one yet (let in by a link, its join not come) edits no live room and leads none.
- The workspace's secret, invite links and their revocation are taken only from people's devices; the
  latest 32 links are announced, not every one.
- A server taken out stays the owner's to drop for good; **Remove…** unlinks the owner's unused links
  for a server. The HTTP API refuses to remove a server's device as a computer (which would drop the
  whole server's key).
- A tunnel to another workspace's device on the same computer only for a device in that workspace;
  hints (relays, DHT nodes, addresses) only from devices that are someone here; connections not yet
  past their first line limited (256, and 16 from one address); a stranger's records weighed only
  where they could show it in (its person has a place, its key is a server's, or it carries a join an
  admin's grant signed).
- A server's folder and all it writes are its user's alone (0700, umask 077); `server join -` takes
  the link from standard input.
- (Run outputs of documents in private spaces, thought to reach every device, did not: they were never
  published to the shared ref.)

**Its state, whatever stops it.** One server to a folder (`server.lock`, a process gone taken over).
It answers at once, its workspaces opening meanwhile, three at a time (`server list` says *opening…*).
`server.json` is written whole, as soon as the API listens; one left by a process gone is not taken. A
join cut short (the server stopped, the computer off) is taken up where its copy was checked out, and
taken away where not; git's locks a stop left are let go of. Each workspace's device key is kept apart
(`server-data/devices/`), so a join tried again is the same device, not one more the members look for
for ever, and a workspace held already is the one held (joined again where the server was taken out).
A member joining again is welcomed (it waited for ever). Restarting to update waits for a join under
way; stopping never waits more than a minute; an uncaught exception stops it, to be started again; the
service stops the server, not its git processes (`KillMode=mixed`). Records that cannot be read are
said, never taken for none (and written over); damaged, set aside. The workspaces' list is on the disk
for sure before it is used. `server remove <id>` lets a workspace go. A UDP port taken is said.

**Efficiency.** The policy is worked out along the line where nothing was made at the same time (each
operation's past is the last one's with it applied), and whole only where operations were at once: 400
operations in 18 ms, not 6 s (it grew as the cube of the history), the two ways checked to agree over
histories made at random; its memo keyed on the records it is worked out from alone. Each commit's
verdict is kept, by the records it was judged by: judged once, not at every merge and on both sides of
it. Changes are told to the other devices one run at a time, those coming meanwhile together, what
every hello says alike read once (each member's acknowledgement had every device told again). A server
makes the merges, and members take them (else a member with the lower key had to merge, and the work
stayed apart if they left first). A server watches no folder (on Linux a watch for every file, `.git`
included), looks on no local network, keeps no online copy; its first copy may bring 64 GiB, and holds
up no other join; git's housekeeping runs in turn, one thread. A device away a day is dialled every six
hours at most. One link per pair of computers for up to 1024 workspaces. Identity memos keyed by a
hash, not every signature joined.

## Decided after the audit

Asked three things the audit left open, the owner chose:

- **Members who reach each other only through a server sync through it** ("Live editing only"):
  where a member is reached by a tunnel and a server connected here is connected to it too, this
  device does not fetch from it: the server holds both, merges them, and each takes the merge. The
  tunnel stays, for their live rooms, which need a link between them.
- **One presence on the network for the whole server: later** ("Leave for later"). Each workspace
  keeps its own key, its own DHT announcements and a connection to each member, which is fine for
  tens of workspaces on a small server; one presence, with workspaces carried over one connection to
  each member's computer, is for when a server holds hundreds.
- **No limit on git processes at once** ("No limit"): a plain one could leave a fetch waiting on a
  git process of the same server that waits for room under it.

## Not yet (after the audit)

- **One presence on the network for the whole server** (above).
- **Each operation's past held whole** (the policy's): fine at hundreds of operations, heavy at many
  thousands.

## Not yet (in the app)

- **Naming a server among a folder's readers** in Permissions: the policy takes it (an audience
  naming its key), the dialog does not offer it yet.

## Not yet

- **Holding spaces sealed** ([0073](0073-encrypted-spaces.md)): a server holds a private space only
  by reading it.
- **Running code for a device that cannot** (decided before, on hold until servers): to be asked of a
  server.
- **Many workspaces on one server**: each still keeps its watcher, its topic on the DHT and its
  timers. A server should wake a workspace when a member connects, and need not announce what its
  members reach by its address.
- **Signing in from the web**, and the other things a server can do because it is always there.
- **Signing in**, and with it any page a server serves.
