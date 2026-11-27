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
| Reads | what its person reads | the workspace's own files, and each space whose audience names it |
| Writes | what its person may change | nothing |
| Acts in the policy | as its person may | never, but its own join |
| Taken out by | a `drop` of its key: its person, an admin (the owner, for an admin's) | a `drop` of its key: the owner |
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
- **Taken out by a `drop`** of its key, the owner's to make, for good, as a computer is. A drop at the
  same time as its join beats it (a drop beats what its key signs).
- **Not a person in any group.** A grant naming a server's key counts for nothing. Audiences may name
  it, by its key: that is how it reads a space.
- **`mayRead`**: a server reads the workspace's own files, and a space whose audience names it.
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

## In the app

Workspace settings' **People and computers** has **Servers**, beneath the people: each server by its
devices' name, how it is connected, and, for the owner, **Remove…**. The owner's **Add a server…**
makes an invite link for one server, for a week, and says to give it to `kuraa-server join` on the
server. The sidebar says *Syncing with the server* where it is
the only other device. Removals list *The server … removed*.

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
