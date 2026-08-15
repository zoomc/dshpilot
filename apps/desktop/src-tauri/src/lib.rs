#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    collections::HashSet,
    env,
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    net::{TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::Duration,
};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg(unix)]
use std::os::unix::process::CommandExt;

use base64::Engine as _;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use keyring::Entry;
use serde::Serialize;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, State,
};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_notification::NotificationExt;

const READINESS_TIMEOUT: Duration = Duration::from_secs(30);
const HEALTH_PROBE_TIMEOUT: Duration = Duration::from_millis(500);
const EMBEDDED_RUNTIME_PUBLIC_KEY: Option<&str> = option_env!("DSHPILOT_RUNTIME_PUBLIC_KEY");
static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);
static RUNTIME_UPDATE_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

struct RuntimeUpdateGuard;

impl RuntimeUpdateGuard {
    fn acquire() -> Result<Self, String> {
        RUNTIME_UPDATE_IN_PROGRESS
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map(|_| Self)
            .map_err(|_| "another Runtime update or rollback is already in progress".into())
    }
}

impl Drop for RuntimeUpdateGuard {
    fn drop(&mut self) {
        RUNTIME_UPDATE_IN_PROGRESS.store(false, Ordering::SeqCst);
    }
}

struct RunningHarness {
    child: Child,
    url: String,
    stopping: Arc<AtomicBool>,
    generation: u64,
}

#[derive(Default)]
struct HarnessState(Arc<Mutex<Option<RunningHarness>>>);

#[derive(Clone, Serialize)]
struct SupervisorStatus {
    state: String,
    phase: String,
    generation: u64,
    url: Option<String>,
    pid: Option<u32>,
    restart_count: u32,
    last_error: Option<String>,
}

#[derive(Clone)]
struct SupervisorStatusState(Arc<Mutex<SupervisorStatus>>);

impl Default for SupervisorStatusState {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(SupervisorStatus {
            state: "idle".into(),
            phase: "spawn".into(),
            generation: 0,
            url: None,
            pid: None,
            restart_count: 0,
            last_error: None,
        })))
    }
}

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
    fs::create_dir_all(destination)
        .map_err(|error| format!("unable to create runtime seed: {error}"))?;
    for entry in
        fs::read_dir(source).map_err(|error| format!("unable to read runtime seed: {error}"))?
    {
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
                let _ = fs::set_permissions(
                    &destination_path,
                    fs::Permissions::from_mode(metadata.permissions().mode()),
                );
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
        mcp_state: app_data
            .join("dsh-home")
            .join("dshpilot")
            .join("mcp-servers.json")
            .display()
            .to_string(),
        mcp_patch: app_data
            .join("dsh-home")
            .join("dshpilot")
            .join("mcp.patch.yml")
            .display()
            .to_string(),
        documents: app_data
            .join("dsh-home")
            .join("documents")
            .display()
            .to_string(),
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

fn http_probe(base_url: &str, path: &str) -> Result<(u16, String), String> {
    let base =
        url::Url::parse(base_url).map_err(|error| format!("invalid Harness URL: {error}"))?;
    if base.scheme() != "http" || base.host_str() != Some("127.0.0.1") {
        return Err("Harness URL is not loopback HTTP".into());
    }
    let port = base
        .port()
        .ok_or_else(|| "Harness URL has no port".to_string())?;
    let address = ("127.0.0.1", port)
        .to_socket_addrs()
        .map_err(|error| format!("unable to resolve Harness socket: {error}"))?
        .next()
        .ok_or_else(|| "Harness socket address is unavailable".to_string())?;
    let mut stream = TcpStream::connect_timeout(&address, HEALTH_PROBE_TIMEOUT)
        .map_err(|error| format!("Harness health connection failed: {error}"))?;
    stream
        .set_read_timeout(Some(HEALTH_PROBE_TIMEOUT))
        .map_err(|error| format!("unable to set health read timeout: {error}"))?;
    stream
        .set_write_timeout(Some(HEALTH_PROBE_TIMEOUT))
        .map_err(|error| format!("unable to set health write timeout: {error}"))?;
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    )
    .map_err(|error| format!("Harness health request failed: {error}"))?;
    let mut response = Vec::new();
    stream
        .take(512 * 1024)
        .read_to_end(&mut response)
        .map_err(|error| format!("Harness health response failed: {error}"))?;
    let text = String::from_utf8_lossy(&response);
    let status = text
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| "Harness health status is malformed".to_string())?;
    let body = text
        .split("\r\n\r\n")
        .nth(1)
        .unwrap_or_default()
        .to_string();
    Ok((status, body))
}

