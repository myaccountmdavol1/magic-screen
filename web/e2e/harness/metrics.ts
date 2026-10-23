// Matting + compositing quality metrics for the keyer harness. Pure TypeScript on
// typed arrays, no imports: runs in the harness page (Chromium) and in Vitest.
//
// Alpha metrics follow the usual matting benchmark definitions (Rhemann et al.,
// "A Perceptually Motivated Online Benchmark for Image Matting", CVPR 2009):
//   SAD   = sum |a - g| / 1000                   (per frame)
//   MSE   = mean (a - g)^2                       (reported x1e3)
//   Grad  = sum (|∇a| - |∇g|)^2 / 1000, ∇ = first derivative of a Gaussian, sigma 1.4
//   Conn  = sum |phi(a) - phi(g)| / 1000, thresholds 0..1 step 0.1, 8-connectivity
// plus keyer-specific ones:
//   FP_bg   mean alpha where GT = 0 (background showing through)         (x1e3)
//   FN_fg   mean (1 - alpha) where GT = 1 (child lost)                   (x1e3)
//   Flicker mean |a_t - a_{t-1}| where GT did not change                 (x1e3)
//   Spill   mean excess of the key channel over max(other two) in the composite,
//           beyond the GT composite's own excess, in a band of GT-opaque pixels next
//           to the edge (green left on hair/skin after despill)          (x1e3)
//   UnmixΔE mean CIE76 ΔE between composite and GT composite where 0 < GT < 1
//           (does the soft edge carry the child's colour, or the screen's?)
//   ColourΔE  the colour part of UnmixΔE alone: the keyer's edge colour, recovered
//           from the composite as F = (C - (1 - a)·bg) / a where a >= 0.25, is
//           re-composited with the GT alpha and compared with the GT composite. Alpha
//           errors don't count, so it isolates unmixing / despill quality.
//   Islands mean count of 8-connected alpha >= 0.5 blobs with no GT pixel >= 0.5 in them
//           (tape / clip specks and other detached false-foreground bits)
//   Ghost   mean alpha where GT = 0 now but GT >= 0.5 in one of the last 3 frames
//           (trail left behind a moving arm by temporal smoothing)        (x1e3)
//   dtSSD   temporal coherence (Erofeev et al. 2015): sqrt(mean(((a_t - a_{t-1}) -
//           (g_t - g_{t-1}))^2)) over all pixels                        (x1e3)
// All alpha inputs are bytes (0..255), row-major, top row first.

export interface FrameInput {
  W: number
  H: number
  /** keyer alpha */
  alpha: Uint8Array
  /** ground-truth alpha */
  gt: Uint8Array
  /** previous frame's keyer + GT alpha (for flicker), if any */
  prevAlpha?: Uint8Array | null
  prevGt?: Uint8Array | null
  /** GT alpha of up to the last 3 frames, newest first (for ghost) */
  recentGt?: Uint8Array[] | null
  /** composite read back from the stage, RGBA bytes, top row first */
  comp?: Uint8Array | null
  /** ground-truth straight foreground colour, RGB bytes */
  gtFg?: Uint8Array | null
  /** solid background used for the composite, sRGB bytes */
  bg?: [number, number, number]
  /** key channel (1 = green screen, 2 = blue screen), null = no screen */
  keyCh?: 1 | 2 | null
}

export interface FrameMetrics {
  sad: number
  sadEdge: number
  mse: number
  grad: number
  conn: number
  fpBg: number
  fnFg: number
  flicker: number | null
  spill: number | null
  unmixDE: number | null
  colorDE: number | null
  islands: number
  ghost: number | null
  dtSSD: number | null
}

export const METRIC_KEYS: (keyof FrameMetrics)[] = [
  'sad',
  'sadEdge',
  'mse',
  'grad',
  'conn',
  'fpBg',
  'fnFg',
  'flicker',
  'spill',
  'unmixDE',
  'colorDE',
  'islands',
  'ghost',
  'dtSSD',
]

