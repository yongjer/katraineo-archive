mod appimage;
mod engine;
mod files;
mod models;
mod paths;
mod updates;

use tauri::RunEvent;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(engine::EngineState::default())
        .manage(models::Downloads::default())
        .manage(updates::PendingUpdate::default())
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
            models::list_models,
            models::resolve_model_endpoint,
            models::download_model,
            updates::update_check,
            updates::update_install,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Katraineo");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            engine::shutdown(handle);
        }
    });
}
