import { describe, expect, it } from 'vitest'
import { HelperTrustTracker, dilateFor, helperTrust, maskStats } from './helperTrust'

const W = 256
const H = 144

/** Disk silhouette with a `ramp`-px soft edge (a crisp mask has a 1–2 px ramp). */
function disk(cx: number, cy: number, r: number, ramp = 2): Uint8Array {
  const m = new Uint8Array(W * H)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const d = Math.hypot(x - cx, y - cy) - r
      m[y * W + x] = Math.round(255 * Math.min(1, Math.max(0, 0.5 - d / ramp)))
    }
  return m
}

describe('helperTrust', () => {
  it('trusts a still child at age 2', () => {
    expect(helperTrust({ excess: 1, motion: 0 }, 2)).toBeGreaterThanOrEqual(0.9)
  })
  it('distrusts a waving child at age 3', () => {
    expect(helperTrust({ excess: 1, motion: 0.04 }, 3)).toBeLessThanOrEqual(0.6)
  })
  it('falls steadily with age', () => {
    let last = 2
    for (let age = 0; age <= 10; age++) {
      const t = helperTrust({ excess: 0.8, motion: 0.01 }, age)
      expect(t).toBeLessThan(last)
      last = t
    }
  })
  it('gives a 0.5-everywhere mask low trust', () => {
    const s = maskStats(new Uint8Array(W * H).fill(128), null, W)
    expect(helperTrust(s, 0)).toBeLessThanOrEqual(0.2)
  })
  it('gives a crisp close-up silhouette full model quality', () => {
    const s = maskStats(disk(128, 72, 60), null, W)
    expect(s.excess).toBeLessThanOrEqual(1)
    expect(helperTrust(s, 0)).toBe(1)
  })
  it('measures motion per camera frame', () => {
    const a = disk(100, 72, 30)
    const b = disk(110, 72, 30)
    const one = maskStats(b, a, W, 1).motion
    const two = maskStats(b, a, W, 2).motion
    expect(one).toBeGreaterThan(0)
    expect(two).toBeCloseTo(one / 2, 6)
    expect(maskStats(a, a, W).motion).toBe(0)
  })
  it('widens the garbage matte only for fast motion', () => {
    expect(dilateFor(0, 0.05)).toBe(0.05)
    expect(dilateFor(0.06, 0.05)).toBeCloseTo(0.08, 6)
  })
})

describe('HelperTrustTracker', () => {
  it('is 1 before any mask and decays with camera time', () => {
    const t = new HelperTrustTracker()
    t.setFrameMs(1000 / 30)
    expect(t.trust(0)).toBe(1)
    const m = disk(128, 72, 40)
    t.onMask(m, W, H, 1000)
    expect(t.ageFrames(1000)).toBe(0)
    expect(t.ageFrames(1000 + 2000 / 30)).toBeCloseTo(2, 6)
    expect(t.trust(1000)).toBe(1)
    expect(t.trust(1100)).toBeLessThan(1)
  })
  it('copies the mask (producers reuse their buffer)', () => {
    const t = new HelperTrustTracker()
    const buf = disk(100, 72, 30)
    t.onMask(buf, W, H, 0)
    buf.set(disk(140, 72, 30))
    const s = t.onMask(buf, W, H, 1000 / 30)
    expect(s.motion).toBeGreaterThan(0)
  })
})
