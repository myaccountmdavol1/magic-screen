// "Do you want to stop?" — the picture-only check shown before leaving the Make flow
// with unsaved work. The safe choice (keep going) is the big green arrow; leaving is a
// small grey house, so a stray tap or a buddy grabbing the iPad doesn't lose anything.
import { createContext, useContext, useEffect, useRef } from 'react'
import { playSound } from '../lib/sound'
import { speak } from '../lib/voice'
import { Icon } from './Icon'

export const STOP_PROMPT = 'Do you want to stop? Tap the green arrow to keep going.'

/** Provided by Make: call to leave the flow (asks first when there is work to lose). */
export const ExitContext = createContext<() => void>(() => {})
export const useRequestExit = () => useContext(ExitContext)

export function StopDialog({ open, onKeepGoing, onStop }: { open: boolean; onKeepGoing: () => void; onStop: () => void }) {
  const keepRef = useRef<HTMLButtonElement>(null)
  const keepCb = useRef(onKeepGoing)
  keepCb.current = onKeepGoing

  useEffect(() => {
    if (!open) return
    speak(STOP_PROMPT)
    keepRef.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && keepCb.current()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return null
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onKeepGoing()}>
      <div className="modal stop-dialog" role="alertdialog" aria-modal="true" aria-label="Do you want to stop?">
        <button
          ref={keepRef}
          type="button"
          className="stop-keep"
          aria-label="Keep going"
          onClick={() => {
            playSound('pop')
            onKeepGoing()
          }}
        >
          <Icon name="next" size={64} />
        </button>
        <button
          type="button"
          className="stop-home"
          aria-label="Stop and go home"
          onClick={() => {
            playSound('tap')
            onStop()
          }}
        >
          <Icon name="home" size={30} />
        </button>
      </div>
    </div>
  )
}