fn wait_for_health(url: &str) -> Result<(), String> {
    if cfg!(debug_assertions) && env::var("DSHPILOT_SKIP_HEALTH").as_deref() == Ok("1") {
        return Ok(());
    }
    let deadline = std::time::Instant::now() + READINESS_TIMEOUT;
    let mut last_error = "Harness health probe did not complete".to_string();
    while std::time::Instant::now() < deadline {
        match http_probe(url, "/") {
            Ok((status, body))
                if (200..300).contains(&status) && body.contains("<!doctype html>") =>
            {
                match http_probe(url, "/__dshpilot/health") {
                    Ok((health_status, health_body)) if (200..300).contains(&health_status) => {
                        let health: serde_json::Value = serde_json::from_str(&health_body)
                            .map_err(|error| {
                                format!("Harness DSHPilot health is invalid JSON: {error}")
                            })?;
                        if health.get("status").and_then(serde_json::Value::as_str) == Some("ready")
                            && health
                                .get("webUiReady")
                                .and_then(serde_json::Value::as_bool)
                                == Some(true)
                            && health.get("apiReady").and_then(serde_json::Value::as_bool)
                                == Some(true)
                        {
                            return Ok(());
                        }
                        last_error = "Harness DSHPilot health reported not ready".into();
                    }
                    Ok((health_status, _)) => {
                        last_error =
                            format!("Harness DSHPilot health returned HTTP {health_status}");
                    }
                    Err(error) => {
                        last_error = error;
                    }
                }
            }
            Ok((status, _)) => {
                last_error = format!("Harness root returned HTTP {status}");
            }
            Err(error) => {
                last_error = error;
            }
        }
        thread::sleep(Duration::from_millis(250));
    }
    Err(last_error)
}

fn log_line(log_path: &Path, line: &str) {
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_path) {
        let _ = writeln!(file, "{line}");
    }
}

fn dsh_command(_app: &AppHandle, paths: &RuntimePaths) -> Result<(PathBuf, Vec<String>), String> {
    let patch_path = PathBuf::from(&paths.mcp_patch);
    if cfg!(debug_assertions) {
        if let Ok(path) = env::var("DSHPILOT_DSH_BIN") {
            let mut args = vec!["web".into()];
            if patch_path.exists() {
                args.extend(["--patch".into(), patch_path.display().to_string()]);
            }
            args.extend([
                "--host".into(),
                "127.0.0.1".into(),
                "--port".into(),
                "0".into(),
            ]);
            return Ok((PathBuf::from(path), args));
        }
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
    let runtime_id = validate_runtime_manifest(&manifest, &PathBuf::from(&paths.runtime))?;
    let runtime_root = PathBuf::from(&paths.runtime)
        .join("versions")
        .join(&runtime_id);
    let node = runtime_root.join(if cfg!(windows) { "node.exe" } else { "node" });
    let dsh = runtime_root.join("dsh").join("lib").join("bin.js");
    if !node.exists() || !dsh.exists() {
        return Err(format!("runtime {runtime_id} is incomplete"));
    }
    for package_name in [
        "control-contracts",
        "desktop-host",
        "dsh-plugin-desktop",
        "dsh-client-desktop",
    ] {
        let package = runtime_root
            .join("dsh")
            .join("node_modules")
            .join("@dshpilot")
            .join(package_name);
        if !package.join("package.json").exists() {
            return Err(format!(
                "runtime {runtime_id} is missing @dshpilot/{package_name}"
            ));
        }
    }
    let fallback_root = PathBuf::from(&paths.dsh_home)
        .join("profiles")
        .join("node_modules")
        .join("@dshpilot");
    for package_name in [
        "control-contracts",
        "desktop-host",
        "dsh-plugin-desktop",
        "dsh-client-desktop",
        "remote-daemon",
    ] {
        let source = runtime_root
            .join("dsh")
            .join("node_modules")
            .join("@dshpilot")
            .join(package_name);
        if source.exists() {
            copy_runtime_seed(&source, &fallback_root.join(package_name))?;
        }
    }
    let mut args = vec![dsh.display().to_string(), "web".into()];
    if patch_path.exists() {
        args.extend(["--patch".into(), patch_path.display().to_string()]);
    }
    let desktop_patch = runtime_root.join("dshpilot.patch.yml");
    if desktop_patch.exists() {
        args.extend(["--patch".into(), desktop_patch.display().to_string()]);
    }
    args.extend([
        "--host".into(),
        "127.0.0.1".into(),
        "--port".into(),
        "0".into(),
    ]);
    Ok((node, args))
}

fn allow_unsigned_runtime() -> bool {
    cfg!(debug_assertions) && env::var("DSHPILOT_ALLOW_UNSIGNED_RUNTIME").as_deref() != Ok("0")
}

fn decode_runtime_public_key(value: &[u8]) -> Result<VerifyingKey, String> {
    let text = String::from_utf8_lossy(value);
    let encoded = if text.contains("BEGIN PUBLIC KEY") {
        text.lines()
            .filter(|line| !line.starts_with("---"))
            .collect::<String>()
    } else {
        text.trim().to_string()
    };
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|error| format!("runtime public key is not base64: {error}"))?;
    let raw = if decoded.len() == 32 {
        decoded
    } else if decoded.len() >= 32 {
        decoded[decoded.len() - 32..].to_vec()
    } else {
        return Err("runtime public key has invalid length".into());
    };
    VerifyingKey::from_bytes(
        raw.as_slice()
            .try_into()
            .map_err(|_| "runtime public key has invalid length")?,
    )
    .map_err(|error| format!("runtime public key is invalid: {error}"))
}

