/**
 * Installs a global `Buffer` polyfill for the browser build. The source-aliased
 * @genoffice/pptx-engine (and the ported tiff-decode path) reference Node's
 * Buffer global — all call sites are inside functions, so installing the
 * polyfill before the first engine call is sufficient. The `buffer` package is
 * the standard feross implementation (Buffer extends Uint8Array, so values it
 * returns satisfy the engine's `Map<string, Uint8Array>` entries).
 *
 * No-op under Node/vitest, where a native Buffer already exists.
 */
import { Buffer } from 'buffer'

if (!('Buffer' in globalThis)) {
  ;(globalThis as { Buffer?: unknown }).Buffer = Buffer
}
