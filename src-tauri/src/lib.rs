mod appimage;
mod engine;
mod files;
mod models;
mod paths;
mod updates;

use tauri::{AppHandle, Emitter, Manager, RunEvent};

/// Store a game record path passed from the OS (double-click, CLI arg, or second instance) and notify the UI.
fn queue_open_file(app: &AppHandle, path: String) {
    app.state::<files::PendingOpenFile>().set(path.clone());
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    let _ = app.emit("open-game-file", path);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let initial_file = files::first_game_file_arg(std::env::args().skip(1));
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_window_state::Builder::default().build()).plugin(
            tauri_plugin_single_instance::init(|app, argv, _cwd| {
                if let Some(path) = files::first_game_file_arg(argv.into_iter().skip(1)) {
                    queue_open_file(app, path);
                } else if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }),
        );
    }

    let app = builder
        .manage(engine::EngineState::default())
        .manage(models::Downloads::default())
        .manage(updates::PendingUpdate::default())
        .manage(files::PendingOpenFile::new(initial_file))
        .invoke_handler(tauri::generate_handler![
            engine::engine_start,
            engine::engine_send,
            engine::engine_stop,
            files::read_game_file,
            files::write_text_file,
            files::load_config,
            files::save_config,
            files::keep_unreadable_config,
            files::fetch_text,
            files::take_pending_open_file,
            models::list_models,
            models::resolve_model_endpoint,
            models::download_model,
            updates::update_check,
            updates::update_install,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Katraineo");

    app.run(|handle, event| match event {
        RunEvent::Exit => engine::shutdown(handle),
        #[cfg(target_os = "macos")]
        RunEvent::Opened { urls } => {
            for url in urls {
                if let Ok(path) = url.to_file_path() {
                    let s = path.to_string_lossy().into_owned();
                    if files::is_game_record_path(&s) {
                        queue_open_file(handle, s);
                        break;
                    }
                }
            }
        }
        _ => {}
    });
}
