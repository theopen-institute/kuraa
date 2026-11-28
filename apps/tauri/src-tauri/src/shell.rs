// What the shell shows and does: the Electron app's main.ts, with the hub in
// its own process (host.rs). The window shows one of the app's own pages (the
// starting page, the launcher: tauri://localhost) or the web client, served by
// this app's hub, or by a host it joined (its own pages, as a browser would show
// them: 0047, 0127). The page learns its connection (ShellConfig) from the
// address the shell sends it to (bridge.ts reads it, and keeps it for reloads),
// and asks the shell things through its commands (bridge.rs), which answer only
// the pages they are for.
use crate::host::Host;
use crate::strings as S;
use crate::updates::Updates;
use base64::Engine;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::window::{ProgressBarState, ProgressBarStatus};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

pub type Shared = Arc<Shell>;

pub struct Shell {
    pub host: OnceLock<Arc<Host>>,
    pub updates: Updates,
    /// The host stopped, as quitting asks: the app may go.
    pub stopped: AtomicBool,
    /// Quitting (or restarting to update): the closing page shows while the host stops (0131).
    pub quitting: AtomicBool,
    /// Every workspace saved, as the app quits: Quit Now may cut what is left short.
    pub saved: AtomicBool,
    /// Quit Now: the app stops waiting for the host.
    cut: AtomicBool,
    /// Tests run the app out of sight (KURAA_HIDDEN_WINDOWS=1).
    pub hidden: bool,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    /// What the page is told (ShellConfig); None on the app's own pages.
    config: Option<Value>,
    /// This app's hub, while the window may show it.
    own: Option<url::Origin>,
    /// A host joined, while the window shows it.
    joined: Option<url::Origin>,
    /// Calls for the page, made once it has loaded.
    pending: Vec<String>,
    loaded: bool,
    /// Where the page's address changes, so going there loads it afresh.
    visits: u64,
    zoom: usize,
    log: Option<PathBuf>,
    home: Option<String>,
}

/// Which page a request comes from.
#[derive(PartialEq, Eq, Debug, Clone, Copy)]
pub enum Page {
    /// The app's own (the starting page, the launcher, the updates window's).
    App,
    /// This app's hub's web client.
    Hub,
    /// A joined host's web client: not this app's code, so it may ask little.
    Joined,
    Other,
}

/// Zoom steps, as browsers have them.
const ZOOMS: [f64; 15] = [0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0];
const ZOOM_ACTUAL: usize = 6;

pub const BRIDGE_JS: &str = include_str!("../../build/bridge.js");
pub const UPDATES_JS: &str = include_str!("../../build/updates-bridge.js");

/// One of the app's own pages, as the webview addresses them.
pub fn app_url(path: &str) -> Url {
    let base = if cfg!(any(windows, target_os = "android")) { "http://tauri.localhost/" } else { "tauri://localhost/" };
    Url::parse(base).and_then(|b| b.join(path)).expect("an app page's address")
}

pub fn is_app_url(url: &Url) -> bool {
    url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost")
}

/// Whether a web address opens in the default browser (anything else goes nowhere).
pub fn open_outside(app: &AppHandle, url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        use tauri_plugin_opener::OpenerExt;
        if let Err(e) = app.opener().open_url(url.as_str(), None::<&str>) {
            log(app, format!("[tauri] could not open {url}: {e}"));
        }
    }
}

/// A line for the log: the host keeps it; once it has stopped (quitting, putting an update in place), the shell adds it to the file itself.
pub fn log(app: &AppHandle, text: impl Into<String>) {
    let text = text.into();
    let Some(shell) = app.try_state::<Shared>() else { return eprintln!("{text}") };
    if shell.host.get().is_some_and(|h| h.log(&text)) {
        return;
    }
    eprintln!("{text}");
    if let Some(file) = shell.log_file() {
        use std::io::Write;
        let seconds = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        if let Ok(mut f) = std::fs::OpenOptions::new().append(true).open(file) {
            let _ = writeln!(f, "[{seconds}] {text}");
        }
    }
}

