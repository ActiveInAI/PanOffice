/**
 * Arch-GPT auth client (JWT SSO) for the PanOffice shell.
 *
 * Implements the `/v1/auth/*` surface from the Arch-GPT API spec
 * (04-backend/openapi.yaml, "Arch-GPT API" v2.0.0):
 *   POST /v1/auth/login                  password sign-in
 *   POST /v1/auth/login/code             verification-code sign-in
 *   POST /v1/auth/verification-codes     issue a verification code
 *   POST /v1/auth/register               register account + initial tenant
 *   POST /v1/auth/password/reset         reset password with a code
 *   POST /v1/auth/qr/challenges          create a QR sign-in challenge
 *   GET  /v1/auth/qr/challenges/{id}     poll a QR challenge (?pollToken=)
 *   GET  /v1/auth/me                     current bearer-token account
 *   POST /v1/auth/logout                 end the bearer session
 *
 * The transport is injectable (constructor arg) so tests can run against a
 * real node:http stub server without mocking the global fetch.
 */

/**
 * Default Arch-GPT API base URL.
 *
 * NOTE: the auth-service port is UNCONFIRMED. The hosted URL in openapi.yaml
 * (`api.arch_gpt.io`) is a placeholder and not a valid hostname, and no
 * Arch-GPT server is listening locally yet. 7071 is the local engine port
 * documented in docs/ARCHGPT.md and is used here only as a working default;
 * override per-install via `installAccount({ baseUrl })`.
 */
export const ARCHGPT_API_BASE_URL = 'http://127.0.0.1:7071'

/** Minimal fetch-compatible transport; injectable for tests. */
export type Transport = (input: string, init?: RequestInit) => Promise<Response>

// ---------------------------------------------------------------------------
// Schema types (mirroring openapi.yaml components/schemas)
// ---------------------------------------------------------------------------

/**
 * QR challenge status. The spec types this as a plain string without an enum;
 * the values below are the assumed lifecycle (pending -> scanned -> approved,
 * terminal: expired/rejected) — confirm against the live service.
 */
export type QrChallengeStatus =
  | 'pending'
  | 'scanned'
  | 'approved'
  | 'expired'
  | 'rejected'
  | (string & {})

/** AuthResponse — returned by login, login/code, register, and QR approval. */
export interface AuthResponse {
  accountId: string
  tenantId: string
  personId: string | null
  /** JWT bearer token. */
  accessToken: string
  /** Relative lifetime of `accessToken` (no absolute expiry is returned). */
  expiresInSeconds: number
  runtimeRoles: string[]
}

/** AuthMeResponse — GET /v1/auth/me. */
export interface AuthMeResponse {
  accountId: string
  tenantId: string
  personId: string | null
  email: string | null
  phone: string | null
  fullName: string | null
  displayName: string | null
  runtimeRoles: string[]
  jobTitles: string[]
}

/** AuthVerificationCodeRequest. `channel` is a free-form string ('email' / 'sms' assumed). */
export interface AuthVerificationCodeRequest {
  channel: string
  destination: string
  purpose?: string | null
}

/** AuthVerificationCodeResponse. */
export interface AuthVerificationCodeResponse {
  channel: string
  destination: string
  purpose: string
  expiresInSeconds: number
  deliveryStatus: string
  /** Development-only code; omitted outside the configured debug flow. */
  debugCode?: string
}

/** AuthLoginRequest. `identifier` is email or phone (spec does not constrain it). */
export interface AuthLoginRequest {
  identifier: string
  password: string
  tenantId?: string | null
}

/** AuthCodeLoginRequest. */
export interface AuthCodeLoginRequest {
  channel: string
  destination: string
  verificationCode: string
  tenantId?: string | null
}

/** AuthRegisterRequest. */
export interface AuthRegisterRequest {
  tenantName: string
  fullName: string
  email?: string | null
  phone?: string | null
  password: string
  verificationChannel: string
  verificationCode: string
  jobTitle?: string | null
}

/** AuthPasswordResetRequest. */
export interface AuthPasswordResetRequest {
  channel: string
  destination: string
  verificationCode: string
  password: string
}

/** AuthQrCreateRequest (all fields optional per spec). */
export interface AuthQrCreateRequest {
  accountType?: string | null
  returnTo?: string | null
}

/** AuthQrChallengeResponse. `qrPayload` is the content to encode as a QR image. */
export interface AuthQrChallengeResponse {
  challengeId: string
  qrPayload: string
  pollToken: string
  status: QrChallengeStatus
  expiresInSeconds: number
}

