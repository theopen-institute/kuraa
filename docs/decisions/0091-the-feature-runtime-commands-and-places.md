# 0091 · The features' runtime, commands, places and services

> Revises how features are run in the client and what the contract gives them
> ([0082](0082-annotations.md), [0087](0087-navigation-is-made-of-components.md),
> [0089](0089-preview-search-and-outline-are-components.md)). Nothing anyone sees changes, but
> for one fix (an open panel kept as it was) and each feature's items in the ⋯ menu being a group
> of their own (*Commands*).

The owner asked for a review of the component architecture ("Is the design coherent and effective?
I hope to keep extending it with other hooks"), then: "Move forward with everything to improve the
architecture." The review found the contract coherent and the client's side of it grown into
`App.vue`; what follows is what it changed.

## One runtime, one context for each feature

What runs features in the client (how each stands, which this person hid, the client halves in use
and their contexts, panels, menus, the shortcuts sheet's lines, layouts and views, what a past
version shows) is `packages/client/src/featureHost.ts` (`useFeatureHost`). `App.vue` only places
what it gives.

**Each feature has one context for as long as the page is open** (`FeatureContexts`), reading how
it stands through it. Before, a context was made anew whenever how any feature stood changed (one
turned on, a feature's settings saved, a merge bringing `.kuraa/features.json`): an open panel was
then taken down and drawn again, losing what was typed in it (Search's query, a reply being
written), and every feature with `activate` was stopped and started again. Layouts and views were
kept from this by a copy of each context made by hand (`liveContext`), which is gone. A feature is
started when it comes into use and stopped when it goes out of it (turned off, hidden, another
workspace opened), never in between. `tests/e2e/feature-contexts.spec.ts` keeps it so.

## Commands

A feature's keys were said three times (a panel's `keys`, its ⋯ menu item's `keys`, a line in its
`help`), bound three ways (the core binding a panel's; a menu item's shown and not bound; a
selection action's bound by the feature's own ProseMirror keymap), and nothing noticed two features
claiming the same keys (the example feature and Comment once both had ⌥⌘M).

**A command** (`ClientFeature.commands`) is something a feature does, by name: its id, label,
keys, where it is done (`about`: `workspace`, the default; `document`, while a live document is
open; `editor`, in the open document's editor with the focus there, done by its `FeatureEditor`'s
`commands[id]`), and what the shortcuts sheet says of it (`help`, its label if not said; `false`
leaves it off). **Each panel is a command too** (`panel:<id>`, opening it), made by the core, its
keys the panel's `keys` and its line on the sheet the panel's `help`.

- **The core binds their keys, once.** Keys the app has (`APP_KEYS`), keys the editor modules list,
  and keys a command earlier in the list has are refused to a later command: it keeps working from
  menus, without keys, and the console says why. `apps/web/test/keys.test.ts` fails if any of the
  standard features' keys (or the example's) clash.
- **A menu item may name a command** (`{ command: 'panel:comments', testid }`): its label (unless
  given), keys and what it does are the command's. In the ⋯ menu, a file's menu, ＋ and beside a
  selection.
- **The sheet lists every command with keys** under the feature's heading (`helpGroup`, its label
  if not said). `help` stays for lines that are not commands: typing cues, and keys a feature's own
  parts handle (the file tree's arrows).
- **The ⋯ menu gives each feature's items a group of their own**, as the contract always said;
  features with one heading on the sheet share one (Preview and the Outline, under *Finding your
  way*).

Annotations (Comment, Code #, Comments and its other panels), Preview, Search, the Outline and the
example are on commands.

## A panel's place

`over: true` is `place: 'over'`. A panel's `place` is `side` (the default: beside the document, one
at a time, under the client's heading) or `over` (a document's, over its top left), and since
[0092](0092-running-code-is-a-component.md) `dialog`. A place added later is a value added there;
a client that does not know a panel's place draws it beside the document. Whether the right side of
the window becomes a layout's to arrange (0087 left it open) is still not decided: the core arranges
each place, so a layout could take places over later without a feature changing.

## The host's services, by name, as a feature says it uses them

The host's calls offered to components (0089) were one flat list on every feature's context. They
are now **services** (`CoreHost`): `search` (`run`), `renders` (`info`, `render`, `output`,
`madeFrom`), `tools` (`list`, `download`, `onChanged`) and, since 0092, `code`. **A feature says
which it uses** (`ClientFeature.uses`: Search `['search']`, Preview `['renders', 'tools']`), and is
given only those: using another throws, naming the feature and the service. What a feature asks of
the host is in its definition.

## What components draw with

**`@kuraa/feature-ui`** is what components draw with: a file's icon, as the core draws it
([0023](0023-file-icons.md)), as a Vue component (`@kuraa/feature-ui/FileIcon.vue`) and without one
(`fileIconElement`), used by the file tree and the sidebar (each had a copy, and the client a third
nobody used); and, said in its source, **the page's look a component may rely on**: the client's
CSS variables (colours, fonts) and its shared classes (`.pane`, `.pane-header`, `.muted`, `.banner`,
`.field`, `.file-icon`, …). Anything else a component draws is its own to style, in its own
package: the sidebar's header (the workspace's name and menu, the connection's light) moved from
the client's stylesheet into `@kuraa/sidebar`.

## Lint knows every feature

The rules for features named `feature-*` and `annotations` only, so the six features made since
(the sidebar, the file tree, the manuscript, Preview, Search, the Outline) were not held to them,
and the core could have imported them (pnpm's strict dependencies happened to stop it). The list is
now made from `@kuraa/features`' dependencies (and the example); a package that depends on
`@kuraa/feature-kit` and is in neither (nor the core) stops the lint, saying to add it. A feature
may use Vue inside its own package (0087); the contract may not.

## The example uses every hook again

`@kuraa/feature-example` (marks) now also has commands (*Mark*, ⌥⌘Y, done in the editor, offered
beside a selection; *Say hello*, done anywhere), a menu item naming a command, a navigation view
(the documents as a plain list) with an item in ＋, and a layout (a bar of the views' names, giving
no navigation of its own, so the core's menu at the upper left stays), used where the browser names
it (`kuraa:layout`). `tests/e2e/feature-hooks.spec.ts` drives them.

## Features come from this repository

The client's features are bundled with it (the shells pass `standardFeatureClients`); `--feature`
turns loaded ones on and off, and loads none. Run components load at run time (`--component`), as
they run on the host only. So `FEATURE_API_VERSION` (still 1: every change above was made with the
features that use it) guards nothing today: both halves are always built together. **Features are
first-party for now.** If features written elsewhere are to be loaded, the contract needs versions
that mean something (each context's members, not one number), and the web client a way to load a
client half the host serves; neither is designed here.