impl Shell {
    pub fn new(hidden: bool) -> Shared {
        Arc::new(Shell {
            host: OnceLock::new(),
            updates: Updates::default(),
            stopped: AtomicBool::new(false),
            quitting: AtomicBool::new(false),
            saved: AtomicBool::new(false),
            cut: AtomicBool::new(false),
            hidden,
            state: Mutex::new(State { zoom: ZOOM_ACTUAL, ..State::default() }),
        })
    }

    pub fn host(&self) -> Result<Arc<Host>, String> {
        self.host.get().cloned().ok_or_else(|| "Kuraa's host has not started.".into())
    }

    pub fn set_log(&self, log: Option<PathBuf>, home: Option<String>) {
        let mut s = self.state.lock().unwrap();
        s.log = log;
        s.home = home;
    }

    pub fn log_file(&self) -> Option<PathBuf> {
        self.state.lock().unwrap().log.clone()
    }

    pub fn config(&self) -> Option<Value> {
        self.state.lock().unwrap().config.clone()
    }

    pub fn manages_host(&self) -> bool {
        self.config().and_then(|c| c.get("managesHost").and_then(Value::as_bool)).unwrap_or(false)
    }

    /// Which page an address is.
    pub fn page_of(&self, url: &Url) -> Page {
        if is_app_url(url) {
            return Page::App;
        }
        let s = self.state.lock().unwrap();
        let origin = url.origin();
        if s.own.as_ref() == Some(&origin) {
            Page::Hub
        } else if s.joined.as_ref() == Some(&origin) {
            Page::Joined
        } else {
            Page::Other
        }
    }

    /// Whether the window (or a frame in it) may go to an address: the app's pages, the hub's or the joined host's, and frames' blank pages.
    pub fn may_show(&self, url: &Url) -> bool {
        if url.scheme() == "about" {
            return true;
        }
        // A file the page made (an image, a rendered file), at its own origin.
        if url.scheme() == "blob" {
            return Url::parse(url.path()).map(|inner| self.page_of(&inner) != Page::Other).unwrap_or(false);
        }
        self.page_of(url) != Page::Other
    }

    fn window(app: &AppHandle) -> Option<WebviewWindow> {
        app.get_webview_window("main")
    }

    /// Show a page in the window: with a connection for the client, or none (the app's own pages).
    fn show(&self, app: &AppHandle, mut url: Url, config: Option<Value>) {
        let mut s = self.state.lock().unwrap();
        s.config = config.clone();
        s.loaded = false;
        if let Some(c) = config {
            // A new address each time, so the page loads afresh even where only the connection changed.
            s.visits += 1;
            url.query_pairs_mut().append_pair("kuraa-shell", &s.visits.to_string());
            let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(c.to_string());
            url.set_fragment(Some(&format!("kuraa-config={encoded}")));
        }
        drop(s);
        if let Some(w) = Self::window(app) {
            if let Err(e) = w.navigate(url) {
                log(app, format!("[tauri] could not show the page: {e}"));
            }
        }
    }

    pub fn show_launcher(&self, app: &AppHandle) {
        {
            let mut s = self.state.lock().unwrap();
            s.own = None;
            s.joined = None;
        }
        self.show(app, app_url("launcher.html"), None);
    }

    /// Your workspaces: the hub, in the client, with `workspace` open if given. The name and email suggested are git's, for `folder` (a folder just opened) or in general.
    pub async fn show_workspaces(&self, app: &AppHandle, workspace: Option<String>, folder: Option<String>) -> Result<(), String> {
        let host = self.host()?;
        let hub = host.ask("start", json!({})).await?;
        let who = host.ask("identity", json!({ "folder": folder })).await?;
        let url = hub["url"].as_str().ok_or("The host gave no address.")?.to_string();
        let page = Url::parse(&format!("{url}/")).map_err(|e| e.to_string())?;
        {
            let mut s = self.state.lock().unwrap();
            s.own = Some(page.origin());
            s.joined = None;
        }
        let mut config = json!({ "hostUrl": url, "token": hub["token"], "name": who["name"], "email": who["email"], "managesHost": true });
        if let Some(w) = workspace {
            config["workspace"] = json!(w);
        }
        self.show(app, page, Some(config));
        Ok(())
    }