export const METRIC_INFO: Record<keyof FrameMetrics, { label: string; unit: string; digits: number }> = {
  sad: { label: 'SAD', unit: '/1000 px', digits: 2 },
  sadEdge: { label: 'SAD edge', unit: '/1000 px, GT edge band', digits: 2 },
  mse: { label: 'MSE', unit: 'x1e3', digits: 3 },
  grad: { label: 'Grad', unit: '/1000', digits: 2 },
  conn: { label: 'Conn', unit: '/1000', digits: 2 },
  fpBg: { label: 'FP bg', unit: 'x1e3', digits: 2 },
  fnFg: { label: 'FN fg', unit: 'x1e3', digits: 2 },
  flicker: { label: 'Flicker', unit: 'x1e3', digits: 2 },
  spill: { label: 'Spill', unit: 'x1e3', digits: 2 },
  unmixDE: { label: 'Unmix ΔE', unit: 'CIE76', digits: 2 },
  colorDE: { label: 'Colour ΔE', unit: 'CIE76, GT alpha', digits: 2 },
  islands: { label: 'Islands', unit: 'blobs/frame', digits: 2 },
  ghost: { label: 'Ghost', unit: 'x1e3', digits: 2 },
  dtSSD: { label: 'dtSSD', unit: 'x1e3', digits: 2 },
}

/** Band radius in pixels for a frame of height H (6 px at 360p). */
export const bandRadius = (H: number) => Math.max(2, Math.round(H / 60))

// ---------- helpers ----------

/** Square binary dilation (radius r) via separable running max. */
export function dilate(mask: Uint8Array, W: number, H: number, r: number): Uint8Array {
  const tmp = new Uint8Array(W * H)
  const out = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) {
    const row = y * W
    let last = -1e9
    // forward pass: distance to the last set pixel on the left; backward for the right
    for (let x = 0; x < W; x++) {
      if (mask[row + x]) last = x
      if (x - last <= r) tmp[row + x] = 1
    }
    last = 1e9
    for (let x = W - 1; x >= 0; x--) {
      if (mask[row + x]) last = x
      if (last - x <= r) tmp[row + x] = 1
    }
  }
  for (let x = 0; x < W; x++) {
    let last = -1e9
    for (let y = 0; y < H; y++) {
      if (tmp[y * W + x]) last = y
      if (y - last <= r) out[y * W + x] = 1
    }
    last = 1e9
    for (let y = H - 1; y >= 0; y--) {
      if (tmp[y * W + x]) last = y
      if (last - y <= r) out[y * W + x] = 1
    }
  }
  return out
}

/** Pixels within r of a GT transition: (dilate(g > lo) AND dilate(g < hi)). */
export function edgeBand(gt: Uint8Array, W: number, H: number, r: number): Uint8Array {
  const n = W * H
  const some = new Uint8Array(n)
  const notFull = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    some[i] = gt[i] > 0 ? 1 : 0
    notFull[i] = gt[i] < 255 ? 1 : 0
  }
  const a = dilate(some, W, H, r)
  const b = dilate(notFull, W, H, r)
  for (let i = 0; i < n; i++) a[i] &= b[i]
  return a
}

let gaussCache: { sigma: number; g: Float32Array; dg: Float32Array } | null = null
function gaussKernels(sigma: number) {
  if (gaussCache && gaussCache.sigma === sigma) return gaussCache
  const eps = 1e-2
  const half = Math.ceil(Math.sqrt(-2 * sigma * sigma * Math.log(Math.sqrt(2 * Math.PI) * sigma * eps)))
  const size = 2 * half + 1
  const g = new Float32Array(size)
  const dg = new Float32Array(size)
  let ng = 0
  let ndg = 0
  for (let i = 0; i < size; i++) {
    const x = i - half
    const v = Math.exp(-(x * x) / (2 * sigma * sigma)) / (Math.sqrt(2 * Math.PI) * sigma)
    g[i] = v
    dg[i] = (-x / (sigma * sigma)) * v
    ng += v * v
    ndg += dg[i] * dg[i]
  }
  // L2-normalise the separable 2D kernel dg(x) g(y): ||dg||*||g|| = 1
  const k = 1 / Math.sqrt(Math.sqrt(ng) * Math.sqrt(ndg))
  for (let i = 0; i < size; i++) {
    g[i] *= k
    dg[i] *= k
  }
  gaussCache = { sigma, g, dg }
  return gaussCache
}

