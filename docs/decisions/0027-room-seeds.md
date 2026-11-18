# 0027 · Rooms start from the file's git blob, the same way everywhere

A room's Yjs history begins with its seed: the document as the file held it when the room was
made. Yjs can only merge two copies that share their history, so two devices that seeded the same
file on their own, each with a random client id, would see each other's whole text as an
insertion, and the text would appear twice when they connected.

So a room is now seeded the same way on every device. Its generation (the last part of its name) is
the git blob id of the text it started from (`blobId`, as `git hash-object` gives it), and its first
state is the document written in by one fixed client id, derived from the blob and the type's id
and version (`seedState`, `encodeSeed` in `@kuraa/session/server`). Two devices opening the same
blob make byte-identical seeds, which Yjs takes as one; edits that follow use each client's own
random id, so their rooms combine with both sets of edits and no duplicate text. If the file
changes before anyone connects to a new room, the seed is still made from the blob the room is
named for, and the change is applied on top.

Rooms cached under an older, random generation are resumed as before; a fresh room uses the blob.
This is what lets rooms on different devices join (0028) and what makes a lost cache cost little:
the next room starts from the blob again.
