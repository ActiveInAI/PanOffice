# PanOffice Roadmap

Direction (2026-08-06): desktop shell is **Tauri v2** (no Electron in the
shipping product); account + AI use **Arch-GPT**. See
`docs/TAURI-MIGRATION.md` and `docs/ARCHGPT.md`.

## M0 — Scaffold (done)

- [x] Fork GenOffice 0.5.1 into `desktop/`; user-facing rebrand to PanOffice.
- [x] Upstream baselines green: `npm install`, `typecheck`, unit tests.
- [x] Collabora Online source from Gerrit (`~/panspace/online`).
- [x] `server/wopi-host` (CheckFileInfo/GetFile/PutFile) + dev index page.
- [x] `deploy/docker-compose.yml` running and verified end to end
      (discovery, iframe assembly, container-to-container WOPI path; host
      port 9981 because 9980 was already taken).

## M1 — Direction pivot (done)

- [x] `archgpt` AI provider added to `packages/ai-provider` and made the
      default (OpenAI-compatible, `http://127.0.0.1:7071/v1`, overridable);
      package typecheck + tests green.
- [x] Arch-GPT integration notes (`docs/ARCHGPT.md`).
- [x] Electron→Tauri coupling inventory + migration design
      (`docs/TAURI-MIGRATION.md`).
- [x] `desktop-tauri/` scaffold (Tauri v2 shell + bridge-shim pattern).

## M2 — First Tauri app + Arch-GPT login

- Port **pdf** app to `desktop-tauri` (easiest: ~870 LOC main, 9 IPC
  channels) using the bridge shim; prove open/edit/save parity on fixtures.
  **[done]** — ported, 144 vitest + byte-level e2e all green.
- Arch-GPT account: login UI (password / verification-code / QR), JWT in
  OS keychain, token doubles as the `archgpt` provider API key.
  **[done]** — `src/account/` module (client/store/session/LoginPanel),
  25 tests green, LoginPanel mounted on the shell home (e2e-covered);
  OS-keychain backend pending (localStorage interim, see
  `src/account/README.md`).
- De-Genspark sweep in renderers: onboarding/Home strings (~190 mentions in
  shell strings.ts + per-app tables), remove gsk sign-in UI, drop bundled
  `@genspark/cli` from packaging; disable or replace `packages/ai-search`
  gsk-based web/image search.
- Decide fate of `ee/` placeholder (likely drop).

## M2.5 — Linux build unlocked (done, 2026-08-07)

- Rust side compiles and runs on the WSL dev box **without sudo**:
  user-space sysroot (`desktop-tauri/tools/linux-sysroot.{sh,env}`, ~490
  Ubuntu debs + a same-length binary patch of WebKit's hardcoded helper
  path). Verified: `cargo check`, `cargo build`, app launch on WSLg with
  real WebKit processes.

## M3 — docs + sheets on Tauri

- Port docs (46 channels; the print/`printToPDF` gap resolved via Rust
  `printpdf` or system print path). **[done]** — ported ahead of schedule
  with the pdf pattern: 438 docs vitest cases + byte-level e2e green
  (edit → save → reload). `print` uses `window.print()`;
  `exportPdf`/`printPdfBuffer`/`saveMergedPdf` are `{ok:false}` stubs until
  the Rust printpdf path lands; gsk/web-search calls are disabled in the
  shim (see the port's stub list in `src/bridge/desktop-api.ts`).
- Port sheets: reuse the Rust xlsx sidecar over stdio (later: link as a
  crate); port the 1700-line preload validation layer mechanically.
  **[done]** — the sidecar crate moved to `desktop-tauri/native/xlsx-engine/`
  (built in-repo); the webview drives it through one xlsx-RPC envelope: the
  `xlsx_rpc` Rust command under Tauri, `tools/xlsx-sidecar-server.mjs`
  (single POST /rpc) in the browser, with `host.*` commands carrying the fs
  the gateway needs. The validation layer is ported verbatim
  (`src/bridge/sheets-validate.ts`); the main-process save/session logic runs
  in the webview (`src/bridge/sheets-api.ts`) with bytes landing in the
  platform byte store. 898 sheets vitest cases (76 upstream files, real
  sidecar where needed) + byte-level e2e green (edit B1 → save → reload);
  native dialogs/menus/close guard, PDF export and gsk/search are TODO-M3
  stubs (full list in `desktop-tauri/README.md`).
- `tauri-plugin-updater` replaces both electron-updater integrations;
  update feed env `PANOFFICE_UPDATE_URL`.

## M4 — slides on Tauri (key path) — DONE (2026-08-08)

- Editing-kernel placement decided and shipped: pptx-engine runs in the
  webview (`src/apps/slides/main/slides-host.ts`, all ~110 editing ops);
  Node built-ins are browser-build shims (`src/bridge/node-shims/`:
  pure-TS sha256, fflate zlib-wrapper, Buffer polyfill). No document
  editing in Rust.
- HarfBuzz wasm metrics run in the webview as-is; the system font scan
  is the Rust `list_fonts` command with opentype.js parsing + .ttc
  splitting JS-side (async warmup; heuristic fallback in a plain
  browser). Dual-screen presenter window and `getDisplayMedia` screen
  recording are honest stubs (need a second Tauri window / WKWebView
  lacks the API).
- 327 slides vitest cases (31 upstream files + node-shims suite) green;
  byte-level e2e green (real-UI title edit → save → reload → marker in
  `ppt/slides/slide1.xml`). Full suite: 1832 vitest + 5 playwright.

## M5 — WOPI host hardening

- Arch-GPT JWT validation (no shared dev token), per-user permissions.
- WOPI `LOCK`/`UNLOCK`/`REFRESH_LOCK`, `PutRelativeFile`, versions.
- WOPI proof-key validation; TLS; remove/gate the dev index page.

## M6 — PanOffice Drive (desktop ⇄ cloud)

- S3-compatible storage, sharing/permissions.
- Tauri shell: "Cloud documents" section; open cloud files either as a
  Collabora iframe tab (live collab) or download → native engine → upload
  new version (respecting WOPI locks).

## M7 — Productization

- Brand the web side (coolwsd theming; evaluate building CODE from the
  Gerrit source with own branding for production).
  **[done 2026-08-07]** — full CODE source build works on this machine
  (engine + coolwsd, no sudo; recipe: `docs/CODE-BUILD.md`), WOPI loop
  verified against our host (open → render → edit → PutFile save). The
  branding pass itself (theme/welcome/about, own identity in coolwsd.xml)
  is the remaining work here.
- Web-side AI assistant beside the Collabora iframe (via Arch-GPT).
- CI/CD: fork CI, signed Tauri installers for Windows/macOS, versioned
  server releases.

## M8+ — Parking lot

- Mobile via Collabora's mobile apps.
- Byte-preserving save as a post-PutFile optimization on the web side.
- Upstream strategy: track GenOffice releases in `desktop/`; send generic
  fixes back.
