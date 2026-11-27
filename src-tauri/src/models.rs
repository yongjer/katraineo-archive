//! KataGo model files and CPU (Eigen) engine fallback downloads.

use std::collections::{BTreeSet, HashMap};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::AsyncWriteExt;

use crate::paths;

/// Downloads in flight, keyed by file name -> cancellation flag, so a second click does not start
/// the same download twice and the UI can cancel an active transfer cleanly.
#[derive(Default)]
pub struct Downloads(Mutex<HashMap<String, Arc<AtomicBool>>>);

#[derive(Serialize)]
pub struct ModelFile {
    /// Absolute path (or a "katrain/..." path for the bundled model).
    path: String,
    name: String,
    size: u64,
}

#[derive(Clone, Serialize)]
struct Progress {
    name: String,
    received: u64,
    total: Option<u64>,
    done: bool,
    cancelled: bool,
    error: Option<String>,
    path: Option<String>,
}

const KATAGO_EIGEN_VERSION: &str = "v1.18.1";

/// Download URL and executable file name for KataGo's CPU (Eigen) fallback build on `os`.
pub fn eigen_download_spec(os: &str) -> Option<(&'static str, &'static str)> {
    match os {
        "windows" => Some((
            "https://github.com/lightvector/KataGo/releases/download/v1.18.1/katago-v1.18.1-eigen-windows-x64.zip",
            "katago.exe",
        )),
        "linux" => Some((
            "https://github.com/lightvector/KataGo/releases/download/v1.18.1/katago-v1.18.1-eigen-linux-x64.zip",
            "katago",
        )),
        _ => None,
    }
}

/// Where downloaded models go: <app data>/models.
fn download_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("models");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

fn is_model(p: &Path) -> bool {
    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
    (name.ends_with(".bin.gz") || name.ends_with(".txt.gz")) && !name.contains(".part")
}

/// Models in the bundled models folder, the download folder, the Python KaTrain data folder (~/.katrain),
/// and next to any model paths currently configured.
#[tauri::command]
pub fn list_models(app: AppHandle, extra_paths: Vec<String>) -> Result<Vec<ModelFile>, String> {
    let mut dirs: Vec<(PathBuf, bool)> = vec![(paths::resolve_resource(&app, "katrain/models"), true)];
    dirs.push((download_dir(&app)?, false));
    if let Ok(home) = app.path().home_dir() {
        dirs.push((home.join(".katrain"), false));
    }
    for p in extra_paths.iter().filter(|p| !p.trim().is_empty()) {
        let resolved = paths::resolve_resource(&app, p.trim());
        let dir =
            if resolved.is_dir() { resolved } else { resolved.parent().map(Path::to_path_buf).unwrap_or(resolved) };
        dirs.push((dir, p.trim().starts_with("katrain")));
    }
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for (dir, bundled) in dirs {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() || !is_model(&path) {
                continue;
            }
            let canonical = path.canonicalize().unwrap_or(path.clone());
            if !seen.insert(canonical) {
                continue;
            }
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
            let shown = if bundled && dir == paths::resolve_resource(&app, "katrain/models") {
                format!("katrain/models/{name}")
            } else {
                path.to_string_lossy().into_owned()
            };
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            out.push(ModelFile { path: shown, name, size });
        }
    }
    Ok(out)
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(concat!("Katraineo/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())
}

/// Resolve katagotraining.org's "latest"/"strongest" endpoints to a model URL.
#[tauri::command]
pub async fn resolve_model_endpoint(url: String) -> Result<String, String> {
    if !url.starts_with("https://katagotraining.org/") {
        return Err("only katagotraining.org endpoints are supported".into());
    }
    let res = client()?.get(&url).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("{url} returned {}", res.status()));
    }
    let json: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    json.get("model_file")
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| format!("{url} did not return a model_file"))
}

/// Allowed download hosts: the ones KaTrain's model list points at.
fn allowed(url: &str) -> bool {
    [
        "https://github.com/lightvector/KataGo/releases/download/",
        "https://media.katagotraining.org/",
        "https://d3dndmfyhecmj0.cloudfront.net/",
    ]
    .iter()
    .any(|prefix| url.starts_with(prefix))
}

