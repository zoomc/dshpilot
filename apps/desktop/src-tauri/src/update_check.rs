//! In-app update engine for DSHPilot.
//!
//! Two independent update channels, both driven by plain GitHub API calls so
//! they work without the (currently unprovisioned) Tauri signing secrets:
//!
//! 1. **App channel** — checks `zoomc/dshpilot` releases for a newer tag than
//!    the running Cargo version, then downloads the platform asset and swaps
//!    the running `.app` after the process exits (replace-on-quit).
//! 2. **dsh core channel** — tracks the upstream `deepseek-ai/deepseek-harness`
//!    repository. The in-app check compares the locally bundled harness commit
//!    against the upstream latest commit; the actual snapshot is published to
//!    our own releases by the `sync-runtime` workflow, so install reuses the
//!    existing `runtime_update_from_url` path.

use std::fs;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager};

const USER_AGENT: &str = "dshpilot-updater";

#[derive(Serialize, Clone, Default)]
pub struct AppUpdateCheck {
    pub available: bool,
    pub current_version: String,
    pub latest_version: String,
    pub notes: String,
    pub asset_url: Option<String>,
    pub asset_name: Option<String>,
    pub error: Option<String>,
}

#[derive(Serialize, Clone, Default)]
pub struct DshCoreUpdateCheck {
    pub available: bool,
    pub ready: bool,
    pub local_sha: String,
    pub upstream_sha: String,
    pub published_sha: Option<String>,
    pub upstream_version: Option<String>,
    pub notes: String,
    pub error: Option<String>,
}

/// Shared state so the tray menu can trigger installs directly.
pub struct UpdateState {
    pub app: std::sync::Mutex<Option<AppUpdateCheck>>,
    pub core: std::sync::Mutex<Option<DshCoreUpdateCheck>>,
}

impl Default for UpdateState {
    fn default() -> Self {
        Self {
            app: std::sync::Mutex::new(None),
            core: std::sync::Mutex::new(None),
        }
    }
}

fn github_json(url: &str) -> Result<serde_json::Value, String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    resp.json().map_err(|e| e.to_string())
}

fn parse_version(value: &str) -> Vec<u32> {
    value
        .trim_start_matches('v')
        .trim_start_matches('V')
        .split(['.', '-', '+'])
        .filter_map(|part| part.parse::<u32>().ok())
        .collect()
}

fn version_gt(a: &str, b: &str) -> bool {
    let pa = parse_version(a);
    let pb = parse_version(b);
    let len = pa.len().max(pb.len());
    for i in 0..len {
        let xa = *pa.get(i).unwrap_or(&0);
        let xb = *pb.get(i).unwrap_or(&0);
        if xa != xb {
            return xa > xb;
        }
    }
    false
}

fn platform_suffix() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin-arm64"
    } else if cfg!(target_os = "windows") {
        "windows-x64"
    } else {
        "linux-x64"
    }
}

pub fn runtime_manifest_url() -> String {
    format!(
        "https://github.com/zoomc/dshpilot/releases/download/runtime/current-{}.json",
        platform_suffix()
    )
}

