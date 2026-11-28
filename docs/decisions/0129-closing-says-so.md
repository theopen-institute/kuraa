# 0129 · Closing says so, and waits less

> Changes [0080](0080-tester-fixes.md) (the online copy gets the last saves as the host stops) and
> [0039](0039-online-copy.md) (each save pushed half a minute after the last).

A tester found quitting slow: "it just feels like it's bugging out". Quitting the desktop app
stops its hub, and each workspace then, one step after another:

1. writes and commits its open rooms (fast: on this computer's disk);
2. pushes what its online copies lack, waiting up to 8 s (0080);
3. lets fetches from other devices under way finish, up to 5 s;
4. leaves the peer network (Hyperswarm's `destroy`, about 1.3 s measured);
5. stops features, code sessions and the relay.

Meanwhile the window stayed as it was, and the hub had already dropped the page's connection: for
up to a quarter of a minute the window showed a workspace that had lost its host. Closing the window
instead (its close button) hid it at once, and the app stayed in the Dock just as long.

## What changed

- **The window says so.** Quitting, closing the window and Restart Now (to update) all show a page of
  the app's own, `static/closing.html`: *Closing Kuraa* (or *Restarting Kuraa*), *Saving your work…*;
  once every workspace has committed, *Your work is saved. Sending the latest to your other devices
  and online copies…*. The page is loaded before the hub stops, so whatever the client still had to
  send goes while the hub listens (waited for one second at most). Closing the window no longer
  hides it: the window stays, showing the page, until the app quits.
- **Quit Now, once everything is saved.** A second and a half after the saves are done (most quits
  are over by then, and the button would only flash), the page offers **Quit Now** (**Restart Now**):
  the app stops waiting for the network. What was not sent goes the next time Kuraa opens, as 0080
  already said of a push that outlasted its 8 s. It is never offered before the saves are done.
  Quitting again meanwhile (⌘Q, the window's close button) does the same as Quit Now: nothing
  before the saves are done, the app quits after.
- **The host says when it is saved.** `Host.close`, `Hub.close` and the `close` of `RunningHost` and
  `RunningHub` take `{ saved }` (`CloseOptions`), called once the open rooms are written and committed
  (the hub's once every workspace's are). The host logs how long stopping took, and how long saving:
  `stopped in 2140 ms (saved in 35 ms)`.
- **The push and letting go of the devices go side by side.** Steps 2 and 3–4 no longer wait for
  each other. The write rules (0066, 0071) still judge what a push brings in (when another device
  pushed first, it fetches and merges): `Peers.close(judging)` lets go of them only once the push is
  done. Features stop once the push is done, as before; code sessions and the relay last.
- **Saves go to the online copy sooner**: 5 s after the last commit (`onlineMs`), not 30 s. Commits come
  at most every half minute anyway (`idleCommitMs`), so pushes are no more frequent than commits; a
  quit made between half a minute and a minute after the last edit no longer has a push to wait for.

## Not done

- **Syncing everything before the person quits.** The last edits are committed as the app quits
  (`idleCommitMs` makes a version only after half a minute without edits), so a quit right after
  writing always has something to push. Committing sooner would change what a version is.
- **Not waiting for Hyperswarm.** Its `destroy` tells the network this device is gone; skipping it
  would let others try it a while longer. With the push beside it, it seldom adds to the wait.
