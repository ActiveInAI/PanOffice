//! Rust commands exposed to the webview (the other half of src/bridge/).
//!
//! M1 scope: raw file IO. Everything the editors need beyond this (dialogs,
//! menus, sidecar spawn, fonts, presenter windows…) is added per app during
//! the M2–M4 ports — see ../../docs/TAURI-MIGRATION.md.
//!
//! NOTE: bytes cross the IPC boundary as JSON number arrays here. That is
//! fine for scaffold-scale files; before porting the xlsx/pptx editors,
//! switch reads to `tauri::ipc::Response` (raw bytes) and writes to
//! `tauri::ipc::Request` bodies.

#[tauri::command]
pub async fn read_file(path: String) -> Result<Vec<u8>, String> {
    tokio::fs::read(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn write_file(path: String, bytes: Vec<u8>) -> Result<(), String> {
    // write to a temp sibling then rename, mirroring the WOPI host's PutFile:
    // a failed save must never truncate the previous version.
    let tmp = format!("{path}.tmp-{}", std::process::id());
    tokio::fs::write(&tmp, &bytes)
        .await
        .map_err(|e| e.to_string())?;
    tokio::fs::rename(&tmp, &path)
        .await
        .map_err(|e| e.to_string())
}
