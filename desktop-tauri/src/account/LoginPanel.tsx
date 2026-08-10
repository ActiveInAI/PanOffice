/**
 * LoginPanel — Arch-GPT sign-in UI for the PanOffice shell.
 *
 * Password login, verification-code login, and a QR sign-in section (the
 * challenge payload is rendered as a placeholder box — no QR encoding
 * library is available in this package yet). Shows an account card with
 * logout once signed in. Plain inline styles, English strings only; shell
 * i18n lands later with the rest of the scaffold.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, FormEvent } from 'react'
import { ArchGptAuthError, type AuthQrChallengeResponse } from './client'
import type { AccountHandles } from './session'

const s: Record<string, CSSProperties> = {
  panel: {
    fontFamily: 'system-ui, sans-serif',
    fontSize: 13,
    maxWidth: 360,
    padding: 16,
    border: '1px solid #e5e7eb',
    borderRadius: 8,
    background: '#fff',
  },
  title: { fontSize: 16, margin: '0 0 12px' },
  tabs: { display: 'flex', gap: 4, marginBottom: 12 },
  tab: {
    padding: '4px 10px',
    borderRadius: 6,
    border: '1px solid #e5e7eb',
    background: '#f9fafb',
    cursor: 'pointer',
    fontSize: 12,
  },
  tabActive: { background: '#fff', borderColor: '#9ca3af', fontWeight: 600 },
  field: { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 },
  label: { color: '#374151' },
  input: {
    padding: '6px 8px',
    borderRadius: 6,
    border: '1px solid #d1d5db',
    fontSize: 13,
  },
  button: {
    padding: '6px 12px',
    borderRadius: 6,
    border: '1px solid #d1d5db',
    background: '#f3f4f6',
    cursor: 'pointer',
    fontSize: 13,
  },
  primaryButton: { background: '#111827', borderColor: '#111827', color: '#fff' },
  buttonRow: { display: 'flex', gap: 8, alignItems: 'center' },
  error: { color: '#b91c1c', margin: '8px 0 0' },
  hint: { color: '#6b7280', margin: '8px 0 0', fontSize: 12 },
  qrBox: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    textAlign: 'center',
    width: 180,
    height: 180,
    margin: '8px 0',
    border: '1px dashed #9ca3af',
    borderRadius: 8,
    color: '#6b7280',
    fontSize: 12,
    padding: 8,
    boxSizing: 'border-box',
  },
  qrPayload: {
    fontFamily: 'ui-monospace, monospace',
    fontSize: 10,
    color: '#9ca3af',
    wordBreak: 'break-all',
    margin: '4px 0 0',
  },
  cardRow: { margin: '4px 0' },
  muted: { color: '#6b7280' },
}

function errorMessage(err: unknown): string {
  if (err instanceof ArchGptAuthError) return err.message
  if (err instanceof Error) return err.message
  return 'Request failed'
}

type Mode = 'password' | 'code' | 'qr'

export function LoginPanel({ account }: { account: AccountHandles }) {
  const subscribe = useCallback(
    (onStoreChange: () => void) => account.session.onChange(onStoreChange),
    [account],
  )
  const current = useSyncExternalStore(subscribe, () => account.session.session)
  const [mode, setMode] = useState<Mode>('password')

  if (current) {
    return (
      <div style={s.panel}>
        <AccountCard account={account} />
      </div>
    )
  }

  return (
    <div style={s.panel}>
      <h2 style={s.title}>Sign in with Arch-GPT</h2>
      <div style={s.tabs}>
        {(
          [
            ['password', 'Password'],
            ['code', 'Code'],
            ['qr', 'QR'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            style={{ ...s.tab, ...(mode === id ? s.tabActive : null) }}
            onClick={() => setMode(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {mode === 'password' && <PasswordForm account={account} />}
      {mode === 'code' && <CodeForm account={account} />}
      {mode === 'qr' && <QrSection account={account} />}
    </div>
  )
}

function PasswordForm({ account }: { account: AccountHandles }) {
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await account.session.loginWithPassword({ identifier, password })
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit}>
      <div style={s.field}>
        <label style={s.label} htmlFor="po-account-identifier">
          Email or phone
        </label>
        <input
          id="po-account-identifier"
          style={s.input}
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          autoComplete="username"
          required
        />
      </div>
      <div style={s.field}>
        <label style={s.label} htmlFor="po-account-password">
          Password
        </label>
        <input
          id="po-account-password"
          style={s.input}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
      </div>
      <button type="submit" style={{ ...s.button, ...s.primaryButton }} disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
      {error && <p style={s.error}>{error}</p>}
    </form>
  )
}

function CodeForm({ account }: { account: AccountHandles }) {
  const [channel, setChannel] = useState<'email' | 'sms'>('email')
  const [destination, setDestination] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [codeSent, setCodeSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const sendCode = async () => {
    if (!destination) return
    setBusy(true)
    setError(null)
    try {
      // 'login' purpose is assumed; the spec leaves purpose free-form.
      await account.client.requestLoginCode({ channel, destination, purpose: 'login' })
      setCodeSent(true)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await account.session.loginWithCode({ channel, destination, verificationCode: code })
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit}>
      <div style={s.field}>
        <label style={s.label} htmlFor="po-account-channel">
          Channel
        </label>
        <select
          id="po-account-channel"
          style={s.input}
          value={channel}
          onChange={(e) => setChannel(e.target.value as 'email' | 'sms')}
        >
          <option value="email">Email</option>
          <option value="sms">SMS</option>
        </select>
      </div>
      <div style={s.field}>
        <label style={s.label} htmlFor="po-account-destination">
          {channel === 'email' ? 'Email address' : 'Phone number'}
        </label>
        <input
          id="po-account-destination"
          style={s.input}
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
          required
        />
      </div>
      <div style={s.field}>
        <label style={s.label} htmlFor="po-account-code">
          Verification code
        </label>
        <input
          id="po-account-code"
          style={s.input}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          inputMode="numeric"
          required
        />
      </div>
      <div style={s.buttonRow}>
        <button type="submit" style={{ ...s.button, ...s.primaryButton }} disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <button type="button" style={s.button} disabled={busy || !destination} onClick={sendCode}>
          Send code
        </button>
      </div>
      {codeSent && <p style={s.hint}>Code sent — check your {channel === 'email' ? 'inbox' : 'messages'}.</p>}
      {error && <p style={s.error}>{error}</p>}
    </form>
  )
}

function QrSection({ account }: { account: AccountHandles }) {
  const [challenge, setChallenge] = useState<AuthQrChallengeResponse | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const create = async () => {
    setBusy(true)
    setError(null)
    setStatus(null)
    try {
      setChallenge(await account.client.createQrChallenge({}))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  // Poll the challenge until it is approved (auth arrives) or terminal.
  useEffect(() => {
    if (!challenge) return
    const timer = window.setInterval(() => {
      account.client
        .pollQrChallenge(challenge.challengeId, challenge.pollToken)
        .then((poll) => {
          setStatus(poll.status)
          if (poll.auth) {
            window.clearInterval(timer)
            account.session.applyAuth(poll.auth)
          } else if (poll.status === 'expired' || poll.status === 'rejected') {
            window.clearInterval(timer)
            setError(`QR sign-in ${poll.status} — create a new challenge.`)
          }
        })
        .catch((err) => {
          window.clearInterval(timer)
          setError(errorMessage(err))
        })
    }, 2000)
    return () => window.clearInterval(timer)
  }, [challenge, account])

  return (
    <div>
      {!challenge && (
        <button type="button" style={s.button} disabled={busy} onClick={create}>
          {busy ? 'Creating…' : 'Create QR sign-in challenge'}
        </button>
      )}
      {challenge && (
        <div>
          {/* Placeholder: no QR-encoding library is available in this package
              yet, so the raw payload is shown instead of a scannable image. */}
          <div style={s.qrBox}>
            QR placeholder
            <br />
            scan with the Arch-GPT app
          </div>
          <p style={s.qrPayload}>{challenge.qrPayload}</p>
          <p style={s.hint}>Status: {status ?? challenge.status} · expires in {challenge.expiresInSeconds}s</p>
          <button type="button" style={s.button} disabled={busy} onClick={create}>
            New challenge
          </button>
        </div>
      )}
      {error && <p style={s.error}>{error}</p>}
    </div>
  )
}

