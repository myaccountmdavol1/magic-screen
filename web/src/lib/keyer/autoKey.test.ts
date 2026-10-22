import { describe, expect, it } from 'vitest'
import type { RGB } from '../../types'
import { autoKeyFromSamples, despill, keyAlpha, pickKeyColor, rgbToYCbCr } from './autoKey'

const GREEN_KEY: RGB = [0.2, 0.75, 0.3] // store default
const BLUE_KEY: RGB = [0.1, 0.3, 0.85]
const SIM = 0.4
const SMOOTH = 0.08

const SKIN: RGB[] = [
  [0.96, 0.8, 0.69], // very light
  [0.9, 0.7, 0.6],
  [0.78, 0.57, 0.44],
  [0.55, 0.38, 0.26],
  [0.35, 0.22, 0.16], // deep
  [0.24, 0.15, 0.11], // very deep
]
const NEUTRALS: RGB[] = [
  [0.5, 0.5, 0.5],
  [0.9, 0.9, 0.9],
  [1, 1, 1],
  [0.2, 0.2, 0.2],
  [0.02, 0.02, 0.02],
]

const mix = (a: RGB, b: RGB, t: number): RGB => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
]

describe('rgbToYCbCr', () => {
  it('maps gray to zero chroma and white to full luma', () => {
    const [y, cb, cr] = rgbToYCbCr([0.5, 0.5, 0.5])
    expect(y).toBeCloseTo(0.5, 5)
    expect(cb).toBeCloseTo(0, 5)
    expect(cr).toBeCloseTo(0, 5)
    expect(rgbToYCbCr([1, 1, 1])[0]).toBeCloseTo(1, 5)
  })
  it('puts green in negative Cb/Cr and blue in positive Cb', () => {
    const [, cbG, crG] = rgbToYCbCr([0, 1, 0])
    expect(cbG).toBeLessThan(0)
    expect(crG).toBeLessThan(0)
    expect(rgbToYCbCr([0, 0, 1])[1]).toBeGreaterThan(0.4)
  })
})

describe('keyAlpha: green screen', () => {
  it('removes the key color itself', () => {
    expect(keyAlpha(GREEN_KEY, GREEN_KEY, SIM, SMOOTH)).toBe(0)
  })
  it('removes typical real-world screen greens (dim, washed out, saturated)', () => {
    const screens: RGB[] = [
      [0.3, 0.6, 0.35], // dull classroom screen
      [0.1, 0.4, 0.15], // in shadow
      [0.55, 0.9, 0.6], // hot spot
      [0, 1, 0], // pure green, beyond key saturation
    ]
    for (const s of screens) expect(keyAlpha(s, GREEN_KEY, SIM, SMOOTH)).toBeLessThan(0.05)
  })
  it('keeps skin tones fully opaque', () => {
    for (const s of SKIN) expect(keyAlpha(s, GREEN_KEY, SIM, SMOOTH)).toBe(1)
  })
  it('keeps neutrals (gray shirts, white walls, black hair) opaque', () => {
    for (const s of NEUTRALS) expect(keyAlpha(s, GREEN_KEY, SIM, SMOOTH)).toBe(1)
  })
  it('keeps other bright colors (red, yellow, blue clothing)', () => {
    const clothes: RGB[] = [
      [0.9, 0.1, 0.1],
      [0.95, 0.85, 0.1],
      [0.1, 0.2, 0.9],
      [0.6, 0.2, 0.7],
    ]
    for (const c of clothes) expect(keyAlpha(c, GREEN_KEY, SIM, SMOOTH)).toBe(1)
  })
  it('keeps very dark pixels opaque even if slightly green (luma guard)', () => {
    expect(keyAlpha([0.01, 0.04, 0.015], GREEN_KEY, SIM, SMOOTH)).toBe(1)
  })
  it('gives soft, monotonic alpha for pixels between the key and skin', () => {
    const skin = SKIN[1]
    let prev = -1
    let sawSoft = false
    for (let i = 0; i <= 100; i++) {
      const a = keyAlpha(mix(GREEN_KEY, skin, i / 100), GREEN_KEY, SIM, SMOOTH)
      expect(a).toBeGreaterThanOrEqual(prev - 1e-9)
      if (a > 0.05 && a < 0.95) sawSoft = true
      prev = a
    }
    expect(sawSoft).toBe(true)
  })
  it('similarity widens what is removed; smoothness widens the soft band', () => {
    const near: RGB = mix(GREEN_KEY, SKIN[1], 0.3)
    expect(keyAlpha(near, GREEN_KEY, 0.6, SMOOTH)).toBeLessThan(keyAlpha(near, GREEN_KEY, 0.1, SMOOTH))
    let soft1 = 0
    let soft2 = 0
    for (let i = 0; i <= 100; i++) {
      const p = mix(GREEN_KEY, SKIN[1], i / 100)
      const a1 = keyAlpha(p, GREEN_KEY, SIM, 0.02)
      const a2 = keyAlpha(p, GREEN_KEY, SIM, 0.3)
      if (a1 > 0.01 && a1 < 0.99) soft1++
      if (a2 > 0.01 && a2 < 0.99) soft2++
    }
    expect(soft2).toBeGreaterThan(soft1)
  })
})

