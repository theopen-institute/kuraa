// Kuraa's desktop app as a Tauri shell (decision 0127): the web client in the
// system's webview, and the hub (src/host.ts, bundled as kuraa-desktop.mjs) in
// the Node the app carries, on loopback, with the git, pandoc and Typst it
// carries too. What the Electron app (apps/desktop) does, it does: its menus, its
// folder dialogs, the launcher, joining a shared host, updating itself, its log;
// with the system's spell checker throughout.
//
//   Kuraa                               your workspaces
//   Kuraa --open <folder>               your workspaces, with <folder> added and open
//   Kuraa --join <url> --token <t>      join a shared host or hub; none of its own
//   and the Electron app's other flags (--workspaces, --engine, --format, …: src/host.ts)
//
// The window shows only the app's own pages, its hub's, and a joined host's:
// other web addresses open in the default browser, and it opens no other windows.
// Quitting asks the hub to stop, which writes and commits pending edits, and
// waits for it; then puts a downloaded update in place.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;
mod host;
mod menu;
mod shell;
mod spelling;
mod strings;
mod testing;
mod updates;

use host::Host;
use serde_json::{json, Value};
use shell::{Shared, Shell};
use std::sync::atomic::Ordering;
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, RunEvent, Theme, WebviewUrl, WebviewWindowBuilder};

/// A path as other programs take it: on Windows, without the `\\?\` the system may put before a drive's
/// (Node's module loader and git's sh do not take it).
fn plain(path: std::path::PathBuf) -> std::path::PathBuf {
    let stripped = path.to_string_lossy().strip_prefix(r"\\?\").filter(|rest| cfg!(windows) && !rest.starts_with("UNC\\")).map(std::path::PathBuf::from);
    stripped.unwrap_or(path)
}

/// The Node the app carries, beside its own program (Tauri's externalBin).
fn node() -> std::path::PathBuf {
    let exe = plain(std::env::current_exe().expect("the app's program"));
    exe.parent().expect("the app's folder").join(if cfg!(windows) { "node.exe" } else { "node" })
}

/// Start the hub's process, and what it shows first once it has (--open, --join, or your workspaces).
fn start_host(app: &AppHandle) -> Result<(), String> {
    let shell = app.state::<Shared>().inner().clone();
    let resources = plain(app.path().resource_dir().map_err(|e| e.to_string())?);
    let script = resources.join("host").join("kuraa-desktop.mjs");
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut env = vec![("KURAA_APP_VERSION", app.package_info().version.to_string())];
    let git = resources.join("git");
    if git.exists() {
        env.push(("KURAA_GIT_DIR", git.to_string_lossy().to_string()));
    }
    let on_event = {
        let app = app.clone();
        move |event: &str| {
            if event == "newer" {
                // A device of a workspace runs a newer kuraa: look for an update now.
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let shell = app.state::<Shared>().inner().clone();
                    shell.updates.check(&app, false).await;
                });
            }
        }
    };
    let on_exit = {
        let app = app.clone();
        let shell = shell.clone();
        move || {
            if shell.host.get().is_some_and(|h| h.quitting.load(Ordering::SeqCst)) {
                return;
            }
            // It stopped without being asked: say so, and go (what it wrote is saved).
            eprintln!("[tauri] the host stopped unexpectedly");
            shell.stopped.store(true, Ordering::SeqCst);
            tauri::async_runtime::spawn(async move {
                shell::error_box(&app, strings::errors::HOST_STOPPED, strings::errors::HOST_STOPPED_DETAIL).await;
                app.exit(1);
            });
        }
    };
    let host = Host::spawn(&node(), &script, &args, &env, on_event, on_exit).map_err(|e| format!("Kuraa's host could not start: {e}"))?;
    let _ = shell.host.set(host.clone());

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let hello = match host.ask("hello", json!({})).await {
            Ok(h) => h,
            Err(e) => return shell::error_box(&app, "Kuraa", &e).await,
        };
        shell.set_log(hello["log"].as_str().map(Into::into), hello["home"].as_str().map(Into::into));
        let text = |k: &str| hello.get(k).and_then(Value::as_str).filter(|s| !s.is_empty()).map(String::from);
        let shown = if let Some(folder) = text("open") {
            match shell.open_folder(&app, folder).await {
                Ok(true) => Ok(()),
                Ok(false) => {
                    shell.show_launcher(&app);
                    Ok(())
                }
                Err(e) => Err(e),
            }
        } else if let Some(url) = text("join") {
            match shell.join(&app, url, text("token").unwrap_or_default()).await {
                Ok(None) => Ok(()),
                Ok(Some(problem)) => Err(problem),
                Err(e) => Err(e),
            }
        } else {
            shell.show_workspaces(&app, None, None).await
        };
        if let Err(e) = shown {
            shell::error_box(&app, "Kuraa", &e).await;
            shell.show_launcher(&app);
        }
    });
    Ok(())
}

