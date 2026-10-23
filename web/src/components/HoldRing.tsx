// Press-and-hold behavior shared by the teacher gear (2 s) and the step-1 Home button (1.5 s).
// Kids tap; grown-ups hold. A ring fills while holding so it's clear something is happening.
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'

const RING_R = 30
const RING_LEN = 2 * Math.PI * RING_R

export interface HoldOptions {
  ms: number
  onDone: () => void
  /** Released well before the hold finished (a kid's tap): show a hint here. */
  onShortTap?: () => void
}

/** Returns the fill progress (0..1) and the handlers to spread onto a <button>. */
export function useHold({ ms, onDone, onShortTap }: HoldOptions) {
  const [progress, setProgress] = useState(0)
  const raf = useRef(0)
  const startedAt = useRef(0)
  const fired = useRef(false)
  const cbs = useRef({ onDone, onShortTap })
  cbs.current = { onDone, onShortTap }

  const stop = (showHint: boolean) => {
    cancelAnimationFrame(raf.current)
    raf.current = 0
    if (showHint && !fired.current && startedAt.current && performance.now() - startedAt.current < ms * 0.6) {
      cbs.current.onShortTap?.()
    }
    startedAt.current = 0
    setProgress(0)
  }

  const start = () => {
    if (raf.current) return
    fired.current = false
    startedAt.current = performance.now()
    const tick = (t: number) => {
      const p = Math.min(1, (t - startedAt.current) / ms)
      setProgress(p)
      if (p >= 1) {
        fired.current = true
        raf.current = 0
        startedAt.current = 0
        setProgress(0)
        cbs.current.onDone()
        return
      }
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
  }

  useEffect(() => () => cancelAnimationFrame(raf.current), [])

  const handlers = {
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
      e.currentTarget.setPointerCapture?.(e.pointerId)
      start()
    },
    onPointerUp: () => stop(true),
    onPointerCancel: () => stop(false),
    onLostPointerCapture: () => stop(false),
    onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => {
      if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
        e.preventDefault()
        start()
      }
    },
    onKeyUp: (e: KeyboardEvent<HTMLButtonElement>) => {
      if (e.key === 'Enter' || e.key === ' ') stop(true)
    },
    onContextMenu: (e: { preventDefault: () => void }) => e.preventDefault(),
  }

  return { progress, handlers }
}

/** The filling ring (styled by .hold-ring* in screens.css). Sits absolutely over its parent. */
export function HoldRing({ progress, className }: { progress: number; className?: string }) {
  return (
    <svg className={`hold-ring${className ? ` ${className}` : ''}`} viewBox="0 0 68 68" aria-hidden="true">
      <circle cx="34" cy="34" r={RING_R} className="hold-ring-track" />
      <circle
        cx="34"
        cy="34"
        r={RING_R}
        className="hold-ring-fill"
        strokeDasharray={RING_LEN}
        strokeDashoffset={RING_LEN * (1 - progress)}
      />
    </svg>
  )
}
