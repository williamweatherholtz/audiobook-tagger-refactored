mod scanner;
mod ollama;
mod claude_cli;

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![
            scanner::scan_library,
            ollama::ollama_get_status,
            ollama::ollama_get_model_presets,
            ollama::ollama_get_disk_usage,
            ollama::ollama_start,
            ollama::ollama_stop,
            ollama::ollama_install,
            ollama::ollama_uninstall,
            ollama::ollama_pull_model,
            ollama::ollama_delete_model,
            claude_cli::call_claude_cli,
        ])
        .on_window_event(|_window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Ok(rt) = tokio::runtime::Runtime::new() {
                    let _ = rt.block_on(ollama::ollama_stop());
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Audiobook Tagger");

    app.run(|_app_handle, event| {
        // Also stop Ollama on clean app exit (complements on_window_event::Destroyed
        // which handles window close but not app::exit() or process termination)
        if let tauri::RunEvent::Exit = event {
            if let Ok(rt) = tokio::runtime::Runtime::new() {
                let _ = rt.block_on(ollama::ollama_stop());
            }
        }
    });
}
