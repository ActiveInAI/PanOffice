/**
 * Token resolution: static dev tokens (WOPI_TOKENS_JSON), the legacy shared
 * dev token (gated by WOPI_ALLOW_DEV_TOKEN), and Arch-GPT JWTs (HS256 shared
 * secret or RS256 via JWKS). Produces a WopiUser with per-file permissions.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'
import { timingSafeEqual } from 'node:crypto'
import type { PermissionLevel, PermissionSpec, WopiHostConfig, WopiUser } from './config.js'
import { parsePermissionSpec } from './config.js'

export function resolvePermission(spec: PermissionSpec, fileId: string): PermissionLevel {
  if (typeof spec === 'string') return spec
  return spec[fileId] ?? spec['*'] ?? 'read'
}

export function canWrite(user: WopiUser, fileId: string): boolean {
  return resolvePermission(user.permissions, fileId) === 'read-write'
}

/** Shape we accept from Arch-GPT JWT claims. */
interface ArchGptClaims extends JWTPayload {
  name?: string
  permissions?: unknown
  wopi_permissions?: unknown
}

export class TokenResolver {
  private readonly cfg: WopiHostConfig
  private readonly hsKey: Uint8Array | null
  private readonly jwks: ReturnType<typeof createRemoteJWKSet> | null

  constructor(cfg: WopiHostConfig) {
    this.cfg = cfg
    this.hsKey = cfg.jwtSecret ? new TextEncoder().encode(cfg.jwtSecret) : null
    this.jwks = cfg.jwksUrl ? createRemoteJWKSet(new URL(cfg.jwksUrl)) : null
  }

  /** Resolve an access token to a user, or null if it is not recognised. */
  async resolve(token: string): Promise<WopiUser | null> {
    if (!token) return null

    if (this.cfg.sharedToken && sameToken(token, this.cfg.sharedToken)) {
      return { userId: 'eflow-wopi', name: 'EFlow', permissions: 'read-write' }
    }

    const dev = this.cfg.devTokens[token]
    if (dev) return { userId: dev.userId, name: dev.name, permissions: dev.permissions }

    if (this.cfg.allowDevToken && token === this.cfg.devToken) {
      return { userId: 'dev-user', name: 'Dev User', permissions: 'read-write' }
    }

    return this.resolveJwt(token)
  }

  private async resolveJwt(token: string): Promise<WopiUser | null> {
    const attempts: Array<{ key: Uint8Array | ReturnType<typeof createRemoteJWKSet>; alg: string }> = []
    if (this.hsKey) attempts.push({ key: this.hsKey, alg: 'HS256' })
    if (this.jwks) attempts.push({ key: this.jwks, alg: 'RS256' })
    for (const { key, alg } of attempts) {
      try {
        const { payload } = (await jwtVerify(token, key, {
          algorithms: [alg],
        })) as { payload: ArchGptClaims }
        const userId = typeof payload.sub === 'string' && payload.sub ? payload.sub : 'archgpt-user'
        const name = typeof payload.name === 'string' && payload.name ? payload.name : userId
        // JWT users default to read-only unless the token carries permissions.
        const permissions = parsePermissionSpec(payload.permissions ?? payload.wopi_permissions ?? 'read')
        return { userId, name, permissions }
      } catch {
        // signature/expiry/format failure on this key — try the next one
      }
    }
    return null
  }
}

function sameToken(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Tokens the dev UI may offer in its chooser (static map + shared dev token). */
export function listDevTokenChoices(cfg: WopiHostConfig): Array<{ token: string; label: string }> {
  const out: Array<{ token: string; label: string }> = []
  if (cfg.allowDevToken) {
    out.push({ token: cfg.devToken, label: `Dev User (shared ${cfg.devToken})` })
  }
  for (const [token, entry] of Object.entries(cfg.devTokens)) {
    out.push({ token, label: `${entry.name} (${entry.userId})` })
  }
  return out
}
