//! `xlsx_rpc` — the Tauri-mode half of the sheets xlsx-RPC channel (the
//! browser-mode half is `tools/xlsx-sidecar-server.mjs`; the webview client is
//! `src/bridge/xlsx-rpc.ts`).
//!
//! One long-running xlsx-sidecar child process, newline-delimited JSON on
//! stdio, requestId matching, 30s timeouts (180s for archive commands) —
//! mirroring the upstream Electron client
//! `desktop/apps/sheets/src/main/xlsx-sidecar-client.ts`. Commands starting
//! with `host.` are answered locally: they are the fs touchpoints the
//! in-webview gateway save pipeline needs (temp dirs, plan content files,
//! staging URL-ish paths so the sidecar sees real files).

use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Archive commands stream whole workbooks; large files need more headroom.
const ARCHIVE_TIMEOUT: Duration = Duration::from_secs(180);
const ARCHIVE_COMMANDS: [&str; 6] = [
    "convert_workbook",
    "archive_manifest",
    "read_entries",
    "scan_entries",
    "save_archive",
    "recalc_cells",
];

type PendingMap = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>;

struct SidecarChild {
    stdin: Mutex<ChildStdin>,
    pending: PendingMap,
}

/// Process-wide sidecar state (one workbook engine per app run).
#[derive(Default)]
pub struct XlsxRpcState {
    child: Mutex<Option<Arc<SidecarChild>>>,
}

fn sidecar_path() -> Result<String, String> {
    if let Ok(path) = std::env::var("XLSX_SIDECAR_PATH") {
        if !path.is_empty() {
            return Ok(path);
        }
    }
    let relative = Path::new("native")
        .join("xlsx-engine")
        .join("target")
        .join("release")
        .join("xlsx-sidecar");
    // dev: cwd is src-tauri, so the binary lives one level up; bundled
    // layouts are a bundling decision (TODO M3: tauri sidecar resource).
    let mut candidates = vec![relative.clone()];
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("..").join(&relative));
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                candidates.push(dir.join(&relative));
                candidates.push(dir.join("../../..").join(&relative));
            }
        }
    }
    for candidate in candidates {
        if candidate.is_file() {
            return Ok(candidate.to_string_lossy().into_owned());
        }
    }
    Err("xlsx-sidecar binary not found (set XLSX_SIDECAR_PATH or build native/xlsx-engine)".into())
}

fn fail_all(pending: &PendingMap, message: String) {
    let pending = pending.clone();
    tauri::async_runtime::spawn(async move {
        let mut map = pending.lock().await;
        for (_, sender) in map.drain() {
            let _ = sender.send(Err(message.clone()));
        }
    });
}

async fn ensure_child(state: &XlsxRpcState) -> Result<Arc<SidecarChild>, String> {
    let mut guard = state.child.lock().await;
    if let Some(child) = guard.as_ref() {
        return Ok(child.clone());
    }
    let binary = sidecar_path()?;
    let mut process: Child = Command::new(binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to spawn xlsx-sidecar: {e}"))?;
    let stdin = process.stdin.take().ok_or("xlsx-sidecar stdin unavailable")?;
    let stdout = process.stdout.take().ok_or("xlsx-sidecar stdout unavailable")?;
    let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
    let reader_pending = pending.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    let parsed: Result<Value, _> = serde_json::from_str(&line);
                    match parsed {
                        Ok(response) => {
                            let request_id = response
                                .get("requestId")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string();
                            let sender = reader_pending.lock().await.remove(&request_id);
                            if let Some(sender) = sender {
                                if response.get("ok").and_then(Value::as_bool) == Some(true) {
                                    let _ =
                                        sender.send(Ok(response.get("result").cloned().unwrap_or(Value::Null)));
                                } else {
                                    let message = response
                                        .get("error")
                                        .and_then(|e| e.get("message"))
                                        .and_then(Value::as_str)
                                        .unwrap_or("XLSX sidecar request failed.")
                                        .to_string();
                                    let _ = sender.send(Err(message));
                                }
                            }
                        }
                        Err(_) => {
                            fail_all(
                                &reader_pending,
                                "XLSX sidecar returned invalid JSON.".to_string(),
                            );
                        }
                    }
                }
                Ok(None) => {
                    fail_all(&reader_pending, "XLSX sidecar exited.".to_string());
                    break;
                }
                Err(error) => {
                    fail_all(&reader_pending, format!("XLSX sidecar read failed: {error}"));
                    break;
                }
            }
        }
    });
    let child = Arc::new(SidecarChild {
        stdin: Mutex::new(stdin),
        pending,
    });
    *guard = Some(child.clone());
    Ok(child)
}

/// After a child death the next request respawns; called on write/timeout failure.
async fn drop_child(state: &XlsxRpcState, child: &Arc<SidecarChild>) {
    let mut guard = state.child.lock().await;
    if guard.as_ref().is_some_and(|c| Arc::ptr_eq(c, child)) {
        *guard = None;
    }
}

