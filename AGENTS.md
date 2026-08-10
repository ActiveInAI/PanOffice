# PanOffice — working notes for agents

## Direction (2026-08-06)

- Shipping desktop shell is **Tauri v2** (`desktop-tauri/`); the Electron
  fork (`desktop/`) is the engine source and behavioral reference, kept
  upstream-mergeable.
- Account + AI use **Arch-GPT** (JWT SSO; OpenAI-compatible LLM gateway,
  default `http://127.0.0.1:7071/v1`). The `archgpt` provider is the
  default in `desktop/packages/ai-provider`.
- Web collaboration: Collabora Online over WOPI (`deploy/` stack).

## Layout

- `desktop-tauri/` — Tauri v2 shell (React frontend + Rust commands;
  bridge shim in `src/bridge/` re-implements the upstream preload globals).
- `desktop/` — GenOffice 0.5.1 fork. npm workspaces:
  `apps/{docs,sheets,slides,pdf,shell}`, `packages/*`.
- `server/wopi-host/` — minimal WOPI host (Express + TS). Dev-grade auth.
- `deploy/` — docker-compose: `collabora/code` + `wopi-host`
  (Collabora on host port **9981**; 9980 is a pre-existing container).
- `docs/` — ARCHITECTURE, TAURI-MIGRATION, ARCHGPT, ROADMAP. Update them
  when scope/decisions change.

## External baselines (outside this repo, in `~/panspace/`)

- `genoffice-0.5.1/` — pristine upstream export + installed node_modules.
  Diff `desktop/` against it to see fork changes.
- `online/` — Collabora Online source (Gerrit clone). MPL-2.0.
- Arch-GPT repo: `~/actions-runner/_work/arch-gpt/arch-gpt/`
  (API spec: `04-backend/openapi.yaml`).

## Commands

```bash
# Tauri shell (Rust side needs webkit2gtk-4.1 on Linux — absent here)
cd desktop-tauri && npm install && npm run build:ui

# engines / Electron reference (node_modules is symlinked to the upstream
# copy; run a real `npm install` in desktop/ if that link breaks)
cd desktop && npm run typecheck && npm test
cd desktop && npm run dev:docs

# WOPI host
cd server/wopi-host && npm install && npm run build && npm start

# web stack (docker)
cd deploy && docker compose up --build   # http://localhost:3000
```

## Conventions

- Keep `desktop/` mergeable with upstream GenOffice: do not rename
  `@genoffice/*` package scopes or `GENOFFICE_*` env vars; rebrand only
  user-facing strings. Never use GenOffice/Genspark trademarks on product
  surfaces.
- No new Electron code for product features — desktop investment goes into
  `desktop-tauri/`. Renderer ports must not change engine behavior; port
  via the bridge shim, keep fixtures/fidelity scripts as the oracle.
- No CRDT/collab in desktop engines — collaboration is Collabora over WOPI.
- New PanOffice code (`desktop-tauri/`, `server/`, `deploy/`) is
  Apache-2.0, TypeScript ESM, minimal dependencies.
- Git: repo not yet initialized (fork came from a zip export).
