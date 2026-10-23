import { describe, expect, it } from 'vitest'
import { connError, countIslands, dilate, edgeBand, frameMetrics, gradError, largestComponent, meanMetrics } from './metrics'

const W = 40
const H = 30

/** Disc of radius 8 with a 1 px soft rim. */
function disc(cx = 20, cy = 15, r = 8): Uint8Array {
  const a = new Uint8Array(W * H)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - r
      a[y * W + x] = Math.round(Math.min(1, Math.max(0, 0.5 - d)) * 255)
    }
  return a
}

describe('harness metrics', () => {
  it('scores a perfect matte as zero error', () => {
    const g = disc()
    const m = frameMetrics({ W, H, alpha: g, gt: g, prevAlpha: g, prevGt: g })
    expect(m.sad).toBe(0)
    expect(m.mse).toBe(0)
    expect(m.grad).toBeCloseTo(0, 9)
    expect(m.conn).toBeCloseTo(0, 9)
    expect(m.fpBg).toBe(0)
    expect(m.fnFg).toBe(0)
    expect(m.flicker).toBe(0)
  })

  it('SAD / FP_bg count background showing through', () => {
    const g = disc()
    const a = g.slice()
    for (let i = 0; i < 100; i++) if (g[i] === 0) a[i] = 255 // 100 fully wrong bg px
    const m = frameMetrics({ W, H, alpha: a, gt: g })
    expect(m.sad).toBeCloseTo(0.1, 6)
    expect(m.fpBg).toBeGreaterThan(0)
    expect(m.fnFg).toBe(0)
  })

  it('connectivity error penalises a detached island more than an attached blob', () => {
    const g = disc()
    const island = g.slice()
    const attached = g.slice()
    for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) island[y * W + x] = 255
    for (let y = 13; y < 17; y++) for (let x = 27; x < 31; x++) attached[y * W + x] = 255
    // same SAD, but only the island is disconnected from the GT component
    expect(connError(island, g, W, H)).toBeGreaterThan(0)
    expect(gradError(g, g, W, H)).toBe(0)
    expect(gradError(island, g, W, H)).toBeGreaterThan(0)
  })

  it('largestComponent keeps only the biggest 8-connected blob', () => {
    const m = new Uint8Array(W * H)
    m[0] = 1
    for (let i = 0; i < 5; i++) m[10 * W + 10 + i] = 1
    const out = largestComponent(m, W, H)
    expect(out.reduce((s, v) => s + v, 0)).toBe(5)
    expect(out[0]).toBe(0)
  })

  it('flicker only counts pixels whose GT did not change', () => {
    const g = disc()
    const a0 = g.slice()
    const a1 = g.slice()
    a1[0] = 255 // bg pixel flips on
    const m = frameMetrics({ W, H, alpha: a1, gt: g, prevAlpha: a0, prevGt: g })
    expect(m.flicker).toBeCloseTo((1 / (W * H)) * 1000, 6)
  })

  it('dilate / edgeBand cover the transition and nothing far away', () => {
    const m = new Uint8Array(W * H)
    m[15 * W + 20] = 1
    const d = dilate(m, W, H, 2)
    expect(d.reduce((s, v) => s + v, 0)).toBe(25)
    const band = edgeBand(disc(), W, H, 2)
    expect(band[15 * W + 20]).toBe(0) // disc centre
    expect(band[0]).toBe(0) // far corner
    expect(band[15 * W + 28]).toBe(1) // on the rim
  })

  it('spill and unmix ΔE are zero for the exact composite and catch green edges', () => {
    const g = disc()
    const fg = new Uint8Array(W * H * 3)
    for (let i = 0; i < W * H; i++) fg.set([200, 120, 100], i * 3)
    const bg: [number, number, number] = [128, 128, 128]
    const exact = new Uint8Array(W * H * 4)
    for (let i = 0; i < W * H; i++) {
      const a = g[i] / 255
      for (let c = 0; c < 3; c++) exact[i * 4 + c] = Math.round(a * fg[i * 3 + c] + (1 - a) * bg[c])
      exact[i * 4 + 3] = 255
    }
    const ok = frameMetrics({ W, H, alpha: g, gt: g, comp: exact, gtFg: fg, bg, keyCh: 1 })
    expect(ok.spill).toBe(0)
    expect(ok.unmixDE!).toBeLessThan(0.6)
    const green = exact.slice()
    for (let i = 0; i < W * H; i++) if (g[i] > 0) green[i * 4 + 1] = 230
    const bad = frameMetrics({ W, H, alpha: g, gt: g, comp: green, gtFg: fg, bg, keyCh: 1 })
    expect(bad.spill!).toBeGreaterThan(50)
    expect(bad.unmixDE!).toBeGreaterThan(10)
  })

  it('meanMetrics skips nulls', () => {
    const g = disc()
    const a = frameMetrics({ W, H, alpha: g, gt: g })
    const b = { ...a, sad: 2, flicker: 4 }
    const m = meanMetrics([a, b])
    expect(m.sad).toBe(1)
    expect(m.flicker).toBe(4)
  })

  it('counts detached false-foreground blobs as islands', () => {
    const g = disc()
    const a = g.slice()
    a[0] = 255 // corner speck
    a[W * H - 1] = 255 // another
    expect(countIslands(g, g, W, H)).toBe(0)
    expect(countIslands(a, g, W, H)).toBe(2)
  })

  it('ghost: alpha left where the GT just moved away; dtSSD: temporal noise', () => {
    const g0 = disc(16)
    const g1 = disc(20)
    const lag = disc(16) // keyer stuck on the previous frame
    const m = frameMetrics({ W, H, alpha: lag, gt: g1, prevAlpha: lag, prevGt: g0, recentGt: [g0] })
    expect(m.ghost).toBeGreaterThan(500)
    const ok = frameMetrics({ W, H, alpha: g1, gt: g1, prevAlpha: g0, prevGt: g0, recentGt: [g0] })
    expect(ok.ghost).toBe(0)
    expect(ok.dtSSD).toBeCloseTo(0, 9)
    expect(m.dtSSD).toBeGreaterThan(0)
  })
})
