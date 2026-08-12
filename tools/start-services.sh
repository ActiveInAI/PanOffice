#!/usr/bin/env bash
# Start the complete PanOffice development stack on this WSL host.
#
# Source, builds, tests, AI execution and runtime state stay local. The ARM
# host at 192.168.1.100 remains a deployment target: source and builds stay
# local, while the browser dev proxy may read its deployed file API without
# copying server files or browser localStorage recents.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME_DIR="${PANOFFICE_LOCAL_RUNTIME_DIR:-$ROOT/.runtime-local}"
DATA_DIR="$RUNTIME_DIR/data/files"
LOG_DIR="$RUNTIME_DIR/logs"
XLSX_STAGE_DIR="$RUNTIME_DIR/xlsx-stage"
TOKEN_FILE="$RUNTIME_DIR/credentials/bridge-token"
COOL_ROOT="${PANOFFICE_COOL_ROOT:-$HOME/panspace/online}"
COOL_SYSROOT="${PANOFFICE_COOL_SYSROOT:-$HOME/.cool-sysroot/root}"
ARCH_GPT_REPO="${ARCH_GPT_REPO:-$HOME/actions-runner/_work/arch-gpt/arch-gpt}"
BRIDGE_SOURCE="${ARCH_GPT_BRIDGE_SOURCE:-$ARCH_GPT_REPO/tools/arch_gpt_cli_openai_bridge.mjs}"
DEV_PORT="${PANOFFICE_DEV_PORT:-5190}"
DEV_FILES_UPSTREAM="${PANOFFICE_DEV_FILES_UPSTREAM:-http://192.168.1.100:3210}"

umask 077
mkdir -p "$DATA_DIR" "$LOG_DIR" "$XLSX_STAGE_DIR" "$(dirname "$TOKEN_FILE")"

# A locally generated service-to-service token is kept outside source and
# browser storage. It is never copied from or sent to the deployment host.
if [[ ! -s "$TOKEN_FILE" ]]; then
  command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }
  openssl rand -hex 32 > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
fi

port_up() {
  ss -ltnH "sport = :$1" | grep -q .
}

wait_for_port() {
  local label="$1" port="$2" unit="$3" log="$4"
  for _ in $(seq 1 120); do
    if port_up "$port"; then
      printf '%-13s ready   http://127.0.0.1:%s\n' "$label" "$port"
      return 0
    fi
    if ! systemctl --user is-active --quiet "$unit"; then
      echo "$label exited before port $port became ready" >&2
      tail -n 40 "$log" >&2 || true
      return 1
    fi
    sleep 0.25
  done
  echo "$label did not open port $port" >&2
  tail -n 40 "$log" >&2 || true
  return 1
}

start_service() {
  local label="$1" port="$2" directory="$3" log="$4"
  local unit="panoffice-local-$label.service"
  shift 4
  if port_up "$port"; then
    printf '%-13s existing http://127.0.0.1:%s\n' "$label" "$port"
    return 0
  fi
  if ! systemctl --user is-active --quiet "$unit"; then
    systemctl --user reset-failed "$unit" 2>/dev/null || true
    systemd-run --user --quiet --collect --unit="$unit" \
      --setenv="HOME=$HOME" \
      --setenv="PATH=$PATH" \
      --property="WorkingDirectory=$directory" \
      --property=Restart=on-failure \
      --property=RestartSec=2s \
      --property="StandardOutput=append:$log" \
      --property="StandardError=append:$log" \
      "$@"
  fi
  wait_for_port "$label" "$port" "$unit" "$log"
}

CODEX_BIN="${ARCH_GPT_CODEX_BIN:-$(command -v codex || true)}"
CLAUDE_BIN="${ARCH_GPT_CLAUDE_BIN:-$(command -v claude || true)}"
[[ -f "$BRIDGE_SOURCE" ]] || { echo "local Arch-GPT bridge source not found: $BRIDGE_SOURCE" >&2; exit 1; }
[[ -x "$CODEX_BIN" ]] || { echo "local Codex CLI not found" >&2; exit 1; }
[[ -x "$CLAUDE_BIN" ]] || { echo "local Claude CLI not found" >&2; exit 1; }

