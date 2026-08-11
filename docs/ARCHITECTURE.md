# PanOffice Architecture

Status: post-M0, direction set (2026-08-06). This document describes the
target shape and the reasons behind it.

## 1. What PanOffice is

PanOffice combines reusable open-source engines with our own services:

| Concern | What we use | Why |
| --- | --- | --- |
| Document engines (docx/xlsx/pptx/pdf) | **GenOffice** fork (`desktop/`) | TypeScript engines, byte-preserving OOXML round trip, unit-tested |
| Desktop shell | **Tauri v2** (`desktop-tauri/`, new) | Product decision: no Electron. Rust backend + system webview |
| Browser editing + real-time collaboration | **Collabora Online** (`coolwsd`) over WOPI | Mature collab backend; LibreOffice fidelity |
| Account (SSO) | **Arch-GPT auth** (JWT) | In-house account system |
| AI capabilities | **Arch-GPT LLM gateway** (OpenAI-compatible) | In-house models/routing; no third-party AI accounts |
| Cloud file access / sync | **PanOffice Server** (new, `server/`) | Thin layer we own; WOPI is the only contract Collabora speaks |

**Update (M8, 2026-08-10):** the web mainline is now our own GenOffice
editors (the `desktop-tauri/` shell served in the browser, opening and
saving docx/xlsx/pptx/pdf through the wopi-host); Collabora Online remains
as the optional real-time collaboration backend.

Two editing engines serve different contexts over the same OOXML files —
they are **not merged**:

```
                 ┌─────────────────────────────┐
                 │        PanOffice            │
                 │                             │
 local files ──► │  Desktop (Tauri shell +     │
                 │  GenOffice TS engines, AI   │
                 │  via Arch-GPT)              │
                 │                             │
                 │  Web (Collabora Online) ◄───┼── browser, N users co-editing
                 └───────────┬─────────────────┘
                             │ WOPI (CheckFileInfo / GetFile / PutFile / LOCK)
                             ▼
                    PanOffice Server (wopi-host → Drive)
                             │
        Arch-GPT ◄───────────┼────────────► Arch-GPT LLM gateway
        auth (JWT)           │              (OpenAI-compatible)
                             ▼
                     file storage (local fs now, S3 later)
```

## 2. Components

### 2.1 Desktop engines (`desktop/`, fork of GenOffice 0.5.1)

- Engine packages under `packages/` are pure TypeScript and run unchanged
  in any webview: `docx-engine`, `pptx-engine`, `pptx-render`, `file-parse`,
  `agent-core`, `ai-provider`, `i18n`, `ui`, `project-store`.
- Sheets builds on Univer core (Apache-2.0) + a Rust xlsx sidecar
  (calamine + IronCalc, stdio JSON-RPC, Electron-free — reusable from a
  Tauri backend as-is).
- AI: `packages/agent-core` (provider-agnostic agent loop) +
  `packages/ai-provider`. **PanOffice change landed:** `archgpt` provider
  added and made the default (`ARCHGPT_DEFAULT_BASE_URL =
  http://127.0.0.1:7071/v1`, OpenAI-compatible, overridable). The upstream
  `genspark` provider remains but unused by default; removal is ROADMAP M2.
- Fork policy: keep internal identifiers (`@genoffice/*` scopes, env var
  names) so upstream merges stay cheap; rebrand only user-facing surfaces
  (done at M0). This Electron tree stays buildable as the **behavioral
  reference** and engine source — it is not the shipping shell.

### 2.2 Desktop shell (`desktop-tauri/`, Tauri v2 — new)

- Tauri v2 (Rust commands + system webview). Renderer code from
  `desktop/apps/*/src/renderer` ports over unchanged via a **bridge shim**
  that re-implements each preload global (`window.pdfApi`, `window.desktop`,
  …) on top of `@tauri-apps/api`.
- Full inventory, per-app difficulty, and the tab-model/print/updater
  decisions: [`docs/TAURI-MIGRATION.md`](TAURI-MIGRATION.md).
- Port order: pdf → docs → sheets → slides.

### 2.3 Web (Collabora Online)

- `collabora/code` container in development (see
  `deploy/docker-compose.yml`; host port **9981** because 9980 is taken by
  a pre-existing container on this machine). Source for reference/patching:
  `~/panspace/online` (Gerrit — GitHub repo is issue-tracker-only; official
  read-only mirror: `CollaboraOnline/online.mirror`).
- coolwsd renders server-side and speaks WOPI back to the host:
  `CheckFileInfo` / `GetFile` / `PutFile` (locks and versions at M5).

### 2.4 Server (`server/wopi-host`, → PanOffice Drive later)

Current scope is the M0 minimal WOPI host over a local directory
(CheckFileInfo/GetFile/PutFile + dev index page, shared dev token).
Hardening (OIDC via Arch-GPT JWT, locks, versions, S3) is ROADMAP M5/M6.

### 2.5 Arch-GPT (account + AI)

Endpoints, repo locations, and open questions:
[`docs/ARCHGPT.md`](ARCHGPT.md). Summary: AI = OpenAI-compatible gateway
(default `127.0.0.1:7071/v1`); account = JWT SSO (`/v1/auth/*`) with a
Tauri-side login UI planned at M2.

## 3. How the two engines meet

The integration contract is the **file**, not the code:

1. Both engines read/write the same OOXML formats. Either opens what the
   other saved.
2. A desktop "cloud document" tab can iframe the Collabora client
   (Tauri webview loading the discovery urlsrc + WOPISrc) — mixing native
   engine tabs and live-collab tabs in one window (M6).
3. Conflicts: while a cloud file is open in Collabora the server holds a
   WOPI `LOCK`; the desktop sync client (M6) treats Collabora's `PutFile`
   result as the winning version.

## 4. Security posture

- Desktop: upstream sandbox model (see `desktop/SECURITY.md`); the Tauri
  port keeps renderers privilege-free (all fs/OS access via audited Rust
  commands).
- Server: the M0 WOPI host is **not internet-safe** (shared token, no proof
  keys, no TLS). Localhost/dev only until M5.
- AI/account: JWT lives in the OS keychain; model traffic goes only to the
  configured Arch-GPT gateway.

## 5. Licensing

- `desktop/` Apache-2.0 (upstream GenOffice + our patches). GenOffice /
  Genspark trademarks must not identify the fork.
- Collabora Online MPL-2.0, used as a separate network service; patches to
  `online/` files remain MPL-2.0 and must be published. The stock image is
  development-branded (see ROADMAP M7).
- New PanOffice code (`server/`, `deploy/`, `desktop-tauri/`, `docs/`):
  Apache-2.0.

## 6. Explicit non-goals (for now)

- No CRDT/multi-user editing inside the desktop engines (Collabora covers
  collaboration; desktop engines stay single-user offline).
- No Electron in the shipping product; the Electron fork is reference-only.
- No mobile apps; no forking LibreOffice core.
