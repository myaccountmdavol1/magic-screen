import { describe, expect, it } from 'vitest'
import {
  backoffFrameMs,
  BACKOFF_OVER_MS,
  BACKOFF_RETRY_MS,
  cadenceFromBenchmark,
  detectPhone,
  fadeToward,
  frameBudgetMs,
  helperCadence,
  initBackoff,
  median,
  percentile,
  renderTier,
  setBackoffCeiling,
  shouldRunThisFrame,
  stepBackoff,
  type BackoffState,
} from './deviceTier'

describe('renderTier', () => {
  it('picks the right path for the device', () => {
    expect(renderTier({ webgl2: false, floatColorBuffer: false })).toBe('canvas2d')
    expect(renderTier({ webgl2: false, floatColorBuffer: true })).toBe('canvas2d')
    expect(renderTier({ webgl2: true, floatColorBuffer: false })).toBe('webgl-tent')
    expect(renderTier({ webgl2: true, floatColorBuffer: true })).toBe('webgl-full')
  })
})

describe('statistics', () => {
  it('median and percentile', () => {
    expect(median([5, 1, 3])).toBe(3)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(Number.isNaN(median([]))).toBe(true)
    const xs = Array.from({ length: 100 }, (_, i) => i + 1)
    expect(percentile(xs, 0.9)).toBe(90)
  })
})

describe('cadenceFromBenchmark', () => {
  it('maps benchmark medians to cadences', () => {
    expect(cadenceFromBenchmark(12, 'GPU')).toBe(1)
    expect(cadenceFromBenchmark(25, 'GPU')).toBe(1)
    expect(cadenceFromBenchmark(40, 'GPU')).toBe(2)
    expect(cadenceFromBenchmark(80, 'GPU')).toBe(3)
    expect(cadenceFromBenchmark(120, 'GPU')).toBe(0)
    expect(cadenceFromBenchmark(NaN, 'GPU')).toBe(0)
  })
  it('only allows the CPU delegate up to 50 ms', () => {
    expect(cadenceFromBenchmark(45, 'CPU')).toBe(2)
    expect(cadenceFromBenchmark(60, 'CPU')).toBe(0)
  })
})

describe('helperCadence', () => {
  it('follows the teacher setting', () => {
    expect(helperCadence('auto', 2)).toBe(2)
    expect(helperCadence('auto', 0)).toBe(0)
    expect(helperCadence('off', 1)).toBe(0)
    expect(helperCadence('on', 0)).toBe(3)
    expect(helperCadence('on', 1)).toBe(1)
  })
  it('a screen-coloured shirt forces it on unless the teacher said off', () => {
    expect(helperCadence('auto', 0, { forced: true })).toBe(3)
    expect(helperCadence('off', 0, { forced: true })).toBe(0)
  })
  it('segment mode always runs the segmenter', () => {
    expect(helperCadence('off', 0, { segmentMode: true })).toBe(3)
    expect(helperCadence('auto', 1, { segmentMode: true })).toBe(1)
  })
})

describe('thermal backoff', () => {
  const run = (s: BackoffState, from: number, to: number, p90: number, budget = 24) => {
    let st = s
    for (let t = from; t <= to; t += 100) st = stepBackoff(st, t, p90, budget)
    return st
  }

  it('steps down only after 3 s over budget, through every cadence to off', () => {
    let s = initBackoff(1, 0)
    s = run(s, 0, BACKOFF_OVER_MS - 200, 30)
    expect(s.cadence).toBe(1)
    s = run(s, BACKOFF_OVER_MS - 100, BACKOFF_OVER_MS + 100, 30)
    expect(s.cadence).toBe(2)
    s = run(s, 3200, 6400, 30)
    expect(s.cadence).toBe(3)
    s = run(s, 6500, 9700, 30)
    expect(s.cadence).toBe(0)
    s = run(s, 9800, 20000, 30)
    expect(s.cadence).toBe(0)
  })

  it('a short spike does not step down', () => {
    let s = initBackoff(1, 0)
    s = run(s, 0, 2000, 30)
    s = stepBackoff(s, 2100, 10, 24)
    s = run(s, 2200, 4500, 30)
    expect(s.cadence).toBe(1)
  })

  it('steps back up after 30 s under budget, but never above the ceiling', () => {
    let s = initBackoff(2, 0)
    s = run(s, 0, 3100, 50)
    expect(s.cadence).toBe(3)
    const down = s.lastStepAt
    s = run(s, down + 100, down + BACKOFF_RETRY_MS - 100, 10)
    expect(s.cadence).toBe(3)
    s = run(s, down + BACKOFF_RETRY_MS, down + BACKOFF_RETRY_MS + 100, 10)
    expect(s.cadence).toBe(2)
    s = run(s, down + BACKOFF_RETRY_MS + 200, down + 4 * BACKOFF_RETRY_MS, 10)
    expect(s.cadence).toBe(2)
  })

  it('respects the floor (segment mode never turns ML off)', () => {
    let s = initBackoff(1, 0, 3)
    s = run(s, 0, 20000, 60, 40)
    expect(s.cadence).toBe(3)
  })

  it('ceiling changes clamp the current cadence', () => {
    let s = initBackoff(1, 0)
    s = setBackoffCeiling(s, 3)
    expect(s.cadence).toBe(3)
    s = setBackoffCeiling(s, 0)
    expect(s.cadence).toBe(0)
    s = setBackoffCeiling(s, 2)
    expect(s.cadence).toBe(0) // waits for the retry timer to climb back
  })
})

describe('helpers', () => {
  it('shouldRunThisFrame', () => {
    expect([0, 1, 2, 3].map((i) => shouldRunThisFrame(2, i))).toEqual([true, false, true, false])
    expect(shouldRunThisFrame(0, 0)).toBe(false)
    expect(shouldRunThisFrame(1, 7)).toBe(true)
  })
  it('fadeToward reaches the target in 300 ms and never overshoots', () => {
    let w = 0
    for (let i = 0; i < 9; i++) w = fadeToward(w, 1, 33.4)
    expect(w).toBeGreaterThan(0.99)
    w = fadeToward(w, 1, 1000)
    expect(w).toBe(1)
    expect(fadeToward(1, 0, 150)).toBeCloseTo(0.5, 5)
    expect(fadeToward(0.2, 0, 1000)).toBe(0)
  })
  it('backoffFrameMs ignores a 30 fps display cap when our own work is light', () => {
    // Low Power Mode: 33 ms intervals, but only ~6 ms of our work per frame.
    expect(backoffFrameMs(33.4, 6, 24)).toBe(24)
    // Genuinely overloaded: heavy segmenter work keeps the real interval.
    expect(backoffFrameMs(45, 20, 24)).toBe(45)
    // Within budget passes through unchanged.
    expect(backoffFrameMs(16.7, 3, 24)).toBe(16.7)
    expect(Number.isNaN(backoffFrameMs(NaN, 3, 24))).toBe(true)
  })
  it('frame budgets and phone detection', () => {
    expect(frameBudgetMs(false)).toBe(24)
    expect(frameBudgetMs(true)).toBe(40)
    expect(detectPhone({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)', maxTouchPoints: 5, screenMin: 390 })).toBe(true)
    // iPadOS reports a Mac UA
    expect(detectPhone({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 5, screenMin: 820 })).toBe(false)
    expect(detectPhone({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', maxTouchPoints: 0, screenMin: 1080 })).toBe(false)
  })
})
