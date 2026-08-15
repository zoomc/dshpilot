#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    env,
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{atomic::{AtomicBool, Ordering}, mpsc, Arc, Mutex},
    thread,
    time::Duration,
};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use serde::Serialize;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, State,
};
use tauri_plugin_notification::NotificationExt;

const READINESS_TIMEOUT: Duration = Duration::from_secs(30);

struct RunningHarness {
    child: Child,
    url: String,
    stopping: Arc<AtomicBool>,
}

#[derive(Default)]
struct HarnessState(Arc<Mutex<Option<RunningHarness>>>);

#[derive(Serialize)]
struct RuntimePaths {
    app_data: String,
    dsh_home: String,
    logs: String,
    runtime: String,
    mcp_state: String,
    mcp_patch: String,
    documents: String,
}

fn copy_runtime_seed(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|error| format!("unable to create runtime seed: {error}"))?;
    for entry in fs::read_dir(source).map_err(|error| format!("unable to read runtime seed: {error}"))? {
        let entry = entry.map_err(|error| format!("unable to inspect runtime seed: {error}"))?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if source_path.is_dir() {
            copy_runtime_seed(&source_path, &destination_path)?;
        } else {
            fs::copy(&source_path, &destination_path)
                .map_err(|error| format!("unable to copy runtime seed: {error}"))?;
            #[cfg(unix)]
            if let Ok(metadata) = fs::metadata(&source_path) {
                let _ = fs::set_permissions(&destination_path, fs::Permissions::from_mode(metadata.permissions().mode()));
            }
        }
    }
    Ok(())
}

fn app_paths(app: &AppHandle) -> Result<RuntimePaths, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("unable to resolve app data directory: {error}"))?;
    let paths = RuntimePaths {
        dsh_home: app_data.join("dsh-home").display().to_string(),
        logs: app_data.join("logs").display().to_string(),
        runtime: app_data.join("runtime").display().to_string(),
        app_data: app_data.display().to_string(),
        mcp_state: app_data.join("dsh-home").join("dshpilot").join("mcp-servers.json").display().to_string(),
        mcp_patch: app_data.join("dsh-home").join("dshpilot").join("mcp.patch.yml").display().to_string(),
        documents: app_data.join("dsh-home").join("documents").display().to_string(),
    };
    for path in [
        PathBuf::from(&paths.app_data),
        PathBuf::from(&paths.dsh_home),
        PathBuf::from(&paths.dsh_home).join("dshpilot"),
        PathBuf::from(&paths.documents),
        PathBuf::from(&paths.logs),
        PathBuf::from(&paths.runtime),
        PathBuf::from(&paths.runtime).join("versions"),
        PathBuf::from(&paths.runtime).join("staging"),
        PathBuf::from(&paths.app_data).join("update"),
    ] {
        fs::create_dir_all(path).map_err(|error| format!("unable to create app data: {error}"))?;
    }
    let current = PathBuf::from(&paths.runtime).join("current.json");
    if !current.exists() {
        if let Ok(resource_dir) = app.path().resource_dir() {
            let resource_runtime = resource_dir.join("runtime");
            let resource_manifest = resource_runtime.join("current.json");
            if resource_manifest.exists() {
                copy_runtime_seed(&resource_runtime, Path::new(&paths.runtime))?;
                fs::copy(resource_manifest, current)
                    .map_err(|error| format!("unable to install runtime manifest: {error}"))?;
            }
        }
    }
    Ok(paths)
}

fn readiness_url(line: &str) -> Option<String> {
    let start = line.find("http://127.0.0.1:")?;
    let candidate = line[start..]
        .split_whitespace()
        .next()?
        .trim_end_matches([')', ',', ';']);
    let url = url::Url::parse(candidate).ok()?;
    if url.scheme() != "http" || url.host_str()? != "127.0.0.1" || url.port().is_none() {
        return None;
    }
    Some(candidate.to_string())
}

