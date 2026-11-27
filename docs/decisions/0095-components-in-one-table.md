# 0095 · Components in one table: Host, Workspace, You

> Changes where components are switched in Settings ([0083](0083-host-components-by-kind.md),
> [0084](0084-components-under-host.md)): every switch of every component, at every level, in one
> section, **Components**, a column for each level. What each switch does, who may change it and
> where it is kept are as before ([0047](0047-browser-equals-desktop.md),
> [0063](0063-settings-keep-what-you-change.md), [0082](0082-annotations.md)).

The owner's direction:

> "The components info is getting scattered all over the settings, and most components have a
> checkbox for user, workspace, and then host. I'd like to move all information about components
> to a single settings tab, with columns for all three levels of activation. This should simplify
> the other panels significantly and provide a cleaner interface for activating, configuring, and
> managing components."

Since 0084 a component could be switched in three places. **Components**, under Host, had the
host's switches (a format or feature on for the host). **Workspace** had the features the
workspace uses, with their settings for it. **You** had the formats' editing and the features you
hid, with their settings for you. A feature, which has all three, was in all three sections.

## One table

**Components** is a section of its own, the last in the list (no longer indented under Host: it
is the host's, the workspace's and yours). Beneath its name in the list: *Host · Workspace · You*.
It is one table, its column heads kept in view as it scrolls:

| Column | Who it is for | Kept |
| --- | --- | --- |
| **Host** | everyone using the host, and every workspace on it | the host's settings; only its owner switches it, applied as the window closes, as before |
| **Workspace** | everyone in the open workspace | in the workspace, at once, by whoever may change its settings |
| **You** | you alone | this browser |

Its rows are the components, grouped by kind as 0083 has them (the row of kinds at the top still
leads to each). A kind's heading row says what it is, how it stands, and holds the switches for the
whole kind (**Run R code in documents** under Languages, **Where code runs** under Environments).
Each component's row has its name, what it is, and a cell in each column: a checkbox where it is
switched at that level, a dash where it is not.

- **Document formats**: Host, the format on; You, its editing (the editor module: formatting as
  you type). Off for you, the file is edited as its text.
- **Features**: Host, on for the host; Workspace, on for the workspace; You, shown or hidden for
  you (only while it is on for the workspace). A feature's settings for the workspace are drawn
  under its row where it says so (`inline`: Annotations, Running code), else open in a subpanel
  from a link in its row, as do its settings for you. A feature on for the workspace but off on the
  host says so in its row.
- **Languages** and **Environments**: Host, loaded and in use (set as the host starts); shown.
- **Tools**: Host, **Download** or **Remove** (kept once on the host's computer).
- **Syncs**: Workspace, **Settings…**, the open workspace's (a subpanel, as before).

With no workspace open, the Workspace and You cells of features are dashes, and the table says to
open one.

## What the others keep

- **You**: your name, email and colour; you on this computer (your key, and its subpanels); the
  host and access code, where the shell does not run the host.
- **Workspace**: people and computers, groups and permissions, its details, and taking it off the
  host's list.
- **Host**: as 0084 has it.

Where the app told people to look elsewhere ("Settings › Workspace › Features", in Annotations'
notes) it now says Settings › Components.

## Not changed

The API, the settings, the flags, and where each switch is kept. Every `data-testid` inside the
switches: `pref-format-*`, `pref-feature-*`, `feature-*` (the workspace's), `feature-shown-*`,
`open-feature-*`, `feature-inline-*`, `feature-settings-*`, `feature-you-*`, `pref-run`,
`components-*`, `environment:*`, `tool:*`, `component-sync:*`, `sync-settings:*`. Gone:
`components-editing`, `workspace-features`, `features-shown`, `open-feature-you-*` as a subpanel
link in You (now a link in the feature's row, same id). Added: `editor-<format>` (the You cell of a
format), `component:format:<id>` and `component:feature:<id>` (rows). The browser tests open
Settings at Components (`openComponents`) to switch a feature.