/** Separable correlation with clamp-to-edge borders. */
function conv1(src: Float32Array, W: number, H: number, k: Float32Array, horizontal: boolean): Float32Array {
  const out = new Float32Array(W * H)
  const half = (k.length - 1) >> 1
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s = 0
      for (let i = 0; i < k.length; i++) {
        const o = i - half
        if (horizontal) {
          const xx = x + o < 0 ? 0 : x + o >= W ? W - 1 : x + o
          s += k[i] * src[y * W + xx]
        } else {
          const yy = y + o < 0 ? 0 : y + o >= H ? H - 1 : y + o
          s += k[i] * src[yy * W + x]
        }
      }
      out[y * W + x] = s
    }
  }
  return out
}

/** Gradient magnitude of a byte alpha (as 0..1) with Gaussian derivatives. */
export function gradMag(a: Uint8Array, W: number, H: number, sigma = 1.4): Float32Array {
  const { g, dg } = gaussKernels(sigma)
  const f = new Float32Array(W * H)
  for (let i = 0; i < f.length; i++) f[i] = a[i] / 255
  const gx = conv1(conv1(f, W, H, dg, true), W, H, g, false)
  const gy = conv1(conv1(f, W, H, g, true), W, H, dg, false)
  for (let i = 0; i < gx.length; i++) gx[i] = Math.hypot(gx[i], gy[i])
  return gx
}

/** Gradient error, restricted to `roi` pixels when given (speed: grads are 0 elsewhere). */
export function gradError(a: Uint8Array, g: Uint8Array, W: number, H: number): number {
  const ma = gradMag(a, W, H)
  const mg = gradMag(g, W, H)
  let s = 0
  for (let i = 0; i < ma.length; i++) {
    const d = ma[i] - mg[i]
    s += d * d
  }
  return s / 1000
}

/** Largest 8-connected component of `mask` (returns a 0/1 map). */
export function largestComponent(mask: Uint8Array, W: number, H: number): Uint8Array {
  const n = W * H
  const label = new Int32Array(n)
  const stack = new Int32Array(n)
  let best = 0
  let bestSize = 0
  let next = 0
  for (let s = 0; s < n; s++) {
    if (!mask[s] || label[s]) continue
    next++
    let size = 0
    let sp = 0
    stack[sp++] = s
    label[s] = next
    while (sp) {
      const p = stack[--sp]
      size++
      const x = p % W
      const y = (p - x) / W
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= H) continue
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          if ((dx === 0 && dy === 0) || xx < 0 || xx >= W) continue
          const q = yy * W + xx
          if (mask[q] && !label[q]) {
            label[q] = next
            stack[sp++] = q
          }
        }
      }
    }
    if (size > bestSize) {
      bestSize = size
      best = next
    }
  }
  const out = new Uint8Array(n)
  if (best) for (let i = 0; i < n; i++) out[i] = label[i] === best ? 1 : 0
  return out
}

/** Connectivity error (Rhemann et al. 2009), step 0.1. */
export function connError(a: Uint8Array, g: Uint8Array, W: number, H: number, step = 0.1): number {
  const n = W * H
  const lmap = new Float32Array(n).fill(-1)
  const m = new Uint8Array(n)
  const steps = Math.round(1 / step)
  for (let s = 1; s <= steps; s++) {
    const t = s * step
    const tb = t * 255 - 1e-6
    for (let i = 0; i < n; i++) m[i] = a[i] >= tb && g[i] >= tb ? 1 : 0
    const omega = largestComponent(m, W, H)
    const prev = (s - 1) * step
    for (let i = 0; i < n; i++) if (lmap[i] === -1 && !omega[i]) lmap[i] = prev
  }
  let sum = 0
  for (let i = 0; i < n; i++) {
    const l = lmap[i] === -1 ? 1 : lmap[i]
    const da = a[i] / 255 - l
    const dg = g[i] / 255 - l
    const pa = 1 - (da >= 0.15 ? da : 0)
    const pg = 1 - (dg >= 0.15 ? dg : 0)
    sum += Math.abs(pa - pg)
  }
  return sum / 1000
}

