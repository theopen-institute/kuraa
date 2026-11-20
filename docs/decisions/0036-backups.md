# 0036 · Backups: git servers pushed to, and nothing more

*Superseded by [0039](0039-online-copy.md): a backup and the sync remote are one online copy, pushed to after each save and fetched from and merged on Sync, never forced.*

A workspace can be backed up to plain git servers (GitHub, GitLab, any git host, or a folder), set
up by the person using it. A backup only receives:

- **Pushed, never fetched or merged.** Every branch is pushed to it after each burst of saves (half
  a minute after the last), when the host starts, and on **Back up now**. Nothing on the backup comes
  back into the workspace: that is what the sync remote (**Sync**) is for, which fetches, merges
  and pushes. A backup is never taken for the sync remote when none is chosen, and cannot be chosen
  as one.
- **Never forced.** If a backup has work this device lacks (another of the person's devices pushed
  first), the push is refused and said so, and goes through once this device has that work (its
  devices sync with each other). So several devices can back up to one repository, and nothing on
  it is ever overwritten.
- **The person's own git credentials** (an SSH key, a credential helper for https); the host never
  asks for any (no prompt, SSH in batch mode), and shows git's answer when they are missing.

Kept in the repository's git config: `kuraa.backup` names the remotes; a backup added by address
gets a remote of its own (`backup-<owner>-<name>`), removed with it; an existing remote named as a
backup stays when it is removed. The repository there is never touched by removing it.

**Who sets them up.** Backups push with the credentials of whoever runs the host, so adding and
removing them is theirs: in the app where the host allows it (`--manage-backups`: the desktop app,
and `pnpm dev`), or `kuraa-host backup add <address> | remove <name> | now`. Everyone using the app
sees the backups (addresses without any password in them) and may ask for a push.
