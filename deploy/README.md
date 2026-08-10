# PanOffice web-collaboration stack (dev)

Brings up Collabora Online (`collabora/code`) plus the PanOffice WOPI host
(`../server/wopi-host`) so office files in `./data/files` can be edited in
a browser with real-time multi-user collaboration.

```bash
docker compose up --build
# then open http://localhost:3000 and click "edit in Collabora"
```

- Drop `.docx` / `.xlsx` / `.pptx` (and ODF) files into `./data/files/`.
- Open the same edit link in two browser windows to see live co-editing.
- Collabora admin console: http://localhost:9981/browser/dist/admin/admin.html
  (user `admin`, password from `COLLABORA_ADMIN_PASSWORD`, default
  `panoffice-dev`). Note the host port is **9981** because 9980 is already
  bound by a pre-existing `collabora-code` container on this machine.

## How the pieces see each other

| Who calls | URL used | Set by |
| --- | --- | --- |
| browser → wopi-host index | `http://localhost:3000` | port mapping |
| browser → coolwsd iframe | `http://localhost:9981` | `COLLABORA_PUBLIC_URL` |
| wopi-host → discovery | `http://collabora:9980/hosting/discovery` | `COLLABORA_INTERNAL_URL` |
| coolwsd → WOPI callbacks | `http://wopi-host:3000/wopi/...` | `WOPI_PUBLIC_BASE` (+ `aliasgroup1` allowlist) |

## Warnings

- **Dev only.** The WOPI host uses one shared token (`WOPI_TOKEN`, default
  `devtoken`), no TLS, no lock ops. Do not expose either port beyond
  localhost (the compose file binds to 127.0.0.1 on purpose).
- The `collabora/code` image is the development edition (CODE) with
  Collabora branding — see `../docs/ROADMAP.md` M4 before shipping.
