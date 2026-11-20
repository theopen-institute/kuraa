# 0034 · Signatures are people; every host is one person

*Refined by 0035: a person's identity no longer signs commits itself; it vouches for a signing key
of theirs on each computer, which does.*

Git's model of identity: names and emails are labels anyone may set; a signature proves which key
made a commit, and the key is the identity. Here likewise.

## Keys

- **Device keys** connect devices to each other (Hyperswarm needs one per device) and pair them.
  They are not who made a change.
- **A person's key** (`~/.kuraa/person.json`, the same on each of their computers; 0033) signs
  every commit made on a computer that keeps one: the desktop app, `pnpm dev`, a `kuraa-host` run
  by its owner. A computer with no person's key signs with its device's key, which is then its
  identity. Names and emails stay free text; tying an email to a key is a layer for later.

## A host is one person

Whoever edits through a host is that host's person, as everyone at one computer is its user: the
desktop app, `pnpm dev`, and a shared server alike. On a shared server, people editing in a browser
are the server's identity (as edits made on a code-hosting website are signed with its key). Telling
people apart on one server (signing in, each with their own key) is a layer for later; it fits on
this one without changing it.

## Judging work by its signer

A device takes another's work on a branch, or a file (0032, 0033), if it accepts the device it came
from (trusting what that device took in, as with an integrator), or else if it accepts whoever
signed each commit it would bring: a person's key, or a device's (with the person that device signs
for). So a person's work is theirs whichever device it comes through. Merges are not signed (0031):
a device makes each again, and whatever one has beyond that merge is the work of the device it came
from (0035). Unsigned commits (made outside the app) count as the device they came
from. Live editing is judged by the device in the room and the person it signs for.

## Where the key is managed

- The desktop app: **Your key** in the menu's **You** section.
- A browser, where the host is the person's own and its operator allows it: `kuraa-host
  --manage-person`, which `pnpm dev` passes. Never on a shared server: its key is its operator's.
- The command line: `kuraa-host person create | export | import | use`.

A key made or imported while a host runs signs its next commit, and the host says so to the other
devices (a person record, 0033).
