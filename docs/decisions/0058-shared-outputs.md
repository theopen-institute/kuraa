# 0058 · Run outputs reach the other devices, on a git ref of each device's own

*Since [0062](0062-outputs-as-they-happen.md): runs also go at once, as they happen, to the connected
devices with the document open, on a channel of the connection; git is what every device ends up
with. Outputs are fetched apart from the branches, in a queue of their own; publishing waits 100 ms
after a first change (then a second between publishes), and telling the others 20 ms.*

Outputs are never written into a document ([0011](0011-running-chunks.md)): each device caches the
latest run of each chunk in `.git/kuraa/outputs/` and shows it to the people using it. In a shared
workspace that meant a chunk run on one computer showed its output on that computer only. Now each
device publishes its outputs, and the other devices show them beside their own.

**Where they go: `refs/kuraa/outputs/<device key>`.** Git refs need not be branches
(`refs/heads/…`). Tools already keep data beside a project's history this way: GitHub Pages' built
sites, `git notes`, pull requests (`refs/pull/…`), Gerrit's changes (`refs/changes/…`). A ref outside
`refs/heads` is not listed as a branch, is never checked out or merged, and is not sent by `git
clone` or a plain `git push`. kuraa's backups and its online copy push branches only, so outputs go
to neither. Each device's outputs are a commit of that device's own ref:

- **A commit with no parent**, made anew when the device's cache changes (a second after a burst of
  runs). Nothing piles up: git's cleanup removes old outputs once no ref holds them, and refs outside
  `refs/heads` and `refs/remotes` keep no reflog to hold them.
- **Signed** with the device's signing key, as its commits are ([0035](0035-identities-and-signing-keys.md)).
- **Its tree:** `runs/<sha1 of the path>/<run id>.json` for each finished run, as cached;
  `images/<sha256 of the bytes>` for each plot, out of line, so a plot shown by several runs (or
  published again) is one blob that is fetched once; and `hidden.json`, the runs of other devices
  cleared on this one.
- **At most 64 MiB:** the newest runs first, until the limit; older ones stay on their device.
- Written by `git fast-import` (one process), with plots already published named by their blob
  rather than written again; nothing is published when the tree is the same as the last.

**How they travel.** With the existing sync between devices ([0028](0028-peers.md)):

- Hellos and `refs` messages say which outputs commits a device has (`outputs`: device key →
  commit), beside its branch tips. A device fetches when the other has an outputs commit it lacks,
  as it does for a branch.
- A fetch takes `+refs/kuraa/outputs/*` into `refs/kuraa/fetched/<remote>/`. Of each member's
  outputs, the device keeps the newest it hears of, by the commit's time, under its own
  `refs/kuraa/outputs/<that device's key>`. It never takes another device's version of its own
  outputs, and never takes outputs of a device that is not a member.
- Outputs are passed on: a device that took a member's outputs offers them to the others. One
  passed on is taken only if signed by the signing key its device said it uses (or, if it has not
  said, only when fetched from that device itself), so no member can pass off outputs as
  another's.
- A device removed from the workspace: its outputs are dropped.
- Devices running an older kuraa ignore the new field and fetch branches only; the protocol version
  is unchanged.

**How they look.** `GET /api/runs` returns this device's cached runs and the other devices'
published ones; each from another device carries `device`, the name it goes by here. People with
the document open are sent each new run (`run`) and each one gone (`runs-removed`) as outputs come
in. The client already shows a chunk's newest finished run, by when it was queued, so the newest
output wins whichever device it came from, and is dimmed as before when its code, or code above it,
has changed since ([0024](0024-out-of-date-outputs.md)). Its line says where it ran, and the day
when not today: "Ada · on ada-laptop · 20 Nov 14:02 · 1.2 s".

**Clearing.** × under an output clears it for everyone with the document open on this device (they
are sent `runs-removed`, which they were not before). An output another device made is hidden here
at once and listed in this device's `hidden.json`. Every device then hides it, and the device that
made it forgets it, so publishes it no more. Clearing a whole document hides every run of it other
devices made. A device keeps the last 2,000 it cleared. Clearing no longer needs the device to run
code.

**Not covered.** A run's `by` is who asked for it, as their device said, as before. The signature
says which device published it. Outputs are matched to chunks as before (by label, code, position),
across devices as on one: two devices running different versions of a chunk each keep their own
output, and the newest is shown. Images are read from git each time a document's runs are asked
for. The online copy (GitHub) does not carry outputs: a device that is never online with another
sees none of its outputs.
