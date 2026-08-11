import { readFileSync } from 'node:fs'

/**
 * Configuration for the WOPI host: env parsing plus the token model types.
 * Kept separate from the HTTP layer so tests can inject configs directly.
 */

/** 'read' everywhere, 'read-write' everywhere, or per-file map with optional '*' fallback. */
export type PermissionLevel = 'read' | 'read-write'
export type PermissionSpec = PermissionLevel | Partial<Record<string, PermissionLevel>>

export interface WopiUser {
  userId: string
  name: string
  permissions: PermissionSpec
}

export interface DevTokenEntry {
  userId: string
  name: string
  permissions: PermissionSpec
}

export interface WopiHostConfig {
  port: number
  dataDir: string
  /** Shared dev token; honoured only when allowDevToken is true. */
  devToken: string
  allowDevToken: boolean
  /** Enable unauthenticated development file listing/upload/edit pages. */
  devUiEnabled: boolean
  /** Static dev token map (WOPI_TOKENS_JSON): token -> user. */
  devTokens: Record<string, DevTokenEntry>
  /** Owner-only shared token used by the authenticated EFlow reverse proxy. */
  sharedToken: string | null
  /** HS256 shared secret for Arch-GPT JWTs (ARCHGPT_JWT_SECRET). */
  jwtSecret: string | null
  /** JWKS endpoint for RS256 Arch-GPT JWTs (ARCHGPT_JWT_JWKS_URL). */
  jwksUrl: string | null
  /** Reject WOPI calls without a valid coolwsd proof signature. */
  proofRequired: boolean
  /** Accepted |now - X-WOPI-TimeStamp| window. */
  proofMaxSkewMs: number
  /** WOPI lock lifetime; REFRESH_LOCK extends it. */
  lockTtlMs: number
  /** Max archived versions kept per file. */
  versionCap: number
  /** Origin coolwsd uses to reach this host (goes into WOPISrc and proof URLs). */
  wopiPublicBase: string
  /** Where this host fetches coolwsd's discovery XML (urlsrc + proof keys). */
  collaboraInternalUrl: string
  /** Origin the user's browser uses for the Collabora iframe. */
  collaboraPublicUrl: string
  /** Base URL of the PanOffice web shell (Tauri frontend); PDFs open there, not in Collabora. */
  pdfAppUrl: string
  /** Origin allowed to call WOPI endpoints cross-origin (the web shell). */
  pdfAppOrigin: string
  /** Directory of the prebuilt PanOffice web shell (served at `/`). */
  shellDir: string | null
  /** Loopback-only XLSX RPC endpoint proxied to the same-origin web shell. */
  xlsxRpcUrl: string | null
  /** Loopback-only OpenAI-compatible bridge used by the server-managed PanAI route. */
  panAiBridgeUrl: string | null
  /** Server-only bearer token loaded from a systemd credential file. */
  panAiBridgeToken: string | null
  /** Model id forced by the server for every PanAI turn. */
  panAiModel: string
}

function isPermissionLevel(v: unknown): v is PermissionLevel {
  return v === 'read' || v === 'read-write'
}

export function parsePermissionSpec(v: unknown): PermissionSpec {
  if (isPermissionLevel(v)) return v
  if (v && typeof v === 'object') {
    const out: Partial<Record<string, PermissionLevel>> = {}
    for (const [k, level] of Object.entries(v as Record<string, unknown>)) {
      if (isPermissionLevel(level)) out[k] = level
    }
    return out
  }
  // Dev-friendly default: anything unparseable means full access.
  return 'read-write'
}

