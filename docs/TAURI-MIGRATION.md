# Electron → Tauri migration design

Decision (2026-08-06): PanOffice Desktop ships on **Tauri v2** (Rust backend +
system webview), not Electron. The Electron fork in `desktop/` remains the
engine source and the reference implementation; new shell work happens in
`desktop-tauri/`.

This document is the migration plan. It is grounded in a full inventory of
the Electron coupling in upstream GenOffice 0.5.1 (summary below).

**Current status (2026-08-07):** pdf and docs are ported and green
(headless vitest parity + byte-level e2e for both). The bridge pattern in
`desktop-tauri/src/bridge/` (platform byte-store with IndexedDB fallback +
shared in-webview AI streaming) proved out — remaining apps follow it:
sheets next, slides last. The Rust side compiles/runs on the WSL dev box
via `desktop-tauri/tools/linux-sysroot.{sh,env}` (no sudo).

## Why the port is feasible

- Renderer code has **zero direct Electron imports** — every app talks to
  the host through preload globals (`window.desktop`, `window.desktopApi`,
  `window.slidesApi`, `window.pdfApi`, `window.aiOffice*`, `window.projectApi`).
- Preloads use only `contextBridge` + `ipcRenderer.invoke/on/send`, which
  map 1:1 onto Tauri's `invoke` / `listen`. The porting pattern is therefore
  a **bridge shim**: inject `window.<api>` implementations backed by
  `@tauri-apps/api`, then reimplement the main-process handlers as Rust
  commands (or keep them in JS inside the webview where they are pure).
- Engine packages (`docx-engine`, `pptx-render`, `i18n`, `agent-core`,
  `ai-provider`, `ui`, `project-store` types) are pure TS with no Node
  built-ins — they run in a system webview unchanged.
- The sheets xlsx sidecar (calamine + IronCalc) is a **stdio JSON-RPC
  process with zero Electron coupling** — spawn it from Rust as-is, or link
  it as a crate later.

## Coupling inventory (per app)

| App | main LOC | IPC channels | Hard points for Tauri |
| --- | --- | --- | --- |
| pdf | ~870 | 9 | easiest — pdf-lib save logic is pure JS |
| docs | ~3700 | 46 | `printToPDF` print/export has no Tauri equivalent |
| sheets | ~3100 | 35 | 1700-line preload validation layer (mechanical); `capturePage` e2e hooks |
| slides | ~8300 | **147** | editing kernel runs in Node main (~110 ops); HarfBuzz wasm metrics; system font scan + .ttc splitting; dual-screen presenter window; `desktopCapturer`/`getDisplayMedia` (unsupported in WKWebView) |
| shell | ~2600 | 34 | `WebContentsView`-per-tab has no direct Tauri analog; two `electron-updater` integrations |

Common: native `Menu`, `dialog`, `shell.openExternal` in all apps (Tauri has
menu/dialog/opener plugins). `nativeTheme`, `protocol.handle`, `Tray`,
`globalShortcut` are unused upstream.

Chromium-specific surface in renderers is minimal: no File System Access
API, no OffscreenCanvas, no SharedArrayBuffer. Only slides screen recording
(`getDisplayMedia`, missing in WKWebView) and pdf.js web workers (low risk)
need per-platform validation.

## Strategy

1. **Bridge shim pattern** (`desktop-tauri/src/bridge/`): implement each
   app's preload global in TypeScript over `@tauri-apps/api` `invoke` /
   `listen`, keeping the exact method signatures the renderers already call.
   Renderer code ports unchanged.
2. **Handler placement decision per feature**: pure-JS main logic (e.g.
   pdf-lib saves, pptx-engine ops) can run *inside the webview* behind the
   shim (with `Buffer`/`zlib` polyfills where needed); OS-touching logic
   (fs, dialogs, menus, fonts, sidecar spawn, presenter windows) becomes
   Rust commands. Decide per app, document in this file.

   **Decision (2026-08-07, proven by the first three ports):** the editing
   kernels stay in TypeScript in the webview. Rust (`src-tauri`) today
   carries only `read_file`/`write_file` and `xlsx_rpc` (spawning the
   sheets sidecar). sheets already demonstrated the pattern end-to-end
   (session/save logic moved into the webview with `Buffer`→`Uint8Array`
   and a pure-TS sha256). **Slides will follow the same pattern**:
   `pptx-engine` runs in the webview (Buffer/zlib polyfills as needed,
   HarfBuzz metrics is already wasm); only system font scanning
   (`fonts.ts`), the dual-screen presenter window, dialogs and
   drag-drop paths become Rust commands. There is no plan to reimplement
   document editing in Rust.
3. **Tab model**: upstream shell uses one `WebContentsView` per tab. Tauri
   options: (a) single webview + one iframe per tab — simplest, all tabs in
   one web process; (b) Tauri v2 multi-webview (`WebviewView`) — closer to
   upstream isolation. Start with (a) in the scaffold, evaluate (b) when the
   first two editors are in.
4. **Print / PDF export**: `printToPDF`/`capturePage` replacements — Rust
   side (`printpdf` crate) or system print dialog via the webview. Decide at
   M3 with docs as the test case.
5. **Updater**: replace both `electron-updater` integrations with
   `tauri-plugin-updater` (one place, `desktop-tauri`).
6. **Port order**: pdf → docs → sheets → slides (increasing difficulty;
   slides' editing-kernel placement is the key-path decision and caps total
   effort).

## What stays Electron (for now)

- `desktop/` keeps building and testing as upstream does — it is our
  upstream-mergeable engine source and the behavioral reference for the
  port (same fixtures, same fidelity scripts).
- The e2e harness (Playwright+Electron drivers) stays Electron-side until
  the Tauri apps need their own.
