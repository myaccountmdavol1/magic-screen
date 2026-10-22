import { describe, expect, it } from 'vitest'
import type { RGB } from '../../types'
import { bakeKeyLut, makeByteIndex, sampleKeyLut } from './keyLut'
import { LUT_N, darkGuard, keyDistRgb, keyLabParams, rgbToLab, sliderThresholds } from './labKey'

const rgb8 = (r: number, g: number, b: number): RGB => [r / 255, g / 255, b / 255]
const KEY = keyLabParams(rgb8(40, 180, 75))
const lut = bakeKeyLut(KEY)

// Deterministic pseudo-random colours (LCG) so the test is reproducible.
function* colours(count: number): Generator<RGB> {
  let s = 12345
  const next = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
  for (let i = 0; i < count; i++) yield [next(), next(), next()]
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

describe('bakeKeyLut', () => {
  it('has the expected size and exact values at grid points', () => {
    expect(lut.length).toBe(LUT_N ** 3 * 2)
    const n = LUT_N
    for (const [ri, gi, bi] of [
      [0, 0, 0],
      [n - 1, n - 1, n - 1],
      [10, 40, 20],
    ]) {
      const c: RGB = [ri / (n - 1), gi / (n - 1), bi / (n - 1)]
      const [d, guard] = sampleKeyLut(lut, n, c[0], c[1], c[2])
      expect(d).toBeCloseTo(Math.min(48, keyDistRgb(c, KEY)), 0)
      expect(guard).toBeCloseTo(darkGuard(rgbToLab(c)[0]), 2)
    }
  })

  it('trilinear sampling tracks the analytic metric (alpha error is small)', () => {
    const t = sliderThresholds(0.4, 0.08)
    let worst = 0
    let sum = 0
    let count = 0
    for (const c of colours(4000)) {
      const lab = rgbToLab(c)
      const exact = Math.max(smooth(t.lo, t.hi, keyDistRgb(c, KEY)), darkGuard(lab[0]))
      const [d, g] = sampleKeyLut(lut, LUT_N, c[0], c[1], c[2])
      const approx = Math.max(smooth(t.lo, t.hi, d), g)
      const err = Math.abs(exact - approx)
      worst = Math.max(worst, err)
      sum += err
      count++
    }
    // Mean error is what shows up as edge noise; the worst case sits in the
    // dark-guard knee and the transition band, which the guided filter smooths.
    expect(sum / count).toBeLessThan(0.01)
    expect(worst).toBeLessThan(0.35)
  })

  it('separates screen from subject after interpolation', () => {
    const screen = [rgb8(40, 180, 75), rgb8(25, 128, 50), rgb8(15, 92, 35), rgb8(70, 230, 105)]
    const subject = [rgb8(150, 220, 60), rgb8(140, 170, 130), rgb8(225, 180, 150), rgb8(245, 215, 40)]
    for (const c of screen) expect(sampleKeyLut(lut, LUT_N, ...c)[0]).toBeLessThan(5)
    for (const c of subject) expect(sampleKeyLut(lut, LUT_N, ...c)[0]).toBeGreaterThan(24)
  })

  it('byte index maps 0 and 255 to the LUT ends', () => {
    const idx = makeByteIndex()
    expect(idx[0]).toBe(0)
    expect(idx[255]).toBe(LUT_N - 1)
  })
})
