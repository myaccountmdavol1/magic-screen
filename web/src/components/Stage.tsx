// The live green-screen stage: one canvas + Compositor + camera + rAF loop.
// Make.tsx mounts exactly one of these (portaled into a detached host element) and
// StageSlot moves that host into whichever step is showing, so the camera, WebGL
// context and video element survive step changes untouched.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useApp } from '../state/store'
import type { RGB } from '../types'
import { Compositor } from '../lib/keyer/Compositor'
import {
  CameraError,
  cameraLooksAsleep,
  startCamera,
  watchCamera,
  type CameraErrorKind,
  type CameraHandle,
} from '../lib/camera'
import { speak } from '../lib/voice'
import { playSound } from '../lib/sound'
import {
  EMPTY_STAGE_API,
  STAGE_SIZES,
  clamp,
  loadBackgroundSource,
  loadFrontOverlay,
  loadStickerImages,
  useKeyerRuntime,
  useStage,
  type KeyingMode,
  type StageApi,
} from '../lib/useStage'
import { Button } from './Button'
import { Icon } from './Icon'
import { toast } from './Toast'
import './Stage.css'

/** 1 sticker scale unit = 20% of the stage height (see PlacedSticker). */
const STICKER_UNIT = 0.2
const STICKER_SCALE: [number, number] = [0.3, 5]
const ME_SCALE: [number, number] = [0.4, 2]
/** Extra forgiving hit area around stickers for small fingers (px). */
const HIT_PAD = 12

/** Keyer hints: the long "Grown-ups: …" ones stay up longer and can be tapped away. */
const notifyKeyer = (message: string) => toast(message, { grownup: message.startsWith('Grown-ups') })

/** atan2 deltas jump by ±2π when the finger line crosses ±180°; keep each step small. */
const wrapAngle = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI))

type Point = { x: number; y: number }
type GestureTarget = { kind: 'me' } | { kind: 'sticker'; uid: string } | null
type Sparkle = { id: number; x: number; y: number }

/** Last keying path Auto settled on, per device (calm start). Storage may be unavailable. */
const LAST_MODE_KEY = 'magicscreen.lastKeyingMode'
function readLastMode(): KeyingMode | null {
  try {
    const v = localStorage.getItem(LAST_MODE_KEY)
    return v === 'chroma' || v === 'segment' ? v : null
  } catch {
    return null
  }
}
function writeLastMode(m: KeyingMode) {
  try {
    localStorage.setItem(LAST_MODE_KEY, m)
  } catch {
    /* private mode etc.: just don't remember */
  }
}

