import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, normalizePath } from 'vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'

const require = createRequire(import.meta.url)
const rootDir = dirname(fileURLToPath(import.meta.url))
const pdfjsRoot = dirname(dirname(require.resolve('pdfjs-dist/package.json')))
// vite-plugin-static-copy globs require POSIX separators; join() breaks on Windows
const pdfjsDir = (sub: string) => normalizePath(join(pdfjsRoot, 'pdfjs-dist', sub))

// The @genoffice/* workspace packages are consumed as source (their package
// entries point at ./src/index.ts and they are not installed here).
const genoffice = (name: string, entry = 'index.ts') =>
  resolve(rootDir, `../desktop/packages/${name}/src/${entry}`)

// Tauri expects a fixed dev port and no clearing of the screen.
export default defineConfig({
  plugins: [
    react(),
    // pdfjs cmaps/standard fonts/wasm, served at /pdfjs/ (see ASSET_BASE in the pdf renderer)
    viteStaticCopy({
      targets: [
        { src: pdfjsDir('cmaps'), dest: 'pdfjs' },
        { src: pdfjsDir('standard_fonts'), dest: 'pdfjs' },
        { src: pdfjsDir('wasm'), dest: 'pdfjs' },
      ],
    }),
  ],
  clearScreen: false,
  resolve: {
    // The @genoffice/* sources sit outside this package — without dedupe their
    // react imports resolve to ../desktop/node_modules and the bundle ends up
    // with two React copies ("Cannot read properties of null (reading 'useRef')")
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
      // ui's entry re-exports .tsx components; resolve to the file so vite picks the loader
      '@genoffice/ui': genoffice('ui'),
      // slides: pptx-engine is consumed as source and references Node built-ins;
      // shim them for the browser build (vitest keeps the real Node modules)
      'node:crypto': resolve(rootDir, 'src/bridge/node-shims/crypto.ts'),
      'node:zlib': resolve(rootDir, 'src/bridge/node-shims/zlib.ts'),
    },
  },
  server: {
    port: 5180,
    strictPort: true,
  },
  build: {
    // tauri.conf.json frontendDist points at ../dist
    outDir: 'dist',
  },
})