#[tauri::command]
pub fn check_app_update() -> AppUpdateCheck {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let url = "https://api.github.com/repos/zoomc/dshpilot/releases/latest";
    match github_json(url) {
        Ok(json) => {
            let latest = json
                .get("tag_name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let notes = json
                .get("body")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let chosen = json
                .get("assets")
                .and_then(|v| v.as_array())
                .and_then(|arr| {
                    arr.iter().find(|a| {
                        let name = a.get("name").and_then(|n| n.as_str()).unwrap_or("");
                        if cfg!(target_os = "macos") {
                            (name.contains("aarch64")
                                || name.contains("arm64")
                                || name.contains("darwin"))
                                && (name.ends_with(".dmg") || name.ends_with(".tar.gz"))
                        } else if cfg!(target_os = "windows") {
                            name.contains("x64")
                                && (name.ends_with(".msi") || name.ends_with(".exe"))
                        } else {
                            name.contains("x64") && name.ends_with(".tar.gz")
                        }
                    })
                });
            let (asset_url, asset_name) = match chosen {
                Some(a) => (
                    a.get("browser_download_url")
                        .and_then(|u| u.as_str())
                        .map(String::from),
                    a.get("name").and_then(|n| n.as_str()).map(String::from),
                ),
                None => (None, None),
            };
            let available = !latest.is_empty() && version_gt(&latest, &current);
            AppUpdateCheck {
                available,
                current_version: current,
                latest_version: latest,
                notes,
                asset_url,
                asset_name,
                error: None,
            }
        }
        Err(e) => AppUpdateCheck {
            available: false,
            current_version: current,
            latest_version: String::new(),
            notes: String::new(),
            asset_url: None,
            asset_name: None,
            error: Some(e),
        },
    }
}

#[tauri::command]
pub fn check_dsh_core_update(app: AppHandle) -> DshCoreUpdateCheck {
    let local_sha = read_local_upstream_sha(&app).unwrap_or_default();
    let upstream = github_json(
        "https://api.github.com/repos/deepseek-ai/deepseek-harness/commits?per_page=1",
    )
    .and_then(|v| {
        v.as_array()
            .and_then(|arr| arr.first())
            .and_then(|c| c.get("sha"))
            .and_then(|s| s.as_str())
            .map(str::to_owned)
            .ok_or_else(|| "no upstream commit".to_string())
    });
    let upstream_version = github_json(
        "https://api.github.com/repos/deepseek-ai/deepseek-harness/releases/latest",
    )
    .ok()
    .and_then(|v| v.get("tag_name").and_then(|t| t.as_str()).map(str::to_owned));
    let published = github_json(&runtime_manifest_url())
        .ok()
        .and_then(|v| {
            v.get("upstream")
                .and_then(|u| u.get("sha"))
                .and_then(|s| s.as_str())
                .map(str::to_owned)
        });

    match upstream {
        Ok(upstream_sha) => {
            let available = !local_sha.is_empty() && local_sha != upstream_sha;
            let ready = published.as_deref() == Some(upstream_sha.as_str());
            DshCoreUpdateCheck {
                available,
                ready,
                local_sha,
                upstream_sha,
                published_sha: published,
                upstream_version,
                notes: if available {
                    if ready {
                        "上游 dsh 核心已有新版本，可立即更新".into()
                    } else {
                        "上游 dsh 核心已有新版本，正在等待 DSHPilot 构建并发布运行时快照…".into()
                    }
                } else {
                    "dsh 核心已是最新".into()
                },
                error: None,
            }
        }
        Err(e) => DshCoreUpdateCheck {
            available: false,
            ready: false,
            local_sha,
            upstream_sha: String::new(),
            published_sha: published,
            upstream_version,
            notes: String::new(),
            error: Some(e),
        },
    }
}

#[tauri::command]
pub fn install_app_update(app: AppHandle, asset_url: String) -> Result<(), String> {
    // The in-app swap uses a detached Unix shell script (setsid + ditto/open);
    // on Windows the installer is distributed via the nsis package on the
    // release page, so we degrade gracefully instead of failing mid-flight.
    if cfg!(target_os = "windows") {
        return Err(
            "应用内自动更新暂不支持 Windows，请前往 GitHub Releases 手动下载安装包".into(),
        );
    }
    let client = reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("update");
    fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    let extract_dir = cache.join("extract");
    let _ = fs::remove_dir_all(&extract_dir);
    fs::create_dir_all(&extract_dir).map_err(|e| e.to_string())?;

    let resp = client.get(&asset_url).send().map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("download failed: HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().map_err(|e| e.to_string())?;
    let is_tar = asset_url.ends_with(".tar.gz") || asset_url.ends_with(".tgz");
    let ext = if is_tar { "tar.gz" } else { "dmg" };
    let archive = cache.join(format!("asset.{ext}"));
    fs::write(&archive, &bytes).map_err(|e| e.to_string())?;

    let new_app = extract_app(&archive, &extract_dir, is_tar)?;

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let bundle = exe
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .ok_or_else(|| "cannot resolve current .app bundle".to_string())?;

    let script = cache.join("apply_update.sh");
    let script_body = format!(
        "#!/bin/bash\nAPP='{}'\nNEW='{}'\nEXE='{}'\nfor i in $(seq 1 120); do pgrep -f \"$EXE\" >/dev/null || break; sleep 1; done\nrm -rf \"$APP\"\nditto \"$NEW\" \"$APP\"\nopen \"$APP\"\nrm -f \"$0\"\n",
        bundle.display(),
        new_app.display(),
        exe.file_name().unwrap().to_string_lossy()
    );
    fs::write(&script, script_body).map_err(|e| e.to_string())?;
    let _ = Command::new("chmod").arg("+x").arg(&script).status();

    // Detach so the swap continues after this process exits.
    let mut cmd = Command::new("/bin/bash");
    cmd.arg(&script);
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(unix)]
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    cmd.spawn().map_err(|e| e.to_string())?;

    // Quit so the detached script can replace the running bundle.
    app.exit(0);
    Ok(())
}

fn extract_app(archive: &Path, dest: &Path, is_tar: bool) -> Result<PathBuf, String> {
    if is_tar {
        let status = Command::new("tar")
            .arg("-xzf")
            .arg(archive)
            .arg("-C")
            .arg(dest)
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("failed to extract .tar.gz".into());
        }
    } else {
        let mount = dest.join("mnt");
        let _ = fs::remove_dir_all(&mount);
        fs::create_dir_all(&mount).ok();
        let out = Command::new("hdiutil")
            .args([
                "attach",
                &archive.display().to_string(),
                "-mountpoint",
                &mount.display().to_string(),
                "-nobrowse",
                "-quiet",
            ])
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err("failed to mount .dmg".into());
        }
        for entry in fs::read_dir(&mount).map_err(|e| e.to_string())?.flatten() {
            let path = entry.path();
            if path.extension().map(|x| x == "app").unwrap_or(false) {
                let status = Command::new("cp")
                    .args([
                        "-R",
                        &path.display().to_string(),
                        &dest.join(entry.file_name()).display().to_string(),
                    ])
                    .status()
                    .map_err(|e| e.to_string())?;
                if !status.success() {
                    let _ = Command::new("hdiutil")
                        .args(["detach", &mount.display().to_string(), "-quiet"])
                        .status();
                    return Err("failed to copy .app from dmg".into());
                }
            }
        }
        let _ = Command::new("hdiutil")
            .args(["detach", &mount.display().to_string(), "-quiet"])
            .status();
    }
    for entry in fs::read_dir(dest).map_err(|e| e.to_string())?.flatten() {
        let p = entry.path();
        if p.extension().map(|x| x == "app").unwrap_or(false) {
            return Ok(p);
        }
    }
    Err("extracted .app not found".into())
}

fn read_local_upstream_sha(app: &AppHandle) -> Option<String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(base) = app.path().app_data_dir() {
        candidates.push(base.join("runtime").join("current.json"));
    }
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join("runtime").join("current.json"));
    }
    for path in candidates {
        if let Ok(text) = fs::read_to_string(&path) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(sha) = value
                    .get("upstream")
                    .and_then(|u| u.get("sha"))
                    .and_then(|s| s.as_str())
                {
                    return Some(sha.to_string());
                }
            }
        }
    }
    None
}