fn canonical_runtime_json(value: &serde_json::Value, output: &mut String) -> Result<(), String> {
    match value {
        serde_json::Value::Null => output.push_str("null"),
        serde_json::Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        serde_json::Value::Number(value) => output.push_str(&value.to_string()),
        serde_json::Value::String(value) => output.push_str(
            &serde_json::to_string(value)
                .map_err(|error| format!("runtime string cannot be canonicalized: {error}"))?,
        ),
        serde_json::Value::Array(values) => {
            output.push('[');
            for (index, item) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                canonical_runtime_json(item, output)?;
            }
            output.push(']');
        }
        serde_json::Value::Object(values) => {
            output.push('{');
            let mut entries: Vec<_> = values
                .iter()
                .filter(|(key, _)| key.as_str() != "manifestSignature")
                .collect();
            entries.sort_by(|left, right| left.0.cmp(right.0));
            for (index, (key, item)) in entries.into_iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output
                    .push_str(&serde_json::to_string(key).map_err(|error| {
                        format!("runtime key cannot be canonicalized: {error}")
                    })?);
                output.push(':');
                canonical_runtime_json(item, output)?;
            }
            output.push('}');
        }
    }
    Ok(())
}

fn validate_runtime_manifest(
    manifest: &serde_json::Value,
    runtime_root: &Path,
) -> Result<String, String> {
    if manifest
        .get("schemaVersion")
        .and_then(serde_json::Value::as_u64)
        != Some(1)
        || manifest.get("channel").and_then(serde_json::Value::as_str) != Some("tested")
    {
        return Err("runtime manifest must be schemaVersion=1/channel=tested".into());
    }
    let runtime_id = manifest
        .get("runtimeVersion")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "runtime manifest is missing runtimeVersion".to_string())?;
    if runtime_id.is_empty()
        || runtime_id.len() > 160
        || !runtime_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        return Err("runtimeVersion contains unsafe path characters".into());
    }
    let node = manifest
        .get("node")
        .ok_or_else(|| "runtime manifest is missing node metadata".to_string())?;
    let expected_platform = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        value => value,
    };
    let expected_arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        value => value,
    };
    if node.get("platform").and_then(serde_json::Value::as_str) != Some(expected_platform)
        || node.get("arch").and_then(serde_json::Value::as_str) != Some(expected_arch)
    {
        return Err("runtime platform/architecture does not match this desktop".into());
    }
    let artifact = manifest
        .get("artifact")
        .ok_or_else(|| "runtime manifest is missing artifact metadata".to_string())?;
    let sha256 = artifact
        .get("sha256")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    if sha256.len() != 64 || !sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("runtime artifact sha256 is invalid".into());
    }
    let unsigned = artifact
        .get("signature")
        .and_then(serde_json::Value::as_str)
        == Some("UNSIGNED-LOCAL");
    let signature = manifest.get("manifestSignature");
    if unsigned || signature.is_none() {
        if !allow_unsigned_runtime() {
            return Err("unsigned runtime is not accepted in a production build".into());
        }
        return Ok(runtime_id.to_string());
    }
    let signature_value = signature
        .and_then(|value| value.get("value"))
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "runtime manifest signature is incomplete".to_string())?;
    let signature_bytes = base64::engine::general_purpose::STANDARD
        .decode(signature_value)
        .map_err(|error| format!("runtime manifest signature is not base64: {error}"))?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|error| format!("runtime manifest signature is invalid: {error}"))?;
    let mut public_key_path = runtime_root.join("public.key");
    if !public_key_path.exists() {
        public_key_path = runtime_root
            .join("versions")
            .join(runtime_id)
            .join("public.key");
    }
    let public_key = match EMBEDDED_RUNTIME_PUBLIC_KEY {
        Some(value) => decode_runtime_public_key(value.as_bytes())?,
        None => decode_runtime_public_key(&fs::read(&public_key_path).map_err(|_| {
            format!(
                "runtime public key is missing: {}",
                public_key_path.display()
            )
        })?)?,
    };
    let mut payload = String::new();
    canonical_runtime_json(manifest, &mut payload)?;
    public_key
        .verify(payload.as_bytes(), &signature)
        .map_err(|_| "runtime manifest signature mismatch".to_string())?;
    Ok(runtime_id.to_string())
}

fn recover_previous_runtime(paths: &RuntimePaths) -> Result<bool, String> {
    let runtime = PathBuf::from(&paths.runtime);
    let previous_path = runtime.join("previous.json");
    if !previous_path.exists() {
        return Ok(false);
    }
    let value: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(&previous_path)
            .map_err(|error| format!("unable to read previous Runtime: {error}"))?,
    )
    .map_err(|error| format!("previous Runtime manifest is invalid: {error}"))?;
    let runtime_id = validate_runtime_manifest(&value, &runtime)?;
    let root = runtime.join("versions").join(&runtime_id);
    let node = root.join(if cfg!(windows) { "node.exe" } else { "node" });
    let dsh = root.join("dsh").join("lib").join("bin.js");
    if !node.exists() || !dsh.exists() {
        return Ok(false);
    }
    let current = runtime.join("current.json");
    let temporary = runtime.join(format!("current.json.{}.recovery.tmp", std::process::id()));
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(&value)
            .map_err(|error| format!("unable to serialize previous Runtime: {error}"))?,
    )
    .map_err(|error| format!("unable to stage previous Runtime recovery: {error}"))?;
    match fs::rename(&temporary, &current) {
        Ok(()) => {}
        Err(error) if cfg!(windows) => {
            fs::remove_file(&current).map_err(|remove_error| format!("unable to replace corrupt current Runtime: {remove_error}; original error: {error}"))?;
            fs::rename(&temporary, &current).map_err(|rename_error| {
                format!("unable to promote previous Runtime: {rename_error}")
            })?;
        }
        Err(error) => {
            let _ = fs::remove_file(&temporary);
            return Err(format!("unable to promote previous Runtime: {error}"));
        }
    }
    Ok(true)
}