    /// Add a local folder to the workspaces, and open it. False if the person declined.
    pub async fn open_folder(&self, app: &AppHandle, path: String) -> Result<bool, String> {
        let host = self.host()?;
        let folder = host.ask("inspect", json!({ "path": path })).await?;
        let dir = folder["dir"].as_str().unwrap_or(&path).to_string();
        let repo = folder["repoRoot"].as_str().map(String::from);
        if repo.is_none() {
            // Not yet a git repository: say what using it means, in plain words (git is named once, in passing).
            let name = std::path::Path::new(&dir).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| dir.clone());
            let entries = folder["entries"].as_u64().unwrap_or(0);
            if !confirm(app, &S::folder::use_ask(&name), &S::folder::use_detail(entries), S::folder::USE, S::folder::CANCEL).await {
                return Ok(false);
            }
        }
        let added = host.ask("add", json!({ "path": repo.clone().unwrap_or(dir), "init": repo.is_none() })).await?;
        let id = added["id"].as_str().map(String::from);
        let at = added["path"].as_str().map(String::from);
        self.show_workspaces(app, id, at).await?;
        Ok(true)
    }

    /// Join a shared host or hub, none of this app's own running: an error to show, or None once its page is loading.
    pub async fn join(&self, app: &AppHandle, url: String, token: String) -> Result<Option<String>, String> {
        let host = self.host()?;
        let base = url.trim_end_matches('/').to_string();
        if let Some(problem) = host.ask("join", json!({ "url": base, "token": token })).await?.as_str() {
            return Ok(Some(problem.to_string()));
        }
        let page = Url::parse(&format!("{base}/")).map_err(|e| e.to_string())?;
        host.ask("stop", json!({})).await?;
        let home = self.state.lock().unwrap().home.clone();
        let who = host.ask("identity", json!({ "folder": home })).await?;
        {
            let mut s = self.state.lock().unwrap();
            s.own = None;
            s.joined = Some(page.origin());
        }
        let config = json!({ "hostUrl": base, "token": token, "name": who["name"], "email": who["email"], "managesHost": false });
        self.show(app, page, Some(config));
        Ok(None)
    }

    /// Back to the launcher, stopping this app's hub (which writes and commits).
    pub async fn leave(&self, app: &AppHandle) -> Result<(), String> {
        self.host()?.ask("stop", json!({})).await?;
        self.show_launcher(app);
        Ok(())
    }

    /// Open a folder…: the page does it, through the hub, as in a browser (its own dialogs); from the launcher, or joined to another host, this app's own workspaces are opened with it.
    pub async fn pick_folder(&self, app: &AppHandle) {
        if self.manages_host() {
            return self.emit(app, "open-folder", Value::Null);
        }
        let Some(path) = choose_folder(app, S::folder::CHOOSE).await else { return };
        if let Err(e) = self.open_folder(app, path).await {
            error_box(app, S::folder::COULD_NOT_OPEN, &e).await;
        }
    }

    /// Settings: the client's window, in the page (this app's own workspaces opened first, from the launcher).
    pub async fn show_preferences(&self, app: &AppHandle) {
        if self.config().is_none() {
            if let Err(e) = self.show_workspaces(app, None, None).await {
                return error_box(app, S::errors::WORKSPACES, &e).await;
            }
        }
        self.emit(app, "preferences", Value::Null);
    }

    /// The page's Markdown and shortcuts sheet (the client's, if it is shown).
    pub fn show_help(&self, app: &AppHandle) {
        if self.config().is_some() {
            self.emit(app, "help", Value::Null);
        }
    }

    /// Tell the page something (bridge.ts's handlers), once it has loaded.
    pub fn emit(&self, app: &AppHandle, event: &str, value: Value) {
        let call = format!("window.__kuraaShell&&window.__kuraaShell.emit({},{})", json!(event), value);
        let flush = {
            let mut s = self.state.lock().unwrap();
            s.pending.push(call);
            s.loaded
        };
        if flush {
            self.flush(app);
        }
    }

    fn flush(&self, app: &AppHandle) {
        let calls = std::mem::take(&mut self.state.lock().unwrap().pending);
        if let Some(w) = Self::window(app) {
            for c in calls {
                let _ = w.eval(c);
            }
        }
    }

    pub fn page_loading(&self) {
        self.state.lock().unwrap().loaded = false;
    }

    pub fn page_loaded(&self, app: &AppHandle) {
        self.state.lock().unwrap().loaded = true;
        self.flush(app);
    }

    /// Zoom the window's page in (1), out (-1), or back to its actual size (0).
    pub fn zoom(&self, app: &AppHandle, by: i32) {
        let level = {
            let mut s = self.state.lock().unwrap();
            s.zoom = match by {
                0 => ZOOM_ACTUAL,
                1 => (s.zoom + 1).min(ZOOMS.len() - 1),
                _ => s.zoom.saturating_sub(1),
            };
            ZOOMS[s.zoom]
        };
        if let Some(w) = Self::window(app) {
            let _ = w.set_zoom(level);
        }
    }

    /// Save every workspace, quit, put the update in place, and start again (the window saying so meanwhile).
    pub fn restart_to_update(self: &Arc<Self>, app: &AppHandle) {
        if self.updates.ready().is_none() {
            return;
        }
        let shell = self.clone();
        let app = app.clone();
        std::thread::spawn(move || {
            shell.close_down(&app, true);
            if let Err(e) = shell.updates.install(&app) {
                log(&app, format!("[updates] could not put the update in place: {e}"));
            }
            app.restart();
        });
    }

    /// Stop the host as the app quits (or restarts to update), saying so in the window, never a page that has lost
    /// its host (0131): every workspace's edits saved, then what is still to go sent, a while at most. Done once the
    /// host has stopped, or once Quit Now is pressed (only offered when everything is saved). Blocks: on a thread of
    /// its own.
    pub fn close_down(&self, app: &AppHandle, restart: bool) {
        if self.quitting.swap(true, Ordering::SeqCst) {
            return;
        }
        // The page first, while the host still listens: what the client had still to send goes. Not waited for long.
        if Self::window(app).is_some() {
            self.show(app, app_url(if restart { "closing.html?restart=1" } else { "closing.html" }), None);
            let until = std::time::Instant::now() + Duration::from_secs(1);
            while !self.state.lock().unwrap().loaded && std::time::Instant::now() < until {
                std::thread::sleep(Duration::from_millis(20));
            }
            log(app, format!("[tauri] {}: the window says so while every workspace is saved", if restart { "restarting" } else { "closing" }));
        }
        self.stop_host();
    }

    /// Everything saved, as the app quits (the host says so): the closing page offers Quit Now.
    pub fn closing_saved(&self, app: &AppHandle) {
        self.saved.store(true, Ordering::SeqCst);
        self.emit(app, "closing-saved", Value::Null);
    }

    /// Quit Now (the closing page's, or asked to quit again): the app stops waiting for the host, once everything is saved; never sooner.
    pub fn quit_now(&self) {
        if self.saved.load(Ordering::SeqCst) {
            self.cut.store(true, Ordering::SeqCst);
        }
    }

    /// Stop the host (it writes and commits what is pending), once.
    pub fn stop_host(&self) {
        if self.stopped.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Some(host) = self.host.get() {
            host.quit(Duration::from_secs(60), &self.cut);
        }
    }
}

