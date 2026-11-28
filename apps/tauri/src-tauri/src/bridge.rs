// The shell's side of the ShellBridge (packages/client/src/shell.ts), which
// bridge.ts offers the page as window.kuraa: the commands it calls. Each answers
// only the pages it is for (as the Electron app's answered only its own pages):
// the app's own and this app's hub's; a joined host's page (not this app's code)
// may only go back (leave, home), set the window's title and ask the spell
// checker. The capabilities (capabilities/) say the same to Tauri.
use crate::shell::{self, Page, Shared};
use crate::spelling;
use crate::strings as S;
use serde_json::Value;
use tauri::{AppHandle, LogicalSize, Manager, Webview};

fn page(app: &AppHandle, webview: &Webview) -> Page {
    let shell = app.state::<Shared>();
    match webview.url() {
        Ok(url) => shell.page_of(&url),
        Err(_) => Page::Other,
    }
}

/// Only from the main window's pages, and those of `allowed`.
fn only(app: &AppHandle, webview: &Webview, allowed: &[Page]) -> Result<(), String> {
    if webview.label() == "main" && allowed.contains(&page(app, webview)) {
        Ok(())
    } else {
        Err(S::errors::NOT_ALLOWED.into())
    }
}

const OWN: &[Page] = &[Page::App, Page::Hub];
const ANY: &[Page] = &[Page::App, Page::Hub, Page::Joined];

/// Open a folder (the launcher's Open folder…; the menu's, where the page does not do it).
#[tauri::command]
pub async fn open_folder(app: AppHandle, webview: Webview) -> Result<(), String> {
    only(&app, &webview, OWN)?;
    let shell = app.state::<Shared>().inner().clone();
    shell.pick_folder(&app).await;
    Ok(())
}

/// Join a shared host: an error to show, or None once its page is loading.
#[tauri::command]
pub async fn join(app: AppHandle, webview: Webview, url: String, token: String) -> Result<Option<String>, String> {
    only(&app, &webview, OWN)?;
    let shell = app.state::<Shared>().inner().clone();
    shell.join(&app, url, token).await
}

/// Back to the launcher, this app's hub stopped.
#[tauri::command]
pub async fn leave(app: AppHandle, webview: Webview) -> Result<(), String> {
    only(&app, &webview, ANY)?;
    let shell = app.state::<Shared>().inner().clone();
    shell.leave(&app).await
}

/// This app's own workspaces (from the launcher; also how the client connects again).
#[tauri::command]
pub async fn home(app: AppHandle, webview: Webview) -> Result<(), String> {
    only(&app, &webview, ANY)?;
    let shell = app.state::<Shared>().inner().clone();
    shell.show_workspaces(&app, None, None).await
}

/// A folder picked with the system's dialog, or None: to open as a workspace, for new workspaces, or for packages and tools.
#[tauri::command]
pub async fn choose_folder(app: AppHandle, webview: Webview, purpose: Option<String>) -> Result<Option<String>, String> {
    only(&app, &webview, OWN)?;
    let title = match purpose.as_deref() {
        Some("data") => S::folder::WHERE_DATA,
        Some("workspaces") => S::folder::WHERE_NEW,
        _ => S::folder::CHOOSE,
    };
    Ok(shell::choose_folder(&app, title).await)
}

/// The version of an update downloaded, if one is: the page asks when it starts.
#[tauri::command]
pub fn update_ready(app: AppHandle, webview: Webview) -> Result<Option<String>, String> {
    only(&app, &webview, OWN)?;
    Ok(app.state::<Shared>().updates.ready())
}

/// Save everything, quit, put the update in place and start again.
#[tauri::command]
pub fn restart_to_update(app: AppHandle, webview: Webview) -> Result<(), String> {
    only(&app, &webview, OWN)?;
    let shell = app.state::<Shared>().inner().clone();
    shell.restart_to_update(&app);
    Ok(())
}

/// A misspelled word's suggestions (perhaps none), or None if it is spelled right: the system's spell checker.
#[tauri::command]
pub async fn spelling(app: AppHandle, webview: Webview, word: String) -> Result<Option<Vec<String>>, String> {
    only(&app, &webview, ANY)?;
    if word.is_empty() || word.chars().count() > 100 {
        return Ok(None);
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(spelling::suggest(&word));
    })
    .map_err(|e| e.to_string())?;
    rx.await.map_err(|e| e.to_string())
}

/// Take a word as spelled right from now on, in the system's dictionary.
#[tauri::command]
pub fn learn_word(app: AppHandle, webview: Webview, word: String) -> Result<(), String> {
    only(&app, &webview, ANY)?;
    if word.is_empty() || word.chars().count() > 100 {
        return Ok(());
    }
    app.run_on_main_thread(move || spelling::learn(&word)).map_err(|e| e.to_string())
}

/// The updates window's page has loaded: what to show.
#[tauri::command]
pub fn updates_ready(app: AppHandle, webview: Webview) -> Result<(), String> {
    if webview.label() != "updates" {
        return Err(S::errors::NOT_ALLOWED.into());
    }
    if let Some(status) = app.state::<Shared>().updates.status() {
        shell::update_status(&app, &status);
    }
    Ok(())
}

/// A button of the updates window: Restart Now, or one that closes it (the download goes on).
#[tauri::command]
pub fn updates_choose(app: AppHandle, webview: Webview, choice: String) -> Result<(), String> {
    if webview.label() != "updates" {
        return Err(S::errors::NOT_ALLOWED.into());
    }
    if choice == "restart" {
        let shell = app.state::<Shared>().inner().clone();
        shell.restart_to_update(&app);
    } else if let Some(w) = app.get_webview_window("updates") {
        let _ = w.close();
    }
    Ok(())
}

/// The updates window's page's height, as drawn: the window fits it.
#[tauri::command]
pub fn updates_size(app: AppHandle, webview: Webview, height: f64) -> Result<(), String> {
    if webview.label() != "updates" || !(1.0..1000.0).contains(&height) {
        return Err(S::errors::NOT_ALLOWED.into());
    }
    if let Some(w) = app.get_webview_window("updates") {
        let _ = w.set_size(LogicalSize::new(440.0, height.ceil()));
    }
    Ok(())
}

/// The closing page asks whether everything is saved yet (it may have been before the page listened).
#[tauri::command]
pub fn closing_saved(app: AppHandle, webview: Webview) -> Result<bool, String> {
    only(&app, &webview, &[Page::App])?;
    Ok(app.state::<Shared>().saved.load(std::sync::atomic::Ordering::SeqCst))
}

/// Quit Now on the closing page: the app stops waiting (only once everything is saved).
#[tauri::command]
pub fn quit_now(app: AppHandle, webview: Webview) -> Result<(), String> {
    only(&app, &webview, &[Page::App])?;
    app.state::<Shared>().quit_now();
    Ok(())
}

/// What a test asked the page to work out (testing.rs), answered.
#[tauri::command]
pub fn test_result(webview: Webview, id: u64, ok: Option<Value>, error: Option<String>) -> Result<(), String> {
    let _ = webview;
    crate::testing::answered(id, ok, error);
    Ok(())
}
