# Working in this repository

## Each new feature in a worktree of its own

Several Claude Code chats may work here at once, and the main checkout (this folder) is the
user's: they switch branches and run `pnpm dev` in it while chats work. So:

- **Start each new feature, or any change of more than a few edits, in a new git worktree**
  (EnterWorktree, under `.claude/worktrees/`), before editing anything. Not for a question, a
  look around, or a small fix the user asks for here. If the user says to work in the main
  checkout, do.
- **In the worktree, `pnpm install` first** (seconds: pnpm links from its store). It has its own
  `.dev-workspaces/`, so its `pnpm dev` has workspaces of its own.
- **Never take port 5173**, the user's `pnpm dev`: run `pnpm dev --port 5174` (or another free
  port).
- **Browser tests on a port of their own**: `KURAA_E2E_PORT=<free port> TMPDIR=/private/tmp/<short>
  pnpm test:e2e` (the default 4400 may be another checkout's; the TMPDIR must be short, as tsx makes
  a socket in it).
- **Commit on the worktree's branch**; merge into `main` only when the user asks. At the end of the
  task, say whether the worktree is kept, where, and on which branch.

## Where things are said

Each change that departs from or interprets the design is a decision record in
[docs/decisions/](docs/decisions/), listed in its README; the README at the top explains running
the app and its options.