export function parseDevTokens(json: string | undefined): Record<string, DevTokenEntry> {
  if (!json) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (err) {
    throw new Error(`WOPI_TOKENS_JSON is not valid JSON: ${(err as Error).message}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('WOPI_TOKENS_JSON must be an object mapping token -> {userId, name, permissions}')
  }
  const out: Record<string, DevTokenEntry> = {}
  for (const [token, entry] of Object.entries(parsed as Record<string, unknown>)) {
    const e = (entry ?? {}) as Record<string, unknown>
    out[token] = {
      userId: typeof e.userId === 'string' && e.userId ? e.userId : 'dev-user',
      name: typeof e.name === 'string' && e.name ? e.name : 'Dev User',
      permissions: parsePermissionSpec(e.permissions),
    }
  }
  return out
}

function envBool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === '') return fallback
  return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes'
}

function stripSlashes(url: string): string {
  return url.replace(/\/+$/, '')
}

function parseLoopbackHttpUrl(value: string | undefined, envName: string): string | null {
  if (!value?.trim()) return null
  const normalized = stripSlashes(value.trim())
  const parsed = new URL(normalized)
  if (
    parsed.protocol !== 'http:' ||
    !new Set(['127.0.0.1', 'localhost', '[::1]']).has(parsed.hostname)
  ) {
    throw new Error(`${envName} must be an http:// loopback URL`)
  }
  return normalized
}

function readTokenFile(path: string | undefined, envName: string): string | null {
  if (!path?.trim()) return null
  const tokenPath = path.trim()
  if (!tokenPath.startsWith('/')) throw new Error(`${envName} must be an absolute path`)
  const token = readFileSync(tokenPath, 'utf8').trim()
  if (token.length < 32 || token.length > 512 || /[\x00-\x1f\x7f]/.test(token)) {
    throw new Error(`${envName} is invalid`)
  }
  return token
}

function parsePanAiModel(value: string | undefined): string {
  const model = value?.trim() || 'gpt-5.6-sol'
  if (!/^[A-Za-z0-9._:/-]{1,128}$/.test(model)) throw new Error('PANAI_MODEL is invalid')
  return model
}

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WopiHostConfig {
  const port = Number(env.PORT ?? 3000)
  return {
    port,
    dataDir: env.DATA_DIR ?? './data/files',
    devToken: env.WOPI_TOKEN ?? 'devtoken',
    allowDevToken: envBool(env.WOPI_ALLOW_DEV_TOKEN, false),
    devUiEnabled: envBool(env.WOPI_DEV_UI_ENABLED, false),
    devTokens: parseDevTokens(env.WOPI_TOKENS_JSON),
    sharedToken: readTokenFile(env.WOPI_SHARED_TOKEN_FILE, 'WOPI_SHARED_TOKEN_FILE'),
    jwtSecret: env.ARCHGPT_JWT_SECRET || null,
    jwksUrl: env.ARCHGPT_JWT_JWKS_URL || null,
    proofRequired: envBool(env.WOPI_PROOF_REQUIRED, false),
    proofMaxSkewMs: Number(env.WOPI_PROOF_MAX_SKEW_MS ?? 10 * 60 * 1000),
    lockTtlMs: Number(env.WOPI_LOCK_TTL_MINUTES ?? 30) * 60 * 1000,
    versionCap: Number(env.WOPI_VERSION_CAP ?? 10),
    wopiPublicBase: stripSlashes(env.WOPI_PUBLIC_BASE ?? `http://localhost:${port}`),
    collaboraInternalUrl: stripSlashes(env.COLLABORA_INTERNAL_URL ?? 'http://localhost:9980'),
    collaboraPublicUrl: stripSlashes(env.COLLABORA_PUBLIC_URL ?? env.COLLABORA_INTERNAL_URL ?? 'http://localhost:9980'),
    pdfAppUrl: stripSlashes(env.PDF_APP_URL ?? 'http://localhost:4180'),
    pdfAppOrigin: stripSlashes(env.PDF_APP_ORIGIN ?? env.PDF_APP_URL ?? 'http://localhost:4180'),
    shellDir: env.SHELL_DIR?.trim() ? env.SHELL_DIR.trim() : null,
    xlsxRpcUrl: parseLoopbackHttpUrl(env.XLSX_RPC_URL, 'XLSX_RPC_URL'),
    panAiBridgeUrl: parseLoopbackHttpUrl(env.PANAI_BRIDGE_URL, 'PANAI_BRIDGE_URL'),
    panAiBridgeToken: readTokenFile(env.PANAI_BRIDGE_TOKEN_FILE, 'PANAI_BRIDGE_TOKEN_FILE'),
    panAiModel: parsePanAiModel(env.PANAI_MODEL),
  }
}
