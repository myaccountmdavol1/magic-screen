// Shared stage API. Make.tsx keeps exactly one <Stage/> alive across the Me, Stickers
// and Action steps (so the camera never restarts) and publishes its API through this
// context; steps read it with useStage() and drop a <StageSlot/> where the stage goes.
import { createContext, useContext, useEffect, useRef, useState, type RefObject } from 'react'
import type { Compositor, KeyerSignal } from './keyer/Compositor'
import type { CameraErrorKind } from './camera'
import type { Segmenter } from './segmenter'
import { HelperTrustTracker } from './helperTrust'
import { KEYER_TUNING } from './keyer/shaders'
import {
  cadenceFromBenchmark,
  detectPhone,
  frameBudgetMs,
  backoffFrameMs,
  helperCadence,
  initBackoff,
  setBackoffCeiling,
  shouldRunThisFrame,
  stepBackoff,
  type BackoffState,
  type Cadence,
  type HelperSetting,
} from './deviceTier'
import type { BackgroundChoice, PlacedSticker, RGB, Settings } from '../types'
import { getBackgroundImage, getFrontImage, getFrontUrl, getStickerImage, loadImage } from '../assets/svg'

export interface StageApi {
  /** The live compositor (null until the canvas is mounted and WebGL is ready). */
  compositorRef: RefObject<Compositor | null>
  /** The visible stage canvas; recorder/capturePhoto read from it. */
  canvasRef: RefObject<HTMLCanvasElement | null>
  video: HTMLVideoElement | null
  stream: MediaStream | null
  /** true once the camera is streaming frames */
  ready: boolean
  error: CameraErrorKind | null
  /** What the stage is doing right now; 'auto' in settings resolves to one of these. */
  mode: KeyingMode
  /** current (local, not persisted) key color */
  keyColor: RGB
  /** Sample the frame border for the screen color. Returns true if a color was found. */
  autoKey: () => boolean
  /** When armed, the next tap on the stage picks the key color ("magic finger"). */
  magicArmed: boolean
  armMagicFinger: (on: boolean) => void
  retryCamera: () => void
  /** The Magic Helper (on-device person finder) is currently helping the key. */
  helperActive: boolean
  /**
   * false while greenScreenMode 'auto' is still taking its first look at the camera
   * (the stage shows "Finding you…"); always true for explicit modes. Hide
   * green-screen-only tools until it is true.
   */
  modeDecided: boolean
}

/** Detached element that hosts the single Stage; StageSlot moves it into place. */
export interface StageContextValue extends StageApi {
  host: HTMLDivElement | null
}

const noop = () => {}

export const EMPTY_STAGE_API: StageApi = {
  compositorRef: { current: null },
  canvasRef: { current: null },
  video: null,
  stream: null,
  ready: false,
  error: null,
  mode: 'chroma',
  keyColor: [0.2, 0.75, 0.3],
  autoKey: () => false,
  magicArmed: false,
  armMagicFinger: noop,
  retryCamera: noop,
  helperActive: false,
  modeDecided: false,
}

export const StageContext = createContext<StageContextValue>({ ...EMPTY_STAGE_API, host: null })

export function useStage(): StageContextValue {
  return useContext(StageContext)
}

/** Internal canvas size for each camera resolution setting (always 16:9). */
/** The keying path actually running (Settings.greenScreenMode 'auto' picks one live). */
export type KeyingMode = 'chroma' | 'segment'

