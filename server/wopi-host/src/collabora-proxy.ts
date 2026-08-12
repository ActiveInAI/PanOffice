/**
 * Same-origin reverse proxy for Collabora Online (coolwsd).
 *
 * The shell iframes `/browser/<hash>/cool.html` from THIS host and the
 * editor's WebSocket (`/cool/<doc>/ws`) rides the same origin, so the full
 * Collabora UI works through every hop that already carries the shell —
 * LAN, Cloudflare tunnel and the public-domain proxy — without exposing
 * coolwsd itself beyond loopback.
 */
import http from 'node:http'
import net from 'node:net'
import type { Duplex } from 'node:stream'
import type { Request, Response } from 'express'

const PROXY_PREFIXES = ['/browser/', '/cool/']

export function isCollaboraPath(url: string): boolean {
  return PROXY_PREFIXES.some((prefix) => url.startsWith(prefix))
}

export function proxyCollaboraHttp(internalUrl: string, req: Request, res: Response): void {
  const upstream = new URL(internalUrl)
  const proxy = http.request(
    {
      hostname: upstream.hostname,
      port: upstream.port || 80,
      path: req.originalUrl,
      method: req.method,
      // Host is deliberately NOT rewritten: coolwsd derives the WebSocket
      // URL it bakes into cool.html from this header, so forwarding the
      // browser-visible host is what keeps the document socket same-origin.
      headers: { ...req.headers },
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
      upstreamRes.pipe(res)
    },
  )
  proxy.setTimeout(120_000, () => proxy.destroy(new Error('collabora upstream timed out')))
  proxy.on('error', () => {
    if (!res.headersSent) res.status(502).send('Collabora unavailable')
    else res.destroy()
  })
  req.pipe(proxy)
}

/** Tunnel a WebSocket upgrade (`/cool/<doc>/ws`) to coolwsd verbatim. */
export function proxyCollaboraUpgrade(
  internalUrl: string,
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
  const upstream = new URL(internalUrl)
  const conn = net.connect(Number(upstream.port || 80), upstream.hostname, () => {
    const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`]
    // Host stays as the browser sent it (see proxyCollaboraHttp).
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue
      for (const entry of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${entry}`)
    }
    conn.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (head.length > 0) conn.write(head)
    socket.pipe(conn)
    conn.pipe(socket)
  })
  conn.on('error', () => socket.destroy())
  socket.on('error', () => conn.destroy())
  socket.on('close', () => conn.destroy())
  conn.on('close', () => socket.destroy())
}