function AccountCard({ account }: { account: AccountHandles }) {
  const subscribe = useCallback(
    (onStoreChange: () => void) => account.session.onChange(onStoreChange),
    [account],
  )
  const current = useSyncExternalStore(subscribe, () => account.session.session)
  const [error, setError] = useState<string | null>(null)
  if (!current) return null

  const me = current.account
  const name = me?.displayName ?? me?.fullName ?? me?.email ?? current.accountId

  const refresh = () => {
    account.session.refreshAccount().catch((err) => setError(errorMessage(err)))
  }
  const logout = () => {
    account.session.logout().catch(() => undefined)
  }

  return (
    <div>
      <h2 style={s.title}>Account</h2>
      <p style={{ ...s.cardRow, fontWeight: 600 }}>{name}</p>
      <p style={{ ...s.cardRow, ...s.muted }}>Tenant {current.tenantId}</p>
      {me && me.runtimeRoles.length > 0 && (
        <p style={{ ...s.cardRow, ...s.muted }}>Roles: {me.runtimeRoles.join(', ')}</p>
      )}
      {error && <p style={s.error}>{error}</p>}
      <div style={{ ...s.buttonRow, marginTop: 8 }}>
        <button type="button" style={s.button} onClick={refresh}>
          Refresh
        </button>
        <button type="button" style={s.button} onClick={logout}>
          Sign out
        </button>
      </div>
    </div>
  )
}
