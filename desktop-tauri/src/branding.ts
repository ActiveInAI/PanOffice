/**
 * PanOffice brand assets (gold 16-point star, cream center).
 *
 * Usage (for the shell-home / wopi-host mounts the parent wires up):
 *   import { LOGO_SVG, LOGO_PNG_256 } from './branding'
 *   <img src={LOGO_SVG} alt="PanOffice" />            // crisp at any size
 *   <link rel="icon" href={LOGO_PNG_256} />           // favicon-ish raster
 *
 * `new URL(..., import.meta.url)` lets Vite emit the files and hand back
 * cache-busted URLs — no `?url` import suffix needed in .ts files.
 * Masters live in ../branding/ (logo-mark.svg, logo-32/128/256/512.png);
 * regenerate these copies from there, do not edit in place.
 */
export const LOGO_SVG = new URL('./assets/logo-mark.svg', import.meta.url).href
export const LOGO_PNG_256 = new URL('./assets/logo-256.png', import.meta.url).href
