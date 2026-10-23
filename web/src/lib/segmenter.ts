// MediaPipe selfie segmentation. Two uses:
// - "Magic Helper" in green screen mode: a garbage/core matte fused with the chroma key
// - the matte itself in "AI cutout" (segment) mode, for rooms without a green screen
// Lazy-loaded by the stage. Wasm + model are served from /mediapipe/ (copied by
// scripts/copy-mediapipe.mjs) so the PWA works offline and nothing leaves the device.
import type { ImageSegmenter, ImageSegmenterResult } from '@mediapipe/tasks-vision'
import { BENCH_FRAMES, BENCH_WARMUP_FRAMES, median, type Delegate } from './deviceTier'

/** Person confidence 0..255, row-major, top row first, camera space (unmirrored). */
export interface MaskFrame {
  data: Uint8Array
  w: number
  h: number
}

export interface Segmenter {
  readonly delegate: Delegate
  /**
   * Segment the current video frame (or a canvas, for the quality harness). Null if
   * there is no frame yet or inference failed.
   */
  segment(video: HTMLVideoElement | HTMLCanvasElement, ts: number): MaskFrame | null
  /**
   * Warm up, then time `frames` calls (one per animation frame so the UI keeps
   * moving) and return the median ms per call, including the mask readback.
   * Infinity if too few frames succeeded.
   */
  benchmark(
    video: HTMLVideoElement,
    opts?: { frames?: number; warmup?: number; onMask?: (m: MaskFrame) => void },
  ): Promise<number>
  close(): void
}

/** Masks wider than this are point-sampled down: the models are at most 256 wide. */
const MAX_MASK_W = 256

/**
 * Which MediaPipe model (all Apache-2.0):
 * - 'landscape': selfie_segmenter_landscape, 256x144 float16 (~250 KB)
 * - 'selfie': selfie_segmenter, 256x256 float16 (~250 KB)
 * - 'multiclass': selfie_multiclass_256x256 float32 (~16 MB, hair/face/body/clothes
 *   classes; person = 1 - background). Evaluation only: never shipped or precached.
 * - 'auto': landscape for landscape cameras, selfie (square) for portrait ones; the
 *   second model is loaded only if the camera turns portrait.
 */
export type SegModel = 'auto' | 'selfie' | 'landscape' | 'multiclass'
type ConcreteModel = Exclude<SegModel, 'auto'>

/**
 * How a camera frame is fed to the model:
 * - 'pad': draw the frame, aspect kept, centred into a model-sized canvas (letterbox),
 *   so the model sees undistorted people; the mask comes back model-sized (a tiny
 *   readback instead of a full camera-size float mask) and is cropped to the picture
 * - 'fit': draw the frame scaled to exactly the model input size (squashed if the
 *   aspect differs), model-sized readback
 * - 'stretch': hand MediaPipe the whole frame (it resizes itself) and read back a
 *   camera-size mask (the original behaviour; slowest)
 */
export type SegInput = 'stretch' | 'pad' | 'fit'

export interface SegmenterOptions {
  model?: SegModel
  input?: SegInput
}

const MODEL_FILES: Record<ConcreteModel, { file: string; w: number; h: number }> = {
  selfie: { file: 'selfie_segmenter.tflite', w: 256, h: 256 },
  landscape: { file: 'selfie_segmenter_landscape.tflite', w: 256, h: 144 },
  multiclass: { file: 'selfie_multiclass_256x256.tflite', w: 256, h: 256 },
}

/**
 * Defaults picked with the keyer harness (e2e/harness, webcam-beige + classroom):
 * the landscape model with letterboxed input had ML-mask IoU 0.98-0.99 vs 0.44-0.92
 * for the square model on the full frame, at half the per-call cost (6.5 vs 13.7 ms
 * at 720p in Chromium, most of it the full-size mask readback).
 */
export const DEFAULT_SEG_OPTIONS: Required<SegmenterOptions> = { model: 'auto', input: 'pad' }

/** Frames at least this wide (w / h) use the landscape model in 'auto'. */
const LANDSCAPE_MIN_ASPECT = 1.2

/**
 * Fetch the MediaPipe JS chunk without creating a segmenter (main.tsx calls it at idle).
 * An app update deletes the old hashed chunks, so a lazy import made later in the session
 * could 404; once loaded here, the module stays in memory.
 */
export async function preloadVisionLib(): Promise<void> {
  await import('@mediapipe/tasks-vision')
}

