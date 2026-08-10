/**
 * CFB (OLE2 compound document) sniffing: legacy .ppt and encrypted OOXML (password-protected pptx) share the same magic number.
 * The latter has an EncryptedPackage stream in its directory (stream name in UTF-16LE), which is used to pick the message shown.
 *
 * Ported from the Electron main process: typed on Uint8Array instead of Node Buffer
 * (Buffer arguments still satisfy the signatures — Buffer extends Uint8Array).
 */
const CFB_MAGIC = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

function utf16leBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length * 2)
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    out[i * 2] = code & 0xff
    out[i * 2 + 1] = code >>> 8
  }
  return out
}
const ENCRYPTED_STREAM_UTF16 = utf16leBytes('EncryptedPackage')

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false
  for (let i = 0; i < prefix.length; i++) if (bytes[i] !== prefix[i]) return false
  return true
}

function includes(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer
    return true
  }
  return false
}

export function isCfbHeader(head: Uint8Array): boolean {
  return head.length >= 8 && startsWith(head.subarray(0, 8), CFB_MAGIC)
}

export function cfbKind(bytes: Uint8Array): 'legacy' | 'encrypted' | null {
  if (!isCfbHeader(bytes)) return null
  return includes(bytes, ENCRYPTED_STREAM_UTF16) ? 'encrypted' : 'legacy'
}