export default function Stage({ onApi }: { onApi: (api: StageApi) => void }) {
  const settings = useApp((s) => s.settings)
  const step = useApp((s) => s.step)
  const background = useApp((s) => s.background)
  const stickers = useApp((s) => s.stickers)
  const selectedUid = useApp((s) => s.selectedStickerUid)
  const me = useApp((s) => s.me)

  const { resolution, mirror, greenScreenMode } = settings
  // A grown-up's Flip on the Me step lasts for this session only; settings.facing stays the default.
  const sessionFacing = useApp((s) => s.sessionFacing)
  const facing = sessionFacing ?? settings.facing
  const magicHelper = settings.magicHelper ?? 'auto'
  const size = STAGE_SIZES[resolution] ?? STAGE_SIZES['720p']

  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const compositorRef = useRef<Compositor | null>(null)

  const [cam, setCam] = useState<CameraHandle | null>(null)
  const [error, setError] = useState<CameraErrorKind | null>(null)
  const [errorDismissed, setErrorDismissed] = useState(false)
  const [retryNonce, setRetryNonce] = useState(0)
  const [keyColor, setKeyColor] = useState<RGB>(settings.key.color)
  const [magicArmed, setMagicArmed] = useState(false)
  const [sparkles, setSparkles] = useState<Sparkle[]>([])
  const [box, setBox] = useState({ w: 0, h: 0 })
  // 'auto' resolves live to whichever path fits what the camera sees.
  // Calm start: begin in the mode this device found last time, and cover the stage
  // ("Finding you…") until the first look at the camera has decided.
  const [autoMode, setAutoMode] = useState<KeyingMode>(() => readLastMode() ?? 'chroma')
  const [autoDecided, setAutoDecided] = useState(false)
  const mode: KeyingMode = greenScreenMode === 'auto' ? autoMode : greenScreenMode
  const modeDecided = greenScreenMode !== 'auto' || autoDecided

  // --- compositor lifecycle -------------------------------------------------
  const pendingDestroy = useRef(0)
  const fallbackCanvas = useRef<HTMLCanvasElement | null>(null)
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    // StrictMode mounts → unmounts → remounts synchronously. Destroying right away
    // could lose the canvas's WebGL context for good, so destruction is deferred
    // and cancelled if we are immediately remounted.
    window.clearTimeout(pendingDestroy.current)
    let c = compositorRef.current
    if (!c) {
      try {
        c = new Compositor(canvas, { width: size.width, height: size.height })
      } catch (err) {
        // WebGL2 handed out a context but setup failed (e.g. a shader would not
        // compile). That canvas can no longer give a 2D context, so key on a fresh
        // sibling canvas with the CPU path instead of crashing the whole app.
        console.warn('[Stage] WebGL2 setup failed, using the 2D keyer', err)
        const fresh = document.createElement('canvas')
        fresh.className = canvas.className
        canvas.after(fresh)
        canvas.style.display = 'none'
        fallbackCanvas.current = fresh
        c = new Compositor(fresh, { width: size.width, height: size.height, webgl: false })
      }
    }
    compositorRef.current = c
    // Dev-only handle for browser tests and debugging the keyer.
    if (import.meta.env.DEV) (window as unknown as { __compositor?: Compositor }).__compositor = c
    // React re-points canvasRef at its own (hidden) canvas on every mount.
    if (fallbackCanvas.current) canvasRef.current = fallbackCanvas.current
    const comp = c
    return () => {
      pendingDestroy.current = window.setTimeout(() => {
        // Not remounted, so this canvas is gone for good: release its WebGL context.
        comp.destroy({ releaseContext: true })
        if (compositorRef.current === comp) compositorRef.current = null
        fallbackCanvas.current?.remove()
        fallbackCanvas.current = null
      }, 0)
    }
    // Created once; resolution changes go through resize() below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    compositorRef.current?.resize(size.width, size.height)
  }, [size.width, size.height])

  // --- camera ---------------------------------------------------------------
  useEffect(() => {
    let cancelled = false
    let handle: CameraHandle | null = null
    setError(null)
    setErrorDismissed(false)
    startCamera({ facing, resolution })
      .then((h) => {
        if (cancelled) return h.stop()
        handle = h
        setCam(h)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof CameraError ? err.kind : 'other')
      })
    return () => {
      cancelled = true
      handle?.stop()
      setCam(null)
    }
  }, [facing, resolution, retryNonce])

  // --- camera drop: the OS took the camera away mid-session ------------------------
  // Without this the picture just freezes. Show a "Camera fell asleep" cover with one
  // big button, and wake it automatically once when the child comes back to the app.
  const [asleep, setAsleep] = useState(false)
  const autoWoke = useRef(false)
  useEffect(() => {
    setAsleep(false)
    if (!cam) return
    const unwatch = watchCamera(cam.stream, (a) => {
      setAsleep(a)
      if (a) speak('The camera fell asleep. Tap the big button to wake it up!')
    })
    let visTimer = 0
    const onVis = () => {
      window.clearTimeout(visTimer)
      if (document.hidden) return
      // Give iOS a moment to unmute the track on its own before deciding.
      visTimer = window.setTimeout(() => {
        if (document.hidden || !cameraLooksAsleep(cam.stream)) return
        if (!autoWoke.current) {
          autoWoke.current = true
          setRetryNonce((n) => n + 1)
        } else {
          setAsleep(true)
        }
      }, 800)
    }
    document.addEventListener('visibilitychange', onVis)
    // A camera that keeps running for a while earns another automatic wake later.
    const healthy = window.setTimeout(() => {
      autoWoke.current = false
    }, 5000)
    return () => {
      unwatch()
      window.clearTimeout(visTimer)
      window.clearTimeout(healthy)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [cam])
  const wakeCamera = useCallback(() => {
    playSound('magic')
    setAsleep(false)
    setRetryNonce((n) => n + 1)
  }, [])

  const mirrored = mirror && facing === 'user'
  useEffect(() => {
    compositorRef.current?.setForeground(cam?.video ?? null, { mirror: mirrored })
  }, [cam, mirrored])

  // A teacher changing the saved key color wins over any auto-picked one.
  useEffect(() => {
    setKeyColor(settings.key.color)
  }, [settings.key.color])

  useEffect(() => {
    compositorRef.current?.setKey({ ...settings.key, color: keyColor, mode })
  }, [settings.key, keyColor, mode])

  useEffect(() => {
    compositorRef.current?.setOutline(settings.outline ?? 0)
  }, [settings.outline])

  useEffect(() => {
    compositorRef.current?.setMe(me)
  }, [me])

  // --- background -----------------------------------------------------------
  // Moving worlds draw their next frame from the render loop (bgTickRef) and freeze
  // while the app is hidden (bgPauseRef); video worlds pause too.
  const bgTickRef = useRef<((now: number) => void) | null>(null)
  const bgPauseRef = useRef<((paused: boolean) => void) | null>(null)
  useEffect(() => {
    let cancelled = false
    let dispose = () => {}
    loadBackgroundSource(background)
      .then((res) => {
        if (cancelled) return res.dispose()
        dispose = res.dispose
        bgTickRef.current = res.tick ?? null
        bgPauseRef.current = res.pause ?? null
        if (document.hidden) res.pause?.(true)
        compositorRef.current?.setBackground(res.source)
      })
      .catch(() => {
        if (!cancelled) toast("That world didn't load. Try another!")
      })
    return () => {
      cancelled = true
      bgTickRef.current = null
      bgPauseRef.current = null
      dispose()
    }
  }, [background])

  useEffect(() => {
    const onVis = () => bgPauseRef.current?.(document.hidden)
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  // --- world front layer (C5: desk / fence drawn over the child, under stickers) ---
  useEffect(() => {
    let cancelled = false
    loadFrontOverlay(background)
      .then((img) => {
        if (!cancelled) compositorRef.current?.setForegroundOverlay(img)
      })
      .catch(() => {
        if (!cancelled) compositorRef.current?.setForegroundOverlay(null)
      })
    return () => {
      cancelled = true
    }
  }, [background])

  // --- stickers -------------------------------------------------------------
  useEffect(() => {
    let cancelled = false
    loadStickerImages(stickers).then((list) => {
      if (!cancelled) compositorRef.current?.setStickers(list)
    })
    return () => {
      cancelled = true
    }
  }, [stickers])

  // --- Magic Helper / AI cutout (MediaPipe), scheduled per device tier ---------
  const keyer = useKeyerRuntime({
    compositorRef,
    video: cam?.video ?? null,
    mode,
    helper: magicHelper,
    notify: notifyKeyer,
  })
  const beforeRender = keyer.beforeRender

  // --- render loop ----------------------------------------------------------
  useEffect(() => {
    let raf = 0
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      // Hidden tabs: skip work (and the browser throttles rAF anyway).
      if (document.hidden) return
      const comp = compositorRef.current
      if (!comp) return
      beforeRender(now)
      bgTickRef.current?.(now)
      // Always render, even when idle: Safari's captureStream only emits on redraw.
      comp.render()
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [cam, beforeRender])

  // --- auto key -------------------------------------------------------------
  const autoKey = useCallback((): boolean => {
    const c = compositorRef.current?.sampleBorderColor() ?? null
    if (c) setKeyColor(c)
    return c != null
  }, [])

  // Give the camera ~1s to settle exposure before sampling the screen color.
  useEffect(() => {
    if (!cam || mode !== 'chroma') return
    const t = window.setTimeout(autoKey, 1000)
    return () => window.clearTimeout(t)
  }, [cam, mode, autoKey])

  // Auto: look for a green/blue screen around the frame edges. Two misses in a row
  // switch to the AI cutout, two hits switch back, so a passing shadow doesn't flap.
  const autoModeRef = useRef(autoMode)
  autoModeRef.current = autoMode
  const autoToastShown = useRef(false)
  useEffect(() => {
    if (!cam || greenScreenMode !== 'auto') return
    let hits = 0
    let misses = 0
    let first = true
    const id = window.setInterval(() => {
      const c = compositorRef.current?.sampleBorderColor() ?? null
      if (c) {
        hits++
        misses = 0
      } else {
        misses++
        hits = 0
      }
      // The first look decides at once (the cover is up); later switches need two in a row.
      const need = first ? 1 : 2
      if (first) {
        first = false
        setAutoDecided(true)
      }
      if (hits >= need && autoModeRef.current !== 'chroma') {
        setKeyColor(c as RGB)
        setAutoMode('chroma')
        writeLastMode('chroma')
      } else if (misses >= need && autoModeRef.current !== 'segment') {
        writeLastMode('segment')
        setAutoMode('segment')
        if (!autoToastShown.current) {
          autoToastShown.current = true
          toast('Magic cutout is on!')
        }
      }
    }, 700)
    return () => {
      window.clearInterval(id)
      setAutoDecided(false)
    }
  }, [cam, greenScreenMode])

  // --- stage size (for DOM overlays + hit tests) ------------------------------
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const r = entry.contentRect
      if (r.width > 0 && r.height > 0) setBox({ w: r.width, h: r.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Leaving the Me step disarms the magic finger so a sticker tap doesn't re-key.
  useEffect(() => {
    if (step !== 'me') setMagicArmed(false)
  }, [step])

  const armMagicFinger = useCallback((on: boolean) => setMagicArmed(on), [])
  const retryCamera = useCallback(() => setRetryNonce((n) => n + 1), [])

  // --- publish API ------------------------------------------------------------
  const api = useMemo<StageApi>(
    () => ({
      compositorRef,
      canvasRef,
      video: cam?.video ?? null,
      stream: cam?.stream ?? null,
      ready: cam != null,
      error,
      mode,
      keyColor,
      autoKey,
      magicArmed,
      armMagicFinger,
      retryCamera,
      helperActive: keyer.active && mode === 'chroma',
      modeDecided,
    }),
    [cam, error, mode, modeDecided, keyColor, autoKey, magicArmed, armMagicFinger, retryCamera, keyer.active],
  )
  useEffect(() => {
    onApi(api)
  }, [api, onApi])
  useEffect(() => () => onApi(EMPTY_STAGE_API), [onApi])

  // --- gestures ---------------------------------------------------------------
  const pointers = useRef(new Map<number, Point>())
  const target = useRef<GestureTarget>(null)

  const stageRect = () => rootRef.current!.getBoundingClientRect()

  const hitSticker = (p: Point): string | null => {
    const r = stageRect()
    const list = useApp.getState().stickers
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i]
      const half = (STICKER_UNIT * r.height * s.scale) / 2 + HIT_PAD
      const dx = p.x - (r.left + s.x * r.width)
      const dy = p.y - (r.top + s.y * r.height)
      // Rotate the touch into the sticker's own frame for an exact rotated-box test.
      const cos = Math.cos(-s.rotation)
      const sin = Math.sin(-s.rotation)
      const lx = dx * cos - dy * sin
      const ly = dx * sin + dy * cos
      if (Math.abs(lx) <= half && Math.abs(ly) <= half) return s.uid
    }
    return null
  }

  const doMagicFinger = (p: Point) => {
    const r = stageRect()
    const color = compositorRef.current?.sampleColorAt((p.x - r.left) / r.width, (p.y - r.top) / r.height) ?? null
    setMagicArmed(false)
    if (!color) {
      toast('Tap the green part!')
      return
    }
    setKeyColor(color)
    playSound('magic')
    const id = Date.now() + Math.random()
    setSparkles((list) => [...list, { id, x: p.x - r.left, y: p.y - r.top }])
    window.setTimeout(() => setSparkles((list) => list.filter((s) => s.id !== id)), 900)
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = { x: e.clientX, y: e.clientY }
    if (magicArmed) {
      doMagicFinger(p)
      return
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, p)
    if (pointers.current.size > 1) return // second finger joins the current gesture

    const state = useApp.getState()
    if (step === 'me') {
      target.current = { kind: 'me' }
    } else if (step === 'stickers') {
      const uid = hitSticker(p)
      if (uid) {
        if (uid !== state.selectedStickerUid) playSound('tap')
        state.selectSticker(uid)
        target.current = { kind: 'sticker', uid }
      } else if (state.selectedStickerUid) {
        state.selectSticker(null)
        target.current = null
      }
    } else {
      target.current = null
    }
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const map = pointers.current
    const prev = map.get(e.pointerId)
    if (!prev || !target.current) {
      if (prev) map.set(e.pointerId, { x: e.clientX, y: e.clientY })
      return
    }
    // Incremental transform from the previous pointer positions: robust to fingers
    // being added or lifted mid-gesture.
    const before = [...map.values()]
    map.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const after = [...map.values()]
    const r = stageRect()

    let dx = 0
    let dy = 0
    let ratio = 1
    let dAngle = 0
    if (after.length === 1) {
      dx = after[0].x - before[0].x
      dy = after[0].y - before[0].y
    } else {
      const [a0, b0] = before
      const [a1, b1] = after
      dx = (a1.x + b1.x) / 2 - (a0.x + b0.x) / 2
      dy = (a1.y + b1.y) / 2 - (a0.y + b0.y) / 2
      const d0 = Math.hypot(b0.x - a0.x, b0.y - a0.y)
      const d1 = Math.hypot(b1.x - a1.x, b1.y - a1.y)
      if (d0 > 4) ratio = d1 / d0
      dAngle = wrapAngle(Math.atan2(b1.y - a1.y, b1.x - a1.x) - Math.atan2(b0.y - a0.y, b0.x - a0.x))
    }

    const state = useApp.getState()
    const t = target.current
    if (t.kind === 'me') {
      const m = state.me
      state.setMe({
        x: clamp(m.x + dx / r.width, 0, 1),
        y: clamp(m.y + dy / r.height, 0, 1),
        scale: clamp(m.scale * ratio, ...ME_SCALE),
      })
    } else {
      const s = state.stickers.find((st) => st.uid === t.uid)
      if (!s) return
      state.updateSticker(t.uid, {
        x: clamp(s.x + dx / r.width, 0, 1),
        y: clamp(s.y + dy / r.height, 0, 1),
        scale: clamp(s.scale * ratio, ...STICKER_SCALE),
        rotation: s.rotation + dAngle,
      })
    }
  }

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size === 0) target.current = null
  }

  // Corner handle: drag to resize + rotate around the sticker center.
  const resizeLast = useRef<Point | null>(null)
  const onHandleDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    resizeLast.current = { x: e.clientX, y: e.clientY }
  }
  const onHandleMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const last = resizeLast.current
    const state = useApp.getState()
    const s = state.stickers.find((st) => st.uid === state.selectedStickerUid)
    if (!last || !s) return
    const r = stageRect()
    const cx = r.left + s.x * r.width
    const cy = r.top + s.y * r.height
    const d0 = Math.hypot(last.x - cx, last.y - cy)
    const d1 = Math.hypot(e.clientX - cx, e.clientY - cy)
    const a0 = Math.atan2(last.y - cy, last.x - cx)
    const a1 = Math.atan2(e.clientY - cy, e.clientX - cx)
    resizeLast.current = { x: e.clientX, y: e.clientY }
    if (d0 < 4) return
    state.updateSticker(s.uid, {
      scale: clamp(s.scale * (d1 / d0), ...STICKER_SCALE),
      rotation: s.rotation + wrapAngle(a1 - a0),
    })
  }
  const onHandleUp = () => {
    resizeLast.current = null
  }

  const selected = step === 'stickers' ? stickers.find((s) => s.uid === selectedUid) : undefined
  const showError = error != null && !errorDismissed
  const loading = !cam && !error

  return (
    <div
      ref={rootRef}
      className={`stage${magicArmed ? ' is-magic' : ''}`}
      data-step={step}
      style={{ aspectRatio: `${size.width} / ${size.height}` }}
    >
      <canvas ref={canvasRef} className="stage-canvas" width={size.width} height={size.height} />

      <div
        className="stage-touch"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        aria-hidden="true"
      />

      {selected && box.h > 0 && (
        <div
          className="sticker-select"
          style={{
            left: selected.x * box.w,
            top: selected.y * box.h,
            width: STICKER_UNIT * box.h * selected.scale,
            height: STICKER_UNIT * box.h * selected.scale,
            transform: `translate(-50%, -50%) rotate(${selected.rotation}rad)`,
          }}
        >
          <button
            type="button"
            className="sticker-tool delete"
            aria-label="Remove sticker"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => {
              playSound('pop')
              useApp.getState().removeSticker(selected.uid)
            }}
          >
            <Icon name="close" size={22} />
          </button>
          <button
            type="button"
            className="sticker-tool resize"
            aria-label="Make bigger or turn"
            onPointerDown={onHandleDown}
            onPointerMove={onHandleMove}
            onPointerUp={onHandleUp}
            onPointerCancel={onHandleUp}
          >
            <Icon name="move" size={22} />
          </button>
        </div>
      )}

      {sparkles.map((s) => (
        <span key={s.id} className="stage-sparkle" style={{ left: s.x, top: s.y }} aria-hidden="true">
          <span className="ring" />
          <Icon name="sparkle" size={44} />
        </span>
      ))}

      {magicArmed && (
        <div className="stage-hint">
          <span>
            <Icon name="finger" size={24} /> Tap the green!
          </span>
        </div>
      )}

      {loading && (
        <div className="stage-cover stage-loading" role="status">
          <span className="stage-spinner" aria-hidden="true" />
          <span>Waking up the camera…</span>
        </div>
      )}

      {!loading && cam && !modeDecided && !showError && (
        <div className="stage-cover stage-loading" role="status">
          <span className="stage-spinner" aria-hidden="true" />
          <span>Finding you…</span>
        </div>
      )}

      {showError && (
        <CameraTrouble
          kind={error}
          onRetry={retryCamera}
          onContinue={() => setErrorDismissed(true)}
        />
      )}

      {asleep && cam && !showError && (
        <div className="stage-cover stage-trouble stage-asleep" role="alert">
          <span className="trouble-icon" aria-hidden="true">
            <Icon name="camera" size={40} />
          </span>
          <h2>Camera fell asleep</h2>
          <div className="trouble-actions">
            <Button variant="primary" size="xl" icon="refresh" onClick={wakeCamera}>
              Wake it up
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

const TROUBLE: Record<CameraErrorKind, { title: string; text: string; retry: boolean }> = {
  denied: { title: 'Ask a grown-up to turn on the camera', text: 'Grown-ups: allow the camera for Magic Screen in Settings, then tap Try again.', retry: true },
  insecure: { title: 'Camera is locked', text: 'Magic Screen needs a safe https:// link to use the camera.', retry: false },
  missing: { title: 'No camera found', text: 'You can still make a picture with just your world.', retry: true },
  other: { title: 'Camera is shy', text: "The camera didn't start. Let's try again!", retry: true },
}

function CameraTrouble({
  kind,
  onRetry,
  onContinue,
}: {
  kind: CameraErrorKind
  onRetry: () => void
  onContinue: () => void
}) {
  const t = TROUBLE[kind]
  return (
    <div className="stage-cover stage-trouble" role="alert">
      <span className="trouble-icon" aria-hidden="true">
        <Icon name={kind === 'insecure' ? 'lock' : 'camera'} size={40} />
      </span>
      <h2>{t.title}</h2>
      <p>{t.text}</p>
      <div className="trouble-actions">
        {t.retry && (
          <Button variant="primary" size="lg" icon="refresh" onClick={onRetry}>
            Try again
          </Button>
        )}
        <Button variant="secondary" size="lg" icon="next" onClick={onContinue}>
          Keep going
        </Button>
      </div>
    </div>
  )
}

/**
 * Where the single Stage appears inside a step. The host element is moved (not
 * re-rendered) into this slot, so the camera keeps running. `children` render as an
 * overlay exactly on top of the stage (countdown numbers, flash, badges).
 */
export function StageSlot({ children, className }: { children?: ReactNode; className?: string }) {
  const { host } = useStage()
  const mountRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const mount = mountRef.current
    if (!mount || !host) return
    mount.appendChild(host)
    return () => {
      if (host.parentNode === mount) mount.removeChild(host)
    }
  }, [host])

  return (
    <div className={className ? `stage-slot ${className}` : 'stage-slot'}>
      <div ref={mountRef} className="stage-mount" />
      {children != null && children !== false && <div className="stage-overlay">{children}</div>}
    </div>
  )
}
