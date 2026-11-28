// The app's menu, as the Electron app's (main.ts's buildMenu): on a Mac, the
// app's menu (About, Check for Updates…, Settings…, Services, Hide, Quit); File
// (Your Workspaces, Open Folder… ⌘O); Edit's standard items, which the webview
// needs for ⌘C, ⌘V and the like; View (Reload, the developer tools on ⌥⌘J, not
// ⌥⌘I, which is the page's own: a new R chunk; zoom; full screen); Window; Help
// (Markdown and Shortcuts on ⌘/, the page's own key for it, and Show Log File).
// Settings takes ⌥⌘, (decision 0044): ⌘, is the page's own. Find (⌘F) is the
// page's own, so no item takes its key.
use crate::shell::{self, Shared};
use crate::strings::menu as M;
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, Wry};

pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let mac = cfg!(target_os = "macos");
    let item = |id: &str, text: &str, accelerator: Option<&str>| MenuItem::with_id(app, id, text, true, accelerator);
    let separator = || PredefinedMenuItem::separator(app);
    let updates = item("updates", M::CHECK_UPDATES, None)?;
    let preferences = item("preferences", M::PREFERENCES, Some("CmdOrCtrl+Alt+,"))?;

    let mut menus: Vec<Submenu<Wry>> = Vec::new();
    if mac {
        let name = app.package_info().name.clone();
        let about = AboutMetadata { name: Some(name.clone()), version: Some(app.package_info().version.to_string()), ..Default::default() };
        menus.push(Submenu::with_items(
            app,
            &name,
            true,
            &[
                &PredefinedMenuItem::about(app, None, Some(about))?,
                &updates,
                &separator()?,
                &preferences,
                &separator()?,
                &PredefinedMenuItem::services(app, None)?,
                &separator()?,
                &PredefinedMenuItem::hide(app, None)?,
                &PredefinedMenuItem::hide_others(app, None)?,
                &PredefinedMenuItem::show_all(app, None)?,
                &separator()?,
                &PredefinedMenuItem::quit(app, None)?,
            ],
        )?);
    }

    let workspaces = item("workspaces", M::YOUR_WORKSPACES, None)?;
    let open = item("open", M::OPEN_FOLDER, Some("CmdOrCtrl+O"))?;
    let file = Submenu::with_items(app, M::FILE, true, &[&workspaces, &open])?;
    if !mac {
        file.append_items(&[&separator()?, &preferences])?;
    }
    file.append_items(&[&separator()?])?;
    if mac {
        file.append(&PredefinedMenuItem::close_window(app, None)?)?;
    } else {
        file.append(&PredefinedMenuItem::quit(app, None)?)?;
    }
    menus.push(file);

    menus.push(Submenu::with_items(
        app,
        M::EDIT,
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &separator()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?);

    menus.push(Submenu::with_items(
        app,
        M::VIEW,
        true,
        &[
            &item("reload", M::RELOAD, Some("CmdOrCtrl+R"))?,
            &item("devtools", M::DEVTOOLS, Some("Alt+CmdOrCtrl+J"))?,
            &separator()?,
            &item("zoom-reset", M::ACTUAL_SIZE, Some("CmdOrCtrl+0"))?,
            &item("zoom-in", M::ZOOM_IN, Some("CmdOrCtrl+Plus"))?,
            &item("zoom-out", M::ZOOM_OUT, Some("CmdOrCtrl+-"))?,
            &separator()?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?);

    let window = Submenu::with_items(app, M::WINDOW, true, &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::maximize(app, None)?])?;
    if mac {
        window.append_items(&[&separator()?, &PredefinedMenuItem::bring_all_to_front(app, None)?])?;
    } else {
        window.append(&PredefinedMenuItem::close_window(app, None)?)?;
    }
    menus.push(window.clone());

    let help = Submenu::with_items(app, M::HELP, true, &[&item("help", M::SHORTCUTS, Some("CmdOrCtrl+/"))?, &item("log", M::SHOW_LOG, None)?])?;
    if !mac {
        help.append_items(&[&separator()?, &updates])?;
    }
    menus.push(help.clone());

    let refs: Vec<&dyn tauri::menu::IsMenuItem<Wry>> = menus.iter().map(|m| m as &dyn tauri::menu::IsMenuItem<Wry>).collect();
    let menu = Menu::with_items(app, &refs)?;
    #[cfg(target_os = "macos")]
    {
        let _ = window.set_as_windows_menu_for_nsapp();
        let _ = help.set_as_help_menu_for_nsapp();
    }
    Ok(menu)
}

/// An item of the menu chosen (or a test's choice: testing.rs).
pub fn chose(app: &AppHandle, id: &str) {
    let shell = app.state::<Shared>().inner().clone();
    let app = app.clone();
    match id {
        "workspaces" => {
            tauri::async_runtime::spawn(async move {
                if let Err(e) = shell.show_workspaces(&app, None, None).await {
                    shell::error_box(&app, crate::strings::errors::WORKSPACES, &e).await;
                }
            });
        }
        "open" => {
            tauri::async_runtime::spawn(async move { shell.pick_folder(&app).await });
        }
        "preferences" => {
            tauri::async_runtime::spawn(async move { shell.show_preferences(&app).await });
        }
        "updates" => {
            tauri::async_runtime::spawn(async move { shell::show_updates(&app).await });
        }
        "help" => shell.show_help(&app),
        "log" => {
            if let Some(file) = shell.log_file() {
                use tauri_plugin_opener::OpenerExt;
                let _ = app.opener().reveal_item_in_dir(file);
            }
        }
        "reload" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.reload();
            }
        }
        "devtools" => {
            if let Some(w) = app.get_webview_window("main") {
                if w.is_devtools_open() {
                    w.close_devtools();
                } else {
                    w.open_devtools();
                }
            }
        }
        "zoom-reset" => shell.zoom(&app, 0),
        "zoom-in" => shell.zoom(&app, 1),
        "zoom-out" => shell.zoom(&app, -1),
        _ => {}
    }
}