fn log_line(log_path: &Path, line: &str) {
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_path) {
        let _ = writeln!(file, "{line}");
    }
}

fn dsh_command(_app: &AppHandle, paths: &RuntimePaths) -> Result<(PathBuf, Vec<String>), String> {
    let patch_path = PathBuf::from(&paths.mcp_patch);
    if let Ok(path) = env::var("DSHPILOT_DSH_BIN") {
        let mut args = vec!["web".into()];
        if patch_path.exists() { args.extend(["--patch".into(), patch_path.display().to_string()]); }
        args.extend(["--host".into(), "127.0.0.1".into(), "--port".into(), "0".into()]);
        return Ok((PathBuf::from(path), args));
    }

    let current = PathBuf::from(&paths.runtime).join("current.json");
    let manifest = fs::read_to_string(&current).map_err(|_| {
        format!(
            "no tested Harness runtime is installed; set DSHPILOT_DSH_BIN for development ({})",
            current.display()
        )
    })?;
    let manifest: serde_json::Value = serde_json::from_str(&manifest)
        .map_err(|error| format!("invalid runtime manifest: {error}"))?;
    let runtime_id = manifest
        .get("runtimeVersion")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "runtime manifest is missing runtimeVersion".to_string())?;
    let runtime_root = PathBuf::from(&paths.runtime).join("versions").join(runtime_id);
    let node = runtime_root.join(if cfg!(windows) { "node.exe" } else { "node" });
    let dsh = runtime_root.join("dsh").join("lib").join("bin.js");
    if !node.exists() || !dsh.exists() {
        return Err(format!("runtime {runtime_id} is incomplete"));
    }
    let mut args = vec![dsh.display().to_string(), "web".into()];
    if patch_path.exists() { args.extend(["--patch".into(), patch_path.display().to_string()]); }
    args.extend(["--host".into(), "127.0.0.1".into(), "--port".into(), "0".into()]);
    Ok((node, args))
}

fn stop_child(running: &mut RunningHarness) {
    running.stopping.store(true, Ordering::SeqCst);
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .args(["-TERM", &running.child.id().to_string()])
            .status();
    }
    #[cfg(not(unix))]
    {
        let _ = running.child.kill();
    }
    for _ in 0..50 {
        if running.child.try_wait().ok().flatten().is_some() {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
    let _ = running.child.kill();
    let _ = running.child.wait();
}

fn spawn_harness(
    program: &Path,
    args: &[String],
    dsh_home: &str,
    log_path: &Path,
) -> Result<(Child, String), String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .env("DSH_HOME", dsh_home)
        .env("DSH_TELEMETRY_DISABLED", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| format!("unable to start Harness: {error}"))?;
    let stdout = child.stdout.take().ok_or_else(|| "Harness stdout unavailable".to_string())?;
    let stderr = child.stderr.take().ok_or_else(|| "Harness stderr unavailable".to_string())?;
    let (sender, receiver) = mpsc::channel::<String>();
    let streams: [Box<dyn BufRead + Send>; 2] = [
        Box::new(BufReader::new(stdout)),
        Box::new(BufReader::new(stderr)),
    ];
    for stream in streams {
        let sender = sender.clone();
        let log_path = log_path.to_path_buf();
        thread::spawn(move || {
            for line in stream.lines().flatten() {
                log_line(&log_path, &line);
                if let Some(url) = readiness_url(&line) {
                    let _ = sender.send(url);
                }
            }
        });
    }
    drop(sender);
    let url = receiver.recv_timeout(READINESS_TIMEOUT).map_err(|_| {
        let _ = child.kill();
        "Harness did not report a loopback readiness URL within 30 seconds".to_string()
    })?;
    Ok((child, url))
}

