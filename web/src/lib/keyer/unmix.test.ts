import { describe, expect, it } from 'vitest'
import { blurFusionF, projBlendAlpha, projectionAlpha, type Lin } from './unmix'

const SKIN: Lin = [0.6, 0.35, 0.25]
const GREEN: Lin = [0.04, 0.5, 0.06]
const mix = (a: number, f: Lin, b: Lin): Lin => [a * f[0] + (1 - a) * b[0], a * f[1] + (1 - a) * b[1], a * f[2] + (1 - a) * b[2]]

describe('blurFusionF', () => {
  it('returns I where alpha = 1 (key alpha only)', () => {
    const I: Lin = [0.5, 0.4, 0.3]
    const F = blurFusionF(I, 1, SKIN, GREEN, { proj: 0 })
    F.forEach((v, i) => expect(v).toBeCloseTo(I[i], 9))
  })
  it('falls back to the local foreground colour as alpha -> 0', () => {
    const F = blurFusionF(GREEN, 0, SKIN, GREEN, { proj: 0 })
    F.forEach((v, i) => expect(v).toBeCloseTo(SKIN[i], 9))
  })
  it('recovers skin from 0.3·skin + 0.7·green with exact F̂ and B̂', () => {
    const I = mix(0.3, SKIN, GREEN)
    for (const proj of [0, 1]) {
      const F = blurFusionF(I, 0.3, SKIN, GREEN, { proj })
      F.forEach((v, i) => expect(Math.abs(v - SKIN[i])).toBeLessThan(1e-6))
    }
  })
  it('recovers skin even when the key alpha is too opaque (colour-line alpha)', () => {
    const I = mix(0.5, SKIN, GREEN)
    const keyOnly = blurFusionF(I, 0.8, SKIN, GREEN, { proj: 0 })
    const proj = blurFusionF(I, 0.8, SKIN, GREEN, { proj: 1 })
    expect(Math.abs(keyOnly[1] - SKIN[1])).toBeGreaterThan(0.01) // screen green left over
    proj.forEach((v, i) => expect(Math.abs(v - SKIN[i])).toBeLessThan(1e-6))
  })
  it('stays in [0, 1] and honours the cap', () => {
    const F = blurFusionF([1, 0, 1], 0.6, SKIN, GREEN, { cap: 0.2 })
    F.forEach((v) => {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    })
    const d = Math.hypot(F[0] - SKIN[0], F[1] - SKIN[1], F[2] - SKIN[2])
    expect(d).toBeLessThanOrEqual(0.2 + 1e-9)
  })
  it('ignores the colour line where F̂ and B̂ are the same colour (green shirt)', () => {
    const shirt: Lin = [0.05, 0.48, 0.07]
    expect(blurFusionF(shirt, 1, shirt, GREEN, { proj: 1 })).toEqual(blurFusionF(shirt, 1, shirt, GREEN, { proj: 0 }))
  })
})

describe('projectionAlpha', () => {
  it('measures the mixing fraction', () => {
    expect(projectionAlpha(mix(0.25, SKIN, GREEN), SKIN, GREEN)).toBeCloseTo(0.25, 9)
    expect(projectionAlpha(GREEN, SKIN, GREEN)).toBe(0)
    expect(projectionAlpha(SKIN, SKIN, GREEN)).toBe(1)
  })
})

describe('projection blend alpha (item 16)', () => {
  it('moves a soft-band alpha toward the colour-line fraction', () => {
    expect(projBlendAlpha(0.6, 0.3, 0.2, 0.75)).toBeCloseTo(0.375, 6)
    expect(projBlendAlpha(0.3, 0.6, 0.2, 1)).toBeCloseTo(0.6, 6)
  })
  it('does nothing where F^ and B^ are too similar, when off, or outside the band', () => {
    expect(projBlendAlpha(0.6, 0.3, 0.005, 1)).toBe(0.6)
    expect(projBlendAlpha(0.6, 0.3, 0.2, 0)).toBe(0.6)
    expect(projBlendAlpha(0.999, 0.3, 0.2, 1)).toBe(0.999)
  })
  it('taper keeps a nearly opaque key from being lowered, but still lets it rise', () => {
    expect(projBlendAlpha(0.99, 0.5, 0.2, 1)).toBeCloseTo(0.99, 6)
    expect(projBlendAlpha(0.99, 0.5, 0.2, 1, 0)).toBeCloseTo(0.5, 6)
    expect(projBlendAlpha(0.9, 1, 0.2, 1)).toBeCloseTo(1, 6)
  })
})
