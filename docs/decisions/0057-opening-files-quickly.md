# 0057 · Opening a file does not wait behind the host's other work

*Since [0077](0077-one-leader-per-room.md): a room kept warm stays in its session (it hears everything), and is no longer kept after it closes; a new session starts from the file as read, its first state made afresh.*

Opening a file showed "Opening…", sometimes for seconds. Nothing on the way waited for the network
or another device: the room was opened in the host's one queue (`Host.serial`), behind whatever
was in it (the last file's save and commit, which ran git even with nothing changed; bringing in
another device's work, which saves and commits every room first), and the page showed nothing
until it was ready.

- **Saving with nothing changed runs no git.** A room knows when its file is the branch's committed
  version (`committedHash`: checked with one `git rev-parse` apart from the queue when it opens, and
  kept after each commit). Leaving a file, an autosave, or saving every room before a merge, returns
  at once while nothing has been written or seen changed since. Edits, outside changes and files
  changed before the host started are committed as before.
- **The file shows at once.** The editor reads the file from disk (`GET /api/files`, not in the
  queue) at the same time as it asks for the room, and shows it as it will look, read-only, until
  the room is ready; "Opening…" is said only if there is nothing to show after 250ms. The live editor
  is shown before it is announced ready, so going to a conflict or a search match scrolls to it.
- **Rooms are kept warm.** A room nobody is in stays 15 minutes (`dropMs`, was 1), at most 24 of
  them (the one used longest ago closes first), so opening a file again needs no reading, parsing
  or seeding. The sidebar asks for a file's room when the pointer rests on it (150ms) or is pressed
  on it, at most once a minute per file; a room asked for and not joined closes after `dropMs`.
- **Rooms open apart from the queue.** A room open (or warm) is given at once. A new one is read and
  parsed apart from the queue (`prepareRecord` only reads), then taken only if the branch and the
  file are still as read; otherwise it is made in the queue, as before. A file changed outside since
  its room was kept still opens in the queue, where that change is merged in. A merge that writes the
  file just after the room is taken is brought in by the watcher, as for any open room.
- **A new room is parsed once.** `seedState` takes the file as already parsed when it is a parse of
  that very text; the state is byte for byte the same, so rooms on other devices still combine
  ([0027](0027-room-seeds.md)).
