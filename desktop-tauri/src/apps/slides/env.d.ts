/** bidi-js has no types (pptx-render sources are compiled into this project via paths aliases; its bundled d.ts does not come along) */
declare module 'bidi-js' {
  interface BidiApi {
    getEmbeddingLevels(
      text: string,
      explicitDirection?: 'ltr' | 'rtl',
    ): { levels: Uint8Array; paragraphs: Array<{ start: number; end: number; level: number }> }
  }
  export default function bidiFactory(): BidiApi
}

/** harfbuzzjs low-level Emscripten factory (deep-path import; the package entry has a top-level await we don't want in the bundle) */
declare module '*/harfbuzzjs/dist/harfbuzz.js' {
  function createHarfBuzz(moduleArg?: Record<string, unknown>): Promise<unknown>
  export default createHarfBuzz
}
