/**
 * Auth client tests against a real node:http stub server implementing the
 * openapi.yaml /v1/auth/* paths — no global fetch mocking.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ArchGptAuthError, AuthClient } from '../src/account/client'

const VALID_TOKEN = 'jwt-valid-token'
const CHALLENGE_ID = '11111111-2222-3333-4444-555555555555'
const POLL_TOKEN = 'poll-token-123'

const AUTH_BODY = {
  accountId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  tenantId: '99999999-8888-7777-6666-555555555555',
  personId: null,
  accessToken: VALID_TOKEN,
  expiresInSeconds: 3600,
  runtimeRoles: ['member'],
}

const ME_BODY = {
  accountId: AUTH_BODY.accountId,
  tenantId: AUTH_BODY.tenantId,
  personId: null,
  email: 'ada@example.com',
  phone: null,
  fullName: 'Ada Lovelace',
  displayName: 'Ada',
  runtimeRoles: ['member'],
  jobTitles: ['architect'],
}

function errorBody(message: string, status: number, errorCode: string) {
  return { error: message, code: status, errorCode, message }
}

function readBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => resolve(data ? JSON.parse(data) : undefined))
    req.on('error', reject)
  })
}

let server: Server
let baseUrl: string
let qrPollCount = 0

/** Await a rejection and return it as a typed ArchGptAuthError. */
async function expectAuthError(promise: Promise<unknown>): Promise<ArchGptAuthError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(ArchGptAuthError)
    return err as ArchGptAuthError
  }
  throw new Error('expected the request to reject')
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const bearer = req.headers.authorization
    const body = (await readBody(req)) as Record<string, unknown> | undefined

    if (req.method === 'POST' && url.pathname === '/v1/auth/login') {
      if (body?.identifier === 'ada@example.com' && body?.password === 'correct horse') {
        return send(200, AUTH_BODY)
      }
      return send(401, errorBody('Invalid credentials.', 401, 'invalid_credentials'))
    }

    if (req.method === 'POST' && url.pathname === '/v1/auth/verification-codes') {
      if (!body?.channel || !body?.destination) {
        return send(400, errorBody('Validation failed.', 400, 'validation_error'))
      }
      return send(200, {
        channel: body.channel,
        destination: body.destination,
        purpose: body.purpose ?? 'login',
        expiresInSeconds: 300,
        deliveryStatus: 'sent',
        debugCode: '123456',
      })
    }

    if (req.method === 'POST' && url.pathname === '/v1/auth/login/code') {
      if (body?.verificationCode === '000000') {
        return send(401, errorBody('Verification code expired.', 401, 'verification_code_expired'))
      }
      if (body?.verificationCode === '123456') {
        return send(200, AUTH_BODY)
      }
      return send(401, errorBody('Invalid verification code.', 401, 'invalid_verification_code'))
    }

    if (req.method === 'POST' && url.pathname === '/v1/auth/register') {
      return send(200, AUTH_BODY)
    }

    if (req.method === 'POST' && url.pathname === '/v1/auth/password/reset') {
      res.writeHead(204)
      return res.end()
    }

    if (req.method === 'POST' && url.pathname === '/v1/auth/qr/challenges') {
      return send(200, {
        challengeId: CHALLENGE_ID,
        qrPayload: `archgpt://qr-login/${CHALLENGE_ID}`,
        pollToken: POLL_TOKEN,
        status: 'pending',
        expiresInSeconds: 120,
      })
    }

    if (req.method === 'GET' && url.pathname === `/v1/auth/qr/challenges/${CHALLENGE_ID}`) {
      if (url.searchParams.get('pollToken') !== POLL_TOKEN) {
        return send(401, errorBody('Invalid poll token.', 401, 'invalid_poll_token'))
      }
      qrPollCount += 1
      if (qrPollCount >= 2) {
        return send(200, {
          challengeId: CHALLENGE_ID,
          status: 'approved',
          expiresInSeconds: 100,
          auth: AUTH_BODY,
        })
      }
      return send(200, { challengeId: CHALLENGE_ID, status: 'pending', expiresInSeconds: 110 })
    }

    if (req.method === 'GET' && url.pathname === '/v1/auth/me') {
      if (bearer === `Bearer ${VALID_TOKEN}`) return send(200, ME_BODY)
      return send(401, errorBody('Invalid or expired token.', 401, 'invalid_token'))
    }

    if (req.method === 'POST' && url.pathname === '/v1/auth/logout') {
      if (bearer === `Bearer ${VALID_TOKEN}`) return send(200, { loggedOut: true })
      return send(401, errorBody('Invalid or expired token.', 401, 'invalid_token'))
    }

    return send(404, errorBody('Not found.', 404, 'resource_not_found'))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  )
})

