import { useEffect } from 'react'
import { useApp } from './state/store'
import { unlock } from './lib/sound'
import { Blobs } from './components/Blobs'
import { Logo } from './components/Logo'
import { ToastHost } from './components/Toast'
import { ConfettiHost } from './components/Confetti'
import { ErrorBoundary } from './components/ErrorBoundary'
import Home from './screens/Home'
import Make from './screens/Make'
import Teacher from './screens/Teacher'
import View from './screens/View'
import './components/components.css'
import './screens/screens.css'

export default function App() {
  const screen = useApp((s) => s.screen)
  const goScreen = useApp((s) => s.goScreen)

  // iOS only allows audio + speech after a user gesture, so unlock on the very first touch.
  useEffect(() => {
    const onFirst = () => {
      unlock()
      useApp.getState().unlockAudio()
      window.removeEventListener('pointerdown', onFirst, true)
      window.removeEventListener('keydown', onFirst, true)
    }
    window.addEventListener('pointerdown', onFirst, true)
    window.addEventListener('keydown', onFirst, true)
    return () => {
      window.removeEventListener('pointerdown', onFirst, true)
      window.removeEventListener('keydown', onFirst, true)
    }
  }, [])

  // New screen starts at the top (phones scroll the whole page).
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [screen])

  return (
    <>
      <Blobs />
      <div className={`app-shell${screen === 'make' || screen === 'view' ? ' wide' : ''}`}>
        <header className="topbar">
          {/* In the Make flow the logo is just a picture: one stray tap used to throw the
              creation away. Leaving goes through Back (step 1: hold Home), which asks first. */}
          <Logo onClick={screen === 'home' || screen === 'make' ? undefined : () => goScreen('home')} />
        </header>
        <main key={screen} className="screen-view">
          <ErrorBoundary onReset={() => goScreen('home')}>
            {screen === 'home' && <Home />}
            {screen === 'make' && <Make />}
            {screen === 'teacher' && <Teacher />}
            {screen === 'view' && <View />}
          </ErrorBoundary>
        </main>
      </div>
      <ToastHost />
      <ConfettiHost />
    </>
  )
}
