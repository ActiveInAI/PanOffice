# PanOffice Drive — design (M6)

Status: design baseline (2026-08-08). M6 turns the hardened WOPI host (M5)
into **PanOffice Drive**: the file-and-sharing service that both the web
collaboration stack (Collabora over WOPI) and the Tauri desktop shell use.

## What Drive is

```
                 ┌────────────────────────────────────┐
                 │            PanOffice Drive          │
                 │  REST API (files/shares/versions)   │
                 │  WOPI endpoints (from M5 host)      │
                 └───────┬──────────────────┬─────────┘
              WOPI       │                  │  REST + sync
             ┌───────────┘                  │
     Collabora Online               PanOffice Desktop
     (web co-editing)               (Tauri; native engines)
```

One storage of record; two editing front ends. Drive owns: identity
(via Arch-GPT JWT), the file store, permissions/shares, versions, locks.
It does NOT edit documents itself.

## Scope for M6 (minimal honest slice)

1. **Users & auth**: Arch-GPT JWT on every request (the M5 token framework
   grows into this; dev tokens only behind `WOPI_ALLOW_DEV_TOKEN`).
2. **Files API** (REST, JSON):
   - `GET /v1/files` — list (paged, folder prefix)
   - `GET /v1/files/:id` / `PUT /v1/files/:id` / `DELETE /v1/files/:id`
   - `POST /v1/files` (upload, multipart or raw body)
   - `GET /v1/files/:id/versions` (+ `GET/PUT` a specific version)
   - `POST /v1/files/:id/share` — share to user or create link-share
3. **Storage abstraction** (`storage/` adapter): `LocalFsStorage` (now) →
   `S3Storage` (later); keys are opaque ids, never client-supplied paths.
4. **Sharing model**: owner / read / write; org-scope flag; link-share with
   its own token (expires). WOPI `UserId`/`OwnerId`/permissions derive from
   the share evaluation, not from the file alone.
5. **Desktop integration** (Tauri shell, later milestone wiring): "Cloud
   documents" list from Drive; open-in-Collabora as an iframe tab (live
   collab) OR download → native engine → upload new version. Lock policy:
   a WOPI-locked file is Collabora-wins; desktop never force-overwrites.
6. **WOPI evolution**: the M5 endpoints keep their shape; file ids become
   Drive ids; CheckFileInfo fields come from Drive metadata.

## Non-goals for M6

Real-time sync daemon, full-text search, trash/undelete polish, quotas,
admin console, mobile. (M8+ material.)

## Security baseline

- TLS only (behind the reverse proxy); no dev tokens in prod mode.
- JWT: Arch-GPT JWKS (RS256) when the hosted auth address is confirmed;
  HS256 shared-secret mode stays for self-host/dev.
- WOPI proof-key validation (M5) required in prod mode
  (`WOPI_PROOF_REQUIRED=true`).
- All bytes in/out go through the storage adapter with size limits and
  content-type sniffing (no executing uploads, obviously).

## Phasing

- M6a: REST files API + storage adapter + versions read-back on top of the
  M5 WOPI host codebase (`server/wopi-host` graduates → `server/drive`,
  keeping WOPI routes mounted under it).
- M6b: shares + link tokens + WOPI permission mapping.
- M6c: desktop shell "Cloud documents" section (open via Collabora tab;
  download/upload flow) + S3 adapter.
