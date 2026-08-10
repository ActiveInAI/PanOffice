# @panoffice/desktop-tauri

PanOffice desktop shell on **Tauri v2** — the shipping desktop home
(product decision: no Electron). The GenOffice-derived editors
(`../desktop/apps/*/src/renderer`) are ported into this shell one app at a
time over the bridge shim in `src/bridge/`; see
[`../docs/TAURI-MIGRATION.md`](../docs/TAURI-MIGRATION.md) for the pattern
and port order (pdf → docs → sheets → slides).

## Status (M2)

The pdf editor is ported and green headlessly:

- `src/apps/pdf/` — the GenOffice pdf renderer (copied from
  `../desktop/apps/pdf/src/renderer`, only the Electron entry files
  dropped), the shared IPC types (`shared/ipc.ts`, channel constants
  removed), and the pdf-lib save/extract/insert engine (`pdf/ops.ts`).
- `src/bridge/pdf-api.ts` implements `window.pdfApi` on the webview side:
  save/extract/insert run the same pdf-lib code that upstream ran in the
  Electron main process; file IO goes through `src/bridge/platform.ts`
  (Rust `read_file`/`write_file` under Tauri; an IndexedDB byte-store
  overlay + fetch fallback in a plain browser, which makes save → reopen
  verifiable headlessly). AI streaming is direct in-webview
  (`streamForProvider` from `@genoffice/ai-provider`, one AbortController
  per request); the close-handshake trio and the native dialogs
  (extract/insert/export pickers under Tauri) are logged stubs for M3.
- Hash routes: `#/` home placeholder, `#/pdf?src=<path>` mounts the editor
  (the bridge hands `src` over once via `consumePending()`).
- Tests: `npm test` — 144 vitest cases ported from upstream, all passing;
  `npm run test:e2e` — Playwright (headless chromium) opens
  `#/pdf?src=/fixtures/hello.pdf`, adds a note through the real UI, saves
  with Ctrl+S, reloads, and parses the persisted bytes back out of the
  IndexedDB overlay to prove the annotation survived.

Still Electron-side: the real close-with-unsaved-changes prompt, native
file dialogs, and password-protected write-back (all need the M3 window
lifecycle / tauri plugin-dialog).

## Status (docs)

The docs (.docx) editor is ported and green headlessly, same pattern:

- `src/apps/docs/` — the GenOffice docs renderer (copied from
  `../desktop/apps/docs/src/renderer`, only the Electron entry files
  dropped) plus its shared IPC types. `src/apps/docs/DocsApp.tsx` mounts it;
  `#/docs?src=<path>` routes to it (the bridge hands `src` over once via
  `consumePendingOpenDocx()`).
- `src/bridge/desktop-api.ts` implements `window.desktop` +
  `window.projectApi`: open/save/recovery/recents run on the platform byte
  store (save = docx-engine paragraph patch in the webview → write bytes);
  print is `window.print()`; chat history persists to localStorage; AI
  streaming shares `src/bridge/ai-stream.ts` with the pdf bridge (extracted
  from `pdf-api.ts`, pdf behavior unchanged). Honest stubs with TODOs:
  PDF export (`exportPdf`/`printPdfBuffer`/`saveMergedPdf` — needs the Rust
  printpdf path, M3 §4), native dialogs/menus/tabs/close handshake (M3),
  gsk login + web/image search (need a Rust-side proxy, M3),
  `getPathForFile` → null (Tauri drag-drop event later).
- Fixtures: `public/fixtures/{simple,kitchen-sink}.docx` copied from
  `desktop/fixtures/generated/` (see tools/fixtures.md).
- Tests: 438 vitest cases in `tests/docs/` ported from
  `../desktop/apps/docs/tests/` (all but `updater.test.ts`, which tests the
  Electron updater); `e2e/docs.spec.ts` types a marker into
  `#/docs?src=/fixtures/simple.docx`, saves with Ctrl+S, reloads, and
  unzips the persisted bytes (jszip) to prove the edit survived. Full
  suite: 607 vitest cases + 2 playwright specs, all green.

## Status (sheets)

The sheets (.xlsx, Univer-based) editor is ported and green headlessly:

