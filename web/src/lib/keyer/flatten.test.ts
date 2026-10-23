import { describe, expect, it } from 'vitest'
import type { RGB } from '../../types'
import { FLATTEN_GAIN_MAX, FLATTEN_GAIN_MIN, flattenSrgb, gainFor, lumaGainFor } from './flatten'
import { keyDistRgb, keyLabParams, srgbToLinear } from './labKey'

const KEY: RGB = [55 / 255, 165 / 255, 85 / 255]
const lin = (c: RGB): RGB => [srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2])]

describe('screen flattening gain (item 7)', () => {
  it('an even plate (plate = key) gives gain 1', () => {
    for (const g of gainFor(lin(KEY), lin(KEY))) expect(g).toBeCloseTo(1, 6)
    for (const g of lumaGainFor(lin(KEY), lin(KEY))) expect(g).toBeCloseTo(1, 6)
  })

  it('clamps the gain', () => {
    const black: RGB = [0, 0, 0]
    const white: RGB = [1, 1, 1]
    for (const g of gainFor(lin(KEY), black)) expect(g).toBe(FLATTEN_GAIN_MAX)
    for (const g of gainFor(lin(KEY), white)) expect(g).toBe(FLATTEN_GAIN_MIN)
    for (const g of lumaGainFor(lin(KEY), white)) expect(g).toBe(FLATTEN_GAIN_MIN)
  })

  it('a hotspot / shadow pixel times its gain keys like the screen', () => {
    const k = keyLabParams(KEY)
    const keyL = lin(KEY)
    for (const scale of [0.72, 1.35]) {
      const plateL = keyL.map((v) => v * scale) as RGB
      const plate: RGB = flattenSrgb(KEY, [scale, scale, scale]) // the camera's view of that patch
      const before = keyDistRgb(plate, k)
      const after = keyDistRgb(flattenSrgb(plate, gainFor(keyL, plateL)), k)
      expect(after).toBeLessThan(0.5)
      expect(after).toBeLessThanOrEqual(before)
    }
  })

  it('strength 0 leaves the colour unchanged', () => {
    const c: RGB = [0.8, 0.4, 0.3]
    const out = flattenSrgb(c, [1.5, 0.7, 1.2], 0)
    out.forEach((v, i) => expect(v).toBeCloseTo(c[i], 6))
  })
})
