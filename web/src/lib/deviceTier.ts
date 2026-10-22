// Device capability tiers and the Magic Helper (ML) cadence policy.
// Pure logic so it can be unit-tested; useStage.ts feeds it measurements.
// Thresholds come from docs/research/realtime/recommendation.md (Tier 2).

/** What the compositor can do on this device. */
export type RenderTier =
  | 'canvas2d' // no WebGL2: CPU key at low resolution, never any ML
  | 'webgl-tent' // WebGL2 without float colour buffers: LUT key + 3x3 tent edges
  | 'webgl-full' // WebGL2 + half/float colour buffers: guided filter edges

export function renderTier(caps: { webgl2: boolean; floatColorBuffer: boolean }): RenderTier {
  if (!caps.webgl2) return 'canvas2d'
  return caps.floatColorBuffer ? 'webgl-full' : 'webgl-tent'
}

/** Run the segmenter every Nth camera frame; 0 = off. */
export type Cadence = 0 | 1 | 2 | 3
export type HelperSetting = 'auto' | 'on' | 'off'
export type Delegate = 'GPU' | 'CPU'

export const BENCH_WARMUP_FRAMES = 5
export const BENCH_FRAMES = 20
/** Thermal backoff: frame-interval p90 must stay over budget this long to step down. */
export const BACKOFF_OVER_MS = 3000
/** ...and after a step down we wait this long before trying one step faster. */
export const BACKOFF_RETRY_MS = 30000
/** mlWeight fade-in/out time. */
export const ML_FADE_MS = 300

export function median(xs: number[]): number {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]
}

/**
 * Benchmark median (ms per segmentForVideo call) → cadence. The CPU (XNNPACK)
 * delegate blocks the main thread for the whole inference, so it gets a stricter cap.
 */
export function cadenceFromBenchmark(medianMs: number, delegate: Delegate): Cadence {
  if (!Number.isFinite(medianMs)) return 0
  if (delegate === 'CPU' && medianMs > 50) return 0
  if (medianMs <= 25) return 1
  if (medianMs <= 50) return 2
  if (medianMs <= 90) return 3
  return 0
}

/** Higher = runs more often. Lets cadences be compared and stepped. */
export function cadenceRank(c: Cadence): number {
  return c === 0 ? 0 : 4 - c
}
function fromRank(r: number): Cadence {
  const k = Math.min(3, Math.max(0, Math.round(r)))
  return k === 0 ? 0 : ((4 - k) as Cadence)
}

/**
 * The cadence ceiling for the current settings.
 * - 'segment' mode (no green screen) needs the mask as its matte, so it always runs
 *   (at least every 3rd frame) whatever the setting says.
 * - 'on' or a forced helper (screen-coloured shirt) runs even if the benchmark said
 *   "too slow", at the slowest cadence; 'auto' trusts the benchmark; 'off' is off.
 */
export function helperCadence(
  setting: HelperSetting,
  benchCadence: Cadence,
  opts: { forced?: boolean; segmentMode?: boolean } = {},
): Cadence {
  if (opts.segmentMode) return benchCadence || 3
  if (setting === 'off') return 0
  if (setting === 'on' || opts.forced) return benchCadence || 3
  return benchCadence
}

export interface BackoffState {
  cadence: Cadence
  /** best cadence allowed (from benchmark + settings) */
  ceiling: Cadence
  /** worst cadence allowed (segment mode never turns ML fully off) */
  floor: Cadence
  overSince: number | null
  lastStepAt: number
}

export function initBackoff(ceiling: Cadence, now: number, floor: Cadence = 0): BackoffState {
  return { cadence: ceiling, ceiling, floor, overSince: null, lastStepAt: now }
}

/** Change the ceiling (settings changed / re-benchmarked) without losing thermal history. */
export function setBackoffCeiling(s: BackoffState, ceiling: Cadence, floor: Cadence = s.floor): BackoffState {
  // Clamp into [floor, ceiling]; if they cross, the ceiling (settings) wins.
  const lo = Math.min(cadenceRank(floor), cadenceRank(ceiling))
  const r = Math.max(lo, Math.min(cadenceRank(s.cadence), cadenceRank(ceiling)))
  return { ...s, ceiling, floor, cadence: fromRank(r) }
}

/**
 * One tick of the thermal backoff state machine. `p90Ms` is the compositor's
 * recent frame-interval p90; `budgetMs` is 24 (iPad/desktop) or 40 (phone).
 * Over budget for 3 s → one step slower (1 → 2 → 3 → off). Under budget and
 * 30 s since the last step → one step faster, never above the ceiling.
 */
export function stepBackoff(s: BackoffState, now: number, p90Ms: number, budgetMs: number): BackoffState {
  if (!Number.isFinite(p90Ms)) return s
  const rank = cadenceRank(s.cadence)
  if (p90Ms > budgetMs) {
    const overSince = s.overSince ?? now
    if (now - overSince >= BACKOFF_OVER_MS && rank > cadenceRank(s.floor)) {
      return { ...s, cadence: fromRank(rank - 1), overSince: null, lastStepAt: now }
    }
    return s.overSince === overSince ? s : { ...s, overSince }
  }
  if (rank < cadenceRank(s.ceiling) && now - s.lastStepAt >= BACKOFF_RETRY_MS) {
    return { ...s, cadence: fromRank(rank + 1), overSince: null, lastStepAt: now }
  }
  return s.overSince === null ? s : { ...s, overSince: null }
}

/**
 * Frame interval to feed stepBackoff. iOS Low Power Mode (and some displays) cap
 * rAF at 30 fps, so intervals sit at ~33 ms however little work we do; backing the
 * Magic Helper off would cost quality and gain nothing. When our own main-thread
 * work per frame (render + amortised segmenter) is under half the budget, slowness
 * is the display's cap, not our load, so report "within budget".
 */
export function backoffFrameMs(p90Ms: number, workMsPerFrame: number, budgetMs: number): number {
  if (!Number.isFinite(p90Ms) || p90Ms <= budgetMs) return p90Ms
  if (Number.isFinite(workMsPerFrame) && workMsPerFrame < budgetMs * 0.5) return budgetMs
  return p90Ms
}

export function shouldRunThisFrame(cadence: Cadence, frameIndex: number): boolean {
  return cadence > 0 && frameIndex % cadence === 0
}

/** Linear fade of the ML weight toward its target over ML_FADE_MS. */
export function fadeToward(current: number, target: number, dtMs: number, durationMs = ML_FADE_MS): number {
  const step = Math.max(0, dtMs) / Math.max(1, durationMs)
  if (current < target) return Math.min(target, current + step)
  return Math.max(target, current - step)
}

/** Frame-interval budget before thermal backoff kicks in. */
export function frameBudgetMs(isPhone: boolean): number {
  return isPhone ? 40 : 24
}

/**
 * Phones get a looser frame budget (they target 30 fps). iPadOS reports a desktop
 * user agent, so "small screen + touch" is the signal rather than the UA alone.
 */
export function detectPhone(env: { userAgent: string; maxTouchPoints: number; screenMin: number }): boolean {
  if (/iPhone|iPod|Android.*Mobile/i.test(env.userAgent)) return true
  return env.maxTouchPoints > 0 && env.screenMin > 0 && env.screenMin < 600
}
