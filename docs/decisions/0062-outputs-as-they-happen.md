# 0062 · Run outputs reach the other devices as they happen

[0058](0058-shared-outputs.md) sends run outputs between devices by git: each device publishes its
cache as a commit of its own ref, and the others fetch it. That works for every device, connected
or not, but it is slow to see: a chunk run on one computer took a second and a half to show on
another with the document open, on one machine; more across a network. The owner's direction:

> "The rmarkdown run outputs take a while to sync among clients … suggest how that might be
> improved to be more responsive" — then: "do all that".

## Where the time went

Measured with `KURAA_TIMINGS=1` (below), two devices on one computer, a run finishing on one and a
person with the document open on the other told of it:

| Step | Before |
| --- | --- |
| Publishing waits for more changes | 1,000 ms |
| Publishing (every cached run serialised and every plot hashed again) | ~100 ms |
| Telling the others (`refs`) waits | 200 ms |
| The other fetches (a `git fetch` over the connection) | ~120 ms |
| It reads the commit (every run in it parsed again) | ~55 ms |
| **In all** | **~1,525 ms** |

Over the internet each fetch is several round trips more, and outputs were taken only inside a
device's branch sync, so they waited behind merges and rooms settling while people edited.

## Not Yjs

Outputs have one writer, the device that ran them, and the newest wins: a CRDT's merging buys
nothing. A Yjs document keeps its history, so plots in one would pile up for good, and putting
outputs in the document's own room would put them in the document, which [0011](0011-running-chunks.md)
rules out. What Yjs gives rooms is a way to send changes at once over the connection; outputs now
have that too.

## Sent as they happen, beside git

Rooms already work this way: live edits go over the connection, and git keeps what everyone ends
up with. Outputs now do the same.

- **A channel of their own**, `kuraa/outputs/1`, on the connection between two devices
  ([link.ts](../../packages/host/src/peers/link.ts)): a message's fields as JSON, its plots beside
  them as bytes (not base64), each plot once however many times a run shows it.
- **What goes:** each change to a run of this device's (queued, running, finished, cancelled), as
  this device tells the people using it, to the connected devices with that document open (rooms
  say which: [rooms.ts](../../packages/host/src/peers/rooms.ts)); a device that opens the document
  while a run is under way is sent it. Clearing goes to every connected device: this device's own
  runs (`gone`), and other devices' (`hide`, which the device that made them forgets, as with
  `hidden.json`).
- **Whom to believe:** only a device's own runs, and only from that device: the connection proves
  which device is at the other end (Noise), as it does for rooms, and it must be a member. Nothing
  sent this way is passed on; devices not connected get it by git, as before.
- **Kept until git catches up.** What came this way is kept beside the device's outputs commit, in
  memory: a finished run until a commit of the device holds it (or one made more than two seconds
  after the run finished does not: cleared there, or left out); a run under way until it finishes,
  is cancelled, or the device goes. Restarting loses nothing: git brings it.
- **Too large to send at once** (8 MiB with its plots): left to git.
- **Older devices.** A device running an older kuraa never opens the channel; nothing is sent on it
  until the other end has (a message for a channel never opened would wait at the other end, and
  enough of them would hold the whole connection up). It gets outputs by git, as before; the
  protocol version is unchanged.

**How it looks.** Another device's run under way shows on the chunk as "Running on ada-laptop… 3 s"
(or "Queued on …"), with no **Stop** (Stop interrupts this device's runs), and Run offered as
usual. It is not counted as this device being busy, nor as a step of this device's session (a
session is each device's own). `GET /api/runs` lists other devices' runs under way among `pending`.

## Git, quicker

Git stays what every device ends up with, and is quicker too:

- **Publishing** waits 100 ms after a first change, then no sooner than a second after the last
  publish, so a burst of runs is still one or a few commits. A run is serialised (and its plots
  hashed) once, not on every publish, and a run already written is named by its blob. The runner
  reads a document's cache file again only once it has changed.
- **Telling the others** that outputs changed waits 20 ms, not 200 (branches still wait 200: they
  come in bursts).
- **Fetching outputs** is a queue of its own, apart from the branches': its own `git fetch`, of
  `refs/kuraa/outputs/*` alone, so outputs never wait for a merge or rooms settling. The branches'
  fetch no longer takes outputs.
- **Reading** a device's next commit reads only runs whose blobs are new.

## Measured after

The same two devices: **about 50 ms** from a run finishing on one to the person on the other told,
by the new channel; by git alone (a device without the document open, say) about 400 ms where it
was 1,525 ms.

**Timings.** `KURAA_TIMINGS=1` logs each step: publishing, fetching outputs and branches, taking a
device's commit, and each run that came as it happened, with how long after it finished.
