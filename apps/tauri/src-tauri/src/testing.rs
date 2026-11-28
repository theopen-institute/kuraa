// Driving the app from the desktop tests (tests/e2e/tauri.spec.ts): Playwright
// drives Electron, not Tauri, and the system's webview has no driver on a Mac, so
// a build with the `test-control` feature (never a release) takes a test's
// requests on loopback, from whoever has the code in the file KURAA_TEST_CONTROL
// names: work something out in a window's page, choose from the app's menu,
// answer its dialogs ahead of time, tell the page what the shell would (an update
// ready), say the window's title, quit. Without the
// feature none of this listens, and the dialogs' answers are never set.
use serde_json::Value;
use std::collections::VecDeque;
use std::sync::Mutex;

#[derive(Default)]
struct Answers {
    /// The folders the next folder dialogs pick (None: cancelled).
    folders: VecDeque<Option<String>>,
    /// The answers to the next questions, with (part of) what each asks.
    confirms: VecDeque<(String, bool)>,
    /// Where the next downloads are saved.
    saves: VecDeque<Option<String>>,
    /// Questions asked, for a test to see.
    asked: Vec<String>,
    active: bool,
}

static ANSWERS: Mutex<Option<Answers>> = Mutex::new(None);

fn with<T>(f: impl FnOnce(&mut Answers) -> T) -> T {
    let mut a = ANSWERS.lock().unwrap();
    f(a.get_or_insert_with(Answers::default))
}

/// Whether a test drives the app (its dialogs are answered, never shown).
pub fn active() -> bool {
    with(|a| a.active)
}

pub fn folder_answer() -> Option<Option<String>> {
    with(|a| if a.active { Some(a.folders.pop_front().flatten()) } else { None })
}

pub fn confirm_answer(message: &str) -> Option<bool> {
    with(|a| {
        if !a.active {
            return None;
        }
        a.asked.push(message.to_string());
        let i = a.confirms.iter().position(|(m, _)| message.contains(m.as_str()))?;
        a.confirms.remove(i).map(|(_, yes)| yes)
    })
}

pub fn save_answer() -> Option<Option<String>> {
    with(|a| if a.active { Some(a.saves.pop_front().flatten()) } else { None })
}

#[cfg(not(feature = "test-control"))]
pub fn answered(_id: u64, _ok: Option<Value>, _error: Option<String>) {}

#[cfg(not(feature = "test-control"))]
pub fn start(_app: &tauri::AppHandle) {}

#[cfg(feature = "test-control")]
pub use control::{answered, start};

#[cfg(feature = "test-control")]
mod control {
    use super::{with, Value};
    use serde_json::json;
    use std::collections::HashMap;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{mpsc, Mutex};
    use std::time::Duration;
    use tauri::{AppHandle, Manager};

    type Waiting = HashMap<u64, mpsc::Sender<Result<Value, String>>>;
    static WAITING: Mutex<Option<Waiting>> = Mutex::new(None);
    static NEXT: AtomicU64 = AtomicU64::new(1);

    pub fn answered(id: u64, ok: Option<Value>, error: Option<String>) {
        if let Some(tx) = WAITING.lock().unwrap().get_or_insert_with(HashMap::new).remove(&id) {
            let _ = tx.send(match error {
                Some(e) => Err(e),
                None => Ok(ok.unwrap_or(Value::Null)),
            });
        }
    }

    /// Work out `js` (an expression, perhaps a promise) in a window's page.
    fn evaluate(app: &AppHandle, window: &str, js: &str) -> Result<Value, String> {
        let w = app.get_webview_window(window).ok_or(format!("no window {window}"))?;
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        WAITING.lock().unwrap().get_or_insert_with(HashMap::new).insert(id, tx);
        let script = format!(
            "(async () => {{ const say = (a) => window.__TAURI_INTERNALS__.invoke('test_result', {{ id: {id}, ...a }}); \
             try {{ const v = await ({js}); say({{ ok: v === undefined ? null : v }}); }} catch (e) {{ say({{ error: String(e && e.stack || e) }}); }} }})()"
        );
        w.eval(script).map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(30)).map_err(|_| "the page did not answer".to_string())?
    }

    fn handle(app: &AppHandle, r: &Value) -> Result<Value, String> {
        let s = |k: &str| r.get(k).and_then(Value::as_str).map(String::from);
        match s("op").as_deref() {
            Some("eval") => evaluate(app, &s("window").unwrap_or_else(|| "main".into()), &s("js").unwrap_or_default()),
            Some("url") => {
                let w = app.get_webview_window(&s("window").unwrap_or_else(|| "main".into())).ok_or("no window")?;
                Ok(json!(w.url().map_err(|e| e.to_string())?.to_string()))
            }
            Some("title") => {
                let w = app.get_webview_window(&s("window").unwrap_or_else(|| "main".into())).ok_or("no window")?;
                Ok(json!(w.title().map_err(|e| e.to_string())?))
            }
            Some("windows") => Ok(json!(app.webview_windows().keys().cloned().collect::<Vec<_>>())),
            Some("menu") => {
                crate::menu::chose(app, &s("id").unwrap_or_default());
                Ok(Value::Null)
            }
            Some("folder") => {
                with(|a| a.folders.push_back(s("path")));
                Ok(Value::Null)
            }
            Some("save") => {
                with(|a| a.saves.push_back(s("path")));
                Ok(Value::Null)
            }
            Some("confirm") => {
                let yes = r.get("answer").and_then(Value::as_bool).unwrap_or(false);
                with(|a| a.confirms.push_back((s("asking").unwrap_or_default(), yes)));
                Ok(Value::Null)
            }
            Some("asked") => Ok(json!(with(|a| a.asked.clone()))),
            Some("emit") => {
                let shell = app.state::<crate::shell::Shared>();
                shell.emit(app, &s("event").unwrap_or_default(), r.get("value").cloned().unwrap_or(Value::Null));
                Ok(Value::Null)
            }
            Some("quit") => {
                let app = app.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(50));
                    app.exit(0);
                });
                Ok(Value::Null)
            }
            other => Err(format!("no such request: {other:?}")),
        }
    }

    /// Listen, if KURAA_TEST_CONTROL names a file to say where (its port and code, on one line).
    pub fn start(app: &AppHandle) {
        let Ok(file) = std::env::var("KURAA_TEST_CONTROL") else { return };
        with(|a| a.active = true);
        let listener = TcpListener::bind("127.0.0.1:0").expect("a port for the tests");
        let port = listener.local_addr().expect("its port").port();
        let mut bytes = [0u8; 16];
        getrandom::fill(&mut bytes).expect("randomness");
        let code: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        std::fs::write(&file, format!("{port} {code}\n")).expect("the control file");
        let app = app.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().map_while(Result::ok) {
                let app = app.clone();
                let code = code.clone();
                std::thread::spawn(move || {
                    let mut out = match stream.try_clone() {
                        Ok(s) => s,
                        Err(_) => return,
                    };
                    let mut lines = BufReader::new(stream).lines();
                    // The first line is the code.
                    if lines.next().and_then(Result::ok).as_deref() != Some(code.as_str()) {
                        return;
                    }
                    for line in lines.map_while(Result::ok) {
                        let reply = match serde_json::from_str::<Value>(&line) {
                            Ok(r) => match handle(&app, &r) {
                                Ok(v) => json!({ "ok": v }),
                                Err(e) => json!({ "error": e }),
                            },
                            Err(e) => json!({ "error": e.to_string() }),
                        };
                        if writeln!(out, "{reply}").is_err() {
                            return;
                        }
                    }
                });
            }
        });
    }
}
