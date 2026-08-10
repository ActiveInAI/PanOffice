# xlsx-engine (PanOffice port)

Rust sidecar for the sheets app: calamine (read) + IronCalc (recalc) behind a
newline-delimited JSON-RPC protocol over stdio (`{version, requestId, command, ...}`;
commands: `open`, `read_range`, `read_formula_cells`, `read_media`,
`recalc_cells`, `convert_workbook`, `archive_manifest`, `read_entries`,
`scan_entries`, `save_archive`, `close`).

## Provenance

Copied verbatim (minus `target/`) from the GenOffice Electron repo
`desktop/apps/sheets/native/xlsx-engine/` on 2026-08-07. It has zero Electron
coupling; PanOffice owns this component going forward. Keep the crates in
`Cargo.toml` in sync with upstream only deliberately.

## Build

```sh
cargo build --release --manifest-path native/xlsx-engine/Cargo.toml
# binary: native/xlsx-engine/target/release/xlsx-sidecar
```

The Tauri shell spawns it from Rust (`xlsx_rpc` command, `src-tauri/`); the
browser dev mode reaches it through `tools/xlsx-sidecar-server.mjs`.
`XLSX_SIDECAR_PATH` overrides the binary location for both.
