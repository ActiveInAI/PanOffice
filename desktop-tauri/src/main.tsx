import { createRoot } from 'react-dom/client'
import { App } from './App'
import { installBridge } from './bridge'

// Install the window.* compatibility shims (Tauri-backed) before any
// renderer code runs — ported GenOffice renderers expect them on boot.
installBridge()

// No StrictMode: the ported renderers were built upstream without it and are
// not safe under its double-effect pass (window.pdfApi.consumePending() is
// single-shot; pdfjs render tasks would be cancelled and restarted).
createRoot(document.getElementById('root')!).render(<App />)
