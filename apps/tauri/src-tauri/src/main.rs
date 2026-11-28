// Kuraa's desktop app as a Tauri shell: a prototype (decision 0123), on macOS.
//
// It opens a window on a loading page, starts the host as released
// (kuraa-host.mjs, scripts/build-server.mjs) with the Node it carries, on
// loopback, on a free port, with a random access code, its settings and
// workspaces in this app's data folder, and the git it carries; once the host
// says its address, the window goes there. The page is the web client the host
// serves, as in a browser: no bridge to the shell yet (decision 0009's
// ShellBridge), so Preferences and Open a folder… are the page's own (0047).
// Quitting asks the host to stop (SIGTERM), which writes and commits pending
// edits, and waits for it.
//
// The window shows only the host's pages and this loading page; other web
// addresses open in the default browser.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder};

/// The host's process, stopped when the app quits.
struct Host(Mutex<Option<Child>>);

/// An access code no one can guess (the host's token), from the system's randomness.
fn access_code() -> std::io::Result<String> {
    let mut bytes = [0u8; 24];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Ask the host to stop, and wait for it to write and commit what is pending; after a while, stop it.
fn stop(host: &mut Child) {
    unsafe {
        libc::kill(host.id() as libc::pid_t, libc::SIGTERM);
    }
    let until = Instant::now() + Duration::from_secs(15);
    while Instant::now() < until {
        if let Ok(Some(_)) = host.try_wait() {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    eprintln!("[tauri] the host did not stop in time: stopping it");
    let _ = host.kill();
    let _ = host.wait();
}

fn main() {
    let started = Instant::now();
    // The host's address, once it has said it: the window may go only there (and to its loading page).
    let origin: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let allowed = origin.clone();
    let app = tauri::Builder::default()
        .setup(move |app| {
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Kuraa")
                .inner_size(1200.0, 820.0)
                .min_inner_size(640.0, 480.0)
                .on_navigation(move |url| {
                    if url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost") {
                        return true;
                    }
                    let here = allowed.lock().unwrap().clone();
                    if here.as_ref().is_some_and(|o| url.as_str().starts_with(o.as_str())) {
                        return true;
                    }
                    eprintln!("[tauri] not shown here: {url} (the host is at {here:?})");
                    if matches!(url.scheme(), "http" | "https" | "mailto") {
                        let _ = Command::new("open").arg(url.as_str()).spawn();
                    }
                    false
                })
                .build()?;

            let resources = app.path().resource_dir()?;
            let data = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data)?;
            let node = std::env::current_exe()?
                .parent()
                .expect("the app's folder")
                .join("node");
            let token = access_code()?;
            let mut child = Command::new(&node)
                .arg(resources.join("host").join("kuraa-host.mjs"))
                .args(["--port", "0", "--token", &token])
                .arg("--settings")
                .arg(data.join("settings.json"))
                .arg("--workspaces")
                .arg(data.join("Workspaces"))
                .env("KURAA_GIT_DIR", resources.join("git"))
                .stdout(Stdio::piped())
                .spawn()?;
            let stdout = child.stdout.take().expect("the host's output");
            app.manage(Host(Mutex::new(Some(child))));

            // Its output, passed on; the line with its address, sent here.
            let (tx, rx) = mpsc::channel::<String>();
            std::thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    eprintln!("{line}");
                    if let Some(url) = line.strip_prefix("[kuraa] url:") {
                        let _ = tx.send(url.trim().to_string());
                    }
                }
            });
            std::thread::spawn(move || match rx.recv_timeout(Duration::from_secs(60)) {
                Ok(url) => {
                    eprintln!("[tauri] host ready after {} ms", started.elapsed().as_millis());
                    *origin.lock().unwrap() = Some(format!("{url}/"));
                    match Url::parse(&format!("{url}/?token={token}")) {
                        Ok(page) => {
                            if let Err(e) = window.navigate(page) {
                                eprintln!("[tauri] could not show the host's page: {e}");
                            }
                        }
                        Err(e) => eprintln!("[tauri] the host's address: {e}"),
                    }
                }
                Err(_) => eprintln!("[tauri] the host did not say its address within a minute"),
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("the app");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            if let Some(host) = app.try_state::<Host>() {
                if let Some(mut child) = host.0.lock().unwrap().take() {
                    stop(&mut child);
                }
            }
        }
    });
}