/// How updating stands, changed (updates.rs): the Dock or taskbar icon's bar, the updates window, and the page once one is ready.
pub fn update_status(app: &AppHandle, status: &Value) {
    let kind = status.get("kind").and_then(Value::as_str).unwrap_or("");
    if let Some(w) = app.get_webview_window("main") {
        let bar = if kind == "downloading" {
            match status.pointer("/progress/percent").and_then(Value::as_f64) {
                Some(p) => ProgressBarState { status: Some(ProgressBarStatus::Normal), progress: Some(p.clamp(0.0, 100.0) as u64) },
                None => ProgressBarState { status: Some(ProgressBarStatus::Indeterminate), progress: None },
            }
        } else {
            ProgressBarState { status: Some(ProgressBarStatus::None), progress: None }
        };
        let _ = w.set_progress_bar(bar);
    }
    if let Some(w) = app.get_webview_window("updates") {
        let _ = w.eval(format!("window.__kuraaUpdates&&window.__kuraaUpdates({status})"));
    }
    if kind == "ready" {
        if let Some(shell) = app.try_state::<Shared>() {
            shell.emit(app, "update-ready", status["version"].clone());
        }
    }
}

/// Check for Updates…: a small window of the app's own, over the main one, that stays open and shows how updating goes, as it goes (updates.html).
pub async fn show_updates(app: &AppHandle) {
    let shell = app.state::<Shared>().inner().clone();
    if let Some(w) = app.get_webview_window("updates") {
        let _ = w.set_focus();
    } else {
        let mut builder = WebviewWindowBuilder::new(app, "updates", WebviewUrl::App("updates.html".into()))
            .title(S::updates::TITLE)
            .inner_size(440.0, 150.0)
            .resizable(false)
            .minimizable(false)
            .maximizable(false)
            .visible(!shell.hidden)
            .initialization_script(UPDATES_JS)
            .on_navigation(|url| is_app_url(url));
        if let Some(main) = app.get_webview_window("main") {
            builder = match builder.parent(&main) {
                Ok(b) => b,
                Err(e) => return log(app, format!("[tauri] the updates window: {e}")),
            };
        }
        if let Err(e) = builder.build() {
            return log(app, format!("[tauri] the updates window: {e}"));
        }
    }
    if let Some(why) = crate::updates::why_not(app) {
        return update_status(app, &json!({ "kind": "off", "why": why }));
    }
    // What it stands at now, then looks (unless downloading or ready already: it shows how that goes).
    match shell.updates.status() {
        Some(s) if matches!(s["kind"].as_str(), Some("downloading" | "ready")) => update_status(app, &s),
        _ => shell.updates.check(app, true).await,
    }
}

