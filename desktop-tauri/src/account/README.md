# PanOffice account module (Arch-GPT JWT SSO)

Lives in `src/account/`, self-contained; the shell wires it up via `installAccount()`.

## Implemented

- `client.ts` — typed Arch-GPT auth client covering the `/v1/auth/*` surface of
  `04-backend/openapi.yaml` (v2.0.0): `loginWithPassword`, `requestLoginCode`,
  `loginWithCode`, `register`, `resetPassword`, `createQrChallenge`,
  `pollQrChallenge`, `fetchCurrentAccount` (GET /v1/auth/me), `logout`.
  Base URL is a constructor arg (default `ARCHGPT_API_BASE_URL`); the HTTP
  transport is injectable (`Transport`), so tests never mock the global fetch.
  Non-2xx responses raise `ArchGptAuthError` carrying `status` + the server's
  `errorCode` (parsed from the spec's `ErrorResponse`).
- `store.ts` — `SessionStore` abstraction + `LocalStorageSessionStore`
  (working today; key `panoffice.account.session`), change listeners
  (incl. cross-tab `storage` events), in-memory fallback outside the browser.
- `session.ts` — `AccountSessionManager`: session restore on startup (drops
  expired sessions), login helpers that persist, `refreshAccount()`
  (/v1/auth/me snapshot), best-effort server logout, and `getAiApiKey()`.
- `LoginPanel.tsx` — password / verification-code / QR sign-in UI, loading +
  error states, signed-in account card with refresh + logout. Inline styles,
  English strings (shell i18n comes later, same as the rest of the scaffold).
- `index.ts` — `installAccount(options?)` returning
  `{ client, store, session, getAiApiKey }`, plus type re-exports.

## Stubbed / TODO

- **OS keychain** — `KeychainStore` interface + TODO in `store.ts`. Plan:
  Tauri command backed by the `keyring` crate stores only the JWT once
  src-tauri compiles; metadata stays in localStorage. Swap via
  `installAccount({ store })`. src-tauri was NOT touched.
- **QR rendering** — no QR-encoding library in this package (zero new deps),
  so `LoginPanel` renders the challenge's `qrPayload` as a placeholder box.
  Drop in an encoder later; the polling/approval flow is already real.

## Integration (parent agent — src/App.tsx)

```tsx
import { installAccount, LoginPanel } from './account'

const account = installAccount() // module scope; account.getAiApiKey() feeds the archgpt provider apiKey

// inside Home(), e.g. under the heading: <LoginPanel account={account} />
```

## Open questions / spec ambiguities

- **Auth service address is UNCONFIRMED.** openapi.yaml's hosted URL
  (`api.arch_gpt.io`) is a placeholder, not a valid hostname, and nothing
  listens locally. `ARCHGPT_API_BASE_URL = 'http://127.0.0.1:7071'` reuses
  the documented local engine port as a working default — confirm the real
  auth endpoint with the Arch-GPT side, then set it per-install via
  `installAccount({ baseUrl })`.
- `QrChallengeStatus`: spec types it as a plain string; assumed lifecycle
  `pending | scanned | approved | expired | rejected` (typed as a union with
  a string fallback so unknown values still parse).
- `channel` in verification-code flows is free-form; UI offers `email`/`sms`.
- `purpose` on `/v1/auth/verification-codes` is optional; the UI sends
  `'login'` for the code sign-in flow.
- `AuthResponse.expiresInSeconds` is relative; the store derives an absolute
  `expiresAt` at login. No refresh token exists in the spec — an expired
  session means signing in again.
- `identifier` in password login is unconstrained (email or phone assumed).

## Tests

- `tests/account-client.test.ts` — real `node:http` stub server implementing
  the openapi auth paths; success + error cases (wrong password 401, expired
  code 401, logout, /v1/auth/me 401, QR create/poll incl. approval).
- `tests/account-store.test.ts` — localStorage store roundtrip/clear/listener
  and session-manager restore/expiry/`getAiApiKey`/logout (jsdom).

Run: `npx vitest run` from `desktop-tauri/`.
