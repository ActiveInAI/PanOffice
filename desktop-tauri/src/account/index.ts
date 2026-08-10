/**
 * PanOffice account module (Arch-GPT JWT SSO).
 *
 * `installAccount()` wires the store + client + session manager and is what
 * the shell (src/App.tsx) calls once at startup; `getAiApiKey()` from the
 * returned handles feeds the `archgpt` provider's apiKey in
 * packages/ai-provider settings. `<LoginPanel account={handles} />` renders
 * the sign-in UI / account card.
 */

import { ARCHGPT_API_BASE_URL, AuthClient, type Transport } from './client'
import { LocalStorageSessionStore, type SessionStore } from './store'
import { AccountSessionManager, type AccountHandles } from './session'

export interface InstallAccountOptions {
  /** Defaults to ARCHGPT_API_BASE_URL (port unconfirmed — see client.ts). */
  baseUrl?: string
  /** Defaults to the global fetch; inject for tests. */
  transport?: Transport
  /** Defaults to LocalStorageSessionStore; later the Tauri keychain store. */
  store?: SessionStore
}

export function installAccount(options: InstallAccountOptions = {}): AccountHandles {
  const client = new AuthClient(options.baseUrl ?? ARCHGPT_API_BASE_URL, options.transport)
  const store = options.store ?? new LocalStorageSessionStore()
  const session = new AccountSessionManager(store, client)
  return {
    client,
    store,
    session,
    getAiApiKey: () => session.getAiApiKey(),
  }
}

export { ARCHGPT_API_BASE_URL, ArchGptAuthError, AuthClient } from './client'
export type {
  AuthCodeLoginRequest,
  AuthErrorResponse,
  AuthLoginRequest,
  AuthMeResponse,
  AuthPasswordResetRequest,
  AuthQrChallengeResponse,
  AuthQrCreateRequest,
  AuthQrPollResponse,
  AuthRegisterRequest,
  AuthResponse,
  AuthVerificationCodeRequest,
  AuthVerificationCodeResponse,
  QrChallengeStatus,
  Transport,
} from './client'
export {
  ACCOUNT_STORAGE_PREFIX,
  isSessionExpired,
  LocalStorageSessionStore,
} from './store'
export type { KeychainStore, SessionListener, SessionStore, StoredSession } from './store'
export { AccountSessionManager } from './session'
export type { AccountHandles } from './session'
export { LoginPanel } from './LoginPanel'
