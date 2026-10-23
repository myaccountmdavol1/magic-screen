import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { playSound } from '../lib/sound'
import { Icon, type IconName } from './Icon'
import { toast } from './Toast'

const RING_R = 30
const RING_LEN = 2 * Math.PI * RING_R

/**
 * A small grown-up button that only fires after being held (2 s by default).
 * Kids tap and nothing happens (a hint toast tells grown-ups to hold); the ring
 * fills while holding so the teacher knows it's working. Same look as the Home gear.
 */
export function HoldButton({
  icon,
  label,
  hint,
  onUnlock,
  holdMs = 2000,
  className,
}: {
  icon: IconName
  /** accessible name, e.g. "Grown-up fix. Press and hold for 3 seconds." */
  label: string
  /** toast shown after a short tap */
  hint: string
  onUnlock: () => void
  holdMs?: number
  className?: string
}) {
  const [progress, setProgress] = useState(0)
  const raf = useRef(0)
  const startedAt = useRef(0)
  const fired = useRef(false)

  const stop = (showHint: boolean) => {
    cancelAnimationFrame(raf.current)
    raf.current = 0
    if (showHint && !fired.current && startedAt.current && performance.now() - startedAt.current < holdMs * 0.6) {
      toast(hint)
    }
    startedAt.current = 0
    setProgress(0)
  }

  const start = () => {
    if (raf.current) return
    fired.current = false
    startedAt.current = performance.now()
    const tick = (t: number) => {
      const p = Math.min(1, (t - startedAt.current) / holdMs)
      setProgress(p)
      if (p >= 1) {
        fired.current = true
        raf.current = 0
        startedAt.current = 0
        setProgress(0)
        playSound('pop')
        onUnlock()
        return
      }
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
  }

  useEffect(() => () => cancelAnimationFrame(raf.current), [])

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
      e.preventDefault()
      start()
    }
  }
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') stop(true)
  }

  return (
    <button
      type="button"
      className={`hold-gear${className ? ` ${className}` : ''}`}
      aria-label={label}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture?.(e.pointerId)
        start()
      }}
      onPointerUp={() => stop(true)}
      onPointerCancel={() => stop(false)}
      onLostPointerCapture={() => stop(false)}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onContextMenu={(e) => e.preventDefault()}
    >
      <svg className="hold-ring" viewBox="0 0 68 68" aria-hidden="true">
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
      <Icon name={icon} size={26} />
    </button>
  )
}
