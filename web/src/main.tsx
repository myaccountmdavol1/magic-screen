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

// Classrooms often have flaky wifi: cache the app shell right away.
registerSW({ immediate: true })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