/// A folder the person picks with the system's dialog, or None.
pub async fn choose_folder(app: &AppHandle, title: &str) -> Option<String> {
    if let Some(answer) = crate::testing::folder_answer() {
        return answer;
    }
    let mut dialog = app.dialog().file().set_title(title);
    if let Some(w) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&w);
    }
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_folder()).await.ok().flatten()?;
    picked.into_path().ok().map(|p| p.to_string_lossy().to_string())
}

/// Ask the person: true for `ok`.
pub async fn confirm(app: &AppHandle, message: &str, detail: &str, ok: &str, cancel: &str) -> bool {
    if let Some(answer) = crate::testing::confirm_answer(message) {
        return answer;
    }
    let mut dialog = app
        .dialog()
        .message(detail)
        .title(message)
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(ok.into(), cancel.into()));
    if let Some(w) = app.get_webview_window("main") {
        dialog = dialog.parent(&w);
    }
    tauri::async_runtime::spawn_blocking(move || dialog.blocking_show()).await.unwrap_or(false)
}

/// Say that something went wrong.
pub async fn error_box(app: &AppHandle, title: &str, message: &str) {
    log(app, format!("[tauri] {title}: {message}"));
    if crate::testing::active() {
        return;
    }
    let mut dialog = app.dialog().message(message).title(title).kind(MessageDialogKind::Error);
    if let Some(w) = app.get_webview_window("main") {
        dialog = dialog.parent(&w);
    }
    let _ = tauri::async_runtime::spawn_blocking(move || dialog.blocking_show()).await;
}
