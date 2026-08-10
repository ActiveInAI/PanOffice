/**
 * Express app factory for the WOPI host. Wires auth (dev tokens / Arch-GPT
 * JWT), optional coolwsd proof-key validation, WOPI lock ops, PutFile with
 * version archiving, and the dev index/edit pages.
 */
import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
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
    if (!id || id !== basename(id) || id.includes('\0')) return null
    const p = resolve(join(dataDir, id))
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

  // CORS for the PanOffice web shell (browser-side PDF editor calls these
  // endpoints cross-origin). Dev-scoped: only the configured shell origin.
  app.use('/wopi', (req: Request, res: Response, next: NextFunction) => {
    res.set('Access-Control-Allow-Origin', cfg.pdfAppOrigin)
    res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-WOPI-Override, X-WOPI-Lock')
    if (req.method === 'OPTIONS') {
      res.status(204).end()
      return
    }
    next()
  })
  app.use('/wopi', wopiAuth, wopiProof)

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
      res.set('X-WOPI-ItemVersion', versionIdOf(statSync(p)))
      res.status(200).end()
    },
  )

  // ---- dev UI ----

  const tokenChoices = listDevTokenChoices(cfg)
  const defaultToken = tokenChoices[0]?.token ?? ''

  app.get('/healthz', (_req, res) => {
    res.type('text').send('ok')
  })

  // Dev upload: POST /upload?name=<file.ext> with raw bytes → lands in DATA_DIR.
  // Overwrite is allowed (this is a dev store); version archiving still applies
  // to WOPI PutFile saves, not to this plain upload path.
  app.post(
    '/upload',
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
        .then(() => res.status(201).json({ ok: true, name: basename(p) }))
        .catch((e: Error) => res.status(500).send(e.message))
    },
  )

  app.get('/', (_req, res) => {
    const files = existsSync(dataDir)
      ? readdirSync(dataDir)
          .filter((f) => !f.startsWith('.') && statSync(join(dataDir, f)).isFile())
          .sort()
      : []
    const rows = files
      .map((f) => {
        const ext = f.split('.').pop()?.toLowerCase() ?? ''
        const size = statSync(join(dataDir, f)).size
        if (ext === 'pdf') {
          // PDFs open in the PanOffice web editor (real editing), not Collabora's view-only Draw
          const srcTemplate = `${cfg.wopiPublicBase}/wopi/files/${encodeURIComponent(f)}/contents?access_token={T}`
          const href = `${cfg.pdfAppUrl}/#/pdf?src=${encodeURIComponent(srcTemplate.replace('{T}', defaultToken))}`
          const edit = ` — <a class="edit-link pdf-edit" data-pdf-src-template="${escapeHtml(srcTemplate)}" href="${escapeHtml(href)}">edit in PanOffice PDF</a>`
          return `<li><code>${escapeHtml(f)}</code> (${size} B)${edit}</li>`
        }
        const edit = OFFICE_EXTS.has(ext)
          ? ` — <a class="edit-link" href="/edit/${encodeURIComponent(f)}">edit in Collabora</a>`
          : ''
        return `<li><code>${escapeHtml(f)}</code> (${size} B)${edit}</li>`
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
const PDF_APP = ${JSON.stringify(cfg.pdfAppUrl)}
const apply = () => {
  document.querySelectorAll('a.edit-link').forEach((a) => {
    if (a.classList.contains('pdf-edit')) {
      const t = a.getAttribute('data-pdf-src-template').replace('{T}', encodeURIComponent(chooser.value))
      a.setAttribute('href', PDF_APP + '/#/pdf?src=' + encodeURIComponent(t))
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
  // open it right away, same routing as the list: pdf → PanOffice editor, rest → Collabora
  const chooser = document.getElementById('token-chooser')
  const token = chooser ? chooser.value : DEFAULT_TOKEN
  if (/\\.pdf$/i.test(file.name)) {
    const src = ${JSON.stringify(cfg.wopiPublicBase)} + '/wopi/files/' + encodeURIComponent(file.name) + '/contents?access_token=' + encodeURIComponent(token)
    window.location.href = ${JSON.stringify(cfg.pdfAppUrl)} + '/#/pdf?src=' + encodeURIComponent(src)
  } else {
    window.location.href = '/edit/' + encodeURIComponent(file.name) + '?token=' + encodeURIComponent(token)
  }
})
</script>
<p>Collabora: <code>${escapeHtml(cfg.collaboraPublicUrl)}</code></p>
</body></html>`)
  })

  app.get('/edit/:id', async (req: Request, res: Response) => {
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