fn stop_child(running: &mut RunningHarness) {
    running.stopping.store(true, Ordering::SeqCst);
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .args(["-TERM", &format!("-{}", running.child.id())])
            .status();
    }
    #[cfg(not(unix))]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &running.child.id().to_string(), "/T"])
            .status();
    }
    for _ in 0..50 {
        if running.child.try_wait().ok().flatten().is_some() {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .args(["-KILL", &format!("-{}", running.child.id())])
            .status();
    }
    #[cfg(not(unix))]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &running.child.id().to_string(), "/T", "/F"])
            .status();
    }
    let _ = running.child.wait();
}

fn cleanup_descendants(pid: u32) {
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .args(["-KILL", &format!("-{}", pid)])
            .status();
    }
    #[cfg(not(unix))]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status();
    }
}

fn cleanup_child(child: &mut Child) {
    cleanup_descendants(child.id());
    let _ = child.wait();
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
    #[cfg(unix)]
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) == 0 {
                Ok(())
            } else {
                Err(std::io::Error::last_os_error())
            }
        });
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("unable to start Harness: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Harness stdout unavailable".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Harness stderr unavailable".to_string())?;
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
    let url = match receiver.recv_timeout(READINESS_TIMEOUT) {
        Ok(url) => url,
        Err(_) => {
            cleanup_child(&mut child);
            return Err("Harness did not report a loopback readiness URL within 30 seconds".into());
        }
    };
    if let Err(error) = wait_for_health(&url) {
        cleanup_child(&mut child);
        return Err(format!("Harness readiness health check failed: {error}"));
    }
    Ok((child, url))
}

fn monitor_harness(
    state: Arc<Mutex<Option<RunningHarness>>>,
    status: Arc<Mutex<SupervisorStatus>>,
    program: PathBuf,
    args: Vec<String>,
    dsh_home: String,
    log_path: PathBuf,
) {
    thread::spawn(move || {
        let mut restart_count = 0u32;
        let mut stable_since: Option<std::time::Instant> = None;
        loop {
            let (unexpected_exit, stopping, generation, exited_pid) = {
                let mut guard = match state.lock() {
                    Ok(guard) => guard,
                    Err(_) => return,
                };
                let Some(running) = guard.as_mut() else {
                    return;
                };
                match running.child.try_wait() {
                    Ok(Some(_status)) => (
                        true,
                        running.stopping.clone(),
                        running.generation,
                        running.child.id(),
                    ),
                    Ok(None) => (
                        false,
                        running.stopping.clone(),
                        running.generation,
                        running.child.id(),
                    ),
                    Err(_) => (
                        true,
                        running.stopping.clone(),
                        running.generation,
                        running.child.id(),
                    ),
                }
            };
            if !unexpected_exit {
                thread::sleep(Duration::from_millis(250));
                continue;
            }
            if stopping.load(Ordering::SeqCst) {
                if let Ok(mut guard) = state.lock() {
                    guard.take();
                }
                if let Ok(mut snapshot) = status.lock() {
                    snapshot.state = "stopped".into();
                    snapshot.phase = "spawn".into();
                    snapshot.url = None;
                    snapshot.pid = None;
                }
                return;
            }
            cleanup_descendants(exited_pid);
            if let Ok(mut guard) = state.lock() {
                guard.take();
            }
            if stable_since.is_some_and(|started| started.elapsed() >= Duration::from_secs(60)) {
                restart_count = 0;
            }
            restart_count += 1;
            if let Ok(mut snapshot) = status.lock() {
                snapshot.state = "restarting".into();
                snapshot.phase = "spawn".into();
                snapshot.restart_count = restart_count;
                snapshot.last_error = Some(format!(
                    "Harness generation {generation} exited unexpectedly"
                ));
                snapshot.url = None;
                snapshot.pid = None;
            }
            loop {
                if restart_count > 5 || stopping.load(Ordering::SeqCst) {
                    if !stopping.load(Ordering::SeqCst) {
                        if let Ok(mut snapshot) = status.lock() {
                            snapshot.state = "failed".into();
                            snapshot.phase = "spawn".into();
                            snapshot.last_error =
                                Some("Harness exceeded the automatic restart limit".into());
                        }
                    }
                    return;
                }
                let delay_seconds = 2u64.pow((restart_count - 1).min(4));
                thread::sleep(Duration::from_secs(delay_seconds.min(30)));
                if stopping.load(Ordering::SeqCst) {
                    return;
                }
                let generation = NEXT_GENERATION.fetch_add(1, Ordering::SeqCst);
                match spawn_harness(&program, &args, &dsh_home, &log_path) {
                    Ok((child, url)) => {
                        let pid = child.id();
                        if let Ok(mut guard) = state.lock() {
                            *guard = Some(RunningHarness {
                                child,
                                url: url.clone(),
                                stopping: stopping.clone(),
                                generation,
                            });
                        }
                        stable_since = Some(std::time::Instant::now());
                        if let Ok(mut snapshot) = status.lock() {
                            snapshot.state = "ready".into();
                            snapshot.phase = "stable".into();
                            snapshot.generation = generation;
                            snapshot.url = Some(url);
                            snapshot.pid = Some(pid);
                            snapshot.restart_count = 0;
                            snapshot.last_error = None;
                        }
                        break;
                    }
                    Err(error) => {
                        log_line(
                            &log_path,
                            &format!("supervisor restart {restart_count} failed: {error}"),
                        );
                        if restart_count >= 5 {
                            if let Ok(mut snapshot) = status.lock() {
                                snapshot.state = "failed".into();
                                snapshot.phase = "spawn".into();
                                snapshot.last_error = Some(error);
                            }
                            return;
                        }
                        restart_count += 1;
                    }
                }
            }
        }
    });
}

