import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, describe, expect, it } from 'vitest'
import { startTestServer, wopiUrl } from './helpers.js'

const servers: Array<{ close: () => Promise<void> }> = []
afterAll(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()))
})

async function checkFileInfo(base: string, token?: string): Promise<Response> {
  const url = token ? wopiUrl(base, '/wopi/files/a.docx', token) : `${base}/wopi/files/a.docx`
  return fetch(url)
}

describe('token resolution', () => {
  it('rejects requests without a token', async () => {
    const srv = await startTestServer()
    servers.push(srv)
    const res = await checkFileInfo(srv.base)
    expect(res.status).toBe(401)
  })

  it('rejects unknown tokens', async () => {
    const srv = await startTestServer()
    servers.push(srv)
    const res = await checkFileInfo(srv.base, 'no-such-token')
    expect(res.status).toBe(401)
  })

  it('accepts the shared dev token when WOPI_ALLOW_DEV_TOKEN=true', async () => {
    const srv = await startTestServer({ allowDevToken: true })
    servers.push(srv)
    const res = await checkFileInfo(srv.base, 'devtoken')
    expect(res.status).toBe(200)
    const info = (await res.json()) as { UserId: string; UserCanWrite: boolean }
    expect(info.UserId).toBe('dev-user')
    expect(info.UserCanWrite).toBe(true)
  })

  it('rejects the shared dev token when WOPI_ALLOW_DEV_TOKEN=false', async () => {
    const srv = await startTestServer({ allowDevToken: false })
    servers.push(srv)
    const res = await checkFileInfo(srv.base, 'devtoken')
    expect(res.status).toBe(401)
  })

  it('resolves WOPI_TOKENS_JSON entries to their user', async () => {
    const srv = await startTestServer({
      devTokens: {
        'tok-alice': { userId: 'alice', name: 'Alice A', permissions: 'read-write' },
      },
    })
    servers.push(srv)
    const res = await checkFileInfo(srv.base, 'tok-alice')
    expect(res.status).toBe(200)
    const info = (await res.json()) as { UserId: string; UserFriendlyName: string }
    expect(info.UserId).toBe('alice')
    expect(info.UserFriendlyName).toBe('Alice A')
  })

  it('accepts the token via Authorization: Bearer as well', async () => {
    const srv = await startTestServer()
    servers.push(srv)
    const res = await fetch(`${srv.base}/wopi/files/a.docx`, {
      headers: { authorization: 'Bearer devtoken' },
    })
    expect(res.status).toBe(200)
  })
})

describe('Arch-GPT JWT (HS256)', () => {
  const secret = 'test-hs256-secret'

  async function issueHs256(claims: Record<string, unknown>, key = secret, exp?: number): Promise<string> {
    let jwt = new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).setIssuedAt()
    jwt = exp !== undefined ? jwt.setExpirationTime(exp) : jwt.setExpirationTime('1h')
    return jwt.sign(new TextEncoder().encode(key))
  }

  it('accepts a valid HS256 JWT and maps sub/name/permissions', async () => {
    const srv = await startTestServer({ jwtSecret: secret, allowDevToken: false })
    servers.push(srv)
    const token = await issueHs256({ sub: 'user-42', name: 'JWT User', permissions: 'read-write' })
    const res = await checkFileInfo(srv.base, token)
    expect(res.status).toBe(200)
    const info = (await res.json()) as { UserId: string; UserFriendlyName: string; UserCanWrite: boolean }
    expect(info.UserId).toBe('user-42')
    expect(info.UserFriendlyName).toBe('JWT User')
    expect(info.UserCanWrite).toBe(true)
  })

  it('defaults JWT users without a permissions claim to read-only', async () => {
    const srv = await startTestServer({ jwtSecret: secret, allowDevToken: false })
    servers.push(srv)
    const token = await issueHs256({ sub: 'reader' })
    const res = await checkFileInfo(srv.base, token)
    expect(res.status).toBe(200)
    const info = (await res.json()) as { UserCanWrite: boolean }
    expect(info.UserCanWrite).toBe(false)
  })

  it('rejects an expired JWT', async () => {
    const srv = await startTestServer({ jwtSecret: secret, allowDevToken: false })
    servers.push(srv)
    const token = await issueHs256({ sub: 'user-42' }, secret, Math.floor(Date.now() / 1000) - 3600)
    const res = await checkFileInfo(srv.base, token)
    expect(res.status).toBe(401)
  })

  it('rejects a JWT signed with the wrong secret', async () => {
    const srv = await startTestServer({ jwtSecret: secret, allowDevToken: false })
    servers.push(srv)
    const token = await issueHs256({ sub: 'user-42' }, 'a-different-secret')
    const res = await checkFileInfo(srv.base, token)
    expect(res.status).toBe(401)
  })

  it('rejects a malformed JWT', async () => {
    const srv = await startTestServer({ jwtSecret: secret, allowDevToken: false })
    servers.push(srv)
    const res = await checkFileInfo(srv.base, 'not.a.jwt')
    expect(res.status).toBe(401)
  })
})

describe('Arch-GPT JWT (RS256 via JWKS)', () => {
  it('verifies RS256 tokens against ARCHGPT_JWT_JWKS_URL', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256')
    const jwk = await exportJWK(publicKey)
    jwk.kid = 'test-key-1'
    jwk.alg = 'RS256'
    const jwksServer = http.createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ keys: [jwk] }))
    })
    await new Promise<void>((res) => jwksServer.listen(0, '127.0.0.1', () => res()))
    const jwksPort = (jwksServer.address() as AddressInfo).port

    const srv = await startTestServer({
      jwksUrl: `http://127.0.0.1:${jwksPort}/jwks.json`,
      allowDevToken: false,
    })
    servers.push(srv)
    try {
      const token = await new SignJWT({ sub: 'rs-user', name: 'RS User', permissions: 'read-write' })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey)
      const res = await checkFileInfo(srv.base, token)
      expect(res.status).toBe(200)
      const info = (await res.json()) as { UserId: string }
      expect(info.UserId).toBe('rs-user')

      // a token from a different key must not verify
      const rogue = await generateKeyPair('RS256')
      const badToken = await new SignJWT({ sub: 'rogue' })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
        .setExpirationTime('1h')
        .sign(rogue.privateKey)
      const badRes = await checkFileInfo(srv.base, badToken)
      expect(badRes.status).toBe(401)
    } finally {
      jwksServer.closeAllConnections()
      await new Promise<void>((res) => jwksServer.close(() => res()))
    }
  })
})
