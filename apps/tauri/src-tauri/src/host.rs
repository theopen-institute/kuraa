// The desktop app's hub: the Node program src/host.ts (bundled as
// kuraa-desktop.mjs), run by the Node the app carries. Asked things over its
// stdin, one JSON line each; it answers on stdout, on lines starting `@kuraa `.
// Its other lines are its log (it keeps them in a file itself), passed on to
// this process's stderr.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

type Reply = oneshot::Sender<Result<Value, String>>;

pub struct Host {
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
    next: AtomicU64,
    waiting: Mutex<HashMap<u64, Reply>>,
    /// Quitting: its going is expected.
    pub quitting: AtomicBool,
}

impl Host {
    /// Start it. `on_event` hears what it says unasked (`ready`, `newer`); `on_exit`, that it is gone.
    pub fn spawn(
        node: &Path,
        script: &Path,
        args: &[String],
        env: &[(&str, String)],
        on_event: impl Fn(&str) + Send + 'static,
        on_exit: impl FnOnce() + Send + 'static,
    ) -> std::io::Result<Arc<Host>> {
        let mut command = Command::new(node);
        command
            .arg(script)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        for (k, v) in env {
            command.env(k, v);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // No console window of its own.
            command.creation_flags(0x0800_0000);
        }
        let mut child = command.spawn()?;
        let stdout = child.stdout.take().expect("the host's output");
        let host = Arc::new(Host {
            stdin: Mutex::new(child.stdin.take()),
            child: Mutex::new(Some(child)),
            next: AtomicU64::new(1),
            waiting: Mutex::new(HashMap::new()),
            quitting: AtomicBool::new(false),
        });
        let reader = host.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let Some(message) = line.strip_prefix("@kuraa ") else {
                    eprintln!("{line}");
                    continue;
                };
                let Ok(v) = serde_json::from_str::<Value>(message) else { continue };
                if let Some(event) = v.get("event").and_then(Value::as_str) {
                    on_event(event);
                } else if let Some(id) = v.get("id").and_then(Value::as_u64) {
                    if let Some(tx) = reader.waiting.lock().unwrap().remove(&id) {
                        let r = match v.get("error").and_then(Value::as_str) {
                            Some(e) => Err(e.to_string()),
                            None => Ok(v.get("ok").cloned().unwrap_or(Value::Null)),
                        };
                        let _ = tx.send(r);
                    }
                }
            }
            // Gone: whatever waits on it hears so.
            for (_, tx) in reader.waiting.lock().unwrap().drain() {
                let _ = tx.send(Err("Kuraa's host stopped.".into()));
            }
            on_exit();
        });
        Ok(host)
    }

    fn send(&self, message: &Value) -> Result<(), String> {
        let mut stdin = self.stdin.lock().unwrap();
        let pipe = stdin.as_mut().ok_or("Kuraa's host has stopped.")?;
        writeln!(pipe, "{message}").and_then(|_| pipe.flush()).map_err(|e| format!("Kuraa's host cannot be reached: {e}"))
    }

    /// Ask it something, and wait for its answer.
    pub async fn ask(&self, op: &str, args: Value) -> Result<Value, String> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.waiting.lock().unwrap().insert(id, tx);
        let mut message = args;
        if !message.is_object() {
            message = json!({});
        }
        message["id"] = json!(id);
        message["op"] = json!(op);
        if let Err(e) = self.send(&message) {
            self.waiting.lock().unwrap().remove(&id);
            return Err(e);
        }
        rx.await.unwrap_or_else(|_| Err("Kuraa's host stopped.".into()))
    }

    /// A line for its log (which it also writes out, as this process's own lines).
    pub fn log(&self, text: impl Into<String>) {
        let text = text.into();
        if self.send(&json!({ "op": "log", "text": text })).is_err() {
            eprintln!("{text}");
        }
    }

    /// Ask it to stop (it writes and commits what is pending), and wait for it to; after `wait`, stop it.
    pub fn quit(&self, wait: Duration) {
        self.quitting.store(true, Ordering::SeqCst);
        let Some(mut child) = self.child.lock().unwrap().take() else { return };
        let _ = self.send(&json!({ "op": "quit" }));
        let until = Instant::now() + wait;
        while Instant::now() < until {
            if let Ok(Some(_)) = child.try_wait() {
                self.stdin.lock().unwrap().take();
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        eprintln!("[tauri] the host did not stop in time: stopping it");
        let _ = child.kill();
        let _ = child.wait();
        self.stdin.lock().unwrap().take();
    }
}