/// Save a file the page hands over (a rendered document: an `<a download>`), where the person says, as a browser asks.
fn download(app: &AppHandle, event: DownloadEvent) -> bool {
    match event {
        DownloadEvent::Requested { destination, .. } => {
            let name = destination.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "download".into());
            let chosen = match testing::save_answer() {
                Some(answer) => answer.map(std::path::PathBuf::from),
                None => {
                    let mut dialog = rfd::FileDialog::new().set_file_name(&name);
                    if let Ok(dir) = app.path().download_dir() {
                        dialog = dialog.set_directory(dir);
                    }
                    if let Some(w) = app.get_webview_window("main") {
                        dialog = dialog.set_parent(&w);
                    }
                    dialog.save_file()
                }
            };
            let Some(path) = chosen else { return false };
            // The dialog asked before replacing a file; the webview will not write over one.
            if path.exists() {
                let _ = std::fs::remove_file(&path);
            }
            shell::log(app, format!("[tauri] saving a file to {}", path.display()));
            *destination = path;
            true
        }
        DownloadEvent::Finished { path, success, .. } => {
            if !success {
                let app = app.clone();
                let at = path.map(|p| p.display().to_string()).unwrap_or_default();
                tauri::async_runtime::spawn(async move { shell::error_box(&app, strings::errors::SAVE, &at).await });
            }
            true
        }
        _ => true,
    }
}

fn main() {
    // Tests run the app out of sight: its windows never shown, and on a Mac out of the Dock, never coming to the front.
    let hidden = std::env::var("KURAA_HIDDEN_WINDOWS").is_ok_and(|v| v == "1");
    let shell = Shell::new(hidden);
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(shell.clone())
        .invoke_handler(tauri::generate_handler![
            bridge::open_folder,
            bridge::join,
            bridge::leave,
            bridge::home,
            bridge::choose_folder,
            bridge::update_ready,
            bridge::restart_to_update,
            bridge::spelling,
            bridge::learn_word,
            bridge::updates_ready,
            bridge::updates_choose,
            bridge::updates_size,
            bridge::test_result,
        ])
        .menu(menu::build)
        .on_menu_event(|app, event| menu::chose(app, event.id().as_ref()))
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            if hidden {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }
            spelling::check_as_you_type();
            if updates::why_not(app.handle()).is_none() {
                app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            }
            let handle = app.handle().clone();
            let navigating = shell.clone();
            let loading = shell.clone();
            let downloads = app.handle().clone();
            let outside = app.handle().clone();
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("starting.html".into()))
                .title("Kuraa")
                .inner_size(1280.0, 820.0)
                .min_inner_size(640.0, 480.0)
                .visible(!hidden)
                .devtools(true)
                .initialization_script(shell::BRIDGE_JS)
                // Files dropped on the page are the page's (images into the editor), not the shell's.
                .disable_drag_drop_handler()
                .on_navigation(move |url| {
                    if navigating.may_show(url) {
                        return true;
                    }
                    shell::open_outside(&handle, url);
                    false
                })
                .on_new_window(move |url, _| {
                    shell::open_outside(&outside, &url);
                    NewWindowResponse::Deny
                })
                // The client sets the window's title itself, from the workspace and file open.
                .on_document_title_changed(|w, title| {
                    let _ = w.set_title(if title.is_empty() { "Kuraa" } else { &title });
                })
                .on_page_load(move |w, payload| match payload.event() {
                    PageLoadEvent::Started => loading.page_loading(),
                    PageLoadEvent::Finished => loading.page_loaded(w.app_handle()),
                })
                .on_download(move |_, event| download(&downloads, event))
                .build()?;
            // The pages' own background, so nothing flashes white before the first one shows.
            let dark = window.theme().map(|t| t == Theme::Dark).unwrap_or(false);
            let _ = window.set_background_color(Some(if dark { (0x17, 0x17, 0x16, 0xff).into() } else { (0xfb, 0xfa, 0xf8, 0xff).into() }));
            testing::start(app.handle());
            if let Err(e) = start_host(app.handle()) {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    shell::error_box(&handle, "Kuraa", &e).await;
                    handle.exit(1);
                });
                return Ok(());
            }
            updates::start(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("the app");

    app.run(|app, event| match event {
        // Quitting (the last window closed, Quit, the system logging out): the hub writes and commits what is
        // pending first, the windows gone meanwhile.
        RunEvent::ExitRequested { api, code, .. } => {
            let shell = app.state::<Shared>().inner().clone();
            if shell.stopped.load(Ordering::SeqCst) {
                return;
            }
            api.prevent_exit();
            for w in app.webview_windows().values() {
                let _ = w.hide();
            }
            let app = app.clone();
            std::thread::spawn(move || {
                shell.stop_host();
                app.exit(code.unwrap_or(0));
            });
        }
        RunEvent::Exit => {
            let shell = app.state::<Shared>().inner().clone();
            shell.stop_host();
            // A downloaded update, put in place for the next start.
            if let Err(e) = shell.updates.install(app) {
                eprintln!("[updates] could not put the update in place: {e}");
            }
        }
        _ => {}
    });
}
