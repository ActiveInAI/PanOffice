/**
 * Store/session tests — jsdom environment, real localStorage.
 * The session manager talks to an AuthClient with an injected transport
 * (no server, no global fetch mocking).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthClient, type AuthResponse } from '../src/account/client'
import { AccountSessionManager } from '../src/account/session'
import {
  ACCOUNT_STORAGE_PREFIX,
  isSessionExpired,
  LocalStorageSessionStore,
  type StoredSession,
} from '../src/account/store'

const SESSION_KEY = `${ACCOUNT_STORAGE_PREFIX}session`

const AUTH: AuthResponse = {
  accountId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  tenantId: '99999999-8888-7777-6666-555555555555',
  personId: null,
  accessToken: 'jwt-test-token',
  expiresInSeconds: 3600,
  runtimeRoles: ['member'],
}

function makeSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    accessToken: AUTH.accessToken,
    accountId: AUTH.accountId,
    tenantId: AUTH.tenantId,
    personId: null,
    expiresAt: Date.now() + 3600_000,
    account: null,
    ...overrides,
  }
}

/** Transport stub: routes by method+URL, returns Response objects. */
function stubTransport(routes: Record<string, { status: number; body?: unknown }>) {
  return vi.fn(async (input: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${new URL(input).pathname}`
    const route = routes[key] ?? { status: 404, body: { error: 'nf', code: 404 } }
    return new Response(route.body === undefined ? null : JSON.stringify(route.body), {
      status: route.status,
      headers: { 'Content-Type': 'application/json' },
    })
  })
}

beforeEach(() => {
  localStorage.clear()
})

describe('LocalStorageSessionStore', () => {
  it('saves and restores a session under the panoffice.account.* key', () => {
    const store = new LocalStorageSessionStore()
    store.save(makeSession())
    expect(localStorage.getItem(SESSION_KEY)).not.toBeNull()
    const loaded = store.load()
    expect(loaded?.accessToken).toBe(AUTH.accessToken)
    expect(loaded?.accountId).toBe(AUTH.accountId)
  })

  it('returns null when nothing is stored, and after clear()', () => {
    const store = new LocalStorageSessionStore()
    expect(store.load()).toBeNull()
    store.save(makeSession())
    store.clear()
    expect(store.load()).toBeNull()
    expect(localStorage.getItem(SESSION_KEY)).toBeNull()
  })

  it('drops a corrupted payload instead of throwing', () => {
    localStorage.setItem(SESSION_KEY, '{not json')
    const store = new LocalStorageSessionStore()
    expect(store.load()).toBeNull()
    expect(localStorage.getItem(SESSION_KEY)).toBeNull()
  })

  it('notifies listeners on save and clear, and unsubscribe works', () => {
    const store = new LocalStorageSessionStore()
    const seen: Array<StoredSession | null> = []
    const off = store.onChange((s) => seen.push(s))
    store.save(makeSession())
    store.clear()
    off()
    store.save(makeSession())
    expect(seen).toHaveLength(2)
    expect(seen[0]?.accessToken).toBe(AUTH.accessToken)
    expect(seen[1]).toBeNull()
  })
})

describe('isSessionExpired', () => {
  it('compares expiresAt against now', () => {
    expect(isSessionExpired(makeSession({ expiresAt: Date.now() + 1000 }))).toBe(false)
    expect(isSessionExpired(makeSession({ expiresAt: Date.now() - 1 }))).toBe(true)
  })
})

describe('AccountSessionManager', () => {
  it('restores a valid stored session on startup', () => {
    new LocalStorageSessionStore().save(makeSession())
    const store = new LocalStorageSessionStore()
    const manager = new AccountSessionManager(store, new AuthClient('http://unused', stubTransport({})))
    expect(manager.session?.accessToken).toBe(AUTH.accessToken)
    expect(manager.getAiApiKey()).toBe(AUTH.accessToken)
  })

  it('discards an expired stored session and returns a null AI key', () => {
    const store = new LocalStorageSessionStore()
    store.save(makeSession({ expiresAt: Date.now() - 1000 }))
    const manager = new AccountSessionManager(store, new AuthClient('http://unused', stubTransport({})))
    expect(manager.session).toBeNull()
    expect(manager.getAiApiKey()).toBeNull()
    expect(store.load()).toBeNull()
  })

  it('loginWithPassword persists the session with a derived expiresAt', async () => {
    const transport = stubTransport({ 'POST /v1/auth/login': { status: 200, body: AUTH } })
    const store = new LocalStorageSessionStore()
    const manager = new AccountSessionManager(store, new AuthClient('http://unused', transport))
    const before = Date.now()
    const session = await manager.loginWithPassword({
      identifier: 'ada@example.com',
      password: 'correct horse',
    })
    expect(session.accessToken).toBe(AUTH.accessToken)
    expect(session.expiresAt).toBeGreaterThanOrEqual(before + 3600_000)
    expect(store.load()?.accessToken).toBe(AUTH.accessToken)
    expect(manager.getAiApiKey()).toBe(AUTH.accessToken)
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('logout clears the local session and calls the server best-effort', async () => {
    const transport = stubTransport({
      'POST /v1/auth/login': { status: 200, body: AUTH },
      'POST /v1/auth/logout': { status: 200, body: { loggedOut: true } },
    })
    const store = new LocalStorageSessionStore()
    const manager = new AccountSessionManager(store, new AuthClient('http://unused', transport))
    await manager.loginWithPassword({ identifier: 'a', password: 'b' })
    const seen: Array<StoredSession | null> = []
    manager.onChange((s) => seen.push(s))
    await manager.logout()
    expect(manager.session).toBeNull()
    expect(manager.getAiApiKey()).toBeNull()
    expect(store.load()).toBeNull()
    expect(seen.at(-1)).toBeNull()
    expect(transport).toHaveBeenCalledTimes(2)
  })

  it('logout still clears locally when the server call fails', async () => {
    const transport = stubTransport({
      'POST /v1/auth/login': { status: 200, body: AUTH },
      'POST /v1/auth/logout': { status: 500, body: { error: 'boom', code: 500 } },
    })
    const store = new LocalStorageSessionStore()
    const manager = new AccountSessionManager(store, new AuthClient('http://unused', transport))
    await manager.loginWithPassword({ identifier: 'a', password: 'b' })
    await manager.logout()
    expect(manager.session).toBeNull()
  })

  it('refreshAccount caches the /v1/auth/me snapshot on the session', async () => {
    const me = {
      accountId: AUTH.accountId,
      tenantId: AUTH.tenantId,
      personId: null,
      email: 'ada@example.com',
      phone: null,
      fullName: 'Ada Lovelace',
      displayName: 'Ada',
      runtimeRoles: ['member'],
      jobTitles: [],
    }
    const transport = stubTransport({
      'POST /v1/auth/login': { status: 200, body: AUTH },
      'GET /v1/auth/me': { status: 200, body: me },
    })
    const store = new LocalStorageSessionStore()
    const manager = new AccountSessionManager(store, new AuthClient('http://unused', transport))
    await manager.loginWithPassword({ identifier: 'a', password: 'b' })
    const result = await manager.refreshAccount()
    expect(result?.displayName).toBe('Ada')
    expect(store.load()?.account?.email).toBe('ada@example.com')
  })
})
