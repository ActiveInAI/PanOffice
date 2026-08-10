# @panoffice/wopi-host

WOPI host bridging Collabora Online (`coolwsd`) to a local directory of
office files. M5 hardening landed: per-user tokens (dev map / Arch-GPT JWT),
WOPI locks persisted across restarts, version archiving, and optional
coolwsd proof-key validation. Still **localhost/dev unless you enable proof
keys and put TLS in front**. See
[`../../docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) §2.4.

## How it works

1. Browser opens `GET /edit/<file>` on this host.
2. The host fetches coolwsd's discovery (`/hosting/discovery`), picks the
   `urlsrc` for the file extension, and serves a page whose iframe points
   at coolwsd with `WOPISrc` pointing back here.
3. coolwsd calls back the WOPI endpoints below to load, lock, and save the
   file.

## Endpoints

| Route | WOPI op |
| --- | --- |
| `GET /wopi/files/:id` | CheckFileInfo (`UserCanWrite`, `SupportsLocks`, `SupportsGetLock`, `Version`, `CurrentVersion`) |
| `GET /wopi/files/:id/contents` | GetFile (answers `X-WOPI-ItemVersion`) |
| `POST /wopi/files/:id/contents` | PutFile (archives previous bytes; `X-WOPI-ItemVersion` in response; 409 + `X-WOPI-Lock` if locked by another token) |
| `POST /wopi/files/:id` + `X-WOPI-Override: LOCK` | Lock; 409 + `X-WOPI-Lock` on foreign lock |
| `POST /wopi/files/:id` + `X-WOPI-Override: UNLOCK` | Unlock (needs matching `X-WOPI-Lock`) |
| `POST /wopi/files/:id` + `X-WOPI-Override: REFRESH_LOCK` | Extend lock to now + TTL |
| `POST /wopi/files/:id` + `X-WOPI-Override: GET_LOCK` | Current lock token in `X-WOPI-Lock` (empty when unlocked) |
| `GET /wopi/files/:id/versions` | JSON `{ fileId, currentVersion, versions: [{versionId, size, archivedAt}] }` (newest first, archives only) |
| `GET /` | dev index page (file list + edit links + token chooser when several dev tokens exist) |
| `GET /edit/:id` | dev page iframing Collabora (`?token=` overrides the embedded token) |
| `GET /healthz` | liveness |

All `/wopi/*` routes require a valid token via `?access_token=` or
`Authorization: Bearer`.

### Locks

In-memory map persisted to `<DATA_DIR>/.wopi-locks.json` (atomic rewrite on
every change), so locks survive restarts. A lock expires `WOPI_LOCK_TTL_MINUTES`
(default 30) after its last `LOCK`/`REFRESH_LOCK`. `LOCK` with the same token
is an idempotent success (and refresh); with a different token it is a 409
carrying the current token in `X-WOPI-Lock`. `UNLOCK`/`REFRESH_LOCK` on a
missing or foreign lock answer 409. Deviation from strict spec: `PutFile` on
an *unlocked* file is allowed (dev leniency); only a foreign-held lock 409s.

### Versions

Every successful PutFile first copies the previous bytes to
`<DATA_DIR>/.versions/<file>/<versionId>` (`versionId` = the mtime-based id
`CheckFileInfo.Version` reports), then prunes to the newest
`WOPI_VERSION_CAP` (default 10) archives per file. The live file's id is
reported as `Version`/`CurrentVersion` in CheckFileInfo and as
`currentVersion` by the versions endpoint.

### Proof keys

When `WOPI_PROOF_REQUIRED=true`, every WOPI call must carry valid
`X-WOPI-Proof` / `X-WOPI-ProofOld` / `X-WOPI-TimeStamp` headers: RSASSA-PKCS1-v1_5
+ SHA-256 over `len32(url.toUpperCase()) ‖ url ‖ len32(token) ‖ token ‖
u64be(timestamp)`, verified against the `modulus`/`exponent` (and
`oldmodulus`/`oldexponent`, for rotation) of the `<proof-key>` element in
coolwsd's discovery XML. Timestamps are Windows FILETIME; ±10 min skew is
tolerated (`WOPI_PROOF_MAX_SKEW_MS` to change). Note: the stock
source-built coolwsd only emits `<proof-key>` when proof key generation is
enabled in `coolwsd.xml`; with it disabled the validator cannot pass
(fail-closed 401).

## Configuration (env)

| Var | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | listen port |
| `DATA_DIR` | `./data/files` | directory holding the office files |
| `WOPI_TOKEN` | `devtoken` | shared dev token — honoured **only** when `WOPI_ALLOW_DEV_TOKEN=true` |
| `WOPI_ALLOW_DEV_TOKEN` | `false` | enable the shared dev token |
| `WOPI_TOKENS_JSON` | — | JSON map `token -> {userId, name, permissions}` of static dev tokens |
| `ARCHGPT_JWT_SECRET` | — | HS256 shared secret for Arch-GPT JWTs |
| `ARCHGPT_JWT_JWKS_URL` | — | JWKS URL for RS256 Arch-GPT JWTs |
| `WOPI_PROOF_REQUIRED` | `false` | require coolwsd proof signatures on `/wopi/*` |
| `WOPI_PROOF_MAX_SKEW_MS` | `600000` | accepted `X-WOPI-TimeStamp` skew |
| `WOPI_LOCK_TTL_MINUTES` | `30` | lock lifetime (REFRESH_LOCK extends) |
| `WOPI_VERSION_CAP` | `10` | archived versions kept per file |
| `WOPI_PUBLIC_BASE` | `http://localhost:$PORT` | origin **coolwsd** uses to reach this host (WOPISrc + proof URL) |
| `COLLABORA_INTERNAL_URL` | `http://localhost:9980` | where **this host** fetches discovery |
| `COLLABORA_PUBLIC_URL` | = internal | origin the **browser** uses for the Collabora iframe |
| `PDF_APP_URL` | `http://localhost:4180` | base URL of the PanOffice web shell; `.pdf` files on the index page link there (`edit in PanOffice PDF`), not to Collabora |
| `PDF_APP_ORIGIN` | = `PDF_APP_URL` | origin allowed cross-origin on `/wopi/*` (CORS) for the web PDF editor |

### Web-side PDF editing

The dev index routes `.pdf` files to the PanOffice web editor (the Tauri
frontend's `#/pdf` route) instead of Collabora's view-only Draw: the link
embeds a `src` URL pointing back at `GET /wopi/files/:id/contents`; the
editor loads over CORS and saves with a POST to the same URL, so edits land
on this host's disk (versions/locks apply as usual). Collabora only offers
`view_comment` for PDF — our editor is the one with real editing
(annotations, forms, stamps, signatures, page ops).

`permissions` is either `"read"` / `"read-write"` for all files, or a
per-file map with optional `"*"` fallback, e.g.
`{"*": "read", "simple.docx": "read-write"}` (missing entry ⇒ `read`).
JWT claims: `sub` → userId, `name` → display name, `permissions` (or
`wopi_permissions`) → same shape; JWT users default to **read-only** when no
claim is present. Read-only users get `UserCanWrite: false` and 403 on
PutFile/LOCK/UNLOCK/REFRESH_LOCK.

Example dev setup with two users:

```bash
WOPI_TOKENS_JSON='{"tok-alice":{"userId":"alice","name":"Alice","permissions":"read-write"},"tok-bob":{"userId":"bob","name":"Bob","permissions":{"*":"read"}}}' \
WOPI_ALLOW_DEV_TOKEN=true npm run dev
```

## Run

```bash
npm install
npm run build
npm start                 # or: npm run dev
# drop .docx/.xlsx/.pptx files into ./data/files, open http://localhost:3000
```

## Test

```bash
npm test                  # vitest: locks matrix, versions, proof keys, JWT, permissions
```
