import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const rootDir = dirname(fileURLToPath(import.meta.url))

const genoffice = (name: string, entry = 'index.ts') =>
  resolve(rootDir, `../desktop/packages/${name}/src/${entry}`)

export default defineConfig({
  resolve: {
    // same reasoning as vite.config.ts: force a single react copy (ai-panel-collapse renders AiPanel)
    dedupe: ['react', 'react-dom'],
    alias: {
      // Subpath before the bare name: string aliases are prefix replacements
      '@genoffice/pptx-engine/src/smartart-layout': genoffice('pptx-engine', 'smartart-layout.ts'),
      '@genoffice/pptx-engine/table-grid': genoffice('pptx-engine', 'table-grid.ts'),
      '@genoffice/agent-core': genoffice('agent-core'),
      '@genoffice/ai-provider': genoffice('ai-provider'),
      '@genoffice/docx-engine': genoffice('docx-engine'),
      '@genoffice/i18n': genoffice('i18n'),
      '@genoffice/pptx-engine': genoffice('pptx-engine'),
      '@genoffice/pptx-render': genoffice('pptx-render'),
      '@genoffice/project-store': genoffice('project-store'),
      '@genoffice/ui': genoffice('ui'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'jsdom',
    testTimeout: 20000,
  },
})
