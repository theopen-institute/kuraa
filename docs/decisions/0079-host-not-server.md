# 0079 · Host, not server

> Changes the words of [0064](0064-four-kinds-of-settings.md) (Settings' fourth section) and
> [0044](0044-polish.md) (the app talks to a *server* with an *access code*).

The owner asked:

> "Right now, the app has a settings panel called "Server". Would it be better to call that
> "Host"? I intend to use "Server" for another type of entity."

What the app called a *server* is `kuraa-host`: the process on a computer that holds its
workspaces, runs their code, keeps their history and syncs with other devices. Most people run one
on their own computer, inside the desktop app or with `pnpm host`; the code was always called the
host. So the interface now says **host** too, everywhere it meant that:

- Settings' fourth section is **Host** (**This computer’s host** where you are its owner), and
  `Settings › Host` holds its settings, components and tools.
- **Host address** and **access code**, where the app does not run the host itself.
- What the host answers when something is turned off or refused ("Running code is turned off on
  this host", "The host did not accept your access code"), and "Preferences" in those answers is
  now Settings, as the window has been called since 0060.
- In the code: `SettingsHost.vue`, the section `'host'`, `hostOf` for the origin access codes are
  kept by, and the test ids `settings-tab-host`.

The servers used to find other computers on a private network (`--bootstrap`) are now
**starting points**, so that neither word is used for them.

**Server** is kept for one kind of host. The owner again:

> "A server is just going to be a standard host, potentially with some additional features, that is
> designed to be accessible at a public ip. There's nothing special about servers per se but because
> they're always available they can do things like relay, provide web login, etc."

So every server is a host; a host is a server when it is always on at a public address. What it does
more (relaying, signing in from the web) it does because it is always there, not because it is
another kind of thing. The word stays only where it means that, or something outside kuraa:

- the host that takes connections at a public address (`--peer-port`, `--public-address`,
  `--dht-port`; "a server" in the device's tooltip), and the README's "a server for many people will
  need a design of its own";
- the build that runs on its own as a service and updates itself
  ([0052](0052-the-server-updates-itself.md)): a host set up to be a server. Its archive
  `kuraa-server-<version>.tar.gz`, `~/.kuraa/server` and the service `org.kuraa.server` are names
  installed computers already look for, so they stay as they are;
- a **git server** (GitHub, GitLab), where an online copy is kept.

Older decisions keep the word they were written with.
