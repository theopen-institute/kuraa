# 0084 · Components, a section of their own, under Host

> Changes where the host's components are shown ([0083](0083-host-components-by-kind.md)): in a
> section of their own in Settings, listed under Host. How they are grouped, what each kind says
> and which switches are whose are as 0083 has them.

The owner's direction:

> "Components should sit in its own settings category, below You, Document, Workspace, and Host."

Since 0083, Host was in two parts, its components first and its own settings beneath. The
components were the larger part, and most people opened Host for them, scrolling past nothing of
their own to reach the host's settings, or the other way round.

## Under Host, not beside it

Settings' sections are sorted by who a setting applies to and where it is kept
([0064](0064-four-kinds-of-settings.md)). Components belong to the host on both counts: they are
for everyone using it, and their switches are kept in its settings. So **Components** is a
section of its own, listed beneath **Host**, indented with a line at its left, as part of it; on
a narrow window it is one more tab. The window still holds four kinds of settings.

- **Host** has how the host itself works: other computers, running code (installs, and under
  Advanced the limits, what a workspace may ask for, other base images, where packages and tools
  are kept), new workspaces and saving. To anyone but its owner it says who sets them, and is
  quieter in the list.
- **Components** has every component the host has, by kind, with each kind's switches. Its line
  says who it applies to and who switches them ("What this host can do, for everyone using it and
  every workspace on it. Only you, its owner, switch them."). A sync's settings open in a
  subpanel of it.

## One form for both

The owner's changes in either section are the host's settings and are applied together, once, as
the window closes, as before ([0063](0063-settings-keep-what-you-change.md)). The window makes
them (`hostSettings.ts`) and hands the same form to `SettingsHost` and `SettingsComponents`. A
value refused on closing opens Host, where the refusal is said.

**Not changed.** The API, the settings, the flags and every `data-testid` inside the sections. The
owner's form in Host is `preferences`, in Components `preferences-components`. The section's tab
is `settings-tab-components`. A feature off on the host now says to turn it on in Settings ›
Components.
