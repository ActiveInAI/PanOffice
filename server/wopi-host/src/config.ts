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
  /** Static dev token map (WOPI_TOKENS_JSON): token -> user. */
  devTokens: Record<string, DevTokenEntry>
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

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WopiHostConfig {
  const port = Number(env.PORT ?? 3000)
  return {
    port,
    dataDir: env.DATA_DIR ?? './data/files',
    devToken: env.WOPI_TOKEN ?? 'devtoken',
    allowDevToken: envBool(env.WOPI_ALLOW_DEV_TOKEN, false),
    devTokens: parseDevTokens(env.WOPI_TOKENS_JSON),
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
  }
}