/** 8-connected blobs of alpha >= 128 that contain no GT pixel >= 128. */
export function countIslands(a: Uint8Array, g: Uint8Array, W: number, H: number): number {
  const n = W * H
  const seen = new Uint8Array(n)
  const stack = new Int32Array(n)
  let count = 0
  for (let s = 0; s < n; s++) {
    if (a[s] < 128 || seen[s]) continue
    let sp = 0
    let touchesGt = false
    stack[sp++] = s
    seen[s] = 1
    while (sp) {
      const p = stack[--sp]
      if (g[p] >= 128) touchesGt = true
      const x = p % W
      const y = (p - x) / W
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= H) continue
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= W) continue
          const q = yy * W + xx
          if (a[q] >= 128 && !seen[q]) {
            seen[q] = 1
            stack[sp++] = q
          }
        }
      }
    }
    if (!touchesGt) count++
  }
  return count
}

// sRGB byte -> CIELAB (D65)
const LIN = new Float32Array(256)
for (let i = 0; i < 256; i++) {
  const v = i / 255
  LIN[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}
function labF(t: number) {
  return t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116
}
export function lab(r: number, g: number, b: number, out: Float32Array, o = 0) {
  const R = LIN[r]
  const G = LIN[g]
  const B = LIN[b]
  const x = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047
  const y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B
  const z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883
  const fx = labF(x)
  const fy = labF(y)
  const fz = labF(z)
  out[o] = 116 * fy - 16
  out[o + 1] = 500 * (fx - fy)
  out[o + 2] = 200 * (fy - fz)
}

// ---------- per frame ----------

export function frameMetrics(f: FrameInput): FrameMetrics {
  const { W, H, alpha: a, gt: g } = f
  const n = W * H
  const r = bandRadius(H)
  const band = edgeBand(g, W, H, r)
  let sad = 0
  let sadEdge = 0
  let mse = 0
  let fp = 0
  let nfp = 0
  let fn = 0
  let nfn = 0
  for (let i = 0; i < n; i++) {
    const d = (a[i] - g[i]) / 255
    const ad = Math.abs(d)
    sad += ad
    mse += d * d
    if (band[i]) sadEdge += ad
    if (g[i] === 0) {
      fp += a[i] / 255
      nfp++
    } else if (g[i] === 255) {
      fn += 1 - a[i] / 255
      nfn++
    }
  }
  let flicker: number | null = null
  if (f.prevAlpha && f.prevGt) {
    let s = 0
    let c = 0
    for (let i = 0; i < n; i++) {
      if (g[i] !== f.prevGt[i]) continue
      s += Math.abs(a[i] - f.prevAlpha[i]) / 255
      c++
    }
    flicker = c ? (s / c) * 1000 : null
  }
  let dtSSD: number | null = null
  if (f.prevAlpha && f.prevGt) {
    let s = 0
    for (let i = 0; i < n; i++) {
      const d = (a[i] - f.prevAlpha[i] - (g[i] - f.prevGt[i])) / 255
      s += d * d
    }
    dtSSD = Math.sqrt(s / n) * 1000
  }
  let ghost: number | null = null
  const recent = f.recentGt?.filter(Boolean) ?? []
  if (recent.length) {
    let s = 0
    let c = 0
    for (let i = 0; i < n; i++) {
      if (g[i] !== 0) continue
      let was = false
      for (const r0 of recent) if (r0[i] >= 128) was = true
      if (!was) continue
      s += a[i] / 255
      c++
    }
    ghost = c ? (s / c) * 1000 : 0
  }
  let spill: number | null = null
  let unmixDE: number | null = null
  let colorDE: number | null = null
  if (f.comp && f.gtFg && f.bg) {
    const bg = f.bg
    const L1 = new Float32Array(3)
    const L2 = new Float32Array(3)
    // opaque band next to the edge, for spill
    const transparentish = new Uint8Array(n)
    for (let i = 0; i < n; i++) transparentish[i] = g[i] < 250 ? 1 : 0
    const near = dilate(transparentish, W, H, r)
    let sSum = 0
    let sN = 0
    let eSum = 0
    let eN = 0
    let cSum = 0
    let cN = 0
    const k = f.keyCh ?? null
    for (let i = 0; i < n; i++) {
      const gi = g[i]
      if (gi <= 5) continue
      const ga = gi / 255
      const cr = f.comp[i * 4]
      const cg = f.comp[i * 4 + 1]
      const cb = f.comp[i * 4 + 2]
      // GT composite in the same (sRGB-byte) space the stage blends in
      const tr = ga * f.gtFg[i * 3] + (1 - ga) * bg[0]
      const tg = ga * f.gtFg[i * 3 + 1] + (1 - ga) * bg[1]
      const tb = ga * f.gtFg[i * 3 + 2] + (1 - ga) * bg[2]
      if (gi >= 250) {
        if (k !== null && near[i]) {
          const ex = (c0: number, c1: number, c2: number) =>
            k === 1 ? Math.max(0, c1 - Math.max(c0, c2)) : Math.max(0, c2 - Math.max(c0, c1))
          sSum += Math.max(0, ex(cr, cg, cb) - ex(tr, tg, tb)) / 255
          sN++
        }
      } else {
        lab(cr, cg, cb, L1)
        lab(Math.round(tr), Math.round(tg), Math.round(tb), L2)
        eSum += Math.hypot(L1[0] - L2[0], L1[1] - L2[1], L1[2] - L2[2])
        eN++
        const ka = a[i] / 255
        if (ka >= 0.25) {
          const fr = Math.min(255, Math.max(0, (cr - (1 - ka) * bg[0]) / ka))
          const fg = Math.min(255, Math.max(0, (cg - (1 - ka) * bg[1]) / ka))
          const fb = Math.min(255, Math.max(0, (cb - (1 - ka) * bg[2]) / ka))
          lab(Math.round(ga * fr + (1 - ga) * bg[0]), Math.round(ga * fg + (1 - ga) * bg[1]), Math.round(ga * fb + (1 - ga) * bg[2]), L1)
          cSum += Math.hypot(L1[0] - L2[0], L1[1] - L2[1], L1[2] - L2[2])
          cN++
        }
      }
    }
    if (k !== null && sN) spill = (sSum / sN) * 1000
    if (eN) unmixDE = eSum / eN
    if (cN) colorDE = cSum / cN
  }
  return {
    sad: sad / 1000,
    sadEdge: sadEdge / 1000,
    mse: (mse / n) * 1000,
    grad: gradError(a, g, W, H),
    conn: connError(a, g, W, H),
    fpBg: nfp ? (fp / nfp) * 1000 : 0,
    fnFg: nfn ? (fn / nfn) * 1000 : 0,
    flicker,
    spill,
    unmixDE,
    colorDE,
    islands: countIslands(a, g, W, H),
    ghost,
    dtSSD,
  }
}

/** Mean of each metric over frames (nulls skipped; null if all null). */
export function meanMetrics(list: FrameMetrics[]): Record<keyof FrameMetrics, number | null> {
  const out = {} as Record<keyof FrameMetrics, number | null>
  for (const k of METRIC_KEYS) {
    let s = 0
    let c = 0
    for (const m of list) {
      const v = m[k]
      if (v === null || !Number.isFinite(v)) continue
      s += v
      c++
    }
    out[k] = c ? s / c : null
  }
  return out
}
