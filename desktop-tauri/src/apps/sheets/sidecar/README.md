# sidecar/

`xlsx-sidecar-client.ts` — the Node stdio JSON-RPC client for the xlsx
sidecar, ported verbatim from `desktop/apps/sheets/src/main/xlsx-sidecar-client.ts`.
In the Electron app this ran in the main process; here it is used by the
vitest suites only (the webview talks to the sidecar through
`src/bridge/xlsx-rpc.ts` instead).

`src/apps/sheets/main/close-guard.ts` — the close-guard decision function,
also verbatim from upstream `src/main/close-guard.ts` (Electron-free by
design); only tests import it. The real close guard lands with the shell's
window lifecycle (TODO M3).
