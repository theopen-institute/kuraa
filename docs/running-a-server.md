# Running a server

For whoever runs a Kuraa server for a team: what it holds, who can read it, how to look after it, and
what to do when something goes wrong. How to install one is in the [README](../README.md) (*A server
in your workspaces*); why it works as it does is in decisions
[0099](decisions/0099-servers.md), [0110](decisions/0110-the-owner-reads-everything.md),
[0112](decisions/0112-server-hardening.md) and [0115](decisions/0115-server-review.md).

## What it holds, and who can read it

A server is always on, working for each workspace's owner. It holds a full copy of every workspace
it is in, **every space too**: files only some people read are on it as well
([0110](decisions/0110-the-owner-reads-everything.md)). It changes nothing in them.

So **whoever controls the computer it runs on can read everything in those workspaces**: you, anyone
with root on it, and the company hosting it. The server's folder (`~/.kuraa/server-data`) is
readable by the user it runs as alone, which protects it from other users on the computer, not from
an administrator or a hosting company. Run a server only where the workspaces' owners would trust
that.

To keep it that way:

- **A user of its own.** Run it as a user that does nothing else.
- **An encrypted disk.** Then a disk taken out, or thrown away, gives nothing away.
- **Snapshots and backups hold everything too.** A hosting company's snapshots of the disk hold every
  workspace; deleting a workspace from the server does not delete it from them.
- **The release key reads everything as well.** A server that updates itself runs whatever is signed
  with the release key; with every space on it, that key is trusted with everything. If that is too
  much, install its service with `--no-auto-update` and update it yourself (`kuraa-host update`), or
  build releases with a key of your own (`KURAA_UPDATES`, `SERVER_SIGNING_KEY`: see the README's
  *Releases*).

The workspaces' owners hold everything too, on their own computers (0110): their laptops want an
encrypted disk as much as the server does.

## What to back up

- **Its key**, `~/.kuraa/server-data/signing.json`, and the device keys, `devices/`. The key **is**
  the server: copied to a new computer, the server is the same server there, in every workspace.
  Whoever has a copy of it can act as the server, so keep the backup encrypted.
- **Not the workspaces.** Every member has a copy, and the owner's computers have all of it. A server
  whose disk is lost copies each workspace again when it is invited back.

Never run two servers from the same key at once (a restored backup beside the original): they would
be the same devices twice. One server runs from a folder at a time; a second refuses to start there,
but a copy of the folder elsewhere would not know.

## Ports, logs and updates

- **Ports:** 5872, TCP (members' connections) and UDP (its DHT node), open in its firewall. Its API,
  on 4322, is for its own commands, on this computer only.
- **Logs:** `journalctl --user -u kuraa -f` on Linux. On macOS, `~/.kuraa/server/kuraa.log`, which
  nothing trims: rotate it with `newsyslog`, or remove it now and then (the server goes on writing a
  new one after a restart).
- **How it stands:** `kuraa-host server status` says the release it runs, since when, how it updates,
  and for each workspace whether it is in, how many members' devices are online, when work last came
  in, and how much room it takes.
- **Metrics:** `GET /hub/api/server/metrics` on its API, with its access code as a bearer token (in
  `server.json`), answers the same in Prometheus's text format: when it started, the room left on its
  disk, and for each workspace, by its ID (never its name), whether it is in, its members' devices
  online and known, and when work last came in. Its API is on this computer only, so a monitor runs
  there too, or reaches it through a tunnel.
- **Updates:** with `--auto-update` (as its service runs it), it looks every six hours and restarts to
  update at night. A release that changes how devices sync is held until a device of its workspaces
  runs it (devices of two of its workspaces, where it holds more than one), as devices still on the old
  one would no longer sync with it; `--auto-update-all` takes it at once. A release held is kept
  through a restart. `kuraa-host update` takes the latest now, for the next start. If a new version fails to
  start three times, it goes back to the last one that ran well.

Members see whether the server holds their latest work, in its view under **People**. One that has
not for a while is marked *behind*, and members stop relying on it to pass work on. The same view
says how the server says it stands: the room left on its disk, and when it last took in work, and
warns when it has stopped taking work in for want of room. If that happens, see that it runs
(`server status`), that it is up to date, and that its disk is not full (it fetches nothing with less
than 1 GB free; with less than 10 GB, one workspace at a time, each no more than the room left).

## Taken out of a workspace

- **Removed** by the owner (*Remove from workspace…*): it stops syncing there as soon as it hears,
  and keeps its copy **a week** (`--keep-removed-days`), in case the removal was a mistake: invited
  back within it, it takes up where it was. After that, if it is still out, it deletes the copy.
  `server list` says *removed* meanwhile.
- **Blocked** by the owner (*Block this server's access…*): its key can never join that workspace
  again, and it deletes its copy as soon as it hears. Only for a key that may be in someone else's
  hands. A server removed before can still be blocked, from **People › Removed servers**; no longer
  connected, it does not hear it, and deletes its copy when the week is out.
- **Its own key given up** (`server new-key`, below): its copies kept until the second step.

`server remove <id>` lets a workspace go from the server's side: its copy deleted, though the server
stays in the workspace until its owner removes it.

## When its key may be in someone else's hands

1. While the server runs: `kuraa-host server new-key`. It blocks its own key in every workspace it
   holds, at once, and says which had a member online to hear it.
2. Stop it (`systemctl --user stop kuraa`), and run `kuraa-host server new-key` again: every
   workspace's copy is deleted, and then the old key put aside in `keys-retired/`. It refuses where
   the first step did not block the key in a workspace, or no member was online to hear it there
   (else no one would know the key is no longer to be trusted): start the server again, wait until a
   member is, and run the first step again. It runs only in a server's folder.
3. Start it again: it makes a new key. Ask each workspace's owner for a new link for a server
   (**People › Add a server…**), and `server join` each.

If the server cannot run (the computer is gone), `new-key --force` on a new one starts afresh, and each
workspace's owner blocks the old server themselves.

## When its disk is lost

Install a new server. With the old key and device keys from the backup, it is the same server, but
holds nothing yet: ask each owner for a link for a server (**Add a server…**) and `server join` it;
it joins as the server it was, and copies the workspace again. Without the backup, it is a new
server: each owner adds it, and removes the old one, or blocks it if the old disk may be in someone
else's hands.

While a workspace has no server, its members still sync with each other, and merge among themselves.
What they lose is being let in, and syncing, while everyone else is away. Work that had reached only
the server, and no member, is gone with it.

## One server or several

A workspace may have more than one server; between two, only one makes the merges, as between two
people. A server may hold many workspaces; each is opened when it starts, a few at a time, and each
connects to its members on its own.
