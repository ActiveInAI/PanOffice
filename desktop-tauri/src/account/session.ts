/**
 * Account session manager — the bridge between Arch-GPT auth and the shell.
 *
 * `getAiApiKey()` returns the live JWT and is meant to feed the `archgpt`
 * provider's apiKey in `packages/ai-provider` settings: the AI gateway is
 * OpenAI-compatible and accepts the account token as its bearer.
 */

import {
  AuthClient,
  type AuthCodeLoginRequest,
  type AuthLoginRequest,
  type AuthMeResponse,
  type AuthResponse,
} from './client'
import { isSessionExpired, type SessionListener, type SessionStore, type StoredSession } from './store'

/** Everything the shell needs from the account module (returned by installAccount). */
export interface AccountHandles {
  client: AuthClient
  store: SessionStore
  session: AccountSessionManager
  /** JWT for the archgpt AI provider's apiKey; null when signed out or expired. */
  getAiApiKey(): string | null
}

export class AccountSessionManager {
  private current: StoredSession | null

  constructor(
    private readonly store: SessionStore,
    private readonly client: AuthClient,
  ) {
    const restored = store.load()
    if (restored && isSessionExpired(restored)) {
      store.clear()
      this.current = null
    } else {
      this.current = restored
    }
    store.onChange((session) => {
      this.current = session && !isSessionExpired(session) ? session : null
    })
  }

  /** Current session, or null when signed out / expired. */
  get session(): StoredSession | null {
    return this.current
  }

  /**
   * JWT to inject as the `archgpt` provider's apiKey in
   * packages/ai-provider settings. Null when signed out or the token expired.
   */
  getAiApiKey(): string | null {
    return this.current && !isSessionExpired(this.current) ? this.current.accessToken : null
  }

  onChange(listener: SessionListener): () => void {
    return this.store.onChange(listener)
  }

  /** Persist an AuthResponse (from any login path) as the active session. */
  applyAuth(auth: AuthResponse): StoredSession {
    const session: StoredSession = {
      accessToken: auth.accessToken,
      accountId: auth.accountId,
      tenantId: auth.tenantId,
      personId: auth.personId ?? null,
      expiresAt: Date.now() + auth.expiresInSeconds * 1000,
      account:
        this.current?.account && this.current.account.accountId === auth.accountId
          ? this.current.account
          : null,
    }
    this.store.save(session)
    return session
  }

  loginWithPassword(params: AuthLoginRequest): Promise<StoredSession> {
    return this.client.loginWithPassword(params).then((auth) => this.applyAuth(auth))
  }

  loginWithCode(params: AuthCodeLoginRequest): Promise<StoredSession> {
    return this.client.loginWithCode(params).then((auth) => this.applyAuth(auth))
  }

  /** Fetch /v1/auth/me and cache the snapshot on the session. */
  async refreshAccount(): Promise<AuthMeResponse | null> {
    if (!this.current || isSessionExpired(this.current)) return null
    const me = await this.client.fetchCurrentAccount(this.current.accessToken)
    this.store.save({ ...this.current, account: me })
    return me
  }

  /** Clear the local session, then tell the server to end the bearer session. */
  async logout(): Promise<void> {
    const token = this.current?.accessToken
    this.store.clear()
    if (token) {
      try {
        await this.client.logout(token)
      } catch {
        // Server-side logout is best-effort; the local session is already gone.
      }
    }
  }
}
