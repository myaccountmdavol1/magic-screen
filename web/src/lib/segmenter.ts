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

/** Masks wider than this are point-sampled down: the model itself is 256x256. */
const MAX_MASK_W = 256

export async function createSegmenter(): Promise<Segmenter> {
  const { FilesetResolver, ImageSegmenter } = await import('@mediapipe/tasks-vision')
  const base = `${import.meta.env.BASE_URL ?? '/'}`.replace(/\/?$/, '/')
  const fileset = await FilesetResolver.forVisionTasks(`${base}mediapipe/wasm`)

  const create = (delegate: Delegate) =>
    ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: `${base}mediapipe/selfie_segmenter.tflite`, delegate },
      runningMode: 'VIDEO',
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    })

  let seg: ImageSegmenter
  let delegate: Delegate = 'GPU'
  try {
    seg = await create('GPU')
  } catch (err) {
    // Older iPads / blocklisted GPUs: the CPU (XNNPACK) path is slower but works everywhere.
    console.warn('[segmenter] GPU delegate failed, using CPU', err)
    seg = await create('CPU')
    delegate = 'CPU'
  }

  let buf = new Uint8Array(0)
  let lastTs = -1
  let closed = false

  const segment = (video: HTMLVideoElement | HTMLCanvasElement, ts: number): MaskFrame | null => {
    if (closed) return null
    if ('videoWidth' in video ? video.readyState < 2 || !video.videoWidth : !video.width) return null
    // MediaPipe requires strictly increasing timestamps (ms).
    const t = Math.max(Math.round(ts), lastTs + 1)
    lastTs = t
    let result: ImageSegmenterResult
    try {
      result = seg.segmentForVideo(video, t)
    } catch (err) {
      console.warn('[segmenter] segmentForVideo failed', err)
      return null
    }
    try {
      const masks = result.confidenceMasks
      if (!masks?.length) return null
      // selfie_segmenter has one output (person); multi-class variants put person last.
      const mask = masks[masks.length - 1]
      const { width, height } = mask
      const conf = mask.getAsFloat32Array()
      // Masks may come back at video size; the compositor only needs model-size
      // detail, so sample down while converting (fewer bytes to convert and upload).
      const step = Math.max(1, width / MAX_MASK_W)
      const w = Math.max(1, Math.round(width / step))
      const h = Math.max(1, Math.round(height / step))
      if (buf.length !== w * h) buf = new Uint8Array(w * h)
      if (step === 1) {
        for (let i = 0; i < buf.length; i++) buf[i] = conf[i] * 255
      } else {
        for (let y = 0; y < h; y++) {
          const row = Math.min(height - 1, Math.floor((y + 0.5) * step)) * width
          for (let x = 0; x < w; x++) buf[y * w + x] = conf[row + Math.min(width - 1, Math.floor((x + 0.5) * step))] * 255
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
      seg.close()
    },
  }
}