/// FNV-1a hex — stable staging key for a logical path (no extra crates).
fn fnv_hex(input: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in input.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

fn unique_temp_dir(prefix: &str) -> std::path::PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("{prefix}{}-{}-{seq}", std::process::id(), nanos))
}

fn sanitize_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '_' })
        .collect();
    if cleaned.is_empty() {
        "workbook.xlsx".to_string()
    } else {
        cleaned
    }
}

async fn handle_host(command: &str, request: &Value) -> Result<Value, String> {
    let str_arg = |key: &str| -> Result<String, String> {
        request
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| format!("{command}: missing string argument '{key}'"))
    };
    match command {
        // Real on-disk paths pass through; anything else (vite URL-ish paths,
        // overlay keys) is staged under a temp dir keyed by the logical path.
        "host.stage" => {
            let logical = str_arg("path")?;
            let path = Path::new(&logical);
            if path.is_absolute() && path.is_file() {
                return Ok(serde_json::json!({ "path": logical }));
            }
            let dir = std::env::temp_dir()
                .join("panoffice-xlsx-stage")
                .join(&fnv_hex(&logical)[..16]);
            tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let staged = dir.join(sanitize_name(&name));
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(request.get("base64").and_then(Value::as_str).unwrap_or(""))
                .map_err(|e| format!("host.stage: bad base64: {e}"))?;
            tokio::fs::write(&staged, bytes).await.map_err(|e| e.to_string())?;
            Ok(serde_json::json!({ "path": staged.to_string_lossy() }))
        }
        "host.mkdtemp" => {
            let prefix = request
                .get("prefix")
                .and_then(Value::as_str)
                .unwrap_or("panoffice-xlsx-");
            let dir = unique_temp_dir(prefix);
            tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
            Ok(serde_json::json!({ "path": dir.to_string_lossy() }))
        }
        "host.mkdir" => {
            tokio::fs::create_dir_all(str_arg("path")?)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::json!({}))
        }
        "host.read_text" => {
            let text = tokio::fs::read_to_string(str_arg("path")?)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::json!({ "text": text }))
        }
        "host.read_file" => {
            let bytes = tokio::fs::read(str_arg("path")?)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::json!({
                "base64": base64::engine::general_purpose::STANDARD.encode(bytes)
            }))
        }
        "host.write_file" => {
            let path = str_arg("path")?;
            if let Some(text) = request.get("text").and_then(Value::as_str) {
                tokio::fs::write(&path, text).await.map_err(|e| e.to_string())?;
            } else {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(request.get("base64").and_then(Value::as_str).unwrap_or(""))
                    .map_err(|e| format!("host.write_file: bad base64: {e}"))?;
                tokio::fs::write(&path, bytes).await.map_err(|e| e.to_string())?;
            }
            Ok(serde_json::json!({}))
        }
        "host.remove" => {
            let path = str_arg("path")?;
            let recursive = request.get("recursive").and_then(Value::as_bool) == Some(true);
            let result = if recursive {
                tokio::fs::remove_dir_all(&path).await
            } else {
                tokio::fs::remove_file(&path).await
            };
            // force semantics: a missing path is not an error
            match result {
                Ok(()) => Ok(serde_json::json!({})),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::json!({})),
                Err(e) => Err(e.to_string()),
            }
        }
        "host.rename" => {
            tokio::fs::rename(str_arg("from")?, str_arg("to")?)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::json!({}))
        }
        _ => Err(format!("Unknown host command: {command}")),
    }
}

#[tauri::command]
pub async fn xlsx_rpc(
    state: tauri::State<'_, XlsxRpcState>,
    request: Value,
) -> Result<Value, String> {
    let command = request
        .get("command")
        .and_then(Value::as_str)
        .ok_or("xlsx_rpc: missing command")?
        .to_string();
    let request_id = request
        .get("requestId")
        .and_then(Value::as_str)
        .ok_or("xlsx_rpc: missing requestId")?
        .to_string();
    if let Some(host_command) = command.strip_prefix("host.") {
        let _ = host_command;
        return handle_host(&command, &request).await;
    }

    let child = ensure_child(&state).await?;
    let (tx, rx) = oneshot::channel();
    child.pending.lock().await.insert(request_id.clone(), tx);
    let line = format!("{}\n", serde_json::to_string(&request).map_err(|e| e.to_string())?);
    {
        let mut stdin = child.stdin.lock().await;
        if let Err(error) = stdin.write_all(line.as_bytes()).await {
            child.pending.lock().await.remove(&request_id);
            drop_child(&state, &child).await;
            return Err(format!("XLSX sidecar write failed: {error}"));
        }
    }
    let limit = if ARCHIVE_COMMANDS.contains(&command.as_str()) {
        ARCHIVE_TIMEOUT
    } else {
        REQUEST_TIMEOUT
    };
    match tokio::time::timeout(limit, rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_dropped)) => {
            drop_child(&state, &child).await;
            Err("XLSX sidecar exited.".to_string())
        }
        Err(_elapsed) => {
            child.pending.lock().await.remove(&request_id);
            Err("XLSX sidecar request timed out.".to_string())
        }
    }
}
