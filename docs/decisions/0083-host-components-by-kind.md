# 0083 · Settings › Host: its components by kind, its own settings apart

*Since [0084](0084-components-under-host.md): the components are a section of their own, **Components**, listed under Host; Host keeps its own settings.*

> Changes how Settings › Host ([0064](0064-four-kinds-of-settings.md), [0076](0076-a-quieter-sidebar.md))
> is laid out. What each setting is, who may change it, and how it is saved and applied are as
> before ([0047](0047-browser-equals-desktop.md), [0063](0063-settings-keep-what-you-change.md)).

The owner's direction:

> "Organize the Host settings section to have a clearer representation of components. It should
> be clear what components exist and of what type, and any switches or settings should be neatly
> organized. As things stand, it's not clear what represents components and what is just standard
> program."

Host was its owner's settings (other computers, kinds of documents, features, running code, new
workspaces, saving), then a list headed Components (languages and where code runs, then formats,
tools and syncs). Formats were in both: switched above, shown again below with On or Off. Features
were only above, so whoever was not the owner never saw them. Running code's switch and the choice
of environment were among the settings, away from the languages and environments they switch.

## Two parts, each with a heading

**Components**, first: every component the host has, grouped by kind. The kinds are those there
are ([0020](0020-components.md), [0059](0059-online-copy-is-a-component.md),
[0082](0082-annotations.md)): **Document formats**, **Features**, **Languages** (engines),
**Environments**, **Tools** and **Syncs**. A row of the kinds the host has, each with how many,
leads to each. Each kind is a box: its name and how it stands (*2 of 3 on*, *In a Podman container
in use*, *0 of 1 downloaded*), one line saying what a component of that kind is, its owner's
switches for the kind, then one row per component, each listed once.

A component's switch is in its row: a format or feature on or off (its owner's; to anyone else,
a box that cannot be changed), a tool's **Download** and **Remove**, a sync's **Settings…**. A
switch for the whole kind is at the top of its box: **Run R code in documents** under Languages,
**Where code runs** under Environments. A flag that overrides one says so in its box. Beneath the
kinds: which components the host has is decided as it starts, with the flags that decide it.

**Host settings**, second: how the host program itself works, not a component. These are
**Other computers**, **Running code** (installs, and under Advanced the limits, what a workspace
may ask for, other base images and where packages and tools are kept), **New workspaces** and
**Saving**. To anyone but its owner the part says who sets them, and shows none.

Both parts are one form, the owner's: changes in either are applied together as the window
closes, as before.

## Not changed

The API, the settings and the flags; every `data-testid` the tests use (`pref-format-*`, `pref-run`,
`components-run`, `environment:*`, `tool:*`, `component-sync:*`). Added: `component-kinds`,
`components-features`, `components-environments` and `host-settings`.
