/**
 * Express app factory for the WOPI host. Wires auth (dev tokens / Arch-GPT
 * JWT), optional coolwsd proof-key validation, WOPI lock ops, PutFile with
 * version archiving, and the dev index/edit pages.
 */
import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { canWrite, listDevTokenChoices, TokenResolver } from './auth.js'
import type { WopiHostConfig, WopiUser } from './config.js'
import { LockManager } from './locks.js'
import { ProofKeyProvider, validateProof } from './proof.js'
import { KeyedMutex, versionIdOf, VersionStore } from './versions.js'

/** Extensions Collabora can usually open; the discovery check decides per file. */
const OFFICE_EXTS = new Set([
  'docx', 'doc', 'odt', 'rtf', 'txt', 'xlsx', 'xls', 'ods', 'csv', 'pptx', 'ppt', 'odp', 'pdf',
])

/** Extensions our own GenOffice web editors open, mapped to the shell hash route. */
const SHELL_ROUTES: Record<string, string> = { docx: 'docs', xlsx: 'sheets', pptx: 'slides' }

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function userOf(res: Response): WopiUser {
  return res.locals.user as WopiUser
}

export interface WopiHostApp {
  app: Express
  locks: LockManager
  versions: VersionStore
  resolver: TokenResolver
}

export async function createApp(cfg: WopiHostConfig): Promise<WopiHostApp> {
  const dataDir = resolve(cfg.dataDir)
  const locksFile = join(dataDir, '.wopi-locks.json')
  const locks = await LockManager.load(locksFile, cfg.lockTtlMs)
  const versions = new VersionStore(dataDir, cfg.versionCap)
  const resolver = new TokenResolver(cfg)
  const proofProvider = new ProofKeyProvider(`${cfg.collaboraInternalUrl}/hosting/discovery`)
  const putMutex = new KeyedMutex()

  /** Map a WOPI file id to a path inside dataDir, or null if it escapes. */
  function filePathFor(id: string): string | null {
    if (!id || id.includes('\0')) return null
    const normalized = id.replace(/\\/g, '/')
    if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return null
    const p = resolve(join(dataDir, normalized))
    return p.startsWith(dataDir + sep) ? p : null
  }

  function tokenFrom(req: Request): string {
    const q = req.query.access_token
    if (typeof q === 'string' && q) return q
    const bearer = req.get('authorization')
    if (bearer?.startsWith('Bearer ')) return bearer.slice('Bearer '.length)
    return ''
  }

  async function wopiAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    const token = tokenFrom(req)
    const user = token ? await resolver.resolve(token) : null
    if (!user) {
      res.status(401).send('invalid access token')
      return
    }
    res.locals.user = user
    res.locals.accessToken = token
    next()
  }

  async function wopiProof(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!cfg.proofRequired) {
      next()
      return
    }
    const verdict = await validateProof(
      {
        url: `${cfg.wopiPublicBase}${req.originalUrl}`,
        accessToken: res.locals.accessToken as string,
        timestampHeader: req.get('X-WOPI-TimeStamp'),
        proofHeader: req.get('X-WOPI-Proof'),
        proofOldHeader: req.get('X-WOPI-ProofOld'),
      },
      proofProvider,
      cfg.proofMaxSkewMs,
    )
    if (!verdict.ok) {
      res.status(401).send(`WOPI proof validation failed: ${verdict.reason}`)
      return
    }
    next()
  }

  /** 404 unless :id maps to an existing file; puts the path in res.locals.filePath. */
  function requireFile(req: Request, res: Response, next: NextFunction): void {
    const p = filePathFor(req.params.id)
    if (!p || !existsSync(p)) {
      res.status(404).json({ error: 'no such file' })
      return
    }
    res.locals.filePath = p
    next()
  }

  /** Only top-level, non-hidden regular files shown by /files.json are
   * deletable from the shell file manager. Internal archives and directories
   * must never become reachable through the delete endpoint. */
  function requireListedFile(req: Request, res: Response, next: NextFunction): void {
    const id = req.params.id
    const normalized = id.replace(/\\/g, '/')
    const p = !normalized.startsWith('.') && !normalized.includes('/') ? filePathFor(id) : null
    if (!p || !existsSync(p) || !statSync(p).isFile()) {
      res.status(404).json({ error: 'no such file' })
      return
    }
    res.locals.filePath = p
    next()
  }

  function requireWrite(req: Request, res: Response, next: NextFunction): void {
    if (!canWrite(userOf(res), req.params.id)) {
      res.status(403).send('read-only access')
      return
    }
    next()
  }

  // ---- Collabora discovery: ext -> urlsrc (prefer the "edit" action) ----

  let discoveryCache: { at: number; map: Map<string, string> } | null = null

  async function fetchDiscoveryMap(): Promise<Map<string, string>> {
    if (discoveryCache && Date.now() - discoveryCache.at < 60_000) return discoveryCache.map
    const res = await fetch(`${cfg.collaboraInternalUrl}/hosting/discovery`, {
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) throw new Error(`discovery HTTP ${res.status}`)
    const xml = await res.text()
    const viewComment = new Map<string, string>()
    const view = new Map<string, string>()
    const edit = new Map<string, string>()
    for (const m of xml.matchAll(/<action\s+[^>]*>/g)) {
      const tag = m[0]
      const ext = /ext="([^"]+)"/.exec(tag)?.[1]?.toLowerCase()
      const name = /name="([^"]+)"/.exec(tag)?.[1]
      const urlsrc = /urlsrc="([^"]+)"/.exec(tag)?.[1]
      if (!ext || !urlsrc) continue
      const url = urlsrc.replace(/&amp;/g, '&')
      if (name === 'edit') edit.set(ext, url)
      else if (name === 'view' && !view.has(ext)) view.set(ext, url)
      // PDFs etc. are offered as view_comment only — last-resort fallback
      else if (name === 'view_comment' && !viewComment.has(ext)) viewComment.set(ext, url)
    }
    const map = new Map<string, string>([...viewComment, ...view, ...edit])
    discoveryCache = { at: Date.now(), map }
    return map
  }

  // ---- WOPI endpoints ----

  const app = express()

  // CORS for the PanOffice web shell (browser-side editors call these
  // endpoints cross-origin). Dev-scoped: only the configured shell origin.
  // Covers WOPI plus the shell's file-manager endpoints (/files.json, /upload).
  function shellCors(req: Request, res: Response, next: NextFunction): void {
    res.set('Access-Control-Allow-Origin', cfg.pdfAppOrigin)
    res.set('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS')
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-WOPI-Override, X-WOPI-Lock')
    if (req.method === 'OPTIONS') {
      res.status(204).end()
      return
    }
    next()
  }
  app.use('/wopi', shellCors)
  app.use('/files.json', shellCors)
  app.use('/upload', shellCors)
  app.use('/wopi', wopiAuth, wopiProof)

  function requireShellOrigin(req: Request, res: Response, next: NextFunction): void {
    if (req.get('origin') !== cfg.pdfAppOrigin) {
      res.status(403).json({ ok: false, error: { code: 'forbidden', message: 'Invalid shell origin.' } })
      return
    }
    next()
  }

  // PanAI runs through a same-origin, server-managed bridge. The browser never
  // receives the loopback URL or bearer credential; the server also forces the
  // configured model so a document prompt cannot select an arbitrary backend.
  const panAiEnabled = Boolean(cfg.panAiBridgeUrl && cfg.panAiBridgeToken)

  app.get('/panai/config', (_req, res) => {
    res.set('Cache-Control', 'no-store')
    res.json({ enabled: panAiEnabled, model: panAiEnabled ? cfg.panAiModel : '' })
  })

  app.post(
    '/panai/turn',
    requireShellOrigin,
    express.json({ type: 'application/json', limit: '1mb', strict: true }),
    async (req: Request, res: Response) => {
      if (!panAiEnabled) {
        res.status(503).json({ ok: false, error: 'PanAI service is not configured.' })
        return
      }
      const prompt = (req.body as { prompt?: unknown } | undefined)?.prompt
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 512_000) {
        res.status(400).json({ ok: false, error: 'Invalid PanAI prompt.' })
        return
      }

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 180_000)
      const abort = () => controller.abort()
      req.once('aborted', abort)
      try {
        const upstream = await fetch(`${cfg.panAiBridgeUrl!}/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${cfg.panAiBridgeToken!}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: cfg.panAiModel,
            stream: false,
            messages: [
              {
                role: 'system',
                content:
                  '你是 PanAI 的 Office 智能体。严格遵循用户消息中的 SYSTEM、AVAILABLE_TOOLS 和 MESSAGES；需要工具时只返回指定的 tool_calls JSON。',
              },
              { role: 'user', content: prompt },
            ],
          }),
          redirect: 'error',
          signal: controller.signal,
        })
        if (!upstream.ok) {
          res.status(502).json({ ok: false, error: `PanAI upstream HTTP ${upstream.status}.` })
          return
        }
        const payload = (await upstream.json()) as {
          choices?: Array<{ message?: { content?: unknown } }>
        }
        const text = payload.choices?.[0]?.message?.content
        if (typeof text !== 'string' || !text.trim()) {
          res.status(502).json({ ok: false, error: 'PanAI upstream returned no content.' })
          return
        }
        res.set('Cache-Control', 'no-store')
        res.json({ ok: true, text, model: cfg.panAiModel })
      } catch (error) {
        const timedOut = controller.signal.aborted
        res.status(timedOut ? 504 : 502).json({
          ok: false,
          error: timedOut ? 'PanAI upstream timed out.' : 'PanAI upstream is unavailable.',
        })
      } finally {
        clearTimeout(timeout)
        req.off('aborted', abort)
      }
    },
  )

  // Browser-mode spreadsheets need the native XLSX engine. Keep that engine
  // on loopback and expose only this origin-checked, same-origin RPC bridge.
  if (cfg.xlsxRpcUrl) {
    /**
     * `host.stage_store_file` is answered here instead of being forwarded:
     * the workbook already sits in this host's file store, so it is staged
     * for the sidecar server-side. The browser then never downloads and
     * re-uploads the bytes just to open a document — over a far link that
     * round trip dominated open time and large bodies aborted outright.
     */
    async function stageStoreFile(
      envelope: { requestId?: unknown; name?: unknown },
      res: Response,
    ): Promise<void> {
      const requestId = typeof envelope.requestId === 'string' ? envelope.requestId : ''
      const name = typeof envelope.name === 'string' ? envelope.name : ''
      const p = filePathFor(name)
      const fail = (code: string, message: string, status = 200): void => {
        res.status(status).json({ version: 1, requestId, ok: false, error: { code, message } })
      }
      if (!p || !existsSync(p) || !statSync(p).isFile()) {
        fail('not_found', 'No such store file.')
        return
      }
      try {
        const bytes = await readFile(p)
        const upstream = await fetch(cfg.xlsxRpcUrl!, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            version: 1,
            requestId,
            command: 'host.stage',
            path: `local/${name}`,
            base64: bytes.toString('base64'),
          }),
          redirect: 'error',
          signal: AbortSignal.timeout(190_000),
        })
        const payload = (await upstream.json().catch(() => null)) as {
          ok?: boolean
          result?: { path?: unknown }
        } | null
        if (!upstream.ok || payload?.ok !== true || typeof payload.result?.path !== 'string') {
          fail('stage_failed', 'XLSX staging failed.', 502)
          return
        }
        res.set('Cache-Control', 'no-store')
        res.json({
          version: 1,
          requestId,
          ok: true,
          result: {
            path: payload.result.path,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            size: bytes.length,
          },
        })
      } catch {
        fail('stage_failed', 'XLSX staging failed.', 502)
      }
    }

    app.post(
      '/xlsx-sidecar/rpc',
      requireShellOrigin,
      express.raw({ type: 'application/json', limit: '512mb' }),
      async (req: Request, res: Response) => {
        if (!Buffer.isBuffer(req.body)) {
          res.status(415).json({
            ok: false,
            error: { code: 'unsupported_media_type', message: 'Expected application/json.' },
          })
          return
        }
        // Only small control envelopes are worth parsing for interception;
        // byte-carrying commands (host.stage uploads) pass through untouched.
        if (req.body.length < 4096) {
          try {
            const envelope = JSON.parse(req.body.toString('utf8')) as {
              command?: unknown
              requestId?: unknown
              name?: unknown
            }
            if (envelope.command === 'host.stage_store_file') {
              await stageStoreFile(envelope, res)
              return
            }
          } catch {
            // not JSON we understand — the sidecar will answer it
          }
        }
        try {
          const upstream = await fetch(cfg.xlsxRpcUrl!, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: req.body as unknown as BodyInit,
            redirect: 'error',
            signal: AbortSignal.timeout(190_000),
          })
          const body = Buffer.from(await upstream.arrayBuffer())
          res.status(upstream.status)
          res.type(upstream.headers.get('content-type') ?? 'application/json')
          res.set('Cache-Control', 'no-store')
          res.send(body)
        } catch {
          res.status(502).json({
            ok: false,
            error: { code: 'xlsx_rpc_unavailable', message: 'XLSX service unavailable.' },
          })
        }
      },
    )
  }

  // PanOffice Web 壳（GenOffice 编辑器）挂载在根路径；API 路由不受影响。
  if (cfg.shellDir) {
    app.use(
      express.static(resolve(cfg.shellDir), {
        index: 'index.html',
        extensions: ['html'],
        setHeaders: (res, filePath) => {
          // HTML must revalidate on every navigation and the hashed bundles
          // it references are immutable — a deploy must never strand a
          // browser-cached page on asset URLs that stopped existing.
          if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache')
          } else if (filePath.includes(`${sep}assets${sep}`)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
          }
        },
      }),
    )
  }

  // CheckFileInfo
  app.get('/wopi/files/:id', requireFile, (req: Request, res: Response) => {
    const st = statSync(res.locals.filePath as string)
    const user = userOf(res)
    const vid = versionIdOf(st)
    res.json({
      BaseFileName: req.params.id,
      OwnerId: 'panoffice-dev',
      Size: st.size,
      UserId: user.userId,
      UserFriendlyName: user.name,
      UserCanWrite: canWrite(user, req.params.id),
      SupportsUpdate: true,
      SupportsLocks: true,
      SupportsGetLock: true,
      Version: vid,
      CurrentVersion: vid,
      LastModifiedTime: st.mtime.toISOString(),
    })
  })

  // GetFile
  app.get('/wopi/files/:id/contents', requireFile, (req: Request, res: Response) => {
    const p = res.locals.filePath as string
    res.set('Content-Type', 'application/octet-stream')
    res.set('X-WOPI-ItemVersion', versionIdOf(statSync(p)))
    createReadStream(p).pipe(res)
  })

  // Delete a file exposed by the shell file manager. This is an authenticated
  // write operation and is serialized with PutFile so save/delete cannot race.
  // Locked files stay intact until their editor releases the WOPI lock.
  app.delete(
    '/wopi/files/:id',
    requireListedFile,
    requireWrite,
    async (req: Request, res: Response) => {
      const id = req.params.id
      const current = locks.get(id)
      if (current) {
        res.set('X-WOPI-Lock', current.token)
        res.status(409).json({ error: 'file is locked' })
        return
      }
      try {
        await putMutex.runExclusive(id, async () => {
          const p = res.locals.filePath as string
          if (!existsSync(p) || !statSync(p).isFile()) {
            const error = new Error('no such file') as NodeJS.ErrnoException
            error.code = 'ENOENT'
            throw error
          }
          await unlink(p)
        })
        console.log(`[store] delete ${id} by=${userOf(res).userId} ip=${req.ip}`)
        res.status(204).end()
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          res.status(404).json({ error: 'no such file' })
          return
        }
        res.status(500).json({ error: 'delete failed' })
      }
    },
  )

  // Versions listing (dev extension; archives live under dataDir/.versions)
  app.get('/wopi/files/:id/versions', requireFile, async (req: Request, res: Response) => {
    const st = statSync(res.locals.filePath as string)
    res.json({
      fileId: req.params.id,
      currentVersion: versionIdOf(st),
      versions: await versions.list(req.params.id),
    })
  })

  // Lock ops routed by X-WOPI-Override (LOCK / UNLOCK / REFRESH_LOCK / GET_LOCK)
  app.post('/wopi/files/:id', requireFile, async (req: Request, res: Response) => {
    const id = req.params.id
    const override = (req.get('X-WOPI-Override') ?? '').toUpperCase()
    const lockToken = req.get('X-WOPI-Lock') ?? ''

    const conflict = (currentToken: string) => {
      res.set('X-WOPI-Lock', currentToken)
      res.status(409).send('lock conflict')
    }

    switch (override) {
      case 'LOCK': {
        if (!canWrite(userOf(res), id)) {
          res.status(403).send('read-only access')
          return
        }
        if (!lockToken) {
          res.status(400).send('missing X-WOPI-Lock')
          return
        }
        const result = await locks.lock(id, lockToken)
        if (!result.ok) {
          conflict(result.current.token)
          return
        }
        res.status(200).end()
        return
      }
      case 'UNLOCK':
      case 'REFRESH_LOCK': {
        if (!canWrite(userOf(res), id)) {
          res.status(403).send('read-only access')
          return
        }
        if (!lockToken) {
          res.status(400).send('missing X-WOPI-Lock')
          return
        }
        const result =
          override === 'UNLOCK' ? await locks.unlock(id, lockToken) : await locks.refresh(id, lockToken)
        if (result === 'ok') {
          res.status(200).end()
          return
        }
        conflict(locks.get(id)?.token ?? '')
        return
      }
      case 'GET_LOCK': {
        res.set('X-WOPI-Lock', locks.get(id)?.token ?? '')
        res.status(200).end()
        return
      }
      default:
        res.status(501).send(`unsupported X-WOPI-Override: ${override || '(none)'}`)
    }
  })

  // PutFile — archive previous bytes, then write to a temp sibling and rename,
  // so a failed save never truncates the previous version.
  app.post(
    '/wopi/files/:id/contents',
    requireFile,
    requireWrite,
    express.raw({ type: () => true, limit: '256mb' }),
    async (req: Request, res: Response) => {
      const id = req.params.id
      const p = res.locals.filePath as string
      const current = locks.get(id)
      if (current && (req.get('X-WOPI-Lock') ?? '') !== current.token) {
        res.set('X-WOPI-Lock', current.token)
        res.status(409).send('lock conflict')
        return
      }
      await putMutex.runExclusive(id, async () => {
        await versions.archiveBeforeWrite(id, p)
        const tmp = `${p}.tmp-${process.pid}`
        await writeFile(tmp, req.body as Buffer)
        await rename(tmp, p)
      })
      console.log(
        `[store] putfile ${id} ${(req.body as Buffer).length}B by=${userOf(res).userId} ip=${req.ip}`,
      )
      res.set('X-WOPI-ItemVersion', versionIdOf(statSync(p)))
      res.status(200).end()
    },
  )

  // ---- dev UI ----

  const tokenChoices = listDevTokenChoices(cfg)
  const defaultToken = tokenChoices[0]?.token ?? ''

  function requireDevUi(_req: Request, res: Response, next: NextFunction): void {
    if (!cfg.devUiEnabled) {
      res.status(404).json({ error: 'not found' })
      return
    }
    next()
  }

  interface ListedFile {
    name: string
    size: number
    mtimeMs: number
    /** Authorized WOPI contents URL for the explicitly enabled shell UI. */
    contentUrl?: string
  }

  /** Visible files in dataDir (dotfiles and internal dirs stay hidden), sorted by name. */
  function listFiles(): ListedFile[] {
    if (!existsSync(dataDir)) return []
    return readdirSync(dataDir)
      .filter((f) => !f.startsWith('.'))
      .flatMap((f) => {
        const st = statSync(join(dataDir, f))
        return st.isFile()
          ? [{
              name: f,
              size: st.size,
              mtimeMs: st.mtimeMs,
              ...(defaultToken
                ? {
                    contentUrl: `${cfg.wopiPublicBase}/wopi/files/${encodeURIComponent(f)}/contents?access_token=${encodeURIComponent(defaultToken)}`,
                  }
                : {}),
            }]
          : []
      })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }

  app.get('/healthz', (_req, res) => {
    res.type('text').send('ok')
  })

  // File listing for the web shell's file-manager home (JSON sibling of the
  // dev index page; CORS-enabled via the shellCors mount above).
  app.get('/files.json', requireDevUi, (_req, res) => {
    res.json(listFiles())
  })

  // Dev upload: POST /upload?name=<file.ext> with raw bytes → lands in DATA_DIR.
  // Overwrite is allowed (this is a dev store); version archiving still applies
  // to WOPI PutFile saves, not to this plain upload path.
  app.post(
    '/upload',
    requireDevUi,
    express.raw({ type: () => true, limit: '256mb' }),
    (req: Request, res: Response) => {
      const name = String(req.query.name ?? '')
      const p = filePathFor(name)
      if (!p) {
        res.status(400).send('bad file name')
        return
      }
      const tmp = `${p}.tmp-${process.pid}`
      writeFile(tmp, req.body as Buffer)
        .then(() => rename(tmp, p))
        .then(() => {
          // Store mutations are logged — a vanished file must be traceable.
          console.log(`[store] upload ${basename(p)} ${(req.body as Buffer).length}B ip=${req.ip}`)
          res.status(201).json({ ok: true, name: basename(p) })
        })
        .catch((e: Error) => res.status(500).send(e.message))
    },
  )

  app.get('/', requireDevUi, (_req, res) => {
    // Shell-editor link: the src template keeps {T} so the token chooser can
    // re-token every link client-side without a page reload.
    const shellLink = (f: string, app: string, label: string, cls: string): string => {
      const srcTemplate = `${cfg.wopiPublicBase}/wopi/files/${encodeURIComponent(f)}/contents?access_token={T}`
      const href = `${cfg.pdfAppUrl}/#/${app}?src=${encodeURIComponent(srcTemplate.replace('{T}', defaultToken))}`
      return ` — <a class="edit-link ${cls}" data-src-template="${escapeHtml(srcTemplate)}" href="${escapeHtml(href)}">${label}</a>`
    }
    const rows = listFiles()
      .map(({ name: f, size }) => {
        const ext = f.split('.').pop()?.toLowerCase() ?? ''
        if (ext === 'pdf') {
          // PDFs open in the PanOffice web editor (real editing), not Collabora's view-only Draw
          const edit = shellLink(f, 'pdf', 'edit in PanOffice PDF', 'pdf-edit')
          return `<li><code>${escapeHtml(f)}</code> (${size} B)${edit}</li>`
        }
        let links = ''
        const shellRoute = SHELL_ROUTES[ext]
        if (shellRoute) {
          // docx/xlsx/pptx: our GenOffice editors are the web mainline…
          links += shellLink(f, shellRoute, 'PanOffice 编辑器', 'shell-edit')
        }
        if (OFFICE_EXTS.has(ext)) {
          // …with Collabora kept as the real-time collaboration option
          links += ` — <a class="edit-link" href="/edit/${encodeURIComponent(f)}">edit in Collabora</a>`
        }
        return `<li><code>${escapeHtml(f)}</code> (${size} B)${links}</li>`
      })
      .join('\n')
    const chooser =
      tokenChoices.length > 1
        ? `<p>Acting as: <select id="token-chooser">${tokenChoices
            .map(
              (c, i) =>
                `<option value="${escapeHtml(c.token)}"${i === 0 ? ' selected' : ''}>${escapeHtml(c.label)}</option>`,
            )
            .join('')}</select></p>
<script>
const chooser = document.getElementById('token-chooser')
const apply = () => {
  document.querySelectorAll('a.edit-link').forEach((a) => {
    const tpl = a.getAttribute('data-src-template')
    if (tpl !== null) {
      // PanOffice editor links: swap {T} in the WOPI src, keep the shell route
      const t = tpl.replace('{T}', encodeURIComponent(chooser.value))
      const prefix = a.getAttribute('href').split('?src=')[0]
      a.setAttribute('href', prefix + '?src=' + encodeURIComponent(t))
      return
    }
    const base = a.getAttribute('href').split('?')[0]
    a.setAttribute('href', base + '?token=' + encodeURIComponent(chooser.value))
  })
}
chooser.addEventListener('change', apply)
apply()
</script>`
        : tokenChoices.length === 1
          ? `<p>Acting as: <code>${escapeHtml(tokenChoices[0].label)}</code></p>`
          : '<p><i>No dev tokens configured — pass <code>?token=&lt;jwt&gt;</code> on /edit links.</i></p>'
    res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>PanOffice WOPI host (dev)</title></head>
<body>
<h1><svg width="28" height="28" viewBox="0 0 96 96" style="vertical-align:-5px" aria-label="PanOffice logo"><polygon points="48 8 55.65 29.52 76.28 19.72 66.48 40.35 88 48 66.48 55.65 76.28 76.28 55.65 66.48 48 88 40.35 66.48 19.72 76.28 29.52 55.65 8 48 29.52 40.35 19.72 19.72 40.35 29.52" fill="#f4c542"/><circle cx="48" cy="48" r="20" fill="#fff1bf"/></svg> PanOffice WOPI host (dev)</h1>
${chooser}
<p>Files in <code>${escapeHtml(dataDir)}</code>:</p>
<ul>
${rows || '<li><i>(empty — upload something below)</i></li>'}
</ul>
<form id="upload-form" style="margin:12px 0">
  <input type="file" id="upload-input" name="file" required
    accept=".docx,.doc,.odt,.rtf,.txt,.xlsx,.xls,.ods,.csv,.pptx,.ppt,.odp,.pdf" />
  <button type="submit">Upload &amp; open</button>
</form>
<script>
const DEFAULT_TOKEN = ${JSON.stringify(defaultToken)}
document.getElementById('upload-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const input = document.getElementById('upload-input')
  const file = input.files && input.files[0]
  if (!file) return
  const res = await fetch('/upload?name=' + encodeURIComponent(file.name), {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  })
  if (!res.ok) { alert('upload failed: HTTP ' + res.status); return }
  // open it right away, same routing as the list: pdf/docx/xlsx/pptx → the
  // PanOffice editors, everything else → Collabora
  const chooser = document.getElementById('token-chooser')
  const token = chooser ? chooser.value : DEFAULT_TOKEN
  const m = /\\.(pdf|docx|xlsx|pptx)$/i.exec(file.name)
  if (m) {
    const app = { pdf: 'pdf', docx: 'docs', xlsx: 'sheets', pptx: 'slides' }[m[1].toLowerCase()]
    const src = ${JSON.stringify(cfg.wopiPublicBase)} + '/wopi/files/' + encodeURIComponent(file.name) + '/contents?access_token=' + encodeURIComponent(token)
    window.location.href = ${JSON.stringify(cfg.pdfAppUrl)} + '/#/' + app + '?src=' + encodeURIComponent(src)
  } else {
    window.location.href = '/edit/' + encodeURIComponent(file.name) + '?token=' + encodeURIComponent(token)
  }
})
</script>
<p>Collabora: <code>${escapeHtml(cfg.collaboraPublicUrl)}</code></p>
</body></html>`)
  })

  app.get('/edit/:id', requireDevUi, async (req: Request, res: Response) => {
    const id = req.params.id
    const p = filePathFor(id)
    if (!p || !existsSync(p)) {
      res.status(404).send('no such file')
      return
    }
    const q = req.query.token
    const token = (typeof q === 'string' && q) || defaultToken
    if (!token) {
      res.status(401).send('no usable access token — configure dev tokens or pass ?token=<jwt>')
      return
    }
    const ext = id.split('.').pop()?.toLowerCase() ?? ''
    let map: Map<string, string>
    try {
      map = await fetchDiscoveryMap()
    } catch (err) {
      res
        .status(502)
        .send(
          `cannot reach Collabora discovery at ${cfg.collaboraInternalUrl} ` +
            `(${(err as Error).message}) — is the collabora service up?`,
        )
      return
    }
    const urlsrc = map.get(ext)
    if (!urlsrc) {
      res.status(415).send(`Collabora discovery has no app for ".${ext}"`)
      return
    }
    // urlsrc points at coolwsd as this host sees it; rewrite the origin to
    // the browser-visible one.
    const u = new URL(urlsrc)
    const base = `${cfg.collaboraPublicUrl}${u.pathname}${u.search}`.replace(/\?+$/, '')
    const wopiSrc = encodeURIComponent(`${cfg.wopiPublicBase}/wopi/files/${encodeURIComponent(id)}`)
    const frameSrc = `${base}?WOPISrc=${wopiSrc}&access_token=${encodeURIComponent(token)}`
    res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(id)} — PanOffice</title>
<style>
html,body{margin:0;height:100%}
iframe{border:0;width:100%;height:calc(100% - 38px)}
.po-topbar{display:flex;align-items:center;gap:10px;height:38px;padding:0 12px;box-sizing:border-box;border-bottom:1px solid #e5e7eb;background:#f9fafb;font:13px system-ui,sans-serif}
.po-topbar a{color:#2563eb;text-decoration:none}
.po-topbar a:hover{text-decoration:underline}
.po-topbar .name{color:#374151}
</style></head>
<body>
<div class="po-topbar">
  <svg width="20" height="20" viewBox="0 0 96 96" aria-hidden="true"><polygon points="48 8 55.65 29.52 76.28 19.72 66.48 40.35 88 48 66.48 55.65 76.28 76.28 55.65 66.48 48 88 40.35 66.48 19.72 76.28 29.52 55.65 8 48 29.52 40.35 19.72 19.72 40.35 29.52" fill="#f4c542"/><circle cx="48" cy="48" r="20" fill="#fff1bf"/></svg>
  <a href="/">&larr; 文件列表 / 上传</a>
  <span class="name">${escapeHtml(id)}</span>
</div>
<iframe src="${escapeHtml(frameSrc)}" allowfullscreen></iframe></body></html>`)
  })

  return { app, locks, versions, resolver }
}

/** dataDir must exist before serving; called once by the entrypoint. */
export async function ensureDataDir(cfg: WopiHostConfig): Promise<void> {
  await mkdir(resolve(cfg.dataDir), { recursive: true })
}