/** AuthQrPollResponse. `auth` is present once the challenge is approved. */
export interface AuthQrPollResponse {
  challengeId: string
  status: QrChallengeStatus
  expiresInSeconds: number
  auth?: AuthResponse
}

/** ErrorResponse — common error body for all auth endpoints. */
export interface AuthErrorResponse {
  error: string
  code: number
  errorCode?: string
  message?: string
  /** Present only in an explicit development runtime profile. */
  detail?: string
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Error thrown for any non-2xx auth API response. */
export class ArchGptAuthError extends Error {
  readonly status: number
  /** Machine-readable `errorCode` from ErrorResponse, when the server sent one. */
  readonly errorCode: string | null

  constructor(status: number, errorCode: string | null, message: string) {
    super(message)
    this.name = 'ArchGptAuthError'
    this.status = status
    this.errorCode = errorCode
  }
}

async function toAuthError(res: Response): Promise<ArchGptAuthError> {
  let body: Partial<AuthErrorResponse> | null = null
  try {
    body = (await res.json()) as Partial<AuthErrorResponse>
  } catch {
    // Non-JSON error body (proxy failure, HTML error page, ...) — fall through.
  }
  const message =
    body?.message ?? body?.error ?? `Arch-GPT auth request failed with HTTP ${res.status}`
  return new ArchGptAuthError(res.status, body?.errorCode ?? null, message)
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class AuthClient {
  private readonly baseUrl: string
  private readonly transport: Transport

  constructor(baseUrl: string = ARCHGPT_API_BASE_URL, transport?: Transport) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.transport = transport ?? ((input, init) => fetch(input, init))
  }

  /** POST /v1/auth/login — sign in with identifier (email/phone) + password. */
  loginWithPassword(params: AuthLoginRequest): Promise<AuthResponse> {
    return this.request('POST', '/v1/auth/login', { body: params })
  }

  /** POST /v1/auth/verification-codes — issue a code (use purpose 'login' for code sign-in). */
  requestLoginCode(params: AuthVerificationCodeRequest): Promise<AuthVerificationCodeResponse> {
    return this.request('POST', '/v1/auth/verification-codes', { body: params })
  }

  /** POST /v1/auth/login/code — sign in with a verification code. */
  loginWithCode(params: AuthCodeLoginRequest): Promise<AuthResponse> {
    return this.request('POST', '/v1/auth/login/code', { body: params })
  }

  /** POST /v1/auth/register — register an account and initial tenant. */
  register(params: AuthRegisterRequest): Promise<AuthResponse> {
    return this.request('POST', '/v1/auth/register', { body: params })
  }

  /** POST /v1/auth/password/reset — 204 on success. */
  async resetPassword(params: AuthPasswordResetRequest): Promise<void> {
    await this.request('POST', '/v1/auth/password/reset', { body: params })
  }

  /** POST /v1/auth/qr/challenges — create a QR sign-in challenge. */
  createQrChallenge(params: AuthQrCreateRequest = {}): Promise<AuthQrChallengeResponse> {
    return this.request('POST', '/v1/auth/qr/challenges', { body: params })
  }

  /** GET /v1/auth/qr/challenges/{id}?pollToken=... — poll until approved/expired. */
  pollQrChallenge(challengeId: string, pollToken: string): Promise<AuthQrPollResponse> {
    return this.request('GET', `/v1/auth/qr/challenges/${encodeURIComponent(challengeId)}`, {
      query: { pollToken },
    })
  }

  /** GET /v1/auth/me — current bearer-token account. Throws ArchGptAuthError(401) if expired. */
  fetchCurrentAccount(accessToken: string): Promise<AuthMeResponse> {
    return this.request('GET', '/v1/auth/me', { token: accessToken })
  }

  /** POST /v1/auth/logout — end the bearer session. Resolves `loggedOut`. */
  async logout(accessToken: string): Promise<boolean> {
    const res = await this.request<{ loggedOut: boolean }>('POST', '/v1/auth/logout', {
      token: accessToken,
    })
    return res.loggedOut
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    options: { token?: string; body?: unknown; query?: Record<string, string> } = {},
  ): Promise<T> {
    const url = new URL(this.baseUrl + path)
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        url.searchParams.set(key, value)
      }
    }
    const headers: Record<string, string> = {}
    if (options.body !== undefined) headers['Content-Type'] = 'application/json'
    if (options.token) headers.Authorization = `Bearer ${options.token}`

    const res = await this.transport(url.toString(), {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
    if (!res.ok) throw await toAuthError(res)
    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  }
}
