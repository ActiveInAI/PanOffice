# PanOffice

An AI-native office suite with web collaboration, assembled from two
open-source engines plus our own services:

- **PanOffice Desktop** — the GenOffice document engines
  ([Apache-2.0](https://github.com/genspark-ai/genoffice)) running in a
  **Tauri v2** shell (`desktop-tauri/`, no Electron in the shipping
  product), for `.docx` / `.xlsx` / `.pptx` / `.pdf` with block-level AI
  editing and byte-preserving round-trip saves. `desktop/` holds the
  upstream Electron fork — engine source and behavioral reference.
- **PanOffice Web** — [Collabora Online](https://www.collaboraonline.com/)
  (MPL-2.0), embedded over WOPI, for browser-based real-time multi-user
  editing of the same file formats.
- **Arch-GPT** — in-house account (JWT SSO) and AI capabilities
  (OpenAI-compatible LLM gateway); no third-party AI accounts.
- **PanOffice Server** (`server/`) — the glue we own: a WOPI host
  (`server/wopi-host`), and later the file-sync (Drive) service.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how the pieces fit,
[`docs/TAURI-MIGRATION.md`](docs/TAURI-MIGRATION.md) for the Electron→Tauri
plan, [`docs/ARCHGPT.md`](docs/ARCHGPT.md) for the account/AI integration,
[`docs/CODE-BUILD.md`](docs/CODE-BUILD.md) for building Collabora Online
from source on this machine (done, verified), and
[`docs/ROADMAP.md`](docs/ROADMAP.md) for milestones.

## Repository layout

```
desktop-tauri/      shipping desktop shell (Tauri v2 + React) — new
desktop/            GenOffice 0.5.1 fork (Electron; engines + reference)
server/wopi-host/   minimal WOPI host bridging Collabora Online to a file store
deploy/             docker-compose for the web-collaboration stack
docs/               architecture, migration plan, Arch-GPT notes, roadmap
```

Upstream references kept outside this repo (in `~/panspace/`):

- `genoffice-0.5.1/` — pristine upstream GenOffice export (diff baseline)
- `online/` — Collabora Online source, cloned from
  [Gerrit](https://gerrit.collaboraoffice.com/) (the GitHub repo is now an
  issue tracker only; official read-only mirror:
  [CollaboraOnline/online.mirror](https://github.com/CollaboraOnline/online.mirror))

## Quick start

Desktop shell (Tauri; Node ≥ 20 + Rust + platform webview deps — see
`desktop-tauri/README.md`):

```bash
cd desktop-tauri
npm install
npm run build:ui     # frontend only; `npm run dev` boots the full Tauri app
```

Engines / reference Electron fork (works today, upstream-complete):

```bash
cd desktop
npm install
npm test
npm run dev:docs     # one app; `npm run dev` runs all editors + shell
```

Web collaboration (Docker):

```bash
cd deploy
docker compose up --build
# open http://localhost:3000 — file list, click a file to edit it in Collabora
# (Collabora is on host port 9981; 9980 belongs to a pre-existing container)
```

## Licensing and branding

- `desktop/` is Apache-2.0 (upstream GenOffice). "GenOffice" and "Genspark"
  are trademarks of Mainfunc, Inc. and may not be used for this fork —
  user-facing branding has been renamed to PanOffice; the remaining
  de-branding work is tracked in `docs/ROADMAP.md` (M2).
- Collabora Online is MPL-2.0. We run it as a separate service and do not
  link it into the desktop code; any local patches to files under
  `online/` must stay MPL-2.0 and be published. "Collabora" branding is
  likewise reserved — production builds need own branding (ROADMAP M7).
- New code under `desktop-tauri/`, `server/`, `deploy/`, `docs/` is
  Apache-2.0.
