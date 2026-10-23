import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'

// Self-hosted fonts so the app looks right offline (Talkline itself never loaded them).
import '@fontsource/baloo-2/latin-800.css'
import '@fontsource/quicksand/latin-500.css'
import '@fontsource/quicksand/latin-600.css'
import '@fontsource/quicksand/latin-700.css'
import './styles/tokens.css'
import './styles/global.css'

import App from './App'
import { useApp } from './state/store'
import { hasPendingSaves } from './lib/storage'

/**
 * A new version finished installing. Reloading mid-session would wipe a child's
 * world, stickers or a recording, so only reload when nothing can be lost: on Home,
 * or while the app is hidden on any screen except Make. Kids never see a prompt.
 */
function safeToReload(): boolean {
  const { screen } = useApp.getState()
  if (screen === 'make') return false
  return screen === 'home' || document.hidden
}

let reloadPending = false
function reloadWhenSafe() {
  if (reloadPending) return
  reloadPending = true
  let retry = 0
  const tryReload = () => {
    if (!safeToReload()) return
    // Keep → Home right after a capture: the gallery save may still be writing, and a
    // reload now would abort it. Check again shortly.
    if (hasPendingSaves()) {
      window.clearTimeout(retry)
      retry = window.setTimeout(tryReload, 300)
      return
    }
    unsubscribe()
    document.removeEventListener('visibilitychange', tryReload)
    window.location.reload()
  }
  const unsubscribe = useApp.subscribe(tryReload)
  document.addEventListener('visibilitychange', tryReload)
  tryReload()
}

// Classrooms often have flaky wifi: cache the app shell right away.
registerSW({ immediate: true, onNeedReload: reloadWhenSafe })

// Warm the lazy keyer chunks (segmenter + MediaPipe JS) soon after start, without creating
// the segmenter: if an app update lands mid-session, the old hashed chunks are gone from
// the server, and a first import('./lib/segmenter') in the middle of Make would 404.
function warmLazyChunks() {
  import('./lib/segmenter')
    .then((m) => m.preloadVisionLib())
    .catch(() => {
      /* offline or blocked: the stage loads it later the normal way */
    })
}
const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }
if (w.requestIdleCallback) w.requestIdleCallback(warmLazyChunks, { timeout: 5000 })
else window.setTimeout(warmLazyChunks, 2000) // Safari has no requestIdleCallback

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