export const STAGE_SIZES: Record<Settings['resolution'], { width: number; height: number }> = {
  '540p': { width: 960, height: 540 },
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Tiny id helper (crypto.randomUUID is missing on older iPadOS). */
export function newId(prefix = 'c'): string {
  const c = globalThis.crypto as Crypto | undefined
  if (c && typeof c.randomUUID === 'function') return `${prefix}_${c.randomUUID()}`
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

export type BackgroundSource = HTMLImageElement | HTMLVideoElement | string | null

/**
 * Turn the store's BackgroundChoice into something the Compositor can draw.
 * Used by the live Stage.
 * Uploaded videos loop silently so a long recording never runs out of world.
 */
/** C5: the chosen world's front layer (desk, fence...), or null when it has none. */
export async function loadFrontOverlay(bg: BackgroundChoice | null): Promise<HTMLImageElement | null> {
  const id = bg?.kind === 'builtin' ? (bg.builtinId ?? bg.id) : null
  if (!id || !getFrontUrl(id)) return null
  return getFrontImage(id)
}

export async function loadBackgroundSource(
  bg: BackgroundChoice | null,
): Promise<{ source: BackgroundSource; dispose: () => void }> {
  const none = { source: null, dispose: () => {} }
  if (!bg) return none
  switch (bg.kind) {
    case 'builtin':
      return { source: await getBackgroundImage(bg.builtinId ?? bg.id), dispose: () => {} }
    case 'image':
      return { source: await loadImage(bg.src), dispose: () => {} }
    case 'color':
      return { source: bg.src, dispose: () => {} }
    case 'video': {
      const v = document.createElement('video')
      v.muted = true
      v.loop = true
      v.playsInline = true
      v.setAttribute('playsinline', '')
      v.setAttribute('muted', '')
      v.autoplay = true
      v.preload = 'auto'
      v.crossOrigin = 'anonymous'
      const loaded = new Promise<void>((resolve, reject) => {
        v.addEventListener('loadeddata', () => resolve(), { once: true })
        v.addEventListener('error', () => reject(new Error('Could not load the video world.')), { once: true })
      })
      loaded.catch(() => {}) // a late error after we stopped waiting is not unhandled
      v.src = bg.src
      // iOS Safari doesn't buffer a detached video until play() is called, so waiting
      // for 'loadeddata' first would hang forever. Muted inline play is always allowed.
      v.play().catch(() => {
        /* autoplay blocked: the first frame still works as a still background */
      })
      if (v.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) await loaded
      return {
        source: v,
        dispose: () => {
          v.pause()
          v.removeAttribute('src')
          v.load()
        },
      }
    }
  }
}

/** Map placed stickers to the image list Compositor.setStickers expects. */
export async function loadStickerImages(list: PlacedSticker[]) {
  const images = await Promise.all(list.map((s) => getStickerImage(s.stickerId).catch(() => null)))
  return list.flatMap((s, i) => {
    const image = images[i]
    return image ? [{ image, x: s.x, y: s.y, scale: s.scale, rotation: s.rotation }] : []
  })
}

// ---------------------------------------------------------------------------
// Keyer runtime: Magic Helper (Tier 2) scheduling + keyer signals.
// ---------------------------------------------------------------------------

export type HelperStatus = 'off' | 'loading' | 'on'

export interface KeyerRuntimeOptions {
  compositorRef: RefObject<Compositor | null>
  video: HTMLVideoElement | null
  mode: KeyingMode
  helper: HelperSetting
  /** Friendly message for the toast system. */
  notify: (message: string) => void
}

export interface KeyerRuntime {
  status: HelperStatus
  /** The segmenter is loaded and currently scheduled (cadence > 0). */
  active: boolean
  /** Call once per animation frame, right before compositor.render(). */
  beforeRender: (now: number) => void
}

const BACKOFF_TICK_MS = 250

const SIGNAL_TEXT = {
  uneven: 'Grown-ups: the green screen looks patchy. More even light or a smoother screen will make the magic cleaner.',
  dark: 'Grown-ups: the green screen is in the dark. Shine more light on it and the magic gets cleaner!',
  shirtOn: 'Green shirt? Magic helper is on!',
  shirtOff: 'Grown-ups: that shirt matches the green screen. A different color shirt works best.',
} as const

function isPhoneDevice(): boolean {
  if (typeof navigator === 'undefined') return false
  const screenMin = typeof screen !== 'undefined' ? Math.min(screen.width, screen.height) : 0
  return detectPhone({ userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints ?? 0, screenMin })
}

/** Run when the browser is idle (Safari has no requestIdleCallback). */
function whenIdle(cb: () => void): () => void {
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number
    cancelIdleCallback?: (h: number) => void
  }
  if (w.requestIdleCallback) {
    const h = w.requestIdleCallback(cb, { timeout: 1500 })
    return () => w.cancelIdleCallback?.(h)
  }
  const h = window.setTimeout(cb, 600)
  return () => window.clearTimeout(h)
}

/**
 * Owns the segmenter for the live stage:
 * - loads it lazily once the camera runs (segment mode, or the Magic Helper when allowed)
 * - benchmarks the device once and picks a cadence (deviceTier.cadenceFromBenchmark)
 * - runs it every Nth frame, uploads masks, fades the ML weight in/out
 * - steps the cadence down when frames get slow (thermal backoff) and back up later
 * - turns keyer signals into friendly toasts; a screen-coloured shirt forces the helper on
 */
export function useKeyerRuntime(opts: KeyerRuntimeOptions): KeyerRuntime {
  const { compositorRef, video, mode, helper, notify } = opts
  const [status, setStatus] = useState<HelperStatus>('off')
  const [forced, setForced] = useState(false)
  const [bench, setBench] = useState<Cadence | null>(null)
  const [running, setRunning] = useState(false)
  const runningRef = useRef(false)
  const segRef = useRef<Segmenter | null>(null)
  const benchingRef = useRef(false)
  const backoffRef = useRef<BackoffState | null>(null)
  const frameRef = useRef(0)
  const lastBackoffRef = useRef(0)
  const notifyRef = useRef(notify)
  notifyRef.current = notify
  const shownRef = useRef({ uneven: false, shirt: false, dark: false })
  const videoRef = useRef(video)
  videoRef.current = video

  const segmentMode = mode === 'segment'
  const comp = compositorRef.current
  const tierOk = segmentMode || (comp?.isWebGL ?? true)
  const wanted = !!video && tierOk && (segmentMode || helper !== 'off')

  const segmentModeRef = useRef(segmentMode)
  segmentModeRef.current = segmentMode
  const benchRef = useRef(bench)
  benchRef.current = bench

  // Load (or drop) the segmenter. It doesn't depend on which camera is live, so a
  // camera switch or a mode change keeps the loaded model (and the benchmark).
  useEffect(() => {
    if (!wanted) {
      setStatus('off')
      return
    }
    let cancelled = false
    setStatus('loading')
    const cancelIdle = whenIdle(() => {
      import('./segmenter')
        .then((m) => m.createSegmenter())
        .then(async (seg) => {
          if (cancelled) return seg.close()
          segRef.current = seg
          let v = videoRef.current
          if (benchRef.current === null && v) {
            benchingRef.current = true
            // Segment mode keeps showing a live cutout while the device is measured.
            const onMask = (m: { data: Uint8Array; w: number; h: number }) => {
              if (segmentModeRef.current) compositorRef.current?.setMaskData(m.data, m.w, m.h)
            }
            let ms = await seg.benchmark(v, { onMask })
            // The camera was flipped (or woken) mid-benchmark: the old video stopped giving
            // frames, so the result (often Infinity) would turn the helper off for the whole
            // session. Measure again on the new camera.
            for (let tries = 0; tries < 3 && !cancelled && videoRef.current !== v; tries++) {
              // Between cameras there is briefly no video: give the new one a moment.
              for (let wait = 0; wait < 50 && !cancelled && !videoRef.current; wait++) {
                await new Promise((r) => window.setTimeout(r, 100))
              }
              if (cancelled || !videoRef.current) break
              v = videoRef.current
              ms = await seg.benchmark(v, { onMask })
            }
            benchingRef.current = false
            if (cancelled) return
            setBench(cadenceFromBenchmark(ms, seg.delegate))
          }
          setStatus('on')
        })
        .catch((err: unknown) => {
          console.warn('[keyer] Magic Helper unavailable', err)
          if (cancelled) return
          setStatus('off')
          if (segmentModeRef.current) notifyRef.current("AI cutout didn't start")
        })
    })
    return () => {
      cancelled = true
      cancelIdle()
      benchingRef.current = false
      segRef.current?.close()
      segRef.current = null
      compositorRef.current?.setMlWeight(0)
      compositorRef.current?.setMaskData(null)
    }
  }, [wanted, compositorRef])

  // Cadence ceiling from benchmark + settings; thermal state survives setting changes.
  useEffect(() => {
    if (status !== 'on' || bench === null) {
      backoffRef.current = null
      return
    }
    const ceiling = helperCadence(helper, bench, { forced, segmentMode })
    const floor: Cadence = segmentMode ? 3 : 0
    const now = performance.now()
    backoffRef.current = backoffRef.current
      ? setBackoffCeiling(backoffRef.current, ceiling, floor)
      : initBackoff(ceiling, now, floor)
  }, [status, bench, helper, forced, segmentMode])

  // Core fill (rescuing screen-coloured clothing) only when it is needed or asked for.
  useEffect(() => {
    compositorRef.current?.setCoreFill(status === 'on' && (forced || helper === 'on'))
  }, [compositorRef, status, forced, helper])

  // Keyer signals → toasts (once each per stage session).
  useEffect(() => {
    if (!comp) return
    comp.onSignal = (s: KeyerSignal) => {
      if (s.type === 'uneven' && !shownRef.current.uneven) {
        shownRef.current.uneven = true
        notifyRef.current(SIGNAL_TEXT.uneven)
      } else if (s.type === 'dark' && !shownRef.current.dark) {
        shownRef.current.dark = true
        notifyRef.current(SIGNAL_TEXT.dark)
      } else if (s.type === 'shirt' && !shownRef.current.shirt) {
        shownRef.current.shirt = true
        notifyRef.current(helper === 'off' ? SIGNAL_TEXT.shirtOff : SIGNAL_TEXT.shirtOn)
        setForced(true)
      }
    }
    return () => {
      if (comp.onSignal) comp.onSignal = null
    }
  }, [comp, helper])

  // Magic Helper trust (mask age in camera frames + motion + confidence), helperTrust.ts.
  const trustRef = useRef(new HelperTrustTracker())

  // Camera switch: start the frame counter over; history reset happens in setForeground.
  useEffect(() => {
    frameRef.current = 0
    const trust = trustRef.current
    trust.reset()
    const stream = video?.srcObject
    const track = stream instanceof MediaStream ? stream.getVideoTracks()[0] : undefined
    const fps = track?.getSettings?.().frameRate
    trust.setFrameMs(fps && fps > 0 ? 1000 / fps : 1000 / 30)
  }, [video])

  // Coming back to the tab: the old matte history no longer matches the picture.
  useEffect(() => {
    const onVis = () => {
      if (!document.hidden) compositorRef.current?.resetTemporal()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [compositorRef])

  const budget = useRef(frameBudgetMs(isPhoneDevice()))
  /** EMA of main-thread ms per segmenter call (separates our load from a 30 fps display cap). */
  const segMsRef = useRef(0)
  const beforeRender = useRef((now: number) => {
    const c = compositorRef.current
    const seg = segRef.current
    const v = videoRef.current
    if (!c) return
    let st = backoffRef.current
    if (!seg || !st || !v || benchingRef.current) {
      if (!benchingRef.current) c.setMlWeight(0)
      return
    }
    if (now - lastBackoffRef.current >= BACKOFF_TICK_MS) {
      lastBackoffRef.current = now
      const stats = c.getStats()
      const work = stats.renderCpuMs + segMsRef.current / Math.max(1, st.cadence)
      st = stepBackoff(st, now, backoffFrameMs(stats.frameP90Ms, work, budget.current), budget.current)
      backoffRef.current = st
    }
    const idx = frameRef.current++
    const on = st.cadence > 0
    if (on !== runningRef.current) {
      runningRef.current = on
      setRunning(on) // only on change, so the rAF loop doesn't re-render React
    }
    if (!on) {
      c.setMlWeight(0)
      return
    }
    // Camera media time (ms) of the frame about to be drawn: mask age is counted in
    // camera frames, not display frames.
    const camT = v.currentTime * 1000
    const trust = trustRef.current
    if (shouldRunThisFrame(st.cadence, idx) && v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      const t0 = performance.now()
      const m = seg.segment(v, now)
      const dt = performance.now() - t0
      segMsRef.current = segMsRef.current === 0 ? dt : segMsRef.current * 0.9 + dt * 0.1
      if (m) {
        c.setMaskData(m.data, m.w, m.h)
        c.setMlWeight(1)
        trust.onMask(m.data, m.w, m.h, camT)
        c.setMlDilate(trust.dilate(KEYER_TUNING.dilate))
      }
    }
    c.setMlTrust(trust.trust(camT))
  })
  return { status, active: status === 'on' && running, beforeRender: beforeRender.current }
}
