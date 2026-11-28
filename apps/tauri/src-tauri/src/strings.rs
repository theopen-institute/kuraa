// The words the desktop app's own parts show (its menus, its dialogs), apart
// from the client's, in the same plain words as the Electron app's
// (apps/desktop/src/strings.ts; the updates window's are there too, drawn by
// its page). British spelling.

pub mod menu {
    pub const PREFERENCES: &str = "Settings…";
    pub const YOUR_WORKSPACES: &str = "Your Workspaces";
    pub const OPEN_FOLDER: &str = "Open Folder…";
    pub const HELP: &str = "Help";
    pub const SHORTCUTS: &str = "Markdown and Shortcuts";
    pub const CHECK_UPDATES: &str = "Check for Updates…";
    pub const SHOW_LOG: &str = "Show Log File";
    pub const FILE: &str = "File";
    pub const EDIT: &str = "Edit";
    pub const VIEW: &str = "View";
    pub const WINDOW: &str = "Window";
    pub const RELOAD: &str = "Reload";
    pub const DEVTOOLS: &str = "Toggle Developer Tools";
    pub const ACTUAL_SIZE: &str = "Actual Size";
    pub const ZOOM_IN: &str = "Zoom In";
    pub const ZOOM_OUT: &str = "Zoom Out";
}

pub mod updates {
    pub const TITLE: &str = "Updates";
}

pub mod folder {
    pub const CHOOSE: &str = "Choose a workspace folder";
    pub const WHERE_NEW: &str = "Where new workspaces go";
    pub const WHERE_DATA: &str = "Where packages and tools are kept";
    pub fn use_ask(name: &str) -> String {
        format!("Use “{name}” as a workspace?")
    }
    pub fn use_detail(items: u64) -> String {
        let already = match items {
            0 => String::new(),
            1 => ", starting with the item already there".into(),
            n => format!(", starting with the {n} items already there"),
        };
        format!("Kuraa keeps every version of the files in it{already}. The history is kept inside the folder (as git does), and the folder stays usable by other programs.")
    }
    pub const USE: &str = "Use this folder";
    pub const CANCEL: &str = "Cancel";
    pub const COULD_NOT_OPEN: &str = "Could not open the folder";
}

pub mod errors {
    pub const WORKSPACES: &str = "Could not open your workspaces";
    pub const NOT_ALLOWED: &str = "Not allowed.";
    pub const HOST_STOPPED: &str = "Kuraa stopped unexpectedly";
    pub const HOST_STOPPED_DETAIL: &str = "The part of Kuraa that keeps your workspaces stopped. What was written before it stopped is saved. Help › Show Log File says why; open Kuraa again to go on.";
    pub const SAVE: &str = "Could not save the file";
}