fn monitor_harness(
    state: Arc<Mutex<Option<RunningHarness>>>,
    program: PathBuf,
    args: Vec<String>,
    dsh_home: String,
    log_path: PathBuf,
) {
    thread::spawn(move || {
        let mut restart_count = 0u32;
        loop {
            let (unexpected_exit, stopping) = {
                let mut guard = match state.lock() {
                    Ok(guard) => guard,
                    Err(_) => return,
                };
                let Some(running) = guard.as_mut() else { return };
                match running.child.try_wait() {
                    Ok(Some(_status)) => (true, running.stopping.clone()),
                    Ok(None) => (false, running.stopping.clone()),
                    Err(_) => (true, running.stopping.clone()),
                }
            };
            if !unexpected_exit {
                thread::sleep(Duration::from_millis(250));
                continue;
            }
            if stopping.load(Ordering::SeqCst) {
                if let Ok(mut guard) = state.lock() { guard.take(); }
                return;
            }
            if let Ok(mut guard) = state.lock() { guard.take(); }
            restart_count += 1;
            if restart_count > 5 {
                return;
            }
            let delay_seconds = 2u64.pow((restart_count - 1).min(4));
            thread::sleep(Duration::from_secs(delay_seconds.min(30)));
            if stopping.load(Ordering::SeqCst) { return; }
            match spawn_harness(&program, &args, &dsh_home, &log_path) {
                Ok((child, url)) => {
                    if let Ok(mut guard) = state.lock() {
                        *guard = Some(RunningHarness { child, url, stopping: stopping.clone() });
                    }
                }
                Err(error) => {
                    log_line(&log_path, &format!("supervisor restart {restart_count} failed: {error}"));
                }
            }
        }
    });
}

#[tauri::command]
fn harness_url(app: AppHandle, state: State<'_, HarnessState>) -> Result<String, String> {
    let mut guard = state.0.lock().map_err(|_| "supervisor lock poisoned".to_string())?;
    if let Some(running) = guard.as_ref() {
        return Ok(running.url.clone());
    }

    let paths = app_paths(&app)?;
    let (program, args) = dsh_command(&app, &paths)?;
    let log_path = PathBuf::from(&paths.logs).join("harness.log");
    let (child, url) = spawn_harness(&program, &args, &paths.dsh_home, &log_path)?;
    let stopping = Arc::new(AtomicBool::new(false));
    *guard = Some(RunningHarness { child, url: url.clone(), stopping });
    monitor_harness(state.0.clone(), program, args, paths.dsh_home.clone(), log_path);
    Ok(url)
}

#[tauri::command]
fn stop_harness(state: State<'_, HarnessState>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|_| "supervisor lock poisoned".to_string())?;
    if let Some(mut running) = guard.take() {
        stop_child(&mut running);
    }
    Ok(())
}

#[tauri::command]
fn runtime_paths(app: AppHandle) -> Result<RuntimePaths, String> {
    app_paths(&app)
}

#[tauri::command]
fn native_notification(app: AppHandle, kind: String, title: String, body: String) -> Result<(), String> {
    match kind.as_str() {
        "task-completed" | "task-failed" | "approval-needed" | "question-needed" => {}
        _ => return Err("unsupported notification kind".into()),
    }
    if title.trim().is_empty() || body.trim().is_empty() {
        return Err("notification title and body are required".into());
    }
    app.notification()
        .builder()
        .title(title.trim())
        .body(body.trim())
        .show()
        .map_err(|error| format!("unable to show notification: {error}"))
}

fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show DSHPilot", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    TrayIconBuilder::new()
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .manage(HarnessState::default())
        .invoke_handler(tauri::generate_handler![harness_url, stop_harness, runtime_paths, native_notification])
        .setup(|app| {
            setup_tray(app)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building DSHPilot")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                api.prevent_exit();
                let state = app.state::<HarnessState>();
                if let Ok(mut guard) = state.0.lock() {
                    if let Some(mut running) = guard.take() {
                        stop_child(&mut running);
                    }
                }
                app.exit(0);
            }
        });
}
