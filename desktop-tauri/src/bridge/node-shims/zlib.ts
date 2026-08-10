/**
 * Browser-build shim for the `node:zlib` import inside the source-aliased
 * @genoffice/pptx-engine (media-insert.ts deflateSync for PNG IDAT chunks).
 * Aliased in vite.config.ts only — vitest keeps the real node:zlib.
 *
 * Naming trap: Node's deflateSync/inflateSync speak the zlib (RFC 1950)
 * wrapper, while fflate's same-named functions are RAW deflate. fflate's
 * zlibSync/unzlibSync are the call-compatible equivalents.
 */
export { unzlibSync as inflateSync, zlibSync as deflateSync } from 'fflate'