export async function createSegmenter(opts: SegmenterOptions = {}): Promise<Segmenter> {
  const model = opts.model ?? DEFAULT_SEG_OPTIONS.model
  const input = opts.input ?? DEFAULT_SEG_OPTIONS.input
  const { FilesetResolver, ImageSegmenter } = await import('@mediapipe/tasks-vision')
  const base = `${import.meta.env.BASE_URL ?? '/'}`.replace(/\/?$/, '/')
  const fileset = await FilesetResolver.forVisionTasks(`${base}mediapipe/wasm`)

  const create = (m: ConcreteModel, delegate: Delegate) =>
    ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: `${base}mediapipe/${MODEL_FILES[m].file}`, delegate },
      runningMode: 'VIDEO',
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    })

  const first: ConcreteModel = model === 'auto' ? 'landscape' : model
  let delegate: Delegate = 'GPU'
  let firstSeg: ImageSegmenter
  try {
    firstSeg = await create(first, 'GPU')
  } catch (err) {
    // Older iPads / blocklisted GPUs: the CPU (XNNPACK) path is slower but works everywhere.
    console.warn('[segmenter] GPU delegate failed, using CPU', err)
    firstSeg = await create(first, 'CPU')
    delegate = 'CPU'
  }
  const loaded = new Map<ConcreteModel, ImageSegmenter>([[first, firstSeg]])
  const loading = new Set<ConcreteModel>()

  let buf = new Uint8Array(0)
  let lastTs = -1
  let closed = false
  // Model-sized input canvases for 'pad' / 'fit' (one per model input size).
  const canvases = new Map<string, { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D }>()
  const inputCanvas = (w: number, h: number) => {
    if (input === 'stretch' || typeof document === 'undefined') return null
    const k = `${w}x${h}`
    let e = canvases.get(k)
    if (!e) {
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      const ctx = c.getContext('2d', { alpha: false })
      if (!ctx) return null
      e = { c, ctx }
      canvases.set(k, e)
    }
    return e
  }

  /** The model for this frame; 'auto' starts loading the square model for portrait cameras. */
  const pick = (vw: number, vh: number): ConcreteModel => {
    if (model !== 'auto') return model
    const want: ConcreteModel = vw / vh >= LANDSCAPE_MIN_ASPECT ? 'landscape' : 'selfie'
    if (loaded.has(want)) return want
    if (!loading.has(want) && !closed) {
      loading.add(want)
      create(want, delegate)
        .then((s) => (closed ? s.close() : void loaded.set(want, s)))
        .catch((err: unknown) => console.warn(`[segmenter] ${want} model unavailable`, err))
    }
    return first // letterboxed meanwhile
  }

  const segment = (video: HTMLVideoElement | HTMLCanvasElement, ts: number): MaskFrame | null => {
    if (closed) return null
    if ('videoWidth' in video ? video.readyState < 2 || !video.videoWidth : !video.width) return null
    const vw = 'videoWidth' in video ? video.videoWidth : video.width
    const vh = 'videoWidth' in video ? video.videoHeight : video.height
    const m = pick(vw, vh)
    const seg = loaded.get(m)!
    const spec = MODEL_FILES[m]
    // Picture rectangle inside the model input (whole input unless letterboxed).
    let rx = 0
    let ry = 0
    let rw = spec.w
    let rh = spec.h
    let frame: HTMLVideoElement | HTMLCanvasElement = video
    const inc = inputCanvas(spec.w, spec.h)
    if (inc) {
      if (input === 'pad') {
        const k = Math.min(spec.w / vw, spec.h / vh)
        rw = Math.max(1, Math.round(vw * k))
        rh = Math.max(1, Math.round(vh * k))
        rx = (spec.w - rw) >> 1
        ry = (spec.h - rh) >> 1
        if (rw !== spec.w || rh !== spec.h) {
          // Mid grey bars: neutral for the model, never mistaken for a person.
          inc.ctx.fillStyle = '#808080'
          inc.ctx.fillRect(0, 0, spec.w, spec.h)
        }
      }
      inc.ctx.drawImage(video, rx, ry, rw, rh)
      frame = inc.c
    }
    // MediaPipe requires strictly increasing timestamps (ms).
    const t = Math.max(Math.round(ts), lastTs + 1)
    lastTs = t
    let result: ImageSegmenterResult
    try {
      result = seg.segmentForVideo(frame, t)
    } catch (err) {
      console.warn('[segmenter] segmentForVideo failed', err)
      return null
    }
    try {
      const masks = result.confidenceMasks
      if (!masks?.length) return null
      // selfie models: one output (person). Multiclass: [background, hair, body
      // skin, face skin, clothes, others] -> person = 1 - background.
      const multi = masks.length > 1
      const mask = masks[multi ? 0 : masks.length - 1]
      const { width, height } = mask
      const conf = mask.getAsFloat32Array()
      // Crop to the picture (letterbox), then sample down to at most MAX_MASK_W wide.
      const sx0 = frame === video ? 0 : (rx * width) / spec.w
      const sy0 = frame === video ? 0 : (ry * height) / spec.h
      const sw = frame === video ? width : (rw * width) / spec.w
      const sh = frame === video ? height : (rh * height) / spec.h
      const step = Math.max(1, sw / MAX_MASK_W)
      const w = Math.max(1, Math.round(sw / step))
      const h = Math.max(1, Math.round(sh / step))
      if (buf.length !== w * h) buf = new Uint8Array(w * h)
      for (let y = 0; y < h; y++) {
        const row = Math.min(height - 1, Math.floor(sy0 + (y + 0.5) * step)) * width
        for (let x = 0; x < w; x++) {
          const v = conf[row + Math.min(width - 1, Math.floor(sx0 + (x + 0.5) * step))]
          buf[y * w + x] = (multi ? 1 - v : v) * 255
        }
      }
      return { data: buf, w, h }
    } finally {
      // Masks hold GPU/wasm memory that is only freed by close().
      result.close()
    }
  }

  return {
    delegate,
    segment,
    async benchmark(video, opts = {}) {
      const { frames = BENCH_FRAMES, warmup = BENCH_WARMUP_FRAMES, onMask } = opts
      const times: number[] = []
      for (let i = 0; i < warmup + frames && !closed; i++) {
        await new Promise<void>((r) => requestAnimationFrame(() => r()))
        const t0 = performance.now()
        const ok = segment(video, t0)
        const dt = performance.now() - t0
        if (ok && i >= warmup) times.push(dt)
        // Segment mode keeps showing a live cutout while the device is measured.
        if (ok) onMask?.(ok)
      }
      return times.length >= Math.min(5, frames) ? median(times) : Infinity
    },
    close() {
      if (closed) return
      closed = true
      for (const s of loaded.values()) s.close()
      loaded.clear()
    },
  }
}
