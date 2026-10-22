import { useEffect, useRef } from 'react'
import { useApp } from '../state/store'

type Listener = () => void
const listeners = new Set<Listener>()

/** Celebrate! Safe to call when no host is mounted (it just does nothing). */
export function fireConfetti() {
  listeners.forEach((l) => l())
}

const COLORS = ['#ffc83d', '#ec4899', '#34d399', '#2f8fef', '#f97316', '#38bdf8']
const COUNT = 140
const DURATION_MS = 3200

interface Piece {
  x: number
  y: number
  vx: number
  vy: number
  rot: number
  vr: number
  w: number
  h: number
  color: string
  round: boolean
}

function reducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

/** Full-screen, click-through canvas. Mount once near the app root. */
export function ConfettiHost() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let raf = 0
    let pieces: Piece[] = []
    let start = 0

    const loop = (t: number) => {
      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d')
      if (!canvas || !ctx) return
      if (!start) start = t
      const elapsed = t - start
      const dpr = window.devicePixelRatio || 1
      const w = window.innerWidth
      const h = window.innerHeight
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr
        canvas.height = h * dpr
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      // Fade the last third so pieces don't just vanish.
      ctx.globalAlpha = Math.max(0, Math.min(1, (DURATION_MS - elapsed) / (DURATION_MS / 3)))
      for (const p of pieces) {
        p.vy += 0.18
        p.vx *= 0.99
        p.x += p.vx
        p.y += p.vy
        p.rot += p.vr
        ctx.save()
        ctx.translate(p.x, p.y)
        ctx.rotate(p.rot)
        ctx.fillStyle = p.color
        if (p.round) {
          ctx.beginPath()
          ctx.arc(0, 0, p.w / 2, 0, Math.PI * 2)
          ctx.fill()
        } else {
          ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h)
        }
        ctx.restore()
      }
      if (elapsed < DURATION_MS) {
        raf = requestAnimationFrame(loop)
      } else {
        ctx.clearRect(0, 0, w, h)
        pieces = []
        raf = 0
      }
    }

    const fire = () => {
      // Reduced motion: skip the flying particles entirely; the success sound/voice still plays.
      if (reducedMotion()) return
      const w = window.innerWidth
      const h = window.innerHeight
      const burst: Piece[] = []
      for (let i = 0; i < COUNT; i++) {
        const fromLeft = i % 2 === 0
        const angle = (fromLeft ? -60 : -120) * (Math.PI / 180) + (Math.random() - 0.5) * 0.9
        const speed = 9 + Math.random() * 9
        burst.push({
          x: fromLeft ? w * 0.1 : w * 0.9,
          y: h * 0.75,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          rot: Math.random() * Math.PI,
          vr: (Math.random() - 0.5) * 0.3,
          w: 8 + Math.random() * 8,
          h: 5 + Math.random() * 6,
          color: COLORS[i % COLORS.length],
          round: Math.random() < 0.3,
        })
      }
      pieces = pieces.concat(burst)
      start = 0
      if (!raf) raf = requestAnimationFrame(loop)
    }

    // Celebration belongs to the Keep step: leaving the make flow clears it so it
    // doesn't rain over Home/View.
    const unsubscribe = useApp.subscribe((s, prev) => {
      if (s.screen === prev.screen || !raf) return
      cancelAnimationFrame(raf)
      raf = 0
      pieces = []
      const canvas = canvasRef.current
      canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
    })

    listeners.add(fire)
    return () => {
      listeners.delete(fire)
      unsubscribe()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  return <canvas ref={canvasRef} className="confetti-canvas" aria-hidden="true" />
}
