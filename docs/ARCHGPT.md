# Arch-GPT integration notes

Decision (2026-08-06): PanOffice's **account system and AI capabilities use
Arch-GPT** (the in-house AEC AI platform), replacing the upstream Genspark
account/proxy. Facts below were inventoried from the local Arch-GPT
checkout; confirm against the live deployment before relying on them.

## Where Arch-GPT lives (this machine)

- Main repo: `~/actions-runner/_work/arch-gpt/arch-gpt/` — "Arch-GPT · AEC
  AI-Native CDE Workflow OS" v2.1.0 (Rust `harness-core` backend + Next.js
  frontend + Python workers), checked out by the self-hosted GitHub runner.
- API spec: `04-backend/openapi.yaml` ("Arch-GPT API" v2.0.0).
- Nothing Arch-GPT server-side is currently running locally (no listeners
  on 7071/8790).

## AI (LLM) integration — what PanOffice uses

Arch-GPT exposes **OpenAI-compatible** endpoints; all PanOffice model
traffic goes there:

- Local engine endpoint: `POST http://127.0.0.1:7071/v1/chat/completions`
  (FastAPI `06-workers/engine_server.py`; `GET /v1/models` lists available
  models; loopback-bound, no token).
- Alternative: CLI bridge on `:8790` (env `ARCH_GPT_CLI_BRIDGE_PORT`,
  bearer `ARCH_GPT_CLI_BRIDGE_TOKEN`).
- Rust `harness-core` `InferenceRouter` routes to vLLM / Ollama / LMDeploy /
  hosted providers, all via OpenAI-compatible adapters.

Code state: `desktop/packages/ai-provider` now has an **`archgpt` provider
and it is the default** (`ARCHGPT_DEFAULT_BASE_URL = http://127.0.0.1:7071/v1`,
overridable per-install via the provider's Base URL setting; model id is
entered/listed dynamically). Chat + streaming/tool-calling both route
through the OpenAI-compatible implementation. The legacy `genspark`
provider entry still exists but is no longer the default; removing it (and
the gsk sign-in flow) is ROADMAP M2.

## Account (SSO) integration — design

From `04-backend/openapi.yaml` (global `bearerAuth` = JWT):

- `POST /v1/auth/register`, `POST /v1/auth/login`,
  `POST /v1/auth/login/code` (verification-code login),
  `POST /v1/auth/verification-codes`, `POST /v1/auth/password/reset`
- QR-code login flow: `/v1/auth/qr/challenges` (create/poll/scan/approve)
- Current-account endpoint (GET, bearer) for the shell's account UI.

Planned shape (ROADMAP M2): an `archgpt-account` client used by the Tauri
shell — login UI (password / code / QR), JWT stored in the OS keychain
(`tauri-plugin-store` or keyring crate), token injected as the AI
provider's API key, and reused for PanOffice Drive auth. The desktop no
longer signs into any Genspark service.

## Decisions (2026-08-06, delegated to the dev agent)

- **LLM gateway address**: default stays the local endpoint
  `http://127.0.0.1:7071/v1` (`ARCHGPT_DEFAULT_BASE_URL` in
  `desktop/packages/ai-provider/src/providers.ts`). No hosted URL is
  hardcoded anywhere — the openapi.yaml `api.arch_gpt.io` value is a
  placeholder and not a valid hostname. When a production gateway is
  deployed, it is configured per-install via the provider's Base URL
  setting (or a one-line change of the constant). 
- Model id is user-entered / later listed from `GET /v1/models`.

## Open questions (need the Arch-GPT side to confirm)

- Which models the gateway exposes for office workloads (`/v1/models`).
- Whether WOPI host / Drive should validate JWTs issued by Arch-GPT auth
  directly (shared secret / JWKS) — decide at M5.
