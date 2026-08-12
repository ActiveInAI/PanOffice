#!/usr/bin/env node

import http from 'node:http'
import { URL } from 'node:url'
import { createGzip, gzipSync } from 'node:zlib'

const listenHost = process.env.PANOFFICE_DOMAIN_PROXY_HOST || '127.0.0.1'
const listenPort = Number(process.env.PANOFFICE_DOMAIN_PROXY_PORT || '3000')
const upstream = new URL(process.env.PANOFFICE_DOMAIN_PROXY_UPSTREAM || 'http://192.168.1.100:3210')
const publicOrigin = new URL(process.env.PANOFFICE_DOMAIN_PUBLIC_ORIGIN || 'https://panoffice.ko.tw.cn')

if (
  upstream.protocol !== 'http:' ||
  publicOrigin.protocol !== 'https:' ||
  !Number.isInteger(listenPort) ||
  listenPort < 1 ||
  listenPort > 65535
) {
  throw new Error('Invalid PanOffice domain proxy configuration')
}

const upstreamOrigin = upstream.origin
const hopByHop = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function forwardHeaders(req) {
  const headers = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (!hopByHop.has(name.toLowerCase()) && value !== undefined) headers[name] = value
  }
  headers.host = upstream.host
  headers['accept-encoding'] = 'identity'
  headers['x-forwarded-host'] = req.headers.host || publicOrigin.host
  headers['x-forwarded-proto'] = publicOrigin.protocol.slice(0, -1)
  if (req.headers.origin === publicOrigin.origin) headers.origin = upstreamOrigin
  if (typeof req.headers.referer === 'string' && req.headers.referer.startsWith(publicOrigin.origin)) {
    headers.referer = `${upstreamOrigin}${req.headers.referer.slice(publicOrigin.origin.length)}`
  }
  return headers
}

function publicValue(value) {
  return String(value).split(upstreamOrigin).join(publicOrigin.origin)
}

/**
 * The upstream is asked for identity encoding (bodies may need rewriting),
 * so without this the tunnel would carry multi-MB editor bundles raw. Text
 * types the client accepts gzip for are compressed on the way out.
 */
const COMPRESSIBLE = /^(text\/|application\/(javascript|x-javascript|json|xml|wasm))/
function wantsGzip(req, headers) {
  return (
    /\bgzip\b/i.test(String(req.headers['accept-encoding'] ?? '')) &&
    !headers['content-encoding'] &&
    COMPRESSIBLE.test(String(headers['content-type'] ?? '').toLowerCase())
  )
}

function responseHeaders(rawHeaders, rewritten) {
  const headers = {}
  for (const [name, value] of Object.entries(rawHeaders)) {
    const lower = name.toLowerCase()
    if (hopByHop.has(lower) || value === undefined) continue
    if (lower === 'location') headers[name] = publicValue(value)
    else if (lower !== 'content-length' || !rewritten) headers[name] = value
  }
  return headers
}

const server = http.createServer((req, res) => {
  const proxy = http.request(
    {
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || 80,
      path: req.url || '/',
      method: req.method,
      headers: forwardHeaders(req),
    },
    (upstreamRes) => {
      const contentType = String(upstreamRes.headers['content-type'] || '').toLowerCase()
      const rewrite = contentType.includes('application/json') || contentType.includes('text/html')
      if (!rewrite) {
        const headers = responseHeaders(upstreamRes.headers, false)
        if (wantsGzip(req, headers)) {
          delete headers['content-length']
          res.writeHead(upstreamRes.statusCode || 502, {
            ...headers,
            'content-encoding': 'gzip',
            vary: 'Accept-Encoding',
          })
          upstreamRes.pipe(createGzip()).pipe(res)
          return
        }
        res.writeHead(upstreamRes.statusCode || 502, headers)
        upstreamRes.pipe(res)
        return
      }

      const chunks = []
      let size = 0
      upstreamRes.on('data', (chunk) => {
        size += chunk.length
        if (size > 8 * 1024 * 1024) {
          proxy.destroy(new Error('rewrite response exceeds 8 MiB'))
          return
        }
        chunks.push(chunk)
      })
      upstreamRes.on('end', () => {
        let body = Buffer.from(publicValue(Buffer.concat(chunks).toString('utf8')))
        const headers = responseHeaders(upstreamRes.headers, true)
        if (wantsGzip(req, headers)) {
          body = gzipSync(body)
          headers['content-encoding'] = 'gzip'
          headers.vary = 'Accept-Encoding'
        }
        res.writeHead(upstreamRes.statusCode || 502, {
          ...headers,
          'content-length': String(body.length),
        })
        res.end(body)
      })
    },
  )

  proxy.setTimeout(300_000, () => proxy.destroy(new Error('PanOffice upstream timed out')))
  proxy.on('error', (error) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: 'PANOFFICE_UPSTREAM_UNAVAILABLE' }))
    } else {
      res.destroy(error)
    }
  })
  req.pipe(proxy)
})

server.listen(listenPort, listenHost, () => {
  console.log(`[panoffice-domain-proxy] ${listenHost}:${listenPort} -> ${upstreamOrigin}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