fn start_harness(
    app: &AppHandle,
    state: &HarnessState,
    status: &SupervisorStatusState,
) -> Result<String, String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "supervisor lock poisoned".to_string())?;
    if let Some(running) = guard.as_ref() {
        return Ok(running.url.clone());
    }

    if let Ok(mut snapshot) = status.0.lock() {
        snapshot.state = "starting".into();
        snapshot.phase = "spawn".into();
        snapshot.restart_count = 0;
        snapshot.last_error = None;
    }
    let paths = app_paths(app)?;
    let log_path = PathBuf::from(&paths.logs).join("harness.log");
    let mut recovered = false;
    let (program, args, child, url) = loop {
        let (program, args) = match dsh_command(app, &paths) {
            Ok(value) => value,
            Err(error) => {
                if !recovered && recover_previous_runtime(&paths)? {
                    recovered = true;
                    continue;
                }
                return Err(error);
            }
        };
        match spawn_harness(&program, &args, &paths.dsh_home, &log_path) {
            Ok((child, url)) => break (program, args, child, url),
            Err(error) => {
                if !recovered && recover_previous_runtime(&paths)? {
                    recovered = true;
                    log_line(
                        &log_path,
                        &format!("current Runtime failed; recovered previous Runtime: {error}"),
                    );
                    continue;
                }
                return Err(error);
            }
        }
    };
    let pid = child.id();
    let generation = NEXT_GENERATION.fetch_add(1, Ordering::SeqCst);
    let stopping = Arc::new(AtomicBool::new(false));
    *guard = Some(RunningHarness {
        child,
        url: url.clone(),
        stopping,
        generation,
    });
    if let Ok(mut snapshot) = status.0.lock() {
        snapshot.state = "ready".into();
        snapshot.phase = "stable".into();
        snapshot.generation = generation;
        snapshot.url = Some(url.clone());
        snapshot.pid = Some(pid);
    }
    monitor_harness(
        state.0.clone(),
        status.0.clone(),
        program,
        args,
        paths.dsh_home.clone(),
        log_path,
    );
    Ok(url)
}

#[tauri::command]
fn harness_url(
    app: AppHandle,
    state: State<'_, HarnessState>,
    status: State<'_, SupervisorStatusState>,
) -> Result<String, String> {
    start_harness(&app, &state, &status)
}

fn stop_harness_inner(state: &HarnessState, status: &SupervisorStatusState) -> Result<(), String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "supervisor lock poisoned".to_string())?;
    if let Ok(mut snapshot) = status.0.lock() {
        snapshot.state = "stopping".into();
        snapshot.phase = "graceful-stop".into();
    }
    if let Some(mut running) = guard.take() {
        stop_child(&mut running);
    }
    if let Ok(mut snapshot) = status.0.lock() {
        snapshot.state = "stopped".into();
        snapshot.phase = "spawn".into();
        snapshot.url = None;
        snapshot.pid = None;
    }
    Ok(())
}

#[tauri::command]
fn stop_harness(
    state: State<'_, HarnessState>,
    status: State<'_, SupervisorStatusState>,
) -> Result<(), String> {
    stop_harness_inner(&state, &status)
}

#[tauri::command]
fn supervisor_status(status: State<'_, SupervisorStatusState>) -> Result<SupervisorStatus, String> {
    status
        .0
        .lock()
        .map(|snapshot| snapshot.clone())
        .map_err(|_| "supervisor lock poisoned".into())
}

#[tauri::command]
fn supervisor_restart(
    app: AppHandle,
    state: State<'_, HarnessState>,
    status: State<'_, SupervisorStatusState>,
) -> Result<SupervisorStatus, String> {
    stop_harness_inner(&state, &status)?;
    start_harness(&app, &state, &status)?;
    supervisor_status(status)
}

#[tauri::command]
fn supervisor_retry(
    app: AppHandle,
    state: State<'_, HarnessState>,
    status: State<'_, SupervisorStatusState>,
) -> Result<SupervisorStatus, String> {
    if status
        .0
        .lock()
        .map_err(|_| "supervisor lock poisoned".to_string())?
        .state
        != "failed"
    {
        return supervisor_status(status);
    }
    start_harness(&app, &state, &status)?;
    supervisor_status(status)
}

