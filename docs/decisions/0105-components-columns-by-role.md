# 0105 · Components: the columns a kind is switched at, as you switch it

**Status: built.** Changes the columns of Settings › Components ([0095](0095-components-in-one-table.md),
[0104](0104-components-a-tab-for-each-kind.md)). Each kind's table now has only the levels it is switched
at, and only those this person switches it at. What each switch does, who may change it and where it is
kept are as 0095 has them.

The owner's direction, on being told that for one person on their own computer, Host and You turn the
same features on and off:

> "That's fine, but it seems a bit confusing because *most* applications are single user. So, Host and
> You are functionally the same in that case, no?" — and then: "Yes, do this."

## Why

The host is, as a rule, its owner's own computer, with no one else using it. To its owner, a feature off
in Host or hidden in You looks the same: they don't have it. The Host change applies as Settings closes,
and the You change at once, in this browser. Three columns made one choice look like two, and most
cells in them were dashes. The You column of a format was a different thing again: formatting as you
type, not whether you have the format.

## The columns

| Kind | The host's owner | Anyone else |
| --- | --- | --- |
| Document formats | **This computer**, **Formatting** | **Formatting** |
| Features | **This computer**, **Workspace** | **Workspace**, **You** |
| Languages, Environments, Tools | **This computer** | **Host** (shown) |
| Syncs | **Workspace** | **Workspace** |

- **This computer** is the Host column, named as Settings names the host to its owner (Host's line
  in the list says *This computer*). Beneath Components in the list, *18 available · This computer*.
- **Formatting** (*as you type*): the format's editor module, yours, in this browser, as the You
  column of a format was.
- **You**, for features, is only for whoever does not run the host: on a host someone else runs,
  hiding a feature for yourself is all you can do.
- To anyone else, what the host has off is said in the row, not shown as a column of checkboxes they
  cannot change: *Off on this host: its files open as Text files* (a format), *Off on this host: it
  does nothing here until whoever runs the host turns it on* (a feature). The host's owner, with a
  feature on for the workspace but off in their own column, is told *On for this workspace, but off on
  this computer*.
- A feature its owner hid for themselves earlier (with a You column they no longer have) says so in
  its row, *Hidden for you in this browser*, with **Show it**.

What is lost: the owner of a host others use cannot hide a feature for themselves alone, keeping it on
for the rest. That host is rare.

## Not changed

The API, the settings, where each switch is kept. Every `data-testid` 0095 and 0104 list, in the
columns that still have them: `pref-format-*` and `pref-feature-*` (This computer) only to the host's
owner, `feature-shown-*` (You) only to anyone else. Added: `column:<level>` (`host`, `workspace`,
`you`, `editing`) on each column head, `feature-unhide-<id>`, `feature-off-on-host-<id>`.