fn model_file_name(url: &str) -> String {
    url.rsplit('/').next().unwrap_or_default().to_string()
}

/// Request cancellation of an in-flight model download.
#[tauri::command]
pub fn cancel_model_download(state: State<'_, Downloads>, url: String) -> Result<(), String> {
    let file_name = model_file_name(&url);
    let active = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(flag) = active.get(&file_name) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

/// Download a model into the download folder, reporting progress as "model-download" events.
/// Returns the saved path.
#[tauri::command]
pub async fn download_model(
    app: AppHandle,
    state: State<'_, Downloads>,
    name: String,
    url: String,
) -> Result<String, String> {
    if !allowed(&url) {
        return Err(format!("Refusing to download from {url}"));
    }
    let file_name = model_file_name(&url);
    if file_name.is_empty()
        || file_name.contains("..")
        || !(file_name.ends_with(".bin.gz") || file_name.ends_with(".txt.gz"))
    {
        return Err(format!("Unexpected model file name in {url}"));
    }
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut active = state.0.lock().map_err(|e| e.to_string())?;
        if active.contains_key(&file_name) {
            return Err(format!("{file_name} is already downloading"));
        }
        active.insert(file_name.clone(), cancel.clone());
    }
    let result = do_download(&app, "model-download", &name, &url, &download_dir(&app)?, &file_name, &cancel).await;
    if let Ok(mut active) = state.0.lock() {
        active.remove(&file_name);
    }
    let report = |done: bool, cancelled: bool, error: Option<String>, path: Option<String>| {
        let _ = app.emit(
            "model-download",
            Progress { name: name.clone(), received: 0, total: None, done, cancelled, error, path },
        );
    };
    match &result {
        Ok(path) => report(true, false, None, Some(path.clone())),
        Err(e) if e == "cancelled" => report(true, true, None, None),
        Err(e) => report(true, false, Some(e.clone()), None),
    }
    result
}

/// Download and unpack KataGo's CPU (Eigen) fallback binary for the current OS into `<app data>/katago-eigen`.
#[tauri::command]
pub async fn download_eigen_katago(app: AppHandle, state: State<'_, Downloads>) -> Result<String, String> {
    let Some((url, exe_name)) = eigen_download_spec(std::env::consts::OS) else {
        return Err("No prebuilt CPU (Eigen) KataGo release is available for macOS. Install via `brew install katago` and select `/opt/homebrew/bin/katago`.".into());
    };
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("katago-eigen");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let exe_path = dir.join(exe_name);
    let key = format!("katago-eigen-{KATAGO_EIGEN_VERSION}.zip");
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut active = state.0.lock().map_err(|e| e.to_string())?;
        if active.contains_key(&key) {
            return Err("KataGo CPU (Eigen) is already downloading".into());
        }
        active.insert(key.clone(), cancel.clone());
    }
    let name = format!("KataGo {KATAGO_EIGEN_VERSION} (CPU / Eigen)");
    let zip_result = do_download(&app, "katago-download", &name, url, &dir, &key, &cancel).await;
    let result = match zip_result {
        Ok(zip_path) => {
            let unpacked = extract_katago_zip(Path::new(&zip_path), &dir, exe_name);
            let _ = std::fs::remove_file(&zip_path);
            unpacked.map(|()| exe_path.to_string_lossy().into_owned())
        }
        Err(e) => Err(e),
    };
    if let Ok(mut active) = state.0.lock() {
        active.remove(&key);
    }
    let report = |done: bool, cancelled: bool, error: Option<String>, path: Option<String>| {
        let _ = app.emit(
            "katago-download",
            Progress { name: name.clone(), received: 0, total: None, done, cancelled, error, path },
        );
    };
    match &result {
        Ok(path) => report(true, false, None, Some(path.clone())),
        Err(e) if e == "cancelled" => report(true, true, None, None),
        Err(e) => report(true, false, Some(e.clone()), None),
    }
    result
}

