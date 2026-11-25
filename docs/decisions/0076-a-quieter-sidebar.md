# 0076 · A quieter sidebar, and Settings in subpanels

*Since [0080](0080-tester-fixes.md):* **Sync now** is back, in the workspace's menu; with no document open, the light is the host's (green while it answers), not grey.

*Since [0078](0078-restrictive-wins.md):* Account recovery holds the recovery key alone: trustees, escrow and checked email addresses are gone.

> Changes [0065](0065-no-menu.md) (⚙ at the foot of the sidebar; Search and Sync beside **+**),
> [0064](0064-four-kinds-of-settings.md) (what each section of Settings holds) and
> [0059](0059-online-copy-is-a-component.md) (where the online copy is set up).

The owner asked:

> "Remove the sync button from the sidebar header. Move the green indicator light from the bottom
> left to the left of the workspace name. Get rid of the settings icon and add a "Workspace
> settings" option to the workspace dropdown. (With both of these things gone, the bottom bar the
> sidebar can be removed.) Move the trustees workflow in a "Account Recovery" subpanel. Streamline
> the "Advanced" section and make it display better. Call it, sign in from another device. Restore
> the list of components that have been installed. Move the Online copy section to a sub-settings
> button inside this components list (next to the online copy component). Move Groups above
> permissions and call it "Workspace Groups". Remove "Name" as a section in the workspace settings.
> The name is already displayed on the top. Move the rename workspace button there."

## The sidebar

- **No Sync button.** Devices sync as they connect; the online copy is pushed on each save and
  fetched every few minutes. Nothing is left that only a button did.
- **The connection's light is left of the workspace's name**: green when the open document is
  connected, amber while connecting, red when cut off, grey with none open. Its tooltip says so in
  words, with who else is here; screen readers read the same.
- **No bar at the foot of the sidebar; ⚙ alone in its lower right corner** opens Settings at the
  workspace (with no workspace open, at You). It was first **Workspace settings…** in the menu of
  the workspace's name; the owner asked for a gear there instead. ⌘, still opens
  Settings at what is in front of you, and the desktop app's own menu has Settings too.

## The page

- **An empty document says "Start writing…"**, and nothing more: the cues and keys (# for a heading,
  @ to cite…) are in **Markdown and shortcuts** (⌘/, and the document's ⋯ menu), where 0044 put them.
- **Folders in the list have a folder's icon**, closed or open, drawn as files' are, where a
  triangle was; a folder's **New file** and **New folder** buttons are a page and a folder, each with
  a plus, where ＋ and ⊞ were.
- **A person's role is a menu** for whoever may change it (Member, Admin, and Owner…, which hands
  the role over and asks first), and **Remove…** is the one button, at the row's end. Others see the
  role, as before.
- **Bullets inside numbers, and numbers inside bullets** (`packages/format-pandoc/src/editor/lists.ts`).
  Pandoc reads and writes them, and the file always kept them, but in the page Tab only made a list
  of the same kind and ⌘⇧8 did nothing inside a numbered list. Now:
  - ⌘⇧8 or ⌘⇧7 in a list of the other kind turns the innermost list the cursor is in into bullets
    or numbers;
  - "- " or "1. " typed in an empty item of the other kind of list turns that item alone, the items
    around it staying as they were, with numbers after it carrying on from those before. So Enter,
    Tab, "- " under "1. First" gives bullets inside it.
  A list turned into the kind of a list beside it is joined to it, as the file would read them back
  as one.

## Settings

- **Subpanels.** A section can hold a subpanel: a row with ›, which shows the subpanel in the
  section's place with **‹ back** above it. What the section holds stays as it was while one shows.
- **You**: your name, email and colour; who you are on this computer, and your recovery key until it
  is saved elsewhere; then two subpanels:
  - **Sign in from another device** (was *Advanced*): copy your identity, to paste on another
    computer; or paste one copied there, to be you here too; your computers, to revoke a lost one's
    key; and the keys themselves, under **Keys**.
  - **Account recovery**: your recovery key, getting your identity back with it, the recovery key
    a server keeps for you (where a workspace names one), and your trustees.
  Your checked email addresses stay on You itself, where a workspace names a verifier.
- **Workspace**: its name is the heading, with **Rename workspace…** beside it; no Name part.
  **Workspace groups** come before **Permissions**, which name them.
- **Server**: every component it has, again in one list: languages, where code runs, document
  formats (for the owner, said *On* or *Off*: the owner's checkboxes are in the settings above),
  tools, and syncs. The online copy is one of them, with **Settings…**: its subpanel holds what the
  Workspace section's *Online copy* held, for the open workspace (each workspace has its own).