- `src/apps/sheets/` — the GenOffice sheets renderer plus its `shared/`
  (IPC types + zod schemas), `domain/`, `gateway/` (the OOXML save
  pipeline), and `ai/` (deterministic planner), copied from
  `../desktop/apps/sheets/src/`; only the Electron entry files were
  dropped. `src/apps/sheets/SheetsApp.tsx` mounts it;
  `#/sheets?src=<path>` routes to it (SheetsApp fires the menu 'open'
  action; the bridge's `selectWorkbook` consumes the `src` once).
  Gateway port notes: `Buffer` → `Uint8Array`, node:crypto's sha256 → a
  small pure-TS `gateway/sha256.ts`, and node:fs → the `HostIo`
  abstraction (`gateway/host-io.ts`; `host-io-node.ts` backs it in
  tests). Two legacy pre-sidecar helpers (`writeXlsxAtomically`,
  `mutateXlsxFile`) were dropped — dead code here.
- The Rust xlsx sidecar (calamine + IronCalc) is now OUR component:
  `native/xlsx-engine/` (provenance in its README), built with
  `cargo build --release`. The webview reaches it through one xlsx-RPC
  envelope (`src/bridge/xlsx-rpc.ts`): in the Tauri app via the new
  `xlsx_rpc` command (`src-tauri/src/xlsx_rpc.rs` — one long-running
  child, newline-JSON, requestId matching, 30s/180s timeouts, mirroring
  the upstream client); in a browser via `tools/xlsx-sidecar-server.mjs`
  (port 8791, single POST `/rpc`, same semantics). Commands starting
  `host.` are answered by the host (Rust or the dev server), not the
  sidecar: they are the fs touchpoints the in-webview gateway needs —
  temp dirs, plan content files, and staging URL-ish paths so the
  sidecar always opens real files.
- `src/bridge/sheets-api.ts` implements `window.desktopApi` (36 methods)
  + reuses the docs-installed `window.projectApi`: the upstream
  preload's ~1700-line validation layer is ported verbatim in
  `src/bridge/sheets-validate.ts`; the main-process session/save logic
  (sheets-main.ts) is reimplemented in the webview — saves run the
  gateway against the sidecar, then the bytes land in the platform byte
  store (IndexedDB overlay in the browser, real disk under Tauri), the
  same overlay pattern as docs/pdf. `.csv`/`.xls` imports convert on
  open (CSV in-webview, XLS via the sidecar) with save-as routing.
  Honest stubs with TODOs: native open/save dialogs + menus + close
  guard + autoRename (M3), PDF export (throws — needs the Rust printpdf
  path, M3 §4), gsk login + web search (need a Rust-side proxy, M3),
  crash-recovery restore prompt (M3; recovery copies still write in the
  browser). `capturePage`/capture-server e2e hooks: omitted (Electron
  e2e-only).
- Tests: 898 vitest cases in `tests/sheets/` — 76 files ported from
  `../desktop/apps/sheets/tests/` (the sidecar suites spawn the real
  binary from `native/xlsx-engine`; `pivot-roundtrip.e2e.test.ts`
  self-skips without LibreOffice, as upstream) plus a new sha256
  equivalence suite. `e2e/sheets.spec.ts` opens
  `#/sheets?src=/fixtures/hello.xlsx`, asserts "Hello PanOffice" renders
  (canvas-pixel assertion — the Univer grid has no DOM text), edits B1
  through the real UI (click cell, type, Enter), saves via the
  quick-access button, reloads, re-asserts, and unzips the persisted
  bytes (jszip) to prove the edit survived. Playwright's `webServer` is
  now an array: vite preview + the sidecar server. Full suite: 1505
  vitest cases + 4 playwright specs, all green.

## Status (slides)

The slides (.pptx, Konva-based) editor is ported and green headlessly —
the last and biggest app, completing the port order:

- `src/apps/slides/` — the GenOffice slides renderer plus its `shared/`
  IPC types, copied from `../desktop/apps/slides/src/` (only the
  Electron entry files dropped), and `main/` — the Electron main-process
  modules ported to run in the webview. `src/apps/slides/SlidesApp.tsx`
  mounts it; `#/slides?src=<path>` routes to it (the bridge's
  `consumePendingOpen` consumes the `src` once; no `src` → blank deck).
- `src/apps/slides/main/slides-host.ts` (~3480 lines) is the
  `slides-main.ts` port: the whole session + all ~110 document-editing
  ops (open/edit/history/master/tables/charts/themes/save) run in the
  webview on the source-aliased `@genoffice/pptx-engine`, exactly the
  kernel-placement decision in `../docs/TAURI-MIGRATION.md`. File IO
  goes through the platform byte-store; saves use `savePptx()` (the
  streaming `savePptxToFile` needs node:fs) →
  `platform.writeFile` → `commitSaved`, recents/autosave recovery copies
  live in localStorage / the overlay. `session-state.ts`,
  `edit-text.ts`, `cfb-sniff.ts`, `mp4-audio-sniff.ts`, `i18n-main.ts`
  ported with the same names; `tiff-decode.ts` re-encodes PNG via a
  hand-rolled fflate-based encoder instead of pngjs (node zlib).
- Node built-ins used by the source-aliased pptx-engine are shimmed for
  the browser build only (`src/bridge/node-shims/`, aliased in
  `vite.config.ts`; vitest keeps the real Node modules): `node:crypto`
  → pure-TS sync sha256 + `crypto.randomUUID`; `node:zlib` → fflate
  (`zlibSync`/`unzlibSync` — fflate's same-named functions are raw
  DEFLATE, not the zlib wrapper Node speaks); `Buffer` global → the
  `buffer` package, installed before the first engine call.
- Fonts/HarfBuzz: `main/fonts.ts` keeps upstream's sync resolve over an
  async-warmed cache — the host awaits
  `ensureSystemFontsReady(deckFamilies)` before first layout; the system
  font scan is the new Rust `list_fonts` command
  (`src-tauri/src/fonts.rs`, recursive, ttf/otf/ttc/otc), opentype.js
  parsing + .ttc splitting stay JS-side; a plain browser finds no fonts
  and takes upstream's heuristic fallback. `main/shaped-metrics.ts`
  loads the HarfBuzz wasm via a `?url` asset and measures complex-script
  ground truth directly in-realm (upstream bounced through
  `webContents.executeJavaScript`).
- `src/bridge/slides-api.ts` implements `window.slidesApi` (148
  methods): editing ops delegate to the host; AI settings/streaming
  reuse `src/bridge/ai-stream.ts`; `window.desktop` (files subset) and
  `window.projectApi` come from the docs bridge. Honest stubs with
  TODOs: dual-screen presenter + audience channel (needs a second Tauri
  window, M4-followup), screen recording via `getDisplayMedia`
  (renderer-side; absent in WKWebView), gsk login + web/image search +
  cloud deck generation (need a Rust-side network proxy), native
  dialogs/menus/close guard (M3 shell lifecycle), PDF export/print
  (`printToPDF` has no Tauri equivalent), `getPathForFile` → null.
- Tests: 327 vitest cases in `tests/slides/` (321 upstream cases over 31
  files — the macOS-only system-fonts describe stays `runIf(darwin)` and
  skips here — plus a new node-shims equivalence suite). Browser-mode
  e2e uses heuristic font metrics (no system fonts without Tauri).
  `e2e/slides.spec.ts` opens `#/slides?src=/fixtures/hello.pptx`,
  asserts the "Hello PanOffice" title renders (canvas-pixel assertion —
  Konva has no DOM text; the title band is located via the bridge's own
  `getRenderSlides()` render tree), double-clicks the title on the
  canvas and types a marker through the real contentEditable overlay,
  saves via the quick-access button, reloads, re-asserts, and unzips the
  persisted bytes (jszip) to prove the marker landed in
  `ppt/slides/slide1.xml` with slide 2 intact. Full suite: 1832 vitest
  cases + 5 playwright specs, all green.

## Build prerequisites

- Node ≥ 20, Rust ≥ 1.85 (this repo was scaffolded with cargo 1.95).
- **Windows**: WebView2 (preinstalled on Win10+); **macOS**: Xcode CLT;
  **Linux**: `webkit2gtk-4.1`/`libsoup-3.0` dev packages — *or*, on a box
  without sudo (like the current WSL dev machine), use the user-space
  sysroot: `tools/linux-sysroot.sh` (downloads ~490 Ubuntu debs into
  `~/.tauri-sysroot`, patches WebKit's helper-path string) then
  `source tools/linux-sysroot.env`. Verified here: `cargo check`,
  `cargo build`, and launching the app under WSLg all work.
- First run: `npm i -D @tauri-apps/cli` is already wired, so
  `npm run tauri -- --help` works after `npm install`.

## Commands

```bash
npm install
npm run build:ui     # typecheck + vite build the shell frontend (works anywhere)
npm test             # vitest: the ported test-suites (pdf 144 + docs 438 + account 25 + sheets 898 + slides 327)
npm run test:e2e     # build + playwright e2e against vite preview (headless chromium)
npm run fixture:pdf  # regenerate public/fixtures/hello.pdf (pdf-lib, tools/make-fixture.mjs)
node tools/xlsx-sidecar-server.mjs  # sheets browser-mode dev server (port 8791; auto-started by playwright)
npm run dev          # tauri dev (needs the system deps above)
npm run build        # tauri build (bundling disabled until icons land, see tauri.conf.json)
```