describe('keyAlpha: blue screen', () => {
  it('removes blue screen colors and keeps skin, neutrals and greens', () => {
    expect(keyAlpha(BLUE_KEY, BLUE_KEY, SIM, SMOOTH)).toBe(0)
    expect(keyAlpha([0.15, 0.35, 0.75], BLUE_KEY, SIM, SMOOTH)).toBeLessThan(0.05)
    for (const s of SKIN) expect(keyAlpha(s, BLUE_KEY, SIM, SMOOTH)).toBe(1)
    for (const s of NEUTRALS) expect(keyAlpha(s, BLUE_KEY, SIM, SMOOTH)).toBe(1)
    expect(keyAlpha([0.2, 0.75, 0.3], BLUE_KEY, SIM, SMOOTH)).toBe(1)
  })
})

describe('despill (alpha-aware, luminance-preserving)', () => {
  const lum = (c: RGB) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
  it('limits green to the brighter other channel inside the subject', () => {
    const edge: RGB = [0.5, 0.7, 0.45]
    const out = despill(edge, GREEN_KEY, 1)
    // 0.2 of spill removed from G, its luma returned as grey to all channels
    expect(out[1]).toBeCloseTo(0.5 + 0.2 * 0.587, 5)
    expect(out[0]).toBeCloseTo(0.5 + 0.2 * 0.587, 5)
    expect(out[1] - out[0]).toBeCloseTo(0, 5)
  })
  it('keeps luminance', () => {
    const edge: RGB = [0.5, 0.7, 0.45]
    const before = lum(edge)
    for (const a of [1, 0.5, 0.2]) expect(lum(despill(edge, GREEN_KEY, 1, a))).toBeCloseTo(before, 1)
  })
  it('is stronger at semi-transparent edges (average limit + boost)', () => {
    const px: RGB = [0.6, 0.7, 0.3]
    const inside = despill(px, GREEN_KEY, 0.5, 1)
    const edge = despill(px, GREEN_KEY, 0.5, 0.5)
    expect(edge[1] - edge[0]).toBeLessThan(inside[1] - inside[0])
  })
  it('is a no-op at strength 0', () => {
    const edge: RGB = [0.5, 0.7, 0.45]
    expect(despill(edge, GREEN_KEY, 0)).toEqual(edge)
  })
  it('leaves yellow, skin and neutrals unchanged inside the subject', () => {
    expect(despill([1, 1, 0], GREEN_KEY, 1, 1)).toEqual([1, 1, 0])
    for (const p of [...SKIN, ...NEUTRALS, [0.95, 0.9, 0.1] as RGB]) {
      expect(despill(p, GREEN_KEY, 1, 1)).toEqual(p)
    }
  })
  it('limits blue for a blue key', () => {
    const out = despill([0.4, 0.45, 0.8], BLUE_KEY, 1)
    expect(out[2] - out[1]).toBeCloseTo(0, 5)
  })
})

