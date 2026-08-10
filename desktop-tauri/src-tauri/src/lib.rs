mod commands;
mod fonts;
mod xlsx_rpc;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(xlsx_rpc::XlsxRpcState::default())
        .invoke_handler(tauri::generate_handler![
            commands::read_file,
            commands::write_file,
            fonts::list_fonts,
            xlsx_rpc::xlsx_rpc,
        ])
        .run(tauri::generate_context!())
        .expect("error while running PanOffice");
}