#[tauri::command]
fn runtime_paths(app: AppHandle) -> Result<RuntimePaths, String> {
    app_paths(&app)
}

fn runtime_tool(
    paths: &RuntimePaths,
    pointer: &str,
) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let manifest_path = PathBuf::from(&paths.runtime).join(pointer);
    let value: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(&manifest_path)
            .map_err(|error| format!("unable to read {pointer}: {error}"))?,
    )
    .map_err(|error| format!("invalid {pointer}: {error}"))?;
    let runtime_id = value
        .get("runtimeVersion")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| format!("{pointer} is missing runtimeVersion"))?;
    if runtime_id.is_empty()
        || runtime_id.len() > 160
        || !runtime_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        return Err("runtimeVersion contains unsafe path characters".into());
    }
    let root = PathBuf::from(&paths.runtime)
        .join("versions")
        .join(runtime_id);
    let node = root.join(if cfg!(windows) { "node.exe" } else { "node" });
    let cli = root
        .join("dsh")
        .join("node_modules")
        .join("@dshpilot")
        .join("desktop-host")
        .join("lib")
        .join("runtime-cli.js");
    if !node.exists() || !cli.exists() {
        return Err(format!(
            "runtime {runtime_id} does not contain the DSHPilot runtime manager"
        ));
    }
    Ok((node, cli, root))
}