/// Extract the KataGo binary and its companion DLLs/certs from a KataGo release zip archive.
fn extract_katago_zip(zip_path: &Path, dest_dir: &Path, exe_name: &str) -> Result<(), String> {
    let file = std::fs::File::open(zip_path).map_err(|e| format!("Could not open {}: {e}", zip_path.display()))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Invalid KataGo archive: {e}"))?;
    let mut found_exe = false;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let Some(name) = entry.enclosed_name().and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        else {
            continue;
        };
        let keep = name == exe_name || name.ends_with(".dll") || name == "cacert.pem";
        if !keep || entry.is_dir() {
            continue;
        }
        let target = dest_dir.join(&name);
        let mut out =
            std::fs::File::create(&target).map_err(|e| format!("Could not create {}: {e}", target.display()))?;
        io::copy(&mut entry, &mut out).map_err(|e| format!("Could not extract {name}: {e}"))?;
        #[cfg(unix)]
        if name == exe_name {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755));
        }
        if name == exe_name {
            found_exe = true;
        }
    }
    if !found_exe {
        return Err(format!("Archive did not contain {exe_name}"));
    }
    Ok(())
}

async fn do_download(
    app: &AppHandle,
    event: &str,
    name: &str,
    url: &str,
    dir: &Path,
    file_name: &str,
    cancel: &AtomicBool,
) -> Result<String, String> {
    let target = dir.join(file_name);
    let part = dir.join(format!("{file_name}.part"));
    let res = client()?.get(url).send().await.map_err(|e| format!("Download of {name} failed: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("Download of {name} failed: HTTP {}", res.status()));
    }
    let total = res.content_length();
    let mut file =
        tokio::fs::File::create(&part).await.map_err(|e| format!("Could not create {}: {e}", part.display()))?;
    let mut received: u64 = 0;
    let mut last_report: u64 = 0;
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::Relaxed) {
            drop(file);
            let _ = tokio::fs::remove_file(&part).await;
            return Err("cancelled".into());
        }
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                drop(file);
                let _ = tokio::fs::remove_file(&part).await;
                return Err(format!("Download of {name} failed: {e}"));
            }
        };
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        received += chunk.len() as u64;
        if received - last_report > 1 << 20 {
            last_report = received;
            let _ = app.emit(
                event,
                Progress { name: name.into(), received, total, done: false, cancelled: false, error: None, path: None },
            );
        }
    }
    if cancel.load(Ordering::Relaxed) {
        drop(file);
        let _ = tokio::fs::remove_file(&part).await;
        return Err("cancelled".into());
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);
    tokio::fs::rename(&part, &target).await.map_err(|e| format!("Could not move {}: {e}", part.display()))?;
    Ok(target.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_eigen_specs_per_os() {
        assert_eq!(eigen_download_spec("windows").map(|(_, exe)| exe), Some("katago.exe"));
        assert_eq!(eigen_download_spec("linux").map(|(_, exe)| exe), Some("katago"));
        assert_eq!(eigen_download_spec("macos"), None);
    }

    #[test]
    fn extracts_katago_binary_and_dlls_only() {
        let dir = std::env::temp_dir().join(format!("katraineo-zip-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let zip_path = dir.join("test.zip");
        {
            let f = std::fs::File::create(&zip_path).unwrap();
            let mut w = zip::ZipWriter::new(f);
            let opts = zip::write::SimpleFileOptions::default();
            w.start_file("katago.exe", opts).unwrap();
            io::Write::write_all(&mut w, b"exe").unwrap();
            w.start_file("z.dll", opts).unwrap();
            io::Write::write_all(&mut w, b"dll").unwrap();
            w.start_file("README.txt", opts).unwrap();
            io::Write::write_all(&mut w, b"ignore").unwrap();
            w.finish().unwrap();
        }
        extract_katago_zip(&zip_path, &dir, "katago.exe").unwrap();
        assert_eq!(std::fs::read(dir.join("katago.exe")).unwrap(), b"exe");
        assert_eq!(std::fs::read(dir.join("z.dll")).unwrap(), b"dll");
        assert!(!dir.join("README.txt").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
