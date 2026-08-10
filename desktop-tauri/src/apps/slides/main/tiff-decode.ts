/**
 * TIFF → PNG transcoding, ported from the Electron main process. Chromium cannot
 * decode TIFF, so pictures embedded as ppt/media/*.tif(f) would render as blank
 * placeholders. Decode with UTIF (pure JS) and re-encode as PNG for display; the
 * original TIFF bytes stay untouched in the package so saving preserves them
 * byte-for-byte.
 *
 * Port notes: upstream used pngjs's PNG.sync.write, which pulls node:zlib/stream —
 * here the PNG encoder is hand-rolled over fflate's zlibSync (the call-compatible
 * equivalent of node:zlib's deflateSync — fflate's own deflateSync is raw DEFLATE,
 * which is not a valid PNG IDAT stream; see src/bridge/node-shims/zlib.ts). The
 * layout mirrors pptx-engine's media-insert solidPng. The ported test still
 * verifies round-trip decode with pngjs (Node side).
 */
import { zlibSync } from 'fflate'
import UTIF from 'utif2'

export interface DecodedTiff {
  png: Uint8Array
  width: number
  height: number
}

// ---- minimal PNG encoder (truecolor RGBA, 8-bit, no interlace) ----

const CRC_TABLE = new Int32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c
}

function crc32(buf: Uint8Array): number {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/** Encode 8-bit RGBA pixels as a PNG (one filter-0 byte per scanline). */
export function encodePngRgba(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const ihdr = new Uint8Array(13)
  const ih = new DataView(ihdr.buffer)
  ih.setUint32(0, width)
  ih.setUint32(4, height)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  const stride = width * 4
  const raw = new Uint8Array(height * (1 + stride))
  for (let y = 0; y < height; y++) {
    raw[y * (1 + stride)] = 0
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (1 + stride) + 1)
  }
  const chunks = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlibSync(raw)),
    pngChunk('IEND', new Uint8Array(0)),
  ]
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

export function tiffToPng(bytes: Uint8Array): DecodedTiff | null {
  try {
    // utif2's types ask for ArrayBuffer|Buffer; hand it a tight ArrayBuffer view
    const ab = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer
    const ifds = UTIF.decode(ab)
    if (!ifds.length) return null
    // Multi-page/multi-resolution TIFFs: pick the largest page
    let page = ifds[0]!
    for (const ifd of ifds) {
      UTIF.decodeImage(ab, ifd)
      const cur = (ifd.width || 0) * (ifd.height || 0)
      if (cur > (page.width || 0) * (page.height || 0)) page = ifd
    }
    const width = page.width
    const height = page.height
    if (!width || !height) return null
    const rgba = UTIF.toRGBA8(page)
    return { png: encodePngRgba(width, height, rgba), width, height }
  } catch {
    return null
  }
}