fn run_runtime_tool(
    paths: &RuntimePaths,
    args: &[String],
    pointer: &str,
) -> Result<String, String> {
    let (node, cli, runtime_root) = runtime_tool(paths, pointer)?;
    let mut command = Command::new(node);
    command
        .arg(cli)
        .args(args)
        .env("DSHPILOT_APP_DATA", &paths.app_data)
        .current_dir(runtime_root);
    let output = command
        .output()
        .map_err(|error| format!("unable to start runtime manager: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "runtime manager failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn runtime_update_inner(
    app: &AppHandle,
    state: &HarnessState,
    status: &SupervisorStatusState,
    manifest_path: String,
    base_url: Option<String>,
    allow_unsigned_local: Option<bool>,
) -> Result<String, String> {
    let _update_guard = RuntimeUpdateGuard::acquire()?;
    if allow_unsigned_local.unwrap_or(false)
        && !cfg!(debug_assertions)
        && env::var("DSHPILOT_ALLOW_UNSIGNED_RUNTIME").as_deref() != Ok("1")
    {
        return Err("unsigned runtime updates are only allowed in development".into());
    }
    stop_harness_inner(state, status)?;
    let paths = app_paths(app)?;
    let mut args = vec!["--manifest".into(), manifest_path];
    if let Some(url) = base_url {
        args.extend(["--base-url".into(), url]);
    }
    if allow_unsigned_local.unwrap_or(false) {
        args.push("--allow-unsigned".into());
    }
    if let Ok((_, _, current_root)) = runtime_tool(&paths, "current.json") {
        if let Some(key) = [
            PathBuf::from(&paths.runtime).join("public.key"),
            current_root.join("public.key"),
        ]
        .into_iter()
        .find(|path| path.exists())
        {
            args.extend(["--public-key".into(), key.display().to_string()]);
        } else if let Some(key) = EMBEDDED_RUNTIME_PUBLIC_KEY {
            let embedded = PathBuf::from(&paths.app_data)
                .join("update")
                .join("embedded-runtime-public.key");
            fs::create_dir_all(embedded.parent().unwrap_or_else(|| Path::new(".")))
                .map_err(|error| format!("unable to prepare runtime verification key: {error}"))?;
            fs::write(&embedded, key.as_bytes())
                .map_err(|error| format!("unable to persist runtime verification key: {error}"))?;
            args.extend(["--public-key".into(), embedded.display().to_string()]);
        }
    }
    let result = run_runtime_tool(&paths, &args, "current.json");
    match result {
        Ok(output) => {
            if let Err(error) = start_harness(app, state, status) {
                let rollback = run_runtime_tool(&paths, &["--rollback".into()], "current.json")
                    .or_else(|_| run_runtime_tool(&paths, &["--rollback".into()], "previous.json"));
                return match rollback {
                    Ok(rollback_output) => match start_harness(app, state, status) {
                        Ok(_) => Err(format!("new runtime failed health check: {error}; restored previous Runtime: {rollback_output}")),
                        Err(restart_error) => Err(format!("new runtime failed health check: {error}; rollback succeeded but previous Runtime failed to start: {restart_error}")),
                    },
                    Err(rollback_error) => Err(format!("new runtime failed health check: {error}; Runtime rollback failed: {rollback_error}")),
                };
            }
            Ok(output)
        }
        Err(error) => {
            if let Err(restart_error) = start_harness(app, state, status) {
                return Err(format!(
                    "Runtime update failed: {error}; Harness restart failed: {restart_error}"
                ));
            }
            Err(error)
        }
    }
}

#[tauri::command]
fn runtime_update(
    app: AppHandle,
    state: State<'_, HarnessState>,
    status: State<'_, SupervisorStatusState>,
    manifest_path: String,
    base_url: Option<String>,
    allow_unsigned_local: Option<bool>,
) -> Result<String, String> {
    runtime_update_inner(
        &app,
        &state,
        &status,
        manifest_path,
        base_url,
        allow_unsigned_local,
    )
}

#[tauri::command]
fn runtime_update_from_url(
    app: AppHandle,
    state: State<'_, HarnessState>,
    status: State<'_, SupervisorStatusState>,
    manifest_url: String,
    allow_unsigned_local: Option<bool>,
) -> Result<String, String> {
    let parsed = url::Url::parse(&manifest_url)
        .map_err(|error| format!("invalid runtime manifest URL: {error}"))?;
    let loopback_http =
        parsed.scheme() == "http" && matches!(parsed.host_str(), Some("127.0.0.1" | "localhost"));
    if parsed.scheme() != "https" && !(cfg!(debug_assertions) && loopback_http) {
        return Err("runtime manifest URL must use HTTPS (loopback HTTP is debug-only)".into());
    }
    let response = reqwest::blocking::get(parsed.clone())
        .map_err(|error| format!("runtime manifest download failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "runtime manifest download failed: HTTP {}",
            response.status()
        ));
    }
    if response.content_length().unwrap_or(0) > 1_048_576 {
        return Err("runtime manifest is too large".into());
    }
    let bytes = response
        .bytes()
        .map_err(|error| format!("runtime manifest read failed: {error}"))?;
    if bytes.len() > 1_048_576 {
        return Err("runtime manifest is too large".into());
    }
    let paths = app_paths(&app)?;
    let manifest_path = PathBuf::from(&paths.app_data)
        .join("update")
        .join("runtime-manifest.json");
    fs::write(&manifest_path, &bytes)
        .map_err(|error| format!("unable to stage runtime manifest: {error}"))?;
    let mut base = parsed;
    let original_path = base.path().to_string();
    let directory = original_path
        .rsplit_once('/')
        .map_or(
            "/",
            |(directory, _)| if directory.is_empty() { "" } else { directory },
        );
    let base_path = if directory.is_empty() {
        "/".to_string()
    } else {
        format!("{directory}/")
    };
    base.set_path(&base_path);
    base.set_query(None);
    base.set_fragment(None);
    runtime_update_inner(
        &app,
        &state,
        &status,
        manifest_path.display().to_string(),
        Some(base.to_string()),
        allow_unsigned_local,
    )
}

#[tauri::command]
fn runtime_rollback(
    app: AppHandle,
    state: State<'_, HarnessState>,
    status: State<'_, SupervisorStatusState>,
) -> Result<String, String> {
    let _update_guard = RuntimeUpdateGuard::acquire()?;
    stop_harness_inner(&state, &status)?;
    let paths = app_paths(&app)?;
    let result = run_runtime_tool(&paths, &["--rollback".into()], "current.json");
    match result {
        Ok(output) => {
            match start_harness(&app, &state, &status) {
                Ok(_) => Ok(output),
                Err(start_error) => {
                    // The runtime CLI has already smoke-tested the target, but
                    // the real desktop launch can still fail (WebView, profile
                    // patch, or OS process policy). Restore the prior pointer
                    // and give the desktop one last known-good start attempt.
                    match run_runtime_tool(&paths, &["--rollback".into()], "current.json") {
                        Ok(restored) => match start_harness(&app, &state, &status) {
                            Ok(_) => Err(format!("Runtime rollback launched unsuccessfully: {start_error}; restored prior Runtime: {restored}")),
                            Err(recovery_error) => Err(format!("Runtime rollback failed to launch: {start_error}; prior Runtime recovery also failed: {recovery_error}")),
                        },
                        Err(recovery_error) => Err(format!("Runtime rollback failed to launch: {start_error}; restoring prior Runtime failed: {recovery_error}")),
                    }
                }
            }
        }
        Err(error) => {
            let _ = start_harness(&app, &state, &status);
            Err(error)
        }
    }
}

#[tauri::command]
fn native_notification(
    app: AppHandle,
    kind: String,
    title: String,
    body: String,
) -> Result<(), String> {
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

fn validate_secret_key(key: &str) -> Result<(), String> {
    if key.is_empty()
        || key.len() > 128
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'/'))
    {
        return Err("credential key is invalid".into());
    }
    Ok(())
}

fn keychain_entry(key: &str) -> Result<Entry, String> {
    validate_secret_key(key)?;
    Entry::new("ai.dshpilot.desktop", key)
        .map_err(|error| format!("unable to open OS credential store: {error}"))
}

#[tauri::command]
fn keychain_get(key: String) -> Result<Option<String>, String> {
    match keychain_entry(&key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("unable to read OS credential: {error}")),
    }
}

#[tauri::command]
fn keychain_set(key: String, value: String) -> Result<(), String> {
    if value.len() > 64 * 1024 {
        return Err("credential value is too large".into());
    }
    keychain_entry(&key)?
        .set_password(&value)
        .map_err(|error| format!("unable to save OS credential: {error}"))
}

#[tauri::command]
fn keychain_delete(key: String) -> Result<(), String> {
    match keychain_entry(&key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("unable to delete OS credential: {error}")),
    }
}

fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show DSHPilot", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    TrayIconBuilder::with_id("dshpilot-tray")
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

