/**
 * @panoffice/wopi-host — WOPI host bridging Collabora Online to a local
 * directory. M5 hardening: per-user tokens (dev map / Arch-GPT JWT), WOPI
 * locks persisted to disk, version archiving, optional coolwsd proof-key
 * validation. Still localhost/dev unless proof keys and TLS are on.
 *
 * WOPI flow: the browser loads /edit/<file>, which iframes coolwsd's
 * urlsrc (from its discovery endpoint) with WOPISrc pointing back here;
 * coolwsd then calls CheckFileInfo / GetFile / PutFile / lock ops below.
 */
import { resolve } from 'node:path'
import { createApp, ensureDataDir } from './app.js'
import { listDevTokenChoices } from './auth.js'
import { isCollaboraPath, proxyCollaboraUpgrade } from './collabora-proxy.js'
import { loadConfigFromEnv } from './config.js'

const cfg = loadConfigFromEnv()

await ensureDataDir(cfg)
const { app } = await createApp(cfg)

const server = app.listen(cfg.port, () => {
  console.log(`[wopi-host] listening on :${cfg.port}`)
  console.log(`[wopi-host] data dir: ${resolve(cfg.dataDir)}`)
  console.log(`[wopi-host] WOPISrc base (as coolwsd sees us): ${cfg.wopiPublicBase}`)
  console.log(`[wopi-host] collabora internal: ${cfg.collaboraInternalUrl}  public: ${cfg.collaboraPublicUrl}`)
  console.log(
    `[wopi-host] auth: dev-token ${cfg.allowDevToken ? 'ENABLED' : 'disabled'}, ` +
      `${Object.keys(cfg.devTokens).length} WOPI_TOKENS_JSON entr${Object.keys(cfg.devTokens).length === 1 ? 'y' : 'ies'}, ` +
      `jwt-hs256 ${cfg.jwtSecret ? 'on' : 'off'}, jwt-jwks ${cfg.jwksUrl ?? 'off'}`,
  )
  console.log(`[wopi-host] proof keys ${cfg.proofRequired ? 'REQUIRED' : 'not required'}; lock ttl ${cfg.lockTtlMs / 60000}min; version cap ${cfg.versionCap}`)
  if (cfg.allowDevToken || Object.keys(cfg.devTokens).length > 0) {
    console.log(`[wopi-host] dev token choices: ${listDevTokenChoices(cfg).map((c) => c.label).join(' | ')}`)
  }
})

// Collabora document sessions speak WebSocket (/cool/<doc>/ws); tunnel the
// upgrade to coolwsd so the editor works through the same-origin proxy.
if (cfg.collaboraSameOrigin) {
  server.on('upgrade', (req, socket, head) => {
    if (req.url && isCollaboraPath(req.url)) {
      proxyCollaboraUpgrade(cfg.collaboraInternalUrl, req, socket, head)
    } else {
      socket.destroy()
    }
  })
}
