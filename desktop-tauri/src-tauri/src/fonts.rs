//! System font enumeration for the slides editor (M4 port of
//! desktop/apps/slides/src/main/fonts.ts's directory scan).
//!
//! The webview-side font registry (src/apps/slides/main/fonts.ts) builds its
//! "normalized filename -> path" index from this list and then reads/parses
//! individual files lazily through the regular `read_file` command (opentype.js
//! parsing and .ttc splitting stay JS-side). Keeping only the scan in Rust is
//! the settled split — see docs/TAURI-MIGRATION.md.
//!
//! Scanning is recursive with a depth cap: Linux keeps fonts in per-family
//! subdirectories (/usr/share/fonts/truetype/...), which the upstream flat
//! readdir never descended into.

use serde::Serialize;

#[derive(Serialize)]
pub struct FontFileEntry {
    pub path: String,
    /// File basename, e.g. "YuGothM.ttc" — the JS side normalizes it into its index key.
    pub name: String,
}

fn font_dirs() -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        let mut dirs = vec![
            "/System/Library/Fonts".to_string(),
            "/System/Library/Fonts/Supplemental".to_string(),
            "/Library/Fonts".to_string(),
        ];
        if let Some(home) = std::env::var_os("HOME") {
            dirs.push(format!("{}/Library/Fonts", home.to_string_lossy()));
        }
        dirs
    }
    #[cfg(target_os = "windows")]
    {
        let mut dirs = vec!["C:\\Windows\\Fonts".to_string()];
        if let Some(profile) = std::env::var_os("USERPROFILE") {
            dirs.push(format!(
                "{}\\AppData\\Local\\Microsoft\\Windows\\Fonts",
                profile.to_string_lossy()
            ));
        }
        dirs
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let mut dirs = vec![
            "/usr/share/fonts".to_string(),
            "/usr/local/share/fonts".to_string(),
        ];
        if let Some(home) = std::env::var_os("HOME") {
            dirs.push(format!("{}/.fonts", home.to_string_lossy()));
            dirs.push(format!("{}/.local/share/fonts", home.to_string_lossy()));
        }
        dirs
    }
}

fn is_font_file(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".ttf") || lower.ends_with(".otf") || lower.ends_with(".ttc") || lower.ends_with(".otc")
}

fn scan_dir(dir: &std::path::Path, depth: u32, out: &mut Vec<FontFileEntry>) {
    const MAX_DEPTH: u32 = 4;
    const MAX_ENTRIES: usize = 20_000;
    if depth > MAX_DEPTH || out.len() >= MAX_ENTRIES {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return, // unreadable/absent dirs are simply skipped
    };
    for entry in entries.flatten() {
        if out.len() >= MAX_ENTRIES {
            return;
        }
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            scan_dir(&path, depth + 1, out);
        } else if meta.is_file() {
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
            if is_font_file(name) {
                out.push(FontFileEntry {
                    path: path.to_string_lossy().into_owned(),
                    name: name.to_string(),
                });
            }
        }
    }
}

/// List every font file under the platform's font directories (paths + basenames).
#[tauri::command]
pub async fn list_fonts() -> Result<Vec<FontFileEntry>, String> {
    let mut out = Vec::new();
    for dir in font_dirs() {
        scan_dir(std::path::Path::new(&dir), 0, &mut out);
    }
    Ok(out)
}