fn emit_deep_links(app: &tauri::AppHandle, urls: Vec<url::Url>) {
    let _ = app.emit("dshpilot://open", serde_json::json!({ "urls": urls.into_iter().map(|value| value.to_string()).collect::<Vec<_>>() }));
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn monitor_notifications(app: AppHandle, path: PathBuf) {
    thread::spawn(move || {
        let mut seen = 0usize;
        let mut seen_ids = HashSet::<String>::new();
        let mut initialized = false;
        loop {
            if let Ok(contents) = fs::read_to_string(&path) {
                let lines: Vec<&str> = contents.lines().collect();
                if !initialized {
                    seen = lines.len();
                    initialized = true;
                }
                if seen > lines.len() {
                    seen = 0;
                    seen_ids.clear();
                }
                for line in lines.iter().skip(seen) {
                    let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
                        continue;
                    };
                    let kind = value.get("kind").and_then(serde_json::Value::as_str);
                    if !matches!(
                        kind,
                        Some("task-completed")
                            | Some("task-failed")
                            | Some("approval-needed")
                            | Some("question-needed")
                    ) {
                        continue;
                    }
                    let Some(title) = value.get("title").and_then(serde_json::Value::as_str) else {
                        continue;
                    };
                    let Some(body) = value.get("body").and_then(serde_json::Value::as_str) else {
                        continue;
                    };
                    let notification_id = value
                        .get("notificationId")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_owned)
                        .unwrap_or_else(|| (*line).to_owned());
                    if !seen_ids.insert(notification_id) {
                        continue;
                    }
                    let _ = app.notification().builder().title(title).body(body).show();
                }
                seen = lines.len();
            } else if !initialized {
                initialized = true;
                seen = 0;
            }
            thread::sleep(Duration::from_millis(500));
        }
    });
}

fn monitor_tray_status(app: AppHandle, status: Arc<Mutex<SupervisorStatus>>) {
    let status_path = env::var_os("DSHPILOT_CI_STATUS_PATH").map(PathBuf::from);
    thread::spawn(move || loop {
        if let Ok(snapshot) = status.lock() {
            if let Some(tray) = app.tray_by_id("dshpilot-tray") {
                let _ = tray.set_tooltip(Some(format!("DSHPilot — {}", snapshot.state)));
            }
            if let Some(path) = status_path.as_ref() {
                if let Ok(value) = serde_json::to_vec(&*snapshot) {
                    if let Some(parent) = path.parent() {
                        let _ = fs::create_dir_all(parent);
                    }
                    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
                    if fs::write(&temporary, value).is_ok() {
                        if fs::rename(&temporary, path).is_err() {
                            let _ = fs::remove_file(path);
                            let _ = fs::rename(&temporary, path);
                        }
                    }
                }
            }
        }
        thread::sleep(Duration::from_millis(500));
    });
}

fn record_single_instance_handoff(argv: &[String], cwd: &str) {
    let Some(status_path) = env::var_os("DSHPILOT_CI_STATUS_PATH").map(PathBuf::from) else {
        return;
    };
    let marker = status_path.with_extension("single-instance.json");
    let value = serde_json::json!({ "argv": argv, "cwd": cwd });
    let _ = fs::write(marker, value.to_string());
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            record_single_instance_handoff(&argv, &cwd);
            let _ = app.emit(
                "dshpilot://open",
                serde_json::json!({ "argv": argv, "cwd": cwd }),
            );
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(HarnessState::default())
        .manage(SupervisorStatusState::default())
        .invoke_handler(tauri::generate_handler![
            harness_url,
            stop_harness,
            supervisor_status,
            supervisor_restart,
            supervisor_retry,
            runtime_paths,
            runtime_update,
            runtime_update_from_url,
            runtime_rollback,
            native_notification,
            keychain_get,
            keychain_set,
            keychain_delete
        ])
        .setup(|app| {
            setup_tray(app)?;
            let handle = app.handle().clone();
            let deep_link_handle = handle.clone();
            app.deep_link()
                .on_open_url(move |event| emit_deep_links(&deep_link_handle, event.urls()));
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                emit_deep_links(&handle, urls);
            }
            let running = app.state::<HarnessState>().0.clone();
            let status = app.state::<SupervisorStatusState>().0.clone();
            monitor_tray_status(handle.clone(), status.clone());
            let notification_path = app
                .path()
                .app_data_dir()
                .map_err(|error| format!("unable to resolve notification path: {error}"))?
                .join("dsh-home")
                .join("dshpilot")
                .join("notifications.jsonl");
            monitor_notifications(handle.clone(), notification_path);
            thread::spawn(move || {
                let status_state = SupervisorStatusState(status);
                if let Err(error) = start_harness(&handle, &HarnessState(running), &status_state) {
                    if let Ok(mut snapshot) = status_state.0.lock() {
                        snapshot.state = "failed".into();
                        snapshot.phase = "spawn".into();
                        snapshot.last_error = Some(error);
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building DSHPilot")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                api.prevent_exit();
                let state = app.state::<HarnessState>();
                let status = app.state::<SupervisorStatusState>();
                let _ = stop_harness_inner(&state, &status);
                app.exit(0);
            }
        });
}