start_service panai 8790 "$ARCH_GPT_REPO" "$LOG_DIR/panai.log" \
  env \
    ARCH_GPT_CLI_BRIDGE_PORT=8790 \
    ARCH_GPT_CLI_BRIDGE_TOKEN_FILE="$TOKEN_FILE" \
    ARCH_GPT_CLI_BRIDGE_ALLOWED_ORIGINS=http://127.0.0.1:3210,http://localhost:3210,http://127.0.0.1:5190,http://localhost:5190 \
    ARCH_GPT_CLI_BRIDGE_DISABLED_MODELS=glm-5.2 \
    ARCH_GPT_CODEX_BIN="$CODEX_BIN" \
    ARCH_GPT_CLAUDE_BIN="$CLAUDE_BIN" \
    node "$BRIDGE_SOURCE"

XLSX_BINARY="${XLSX_SIDECAR_PATH:-$ROOT/desktop-tauri/native/xlsx-engine/target/release/xlsx-sidecar}"
[[ -x "$XLSX_BINARY" ]] || { echo "local x86_64 XLSX sidecar not found: $XLSX_BINARY" >&2; exit 1; }
start_service xlsx 8791 "$ROOT/desktop-tauri" "$LOG_DIR/xlsx.log" \
  env \
    XLSX_SIDECAR_PORT=8791 \
    XLSX_SIDECAR_PATH="$XLSX_BINARY" \
    XLSX_SIDECAR_STAGE_DIR="$XLSX_STAGE_DIR" \
    node tools/xlsx-sidecar-server.mjs

start_service wopi 3210 "$ROOT/server/wopi-host" "$LOG_DIR/wopi.log" \
  env \
    PORT=3210 \
    DATA_DIR="$DATA_DIR" \
    WOPI_PUBLIC_BASE=http://127.0.0.1:3210 \
    COLLABORA_INTERNAL_URL=http://127.0.0.1:9982 \
    COLLABORA_PUBLIC_URL=http://127.0.0.1:9982 \
    WOPI_ALLOW_DEV_TOKEN=true \
    WOPI_DEV_UI_ENABLED=true \
    PDF_APP_URL=http://127.0.0.1:5190 \
    PDF_APP_ORIGIN=http://127.0.0.1:5190 \
    XLSX_RPC_URL=http://127.0.0.1:8791/rpc \
    PANAI_BRIDGE_URL=http://127.0.0.1:8790/v1 \
    PANAI_BRIDGE_TOKEN_FILE="$TOKEN_FILE" \
    PANAI_MODEL="${PANAI_MODEL:-deepseek-v4-flash}" \
    PANAI_MODELS="${PANAI_MODELS:-deepseek-v4-flash,deepseek-v4-pro,gpt-5.6-sol,claude-sonnet-5-xhigh}" \
    PANAI_DEEPSEEK_URL="${PANAI_DEEPSEEK_URL:-https://api.deepseek.com/v1}" \
    PANAI_DEEPSEEK_TOKEN_FILE="${PANAI_DEEPSEEK_TOKEN_FILE:-$RUNTIME_DIR/credentials/deepseek-api-key}" \
    npm run dev

start_service shell "$DEV_PORT" "$ROOT/desktop-tauri" "$LOG_DIR/shell.log" \
  env \
    PANOFFICE_DEV_PORT="$DEV_PORT" \
    PANOFFICE_DEV_FILES_UPSTREAM="$DEV_FILES_UPSTREAM" \
    VITE_XLSX_SIDECAR_URL=/xlsx-sidecar \
    npm run dev:ui

[[ -x "$COOL_ROOT/coolwsd" ]] || { echo "local Collabora binary not found: $COOL_ROOT/coolwsd" >&2; exit 1; }
start_service coolwsd 9982 "$COOL_ROOT" "$LOG_DIR/coolwsd.log" \
  env LD_LIBRARY_PATH="$COOL_SYSROOT/usr/lib/x86_64-linux-gnu" \
    "$COOL_ROOT/coolwsd" \
      --o:sys_template_path="$COOL_ROOT/systemplate" \
      --o:child_root_path="$COOL_ROOT/jails" \
      --o:cache_files.path="$COOL_ROOT/cache" \
      --port=9982 \
      --o:ssl.enable=false \
      --o:ssl.termination=false \
      --o:welcome.enable=false

echo
echo "PanOffice local development: http://127.0.0.1:$DEV_PORT"
echo "Deployed file API (proxied):  $DEV_FILES_UPSTREAM"
echo "Local empty file store:      $DATA_DIR"
echo "Logs:                       $LOG_DIR"
