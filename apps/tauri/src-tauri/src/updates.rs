// The app updating itself (decision 0127, as 0051 had it for the Electron app),
// with Tauri's updater: it looks where the build says (tauri.conf.json's
// plugins.updater, written by scripts/build.mjs from KURAA_UPDATES), downloads a
// newer release in the background, checked against the key built in, and puts it
// in place when the app quits, or at once when the person says so (Restart now).
//
// It looks a minute after starting, every four hours, when the app's menu asks
// (Check for Updates…, whose window shows how it goes), and when a device of a
// workspace runs a newer kuraa than this one (the host says so). Whoever listens
// (shell.rs) hears how updating stands as it changes: looking, downloading and how
// far, ready, failed; in the shape the updates window's page draws (the Electron
// app's update-view.ts: UpdateStatus).
//
// Not in a build without a place to look (no KURAA_UPDATES), nor run from the
// repository (`tauri dev`).
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Looked for again this often while the app runs.
const EVERY: Duration = Duration::from_secs(4 * 3600);
/// Not looked for more often than this unless asked.
const AT_MOST: Duration = Duration::from_secs(10 * 60);

#[derive(Default)]
pub struct Updates {
    status: Mutex<Option<Value>>,
    /// The update downloaded, ready to put in place.
    ready: Mutex<Option<(Update, Vec<u8>)>>,
    last: Mutex<Option<Instant>>,
    checking: Mutex<bool>,
}

/// Whether this build can update itself, and if not, why.
pub fn why_not(app: &AppHandle) -> Option<String> {
    if cfg!(debug_assertions) {
        return Some("run from the repository".into());
    }
    if !app.config().plugins.0.contains_key("updater") {
        return Some("built without a place to look for updates (KURAA_UPDATES)".into());
    }
    None
}

impl Updates {
    pub fn status(&self) -> Option<Value> {
        self.status.lock().unwrap().clone()
    }

    /// The version downloaded and ready to put in place, if any.
    pub fn ready(&self) -> Option<String> {
        self.ready.lock().unwrap().as_ref().map(|(u, _)| u.version.clone())
    }

    fn set(&self, app: &AppHandle, status: Value) {
        *self.status.lock().unwrap() = Some(status.clone());
        crate::shell::update_status(app, &status);
    }

    fn kind(&self) -> Option<String> {
        self.status.lock().unwrap().as_ref().and_then(|s| s.get("kind")).and_then(Value::as_str).map(String::from)
    }

    /// Look for one now (`asked`: the person asked, so even if it looked moments ago), and download it.
    pub async fn check(&self, app: &AppHandle, asked: bool) {
        if why_not(app).is_some() || self.ready().is_some() || self.kind().as_deref() == Some("downloading") {
            return;
        }
        {
            let mut checking = self.checking.lock().unwrap();
            let mut last = self.last.lock().unwrap();
            if *checking || (!asked && last.is_some_and(|t| t.elapsed() < AT_MOST)) {
                return;
            }
            *checking = true;
            *last = Some(Instant::now());
        }
        self.set(app, json!({ "kind": "checking" }));
        let result = self.look(app).await;
        *self.checking.lock().unwrap() = false;
        match result {
            Ok(None) => self.set(app, json!({ "kind": "none" })),
            Ok(Some(version)) => {
                crate::shell::log(app, format!("[updates] {version} downloaded: put in place when Kuraa quits, or at once with Restart now"));
                self.set(app, json!({ "kind": "ready", "version": version }));
            }
            Err(e) => {
                crate::shell::log(app, format!("[updates] {e}"));
                self.set(app, json!({ "kind": "failed", "message": e }));
            }
        }
    }

    async fn look(&self, app: &AppHandle) -> Result<Option<String>, String> {
        let updater = app.updater().map_err(|e| e.to_string())?;
        let Some(update) = updater.check().await.map_err(|e| e.to_string())? else { return Ok(None) };
        let version = update.version.clone();
        crate::shell::log(app, format!("[updates] downloading {version}"));
        self.set(app, json!({ "kind": "downloading", "version": version, "progress": null }));
        let started = Instant::now();
        let done = Mutex::new(0u64);
        let shown = Mutex::new(Instant::now() - Duration::from_secs(1));
        let bytes = update
            .download(
                |chunk, total| {
                    let mut d = done.lock().unwrap();
                    *d += chunk as u64;
                    // Said a few times a second, not for every chunk.
                    let mut at = shown.lock().unwrap();
                    if at.elapsed() < Duration::from_millis(200) {
                        return;
                    }
                    *at = Instant::now();
                    let total = total.unwrap_or(0);
                    let seconds = started.elapsed().as_secs_f64().max(0.001);
                    let progress = if total > 0 {
                        json!({ "percent": *d as f64 * 100.0 / total as f64, "transferred": *d, "total": total, "bytesPerSecond": *d as f64 / seconds })
                    } else {
                        Value::Null
                    };
                    self.set(app, json!({ "kind": "downloading", "version": version, "progress": progress }));
                },
                || {},
            )
            .await
            .map_err(|e| e.to_string())?;
        *self.ready.lock().unwrap() = Some((update, bytes));
        Ok(Some(version))
    }

    /// Put the update downloaded in place (the app stopped first): true if there was one.
    pub fn install(&self, app: &AppHandle) -> Result<bool, String> {
        let Some((update, bytes)) = self.ready.lock().unwrap().take() else { return Ok(false) };
        crate::shell::log(app, format!("[updates] putting {} in place", update.version));
        update.install(bytes).map_err(|e| e.to_string())?;
        Ok(true)
    }
}

/// Look a minute after starting, then every four hours.
pub fn start(app: &AppHandle) {
    if let Some(why) = why_not(app) {
        crate::shell::log(app, format!("[updates] not looking for updates: {why}"));
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(60)).await;
        loop {
            let shell = app.state::<crate::shell::Shared>();
            shell.updates.check(&app, false).await;
            tokio::time::sleep(EVERY).await;
        }
    });
}
