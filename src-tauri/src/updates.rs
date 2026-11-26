//! Updates of Katraineo itself (tauri-plugin-updater). The release workflow publishes `latest.json` with the
//! signed installers; `KATRAINEO_UPDATE_ENDPOINT` points the check at another manifest, for tests.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, Updater, UpdaterExt};

/// The update found by the last check, which `update_install` installs.
#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<Update>>);

#[derive(Serialize)]
pub struct UpdateInfo {
    version: String,
    current_version: String,
    notes: Option<String>,
}

#[derive(Clone, Serialize)]
struct Progress {
    received: u64,
    total: Option<u64>,
}

fn updater(app: &AppHandle) -> Result<Updater, String> {
    let mut builder = app.updater_builder();
    if let Some(url) = std::env::var("KATRAINEO_UPDATE_ENDPOINT").ok().filter(|u| !u.trim().is_empty()) {
        let url = url.trim().parse().map_err(|e| format!("KATRAINEO_UPDATE_ENDPOINT: {e}"))?;
        builder = builder.endpoints(vec![url]).map_err(|e| e.to_string())?;
    }
    // On Windows the installer replaces the files in place once the app has exited, so KataGo must not keep
    // katago.exe open (download_and_install exits the app there without the usual exit events).
    let handle = app.clone();
    builder = builder.on_before_exit(move || crate::engine::shutdown(&handle));
    builder.build().map_err(|e| e.to_string())
}

/// Ask the update endpoint for a newer version. None when this is the newest.
#[tauri::command]
pub async fn update_check(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<Option<UpdateInfo>, String> {
    let update = updater(&app)?.check().await.map_err(|e| e.to_string())?;
    let info = update.as_ref().map(|u| UpdateInfo {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        notes: u.body.clone(),
    });
    *pending.0.lock().map_err(|e| e.to_string())? = update;
    Ok(info)
}

/// Download the update found by `update_check`, verify its signature, install it and restart. Reports the
/// download as `update-progress` events. Only returns on failure.
#[tauri::command]
pub async fn update_install(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<(), String> {
    let update = pending.0.lock().map_err(|e| e.to_string())?.clone().ok_or("No update to install")?;
    let progress = app.clone();
    let mut received = 0u64;
    update
        .download_and_install(
            |chunk, total| {
                received += chunk as u64;
                let _ = progress.emit("update-progress", Progress { received, total });
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    // macOS and Linux: the new version is in place. (On Windows the installer has taken over and restarts the app.)
    crate::engine::shutdown(&app);
    app.restart()
}
