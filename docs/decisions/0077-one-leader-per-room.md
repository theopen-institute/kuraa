# 0077 · A room is one session, with one leader

> Replaces how rooms start and combine across devices ([0027](0027-room-seeds.md), the rooms of
> [0028](0028-peers.md)), who commits a shared room ([0038](0038-equal-peers.md)) and what a warm
> room is ([0057](0057-opening-files-quickly.md), [0075](0075-review-fixes.md)). `PROTOCOL` is now 7:
> devices running an older kuraa do not sync or share rooms with these until updated.

Git and Yjs are two ways of merging the same text. They agree only while every device holds the
same Yjs history of a file. They did not always: two devices each made the same change from git
into their own rooms (a commit both brought in, a warm room patched), or two rooms started apart
met in Yjs, and the text showed twice; or a room's old text was written over a merge. 0075 fixed
the cases found. This changes the design, so that none of them can happen.

## A session

- **A room is one session on one base.** A session is one Yjs document: started by the first
  device to open the file, from its file, with an id of its own (random); joined by the others,
  from the state of a device in it. Those in it are devices, not browsers: several browsers on
  one host are one device in it.
- **A session's document is never kept or used again once it is over.** When the last device
  leaves it, its text is written, committed, and the document let go of. The next session starts
  from the file. Nothing of a room is kept in `.git/kuraa/rooms` any more, but the text of edits
  that could not be written when the host stopped (saving paused, or failing), to write next time.
  The app's own copy (IndexedDB) and its carrying of edits not yet sent (0075) stay.
- **A room no one is in here stays in its session a while** (`dropMs`, 15 minutes): still open,
  hearing everything, so opening the file again is at once, as 0057 wants. Then the device
  leaves the session. A new session starts from the file as already read and parsed; making its
  first state takes about 15 ms for a document of 200 KB, parsing it about 140.
- **The room's name in the relay is new for each session**, so an app still holding an old one is
  refused, asks again, and carries its edits not yet sent into the new room.

## One leader

- **One device leads a session:** of the devices in it that may change the document (0066), the
  one with the lowest key. Every device works this out the same from who says it is in the
  session; there is no election.
- **Only the leader writes the room's text to the file, commits it, and brings changes into it:**
  a commit come by git (another device's, the online copy's, a pull) or an edit made outside the
  app on its disk.
- **The others never write the file from the room, nor change the room from git.** Their file is
  git's, as it comes; the leader's commits reach them by git. An edit made outside the app on their
  disk (in RStudio, say) is committed there as it is, an ordinary commit, which reaches the leader
  by git and is merged into the room there. A named version asked for on another device is made
  by the leader.
- **When the leader leaves, the next carries on with the same document.** The leader writes and
  commits its text as it leaves, and says on which commit. The next builds on that commit once it
  has it (waiting up to 10 seconds), bringing into the room what its file has beyond it. One
  with a lower key that joins leads once the one leading has made its last commit and said so.
- **A leader gone without a word** (the network) is waited for a while (`rejoinMs`, 5 seconds),
  no one leading meanwhile: back in time, the session goes on as one, since only one side could
  have changed it from git. Else the device with the lowest key left goes on in a session of its
  own (a fork: the same document, a new id), which the others with it follow.

## Edits made apart meet in git

Two sessions of one file never combine. Devices that were apart (a split network, or two that
opened the file at the same moment) meet in git: each side's leader commits; git merges, as ever
(0025), with the policy's gate and conflict blocks; then the devices of the session whose leader
has the higher key move to the other session. Each moves once the other session holds the last
commit of its own and it has nothing in its room beyond that commit; its people's edits not yet
sent are carried across by the app, as when a room is replaced.

A session in which no one may change the document (0066: only those who may only read it opened
it there) has no leader, so nothing in it is ever committed; it moves to the other session at once,
not waiting for a commit that would never come (*later*: it waited, and two devices that opened such
a file at the same moment never met; seen as a test that failed now and then, mostly on CI's slower
machines). Not while the one leading it is only missing for now.

Of two devices, only the one with the lower key now makes merges; the other takes them (as
devices running another version of kuraa did already). Three devices merging each other's merges
at once could each make a new one, and go on so.

## What was removed

Rooms named by their file's git blob, and the fixed client id that seeded them the same on every
device (`seedState`, `encodeSeed`); rooms of different seeds taking one another's room
(`adoptRoom`, the `want`/`state` of a room to replace one's own); merges taking a shared room's
text instead of merging it, and signing such merges; waiting for rooms to settle before bringing
a device's work in; a room left while shared (`leftShared`) and rooms held back from a merge;
patching or starting again rooms no one was in; resuming a room's state from `.git/kuraa/rooms`.

## Not done

- Edits not yet committed when the network parts are in both sides' rooms, and both sides commit
  them. Where both sides then edit the same paragraph beside them, git keeps a conflict block.
- A device that does not lead a room renders its file as last committed, not as being typed.
- The app forgets its copy of a room when it next opens a file whose session is new: edits made
  offline and not sent before the page was closed are not carried across a reload.
