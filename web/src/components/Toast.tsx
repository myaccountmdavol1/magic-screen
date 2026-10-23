import { useEffect, useState } from 'react'
import { useApp } from '../state/store'
import { Icon } from './Icon'

export interface ToastOptions {
  /** A message for the teacher, not the child: stays longer and can be tapped away. */
  grownup?: boolean
}

type Listener = (message: string | null, opts?: ToastOptions) => void
const listeners = new Set<Listener>()
let lastShownAt = 0

/** Show a short hint pill from anywhere (no React context needed). Kid toasts: under 6 words. */
export function toast(message: string, opts?: ToastOptions) {
  lastShownAt = performance.now()
  listeners.forEach((l) => l(message, opts))
}

/** Hide whatever toast is showing right now. */
export function clearToasts() {
  listeners.forEach((l) => l(null))
}

// A hint belongs to the screen it was shown on: moving to another screen or step clears it
// (the gear's "hold" hint used to linger into World). A toast fired in the same moment as
// the move ("All gone!" then Home) is about that move, so it stays.
const SAME_MOMENT_MS = 300
useApp.subscribe((s, prev) => {
  if (s.screen === prev.screen && s.step === prev.step) return
  if (performance.now() - lastShownAt > SAME_MOMENT_MS) clearToasts()
})

const SHOW_MS = 2600
const GROWNUP_MS = 6000

/** Mount once near the app root. Talkline dark-blue hint pill that fades away. */
export function ToastHost() {
  const [msg, setMsg] = useState<{ text: string; key: number; grownup: boolean } | null>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const l: Listener = (text, opts) => {
      if (text == null) {
        setVisible(false)
        setMsg(null)
        return
      }
      setMsg({ text, key: Date.now(), grownup: !!opts?.grownup })
      setVisible(true)
    }
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }, [])

  useEffect(() => {
    if (!msg) return
    const ms = msg.grownup ? GROWNUP_MS : SHOW_MS
    const hide = window.setTimeout(() => setVisible(false), ms)
    // Unmount after the 500ms fade so screen readers don't re-read stale text.
    const clear = window.setTimeout(() => setMsg(null), ms + 600)
    return () => {
      window.clearTimeout(hide)
      window.clearTimeout(clear)
    }
  }, [msg])

  return (
    <div className={`toast-host${visible ? '' : ' hidden'}`} role="status" aria-live="polite">
      {msg &&
        (msg.grownup ? (
          <button
            key={msg.key}
            type="button"
            className="toast toast-grownup"
            aria-label={`${msg.text}. Tap to close.`}
            onClick={() => clearToasts()}
          >
            <span>{msg.text}</span>
            <Icon name="close" size={20} />
          </button>
        ) : (
          <span key={msg.key} className="toast">
            {msg.text}
          </span>
        ))}
    </div>
  )
}
