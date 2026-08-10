/**
 * Account session storage for the PanOffice shell.
 *
 * Working today: `LocalStorageSessionStore`, persisting the session under
 * `panoffice.account.*` keys in localStorage.
 *
 * Planned (ROADMAP M2): an OS-keychain-backed store via a Tauri command
 * (keyring crate) — see `KeychainStore` below. Not wired yet because the
 * Rust side of the shell does not compile; do NOT touch src-tauri from here.
 */

import type { AuthMeResponse } from './client'

/** localStorage key prefix for everything account-related. */
export const ACCOUNT_STORAGE_PREFIX = 'panoffice.account.'

const SESSION_KEY = `${ACCOUNT_STORAGE_PREFIX}session`

/** Persisted Arch-GPT session (derived from AuthResponse + a /v1/auth/me snapshot). */
export interface StoredSession {
  /** JWT bearer token; doubles as the archgpt AI provider's apiKey. */
  accessToken: string
  accountId: string
  tenantId: string
  personId: string | null
  /** Absolute expiry (epoch ms), derived from `expiresInSeconds` at login time. */
  expiresAt: number
  /** Last fetched /v1/auth/me snapshot; null until `refreshAccount()` succeeds. */
  account: AuthMeResponse | null
}

export type SessionListener = (session: StoredSession | null) => void

/** Storage abstraction for the account session. */
export interface SessionStore {
  load(): StoredSession | null
  save(session: StoredSession): void
  clear(): void
  /** Subscribe to session changes (including cross-tab `storage` events). Returns an unsubscribe. */
  onChange(listener: SessionListener): () => void
}

/**
 * TODO(keychain): OS keychain backend, to be implemented once src-tauri
 * compiles. Plan: a Rust command (`account_set_token` / `account_get_token` /
 * `account_clear_token`) backed by the `keyring` crate stores ONLY the JWT;
 * the non-secret session metadata can stay in localStorage. The async shape
 * below matches `invoke(...)` from @tauri-apps/api. Swap it in via
 * `installAccount({ store })` — no other call sites change.
 */
export interface KeychainStore {
  loadToken(): Promise<string | null>
  saveToken(token: string): Promise<void>
  clearToken(): Promise<void>
}

export function isSessionExpired(session: StoredSession, now: number = Date.now()): boolean {
  return session.expiresAt <= now
}

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** In-memory shim used when no Web Storage is available (e.g. plain node). */
function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, String(value)),
  }
}

/** localStorage-backed session store — the working default in the browser shell. */
export class LocalStorageSessionStore implements SessionStore {
  private readonly storage: Storage
  private readonly listeners = new Set<SessionListener>()
  private listeningToWindow = false

  constructor(storage?: Storage | null) {
    this.storage = storage ?? defaultStorage() ?? memoryStorage()
  }

  load(): StoredSession | null {
    const raw = this.storage.getItem(SESSION_KEY)
    if (!raw) return null
    try {
      return JSON.parse(raw) as StoredSession
    } catch {
      this.storage.removeItem(SESSION_KEY)
      return null
    }
  }

  save(session: StoredSession): void {
    this.storage.setItem(SESSION_KEY, JSON.stringify(session))
    this.emit(session)
  }

  clear(): void {
    this.storage.removeItem(SESSION_KEY)
    this.emit(null)
  }

  onChange(listener: SessionListener): () => void {
    this.listeners.add(listener)
    this.ensureWindowListener()
    return () => this.listeners.delete(listener)
  }

  private emit(session: StoredSession | null): void {
    for (const listener of this.listeners) listener(session)
  }

  /** Reflect same-key writes from other tabs into this store's listeners. */
  private ensureWindowListener(): void {
    if (this.listeningToWindow || typeof window === 'undefined') return
    this.listeningToWindow = true
    window.addEventListener('storage', (event) => {
      if (event.key === SESSION_KEY) this.emit(this.load())
    })
  }
}