describe('pickKeyColor', () => {
  const jitter = (c: RGB, i: number): RGB => [
    c[0] + ((i * 7) % 5) * 0.01 - 0.02,
    c[1] + ((i * 3) % 5) * 0.01 - 0.02,
    c[2] + ((i * 11) % 5) * 0.01 - 0.02,
  ]

  it('finds the green screen among gray and skin samples', () => {
    const samples: RGB[] = []
    for (let i = 0; i < 60; i++) samples.push(jitter([0.25, 0.65, 0.3], i))
    for (let i = 0; i < 20; i++) samples.push(NEUTRALS[i % NEUTRALS.length])
    for (let i = 0; i < 20; i++) samples.push(SKIN[i % SKIN.length])
    const k = pickKeyColor(samples)
    expect(k).not.toBeNull()
    expect(k![0]).toBeCloseTo(0.25, 1)
    expect(k![1]).toBeCloseTo(0.65, 1)
    expect(k![2]).toBeCloseTo(0.3, 1)
  })
  it('finds a blue screen', () => {
    const samples: RGB[] = []
    for (let i = 0; i < 40; i++) samples.push(jitter([0.1, 0.3, 0.85], i))
    for (let i = 0; i < 10; i++) samples.push(SKIN[i % SKIN.length])
    const k = pickKeyColor(samples)!
    expect(k[2]).toBeGreaterThan(k[1])
    expect(k[2]).toBeGreaterThan(0.7)
  })
  it('ignores gray and skin samples entirely', () => {
    const samples: RGB[] = [...SKIN, ...NEUTRALS, ...SKIN, ...NEUTRALS]
    expect(pickKeyColor(samples)).toBeNull()
  })
  it('returns null when only a few screen-like pixels are present', () => {
    const samples: RGB[] = []
    for (let i = 0; i < 95; i++) samples.push(NEUTRALS[i % NEUTRALS.length])
    for (let i = 0; i < 5; i++) samples.push([0.2, 0.7, 0.3])
    expect(pickKeyColor(samples)).toBeNull()
    expect(pickKeyColor([])).toBeNull()
  })
  it('picks the dominant cluster when a small blue object is in a green frame', () => {
    const samples: RGB[] = []
    for (let i = 0; i < 50; i++) samples.push(jitter([0.2, 0.7, 0.3], i))
    for (let i = 0; i < 15; i++) samples.push(jitter([0.1, 0.3, 0.85], i))
    const k = pickKeyColor(samples)!
    expect(k[1]).toBeGreaterThan(k[2])
  })
  it('averages the cluster in linear light', () => {
    const samples: RGB[] = []
    for (let i = 0; i < 30; i++) samples.push([0.1, 0.4, 0.15], [0.3, 0.8, 0.35])
    const k = pickKeyColor(samples)!
    // linear mean is brighter than the sRGB mean (0.6)
    expect(k[1]).toBeGreaterThan(0.62)
  })
})

describe('autoKeyFromSamples', () => {
  it('returns colour and tight thresholds for an even screen', () => {
    const samples: RGB[] = []
    for (let i = 0; i < 80; i++) samples.push([0.16 + (i % 3) * 0.01, 0.7 - (i % 5) * 0.01, 0.3])
    for (let i = 0; i < 20; i++) samples.push(SKIN[i % SKIN.length])
    const r = autoKeyFromSamples(samples)!
    expect(r.color[1]).toBeGreaterThan(r.color[0])
    expect(r.lo).toBeLessThan(8)
    expect(r.tooUneven).toBe(false)
  })
  it('flags an uneven screen (mixed hues of green) instead of loosening forever', () => {
    const samples: RGB[] = []
    for (let i = 0; i < 100; i++) {
      const t = i / 99
      samples.push([0.1 + 0.35 * t, 0.75, 0.5 - 0.3 * t]) // teal..yellow-green
    }
    const r = autoKeyFromSamples(samples)!
    expect(r.tooUneven).toBe(true)
    expect(r.lo).toBe(14)
  })
  it('returns null without a screen', () => {
    expect(autoKeyFromSamples([...SKIN, ...NEUTRALS])).toBeNull()
  })
})
