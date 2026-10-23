// Magic Helper trust (plan item 2, docs/research/corridorkey-lessons/plan-final.md).
//
// The idea comes from CorridorKey, which gives each hint mask one trust value
// instead of editing the mask. Our helper mask is often a little late: MediaPipe
// runs every 2nd or 3rd camera frame. A stale mask behind a waving arm can then
// paint screen back in (a "ghost" from the core fill) or cut an arm off (the
// garbage matte). So each new mask gets a quality score, and the trust decays
// with the mask's age. Age is counted in camera frames, measured with
// video-frame timestamps, not display time. It decays faster while the child
// moves. The Compositor uses the trust to fade the core fill first and the
// garbage kill later, and it widens the garbage matte while the child moves fast.
//
// Original code: clean-room from the plan's description; no CorridorKey code.

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

export interface MaskStats {
  /** "model unsure" pixels per outline pixel, relative to a crisp mask (1 = crisp) */
  excess: number
  /** mean |Δ confidence| per camera frame since the previous mask (0..1) */
  motion: number
}

/**
 * Per new mask: uncertainty relative to the outline length, and motion against
 * the previous mask. Measuring uncertainty against the outline keeps a close-up
 * child from being distrusted just for having more edge.
 * @param framesApart camera frames between the two masks (motion is per frame)
 */
export function maskStats(cur: Uint8Array, prev: Uint8Array | null, w: number, framesApart = 1): MaskStats {
  let amb = 0
  let outline = 0
  let diff = 0
  const n = cur.length
  const usePrev = !!prev && prev.length === n
  for (let i = 0; i < n; i++) {
    const v = cur[i]
    if (v > 51 && v < 204) amb++
    const inside = v > 127
    if (i % w !== 0 && inside !== cur[i - 1] > 127) outline++
    if (i >= w && inside !== cur[i - w] > 127) outline++
    if (usePrev) diff += Math.abs(v - prev![i])
  }
  // A crisp mask has about 3 unsure pixels per outline pixel; more means the model is guessing.
  // No outline at all (empty or full mask) with unsure pixels is pure guessing.
  const excess = outline ? amb / (3 * outline) : amb > n * 0.01 ? 4 : 0
  const motion = usePrev ? diff / (255 * n) / Math.max(1, framesApart) : 0
  return { excess, motion }
}

/** Trust in [0, 1] of a mask with these stats, `ageFrames` camera frames after it was captured. */
export function helperTrust(s: MaskStats, ageFrames: number): number {
  const qModel = clamp01(1.5 - 0.5 * s.excess) // 1 up to 1x the crisp level, 0 at 3x
  const qAge = Math.exp(-Math.max(0, ageFrames) * (0.04 + 4 * s.motion)) // still: slow decay; waving: fast
  return clamp01(qModel * qAge)
}

/** Garbage-matte dilation (fraction of frame width): wider while the child moves fast. */
export const dilateFor = (motion: number, base: number) => base * (1 + 0.6 * clamp01((motion - 0.01) / 0.05))

/**
 * Keeps the stats of the latest mask and turns frame timestamps into trust. Used
 * by the live stage (useStage) and by the quality harness, so both run the same
 * code. Times are camera media times in ms (video.currentTime × 1000, or the
 * harness's frame clock), never performance.now().
 */
export class HelperTrustTracker {
  private prev: Uint8Array | null = null
  private prevAt = NaN
  private capturedAt = NaN
  private frameMs = 1000 / 30
  stats: MaskStats = { excess: 0, motion: 0 }

  /** Camera frame interval in ms (from the track's frame rate). */
  setFrameMs(ms: number): void {
    if (Number.isFinite(ms) && ms > 0) this.frameMs = Math.min(1000 / 10, Math.max(1000 / 120, ms))
  }

  /** A new mask computed from the camera frame at `capturedAt`. `data` may be reused by the caller (copied). */
  onMask(data: Uint8Array, w: number, h: number, capturedAt: number): MaskStats {
    const n = w * h
    const cur = data.subarray(0, n)
    const apart = Number.isFinite(this.prevAt) ? Math.max(1, Math.round((capturedAt - this.prevAt) / this.frameMs)) : 1
    this.stats = maskStats(cur, this.prev && this.prev.length === n ? this.prev : null, w, apart)
    if (!this.prev || this.prev.length !== n) this.prev = new Uint8Array(n)
    this.prev.set(cur)
    this.prevAt = capturedAt
    this.capturedAt = capturedAt
    return this.stats
  }

  /** Camera frames since the mask was captured, at camera time `now`. */
  ageFrames(now: number): number {
    if (!Number.isFinite(this.capturedAt) || !Number.isFinite(now)) return 0
    return Math.max(0, (now - this.capturedAt) / this.frameMs)
  }

  /** Trust of the current mask at camera time `now` (1 before any mask). */
  trust(now: number): number {
    if (!Number.isFinite(this.capturedAt)) return 1
    return helperTrust(this.stats, this.ageFrames(now))
  }

  /** Garbage dilation for the current mask, from the base fraction of frame width. */
  dilate(base: number): number {
    return dilateFor(this.stats.motion, base)
  }

  /** Forget everything (camera switch). */
  reset(): void {
    this.prev = null
    this.prevAt = NaN
    this.capturedAt = NaN
    this.stats = { excess: 0, motion: 0 }
  }
}
