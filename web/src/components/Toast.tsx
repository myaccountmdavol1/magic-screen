import { useEffect, useState } from 'react'

type Listener = (message: string) => void
const listeners = new Set<Listener>()

/** Show a short hint pill from anywhere (no React context needed). */
export function toast(message: string) {
  listeners.forEach((l) => l(message))
}

const SHOW_MS = 2600

/** Mount once near the app root. Talkline dark-blue hint pill that fades away. */
export function ToastHost() {
  const [msg, setMsg] = useState<{ text: string; key: number } | null>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const l: Listener = (text) => {
      setMsg({ text, key: Date.now() })
      setVisible(true)
    }
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }, [])

  useEffect(() => {
    if (!msg) return
    const hide = window.setTimeout(() => setVisible(false), SHOW_MS)
    // Unmount after the 500ms fade so screen readers don't re-read stale text.
    const clear = window.setTimeout(() => setMsg(null), SHOW_MS + 600)
    return () => {
      window.clearTimeout(hide)
      window.clearTimeout(clear)
    }
  }, [msg])

  return (
    <div className={`toast-host${visible ? '' : ' hidden'}`} role="status" aria-live="polite">
      {msg && (
        <span key={msg.key} className="toast">
          {msg.text}
        </span>
      )}
    </div>
  )
}
