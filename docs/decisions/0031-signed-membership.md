# 0031 · Membership as signed records, and signed commits

Groundwork for permissions later (roles, who may change what): authority that can be checked,
rather than taken on a device's word. Three parts.

## Membership changes are signed records (`peers/records.ts`)

Before, devices told each other who was in as plain lists (members, removed, revoked links), each
device believing what its neighbours said. Now each change is a record signed with the key of the
device that made it: **add** (pair a device), **remove**, **revoke-link**. Devices keep every
record they take (`.git/kuraa/records.json`) and pass them all on in their hello, so a change
reaches every device through any other, and each checks the signature and whether it takes changes
from the device that signed it (0032: every member's, or only the devices it names). Any device may
make a record; each other device takes it or not by its own rule.

The git config used before (remotes, `kuraa.removed`, `kuraa.revokedlinks`) stays: it is what the
records taken say, applied. Devices send only records, never the plain lists; repositories and
devices from before records are not supported.

## Commits are signed with the device's key (`signing.ts`)

A device that syncs with others signs the commits it makes for people's edits, with git's own SSH
signatures, so any device can tell which device made a change, whoever passed it on, and plain git
checks them too: the host keeps `.git/kuraa/allowed_signers` and points `gpg.ssh.allowedSignersFile`
at it, so `git log --show-signature` names the device. `kuraa-host signing-key` prints the key, to
add to GitHub as a signing key.

The commit is built and signed before the branch points at it (as merges are built), so no device
ever fetches it unsigned; git's hooks do not run for these commits, as for merges. **Merge commits
are not signed**: every device must make the same merge commit for the same two commits (0025),
and a signature would differ by device. Anyone can check a merge by making it again.

## What this does not do yet

- Enforcement is each device's, by design (0032): a device may do as it likes with its own copy;
  what others take from it is theirs to decide.
- Signatures are not checked when bringing work in; they are there to be checked (`commitSigner`),
  and rules naming people would check them. Seeing is never restricted: every device has
  everything it syncs.
