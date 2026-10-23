import { describe, expect, it } from 'vitest'
import type { RGB } from '../../types'
import {
  autoThresholds,
  averageLinear,
  combineThresholds,
  deltaE00,
  median,
  keyDistLab,
  keyDistRgb,
  keyLabParams,
  labAlpha,
  labToRgb,
  rgbToLab,
  sliderThresholds,
  srgbToLinear,
  linearToSrgb,
} from './labKey'

const rgb8 = (r: number, g: number, b: number): RGB => [r / 255, g / 255, b / 255]
// Key and samples from docs/research/realtime/deltae.md §2.
const KEY = keyLabParams(rgb8(40, 180, 75))

describe('colour conversions', () => {
  it('sRGB green maps to the reference Lab value', () => {
    const [L, a, b] = rgbToLab([0, 1, 0])
    expect(L).toBeCloseTo(87.735, 1)
    expect(a).toBeCloseTo(-86.183, 1)
    expect(b).toBeCloseTo(83.179, 1)
  })
  it('white is L=100 with no chroma, black is L=0', () => {
    const w = rgbToLab([1, 1, 1])
    expect(w[0]).toBeCloseTo(100, 2)
    expect(Math.abs(w[1])).toBeLessThan(0.01)
    expect(Math.abs(w[2])).toBeLessThan(0.01)
    expect(rgbToLab([0, 0, 0])[0]).toBeCloseTo(0, 5)
  })
  it('linear/sRGB and Lab/RGB round-trip', () => {
    for (const v of [0, 0.002, 0.04, 0.2, 0.5, 0.9, 1]) expect(linearToSrgb(srgbToLinear(v))).toBeCloseTo(v, 6)
    for (const c of [rgb8(40, 180, 75), rgb8(225, 180, 150), rgb8(10, 20, 200)]) {
      const back = labToRgb(rgbToLab(c))
      for (let i = 0; i < 3; i++) expect(back[i]).toBeCloseTo(c[i], 4)
    }
  })
  it('averages in linear light, not sRGB', () => {
    const avg = averageLinear([
      [0, 0, 0],
      [1, 1, 1],
    ])!
    // linear mean 0.5 is sRGB ≈ 0.735, not 0.5
    expect(avg[0]).toBeCloseTo(0.7354, 3)
    expect(averageLinear([])).toBeNull()
  })
})

describe('median', () => {
  it('handles odd, even and empty lists', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(median([])).toBeNaN()
  })
})

describe('deltaE00 (Sharma 2005 test pairs)', () => {
  it('matches pairs #1, #7, #17', () => {
    expect(deltaE00([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 4)
    expect(deltaE00([50, 0, 0], [50, -1, 2])).toBeCloseTo(2.3669, 4)
    expect(deltaE00([50, 2.5, 0], [73, 25, -18])).toBeCloseTo(27.1492, 4)
  })
  it('kL > 1 discounts lightness only', () => {
    expect(deltaE00([50, 0, 0], [60, 0, 0], 2)).toBeCloseTo(deltaE00([50, 0, 0], [60, 0, 0]) / 2, 6)
    expect(deltaE00([50, 0, 0], [50, -1, 2], 3)).toBeCloseTo(2.3669, 4)
  })
  it('is zero for identical colours', () => {
    expect(deltaE00([60, -50, 40], [60, -50, 40])).toBe(0)
  })
})

describe('keyD (shadow-invariant one-sided key distance)', () => {
  it('rates every screen variant as close to the key', () => {
    const screens = [
      rgb8(40, 180, 75), // key itself
      rgb8(25, 128, 50), // 50% shadow
      rgb8(15, 92, 35), // 25% shadow
      rgb8(70, 230, 105), // hot spot
    ]
    for (const s of screens) expect(keyDistRgb(s, KEY)).toBeLessThanOrEqual(3.5)
    // One-sided: more saturated than the key in the same hue is still screen.
    expect(keyDistLab([KEY.L, KEY.a * 1.4, KEY.b * 1.4], KEY)).toBeCloseTo(0, 6)
  })
  it('rates shirts, skin and hair far from the key', () => {
    const keep = [
      rgb8(150, 220, 60), // lime shirt
      rgb8(140, 170, 130), // sage shirt
      rgb8(225, 180, 150), // skin
      rgb8(40, 30, 25), // dark hair
      rgb8(128, 128, 128), // grey
      rgb8(245, 215, 40), // yellow shirt
    ]
    for (const s of keep) expect(keyDistRgb(s, KEY)).toBeGreaterThanOrEqual(25)
  })
  it('forest green really is ambiguous (that is why the app warns about it)', () => {
    expect(keyDistRgb(rgb8(34, 100, 40), KEY)).toBeLessThan(8)
  })
  it('keeps near-black pixels through the dark guard', () => {
    const t = sliderThresholds(0.4, 0.08)
    expect(labAlpha(rgb8(2, 8, 3), KEY, t)).toBe(1)
    expect(labAlpha(rgb8(25, 128, 50), KEY, t)).toBe(0)
    expect(labAlpha(rgb8(225, 180, 150), KEY, t)).toBe(1)
  })
  it('handles a grey key by assuming green', () => {
    const grey = keyLabParams([0.5, 0.5, 0.5])
    expect(grey.dirA).toBeLessThan(0)
    expect(grey.dirB).toBeGreaterThan(0)
  })
})

describe('thresholds', () => {
  it('maps sliders to ΔE units', () => {
    expect(sliderThresholds(0, 0)).toEqual({ lo: 4, hi: 10 })
    const t = sliderThresholds(1, 1)
    expect(t.lo).toBe(20)
    expect(t.hi).toBe(38)
  })
  it('derives auto thresholds from p95 and flags uneven screens', () => {
    const even = autoThresholds([0.2, 0.5, 1, 1.5, 2, 2.5, 3, 1, 0.8, 0.4])
    expect(even.lo).toBeCloseTo(5, 5)
    expect(even.hi).toBeCloseTo(17, 5)
    expect(even.tooUneven).toBe(false)
    const uneven = autoThresholds(Array.from({ length: 20 }, (_, i) => i))
    expect(uneven.lo).toBe(14)
    expect(uneven.tooUneven).toBe(true)
    expect(autoThresholds([]).lo).toBe(4)
  })
  it('auto thresholds only raise the floor', () => {
    const s = sliderThresholds(0.4, 0.08)
    expect(combineThresholds(s, null)).toEqual(s)
    const c = combineThresholds(s, { lo: 14, hi: 26 })
    expect(c).toEqual({ lo: 14, hi: 26 })
    const low = combineThresholds(s, { lo: 5, hi: 17 })
    expect(low).toEqual(s)
  })
})
