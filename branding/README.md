# PanOffice branding assets

Master mark: gold 16-point star (`#f4c542`) with cream center (`#fff1bf`),
96×96 viewBox, transparent background.

## Inventory

| File | What | Consumed by |
|---|---|---|
| `logo-mark.svg` | Master vector logo | Copied to `desktop-tauri/src/assets/logo-mark.svg` (shell UI via `src/branding.ts`) and rendered into everything below |
| `logo-32.png` / `logo-128.png` / `logo-256.png` / `logo-512.png` | Pre-rendered transparent rasters | `logo-256.png` → `desktop-tauri/src/assets/`; all sizes feed `make-icons.py` |
| `icon.ico` | Multi-size Windows icon (16/24/32 baked in) | Copied verbatim to `desktop-tauri/src-tauri/icons/icon.ico` |
| `make-icons.py` | Icon-kit generator (PIL, LANCZOS downscale from `logo-512.png`) | Writes `desktop-tauri/src-tauri/icons/` |

## Regenerate

```sh
# Tauri icon kit (icon.png 512, 32x32, 128x128, 128x128@2x, icon.ico,
# Square{30..310}Logo.png, StoreLogo.png) -> desktop-tauri/src-tauri/icons/
~/.venvs/ai/bin/python branding/make-icons.py
```

`desktop-tauri/src-tauri/tauri.conf.json` references the kit in `bundle.icon`;
`bundle.active` stays `false` until we ship — **no `icon.icns` yet** (needs a
macOS pass or `png2icns`; add it to `bundle.icon` when produced).

## Where else the mark is applied

- **Desktop shell (Vite)**: `desktop-tauri/src/branding.ts` exports
  `LOGO_SVG` / `LOGO_PNG_256` as typed, cache-busted URLs
  (`new URL('./assets/...', import.meta.url).href`).
- **Collabora Online fork** (`~/panspace/online`): served at
  `/browser/<hash>/images/logo-panoffice.svg`; wired via `coolwsd.xml`
  `user_interface.logoURL` + `brandProductName=PanOffice` and
  `browser/dist/branding.css` (source copy: `browser/branding/branding.css`).
- **Proof screenshots**: `docs/screenshots/collabora-edit-panoffice.png`,
  `docs/screenshots/collabora-about-panoffice.png`
  (regenerate: `cd desktop-tauri && node tools/brand-shot.mjs`).

## Usage note for shell-home / wopi-host mounts (parent task)

```ts
import { LOGO_SVG, LOGO_PNG_256 } from '../branding'   // adjust relative depth
// <img src={LOGO_SVG} alt="PanOffice" /> — crisp at any size, transparent bg.
// Prefer LOGO_SVG for headers/login; LOGO_PNG_256 only where raster is required
// (favicon, OG tags). Do not recolor; on dark backgrounds keep the cream core.
```
