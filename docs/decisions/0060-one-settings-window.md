# 0060 · One Settings window

> Changes the client's menu ([0044](0044-polish.md)) and where Preferences are shown
> ([0047](0047-browser-equals-desktop.md)); what they are and who may change them is as before.

Settings were in two places. The menu's **You** section held your name, email and cursor colour,
with a **Save settings** button, and **Server and access code…** opened a panel of the menu for the
server's address and access code. **Preferences…** (⌥⌘,) opened a dialog of its own for the
server's settings: syncing, running code, kinds of documents, folders, timings. Which held a
setting was a guess: syncing and running code read as "settings", and your name as a "preference".

Now there is one window, **Settings**, opened from the menu's **You** section (**Settings…**), by
⌥⌘, and by the desktop app's menu (**Settings…**, where it was **Preferences…**), in two parts:

- **You**: name, email and colour; your key on this computer; and, where the shell does not run the
  server, its address and access code. The name, email and colour are kept in this browser, as
  before, and saved as each is changed (on leaving the field, or Enter; the colour as it is
  picked), and what is still being typed when the window closes is kept: there is no Save button.
  A name left empty goes back to the one saved; an email that is not one is not saved. The address
  and access code keep a button of their own (**Save connection**), because saving them reconnects,
  and a half-typed access code would be refused.
- **This computer's server**: what Preferences held, only for the server's owner (0047), and as
  before: a wrong value refused, saying what; a flag that wins said. It keeps a button of its own
  (**Save server settings**), because saving reopens every workspace and reloads the page; closing
  the window leaves them as they were. Where the owner's features are off, the window says why in
  its place.

The two parts stay apart in what they are: one is yours, kept in this browser, the other is the
server's, kept in its settings file and shared by every workspace on it. Only where they are shown
is one.

The menu keeps who you are (name and email) and **Settings…** in **You**, and the shell's
**Join a shared server…**. **Server and access code…** and its panel are gone; **Change the access
code…**, in the banner shown when the server refuses the code, opens Settings. ⌘, still opens and
closes the menu. Document settings stay in the menu: they are the open document's, not the app's.