describe('AuthClient password login', () => {
  it('parses a successful AuthResponse', async () => {
    const client = new AuthClient(baseUrl)
    const auth = await client.loginWithPassword({
      identifier: 'ada@example.com',
      password: 'correct horse',
    })
    expect(auth.accessToken).toBe(VALID_TOKEN)
    expect(auth.accountId).toBe(AUTH_BODY.accountId)
    expect(auth.tenantId).toBe(AUTH_BODY.tenantId)
    expect(auth.personId).toBeNull()
    expect(auth.expiresInSeconds).toBe(3600)
    expect(auth.runtimeRoles).toEqual(['member'])
  })

  it('throws ArchGptAuthError with the server errorCode on a wrong password', async () => {
    const client = new AuthClient(baseUrl)
    const err = await expectAuthError(
      client.loginWithPassword({ identifier: 'ada@example.com', password: 'wrong' }),
    )
    expect(err.status).toBe(401)
    expect(err.errorCode).toBe('invalid_credentials')
    expect(err.message).toBe('Invalid credentials.')
  })
})

describe('AuthClient verification-code login', () => {
  it('requests a code and parses the delivery result', async () => {
    const client = new AuthClient(baseUrl)
    const res = await client.requestLoginCode({
      channel: 'email',
      destination: 'ada@example.com',
      purpose: 'login',
    })
    expect(res.deliveryStatus).toBe('sent')
    expect(res.expiresInSeconds).toBe(300)
    expect(res.debugCode).toBe('123456')
  })

  it('signs in with a valid code', async () => {
    const client = new AuthClient(baseUrl)
    const auth = await client.loginWithCode({
      channel: 'email',
      destination: 'ada@example.com',
      verificationCode: '123456',
    })
    expect(auth.accessToken).toBe(VALID_TOKEN)
  })

  it('surfaces an expired code as a 401 with verification_code_expired', async () => {
    const client = new AuthClient(baseUrl)
    const err = await expectAuthError(
      client.loginWithCode({
        channel: 'email',
        destination: 'ada@example.com',
        verificationCode: '000000',
      }),
    )
    expect(err.status).toBe(401)
    expect(err.errorCode).toBe('verification_code_expired')
  })
})

describe('AuthClient current account and logout', () => {
  it('fetches the current account with a valid bearer token', async () => {
    const client = new AuthClient(baseUrl)
    const me = await client.fetchCurrentAccount(VALID_TOKEN)
    expect(me.accountId).toBe(AUTH_BODY.accountId)
    expect(me.displayName).toBe('Ada')
    expect(me.jobTitles).toEqual(['architect'])
  })

  it('throws a 401 ArchGptAuthError for an invalid token on /v1/auth/me', async () => {
    const client = new AuthClient(baseUrl)
    const err = await expectAuthError(client.fetchCurrentAccount('jwt-garbage'))
    expect(err.status).toBe(401)
    expect(err.errorCode).toBe('invalid_token')
  })

  it('logs out and returns the acknowledgement flag', async () => {
    const client = new AuthClient(baseUrl)
    await expect(client.logout(VALID_TOKEN)).resolves.toBe(true)
  })

  it('rejects logout with an invalid token', async () => {
    const client = new AuthClient(baseUrl)
    const err = await expectAuthError(client.logout('jwt-garbage'))
    expect(err.status).toBe(401)
  })
})

describe('AuthClient QR challenge flow', () => {
  it('creates a challenge with payload and poll token', async () => {
    const client = new AuthClient(baseUrl)
    const challenge = await client.createQrChallenge({})
    expect(challenge.challengeId).toBe(CHALLENGE_ID)
    expect(challenge.qrPayload).toContain('archgpt://qr-login/')
    expect(challenge.pollToken).toBe(POLL_TOKEN)
    expect(challenge.status).toBe('pending')
  })

  it('polls pending then approved with an AuthResponse', async () => {
    qrPollCount = 0
    const client = new AuthClient(baseUrl)
    const first = await client.pollQrChallenge(CHALLENGE_ID, POLL_TOKEN)
    expect(first.status).toBe('pending')
    expect(first.auth).toBeUndefined()
    const second = await client.pollQrChallenge(CHALLENGE_ID, POLL_TOKEN)
    expect(second.status).toBe('approved')
    expect(second.auth?.accessToken).toBe(VALID_TOKEN)
  })

  it('rejects polling with a wrong poll token', async () => {
    const client = new AuthClient(baseUrl)
    const err = await expectAuthError(client.pollQrChallenge(CHALLENGE_ID, 'wrong-token'))
    expect(err.status).toBe(401)
    expect(err.errorCode).toBe('invalid_poll_token')
  })
})

describe('AuthClient misc', () => {
  it('resolves register and resetPassword (204) without a body', async () => {
    const client = new AuthClient(baseUrl)
    const auth = await client.register({
      tenantName: 'Acme AEC',
      fullName: 'Ada Lovelace',
      email: 'ada@example.com',
      password: 'correct horse',
      verificationChannel: 'email',
      verificationCode: '123456',
    })
    expect(auth.accessToken).toBe(VALID_TOKEN)
    await expect(
      client.resetPassword({
        channel: 'email',
        destination: 'ada@example.com',
        verificationCode: '123456',
        password: 'new password',
      }),
    ).resolves.toBeUndefined()
  })

  it('falls back to a generic message when the error body is not JSON', async () => {
    const transport = async () => new Response('not json', { status: 502 })
    const client = new AuthClient(baseUrl, transport)
    const err = await expectAuthError(client.loginWithPassword({ identifier: 'a', password: 'b' }))
    expect(err.status).toBe(502)
    expect(err.errorCode).toBeNull()
    expect(err.message).toContain('502')
  })
})
