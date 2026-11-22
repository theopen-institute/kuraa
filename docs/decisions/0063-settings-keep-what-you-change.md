# 0063 · Settings keep what you change; a shorter workspace menu; no Join in the app for now

Four changes to the interface, each from the owner looking at the app:

> "This 'Save Server Settings' button is confusing. People will assume the settings aren't saved
> when clicking 'Close'. Aren't they? Defer to best practices here (and on the other settings
> menu… make sure it's consistent)."

> "This dropdown from the top of the sidebar should be streamlined. Show only the names of existing
> workspaces and then (in a way that is visually separate) the trigger to add a new workspace."

> "No need to print the red text about podman here. The disabled button and the tooltip is enough."

> "I don't think I want that feature right now. Remove it from the interface, though keep the
> backend in place to add later." (joining a shared server)

## Closing a settings window never loses what was changed

They were not saved. **Settings** saved your name, email and colour as each was changed, but this
computer's server's settings only with their own **Save server settings** button; **Close** dropped
them, saying nothing. **Document settings** did the same with the header (**Save header**). One
window working two ways is what confused.

Settings windows keep what you change, and closing one is how you finish (macOS and GNOME settings
apply as you go; losing changes without a word is the thing to avoid). Server settings cannot apply
as each is typed, since applying reopens every workspace and reloads the page, so they apply once,
on closing:

- **Settings** (`SettingsWindow.vue`) has no Save button. Its one button is **Done**; Escape and a
  click outside do the same. Once a server setting is changed, beside Done it says "Your changes
  take effect when you close Settings: your workspaces reopen, saving any edits first, and the page
  reloads." Done then shows **Applying…**. A value the server refuses keeps the window open, saying
  what, with **Discard changes** beside Done (it closes, keeping nothing not yet saved). The server
  and access code (shown only when joined with `--join`) are used on closing too, not as each is
  typed: half an address would connect nowhere.
- **Document settings** has no **Save header**. What was changed in the header is written as the
  panel closes, however it closes (**Done**, Escape, a click outside, **Back**, or a button that
  closes it), as one edit that can be undone. Once something is changed it says "Saved when you
  close Document settings". A field not valid says "Fix this to keep your changes", and closing
  then asks whether to discard them (Cancel stays, to fix it). Writing YAML over a header someone
  else changed meanwhile asks first, as before; saying no keeps theirs.

## The workspace menu: the workspaces, then Add a workspace…

The menu from the sidebar's header held the workspaces ("· synced" beside some), **Invite people
to …**, **Add a workspace…**, **Open a folder…** and **Remove … from this list…**. It now holds
the workspaces' names (✓ on the open one; "(cannot open)" on one that cannot be opened, as that is
found otherwise only by choosing it), then, below a line, **Add a workspace…**.

- **Opening a folder** is a third way in **Add a workspace**: **An existing folder**, with
  **Choose a folder…**, where the server can open folders of its computer (the desktop app, or a
  server's owner). It goes on as **Open a folder…** did (the folder dialog, then asking before it
  keeps versions). The empty screen's **Open a folder…**, and the app menu's, stay.
- **Inviting people** is in the menu's **Devices** section, where it was already.
- **Removing a workspace from the list** is in the menu's workspace section: **Remove from this
  list…**, beside **Rename workspace…**, asking first as before (its folder stays).

## Where code cannot run, Run says why as its tooltip

A chunk whose code cannot run here (Podman missing or stopped) showed the environment's message in
red beside its disabled **Run** button ([0044](0044-polish.md)). The disabled Run's tooltip says the
same, and the menu's Code section still does; the red text is gone.

## Joining a shared server is not offered in the app

Connecting the app to a kuraa server on another computer (its address and access code), working on
its workspaces with none of this computer's, was offered in three places: the launcher's **Join a
shared server** card, the desktop app's **File → Join Shared Server…**, and **Join a shared server…**
in the menu and in Settings. All are gone; the launcher keeps **Your workspaces** and **Open
folder…**. Joining from an invite link (a copy of a workspace that syncs) is what people want, and
the two looked alike.

What it runs on stays, to offer again later: the desktop app's `--join <url> --token <code>`, the
bridge's `join` and `leave`, and Settings' server and access code when joined that way. A server
running code for those who join it may come back as part of running chunks on a server.
