import { defineConfig } from '@playwright/test'

/**
 * Headless e2e for the ported editors. Runs against the production build
 * (`vite preview`); `npm run test:e2e` chains `build:ui` first so dist/ and
 * the fixture are always fresh. The sheets editor additionally needs the
 * xlsx sidecar dev server (browser-mode xlsx-RPC transport).
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4180',
    headless: true,
  },
  webServer: [
    {
      command: 'npx vite preview --port 4180 --strictPort',
      port: 4180,
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: 'node tools/xlsx-sidecar-server.mjs',
      port: 8791,
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      // wopi-host serving deploy/data/files (the pdf-web spec writes through it)
      command:
        'PORT=3210 DATA_DIR=../deploy/data/files WOPI_PUBLIC_BASE=http://127.0.0.1:3210 COLLABORA_INTERNAL_URL=http://127.0.0.1:9982 COLLABORA_PUBLIC_URL=http://127.0.0.1:9982 WOPI_ALLOW_DEV_TOKEN=true WOPI_DEV_UI_ENABLED=true PDF_APP_URL=http://localhost:4180 node ../server/wopi-host/dist/index.js',
      port: 3210,
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
})
