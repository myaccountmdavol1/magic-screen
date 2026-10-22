// Pure chroma-key helpers: auto-key colour picking, the alpha-aware despill
// (CPU twin of despillA in shaders.ts) and the legacy YCbCr key. The live key
// metric itself is the Lab "keyD" in labKey.ts, baked into a LUT (keyLut.ts).
// keyAlpha/keyAlphaFast (YCbCr) stay for API compatibility and quick checks.
import type { RGB } from '../../types'
import { autoThresholds, averageLinear, keyDistRgb, keyLabParams, type AutoThresholds } from './labKey'

/**
 * Tuning constants shared with the shader.
 * - ALONG_WEIGHT: how much "less saturated than the key, same hue" counts as
 *   distance. Below 1 so hot spots / washed-out parts of a real screen still key,
 *   while neutral gray sits at distance 0.75 (kept for any similarity < ~0.7).
 * - MIN_KEY_CHROMA: floor for the key's chroma so a grayish key can't divide by ~0.
 * - MAX_SHADOW_GAIN: pixels darker than the key get their chroma boosted (up to
 *   this factor) so shadows on the screen still key. Never shrinks brighter pixels.
 * - DARK_LO/HI: luma guard. Near-black pixels have meaningless chroma (sensor
 *   noise), and are almost always hair, pupils or clothing, so they stay opaque.
 */
export const KEY_CONSTANTS = {
  ALONG_WEIGHT: 0.75,
  MIN_KEY_CHROMA: 0.05,
  MAX_SHADOW_GAIN: 2.5,
  DARK_LO: 0.04,
  DARK_HI: 0.12,
} as const

/** BT.601 full range. Y in 0..1, Cb/Cr centered on 0 (about -0.5..0.5). */
export function rgbToYCbCr(c: RGB): [number, number, number] {
  const [r, g, b] = c
  const y = 0.299 * r + 0.587 * g + 0.114 * b
  const cb = -0.168736 * r - 0.331264 * g + 0.5 * b
  const cr = 0.5 * r - 0.418688 * g - 0.081312 * b
  return [y, cb, cr]
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

/** Precomputed key parameters; also what the Compositor sends as uniforms. */
export interface KeyParams {
  keyY: number
  /** unit vector of the key's CbCr direction */
  dirCb: number
  dirCr: number
  /** magnitude of the key's chroma (floored) */
  chroma: number
  lo: number
  hi: number
}

export function keyParams(key: RGB, similarity: number, smoothness: number): KeyParams {
  const [keyY, kcb, kcr] = rgbToYCbCr(key)
  let mag = Math.hypot(kcb, kcr)
  let dirCb = kcb
  let dirCr = kcr
  if (mag < 1e-6) {
    // A perfectly gray key has no hue; assume green, the overwhelmingly common screen.
    const [, gcb, gcr] = rgbToYCbCr([0, 1, 0])
    mag = Math.hypot(gcb, gcr)
    dirCb = gcb
    dirCr = gcr
  }
  const lo = Math.max(0, similarity)
  return {
    keyY,
    dirCb: dirCb / mag,
    dirCr: dirCr / mag,
    chroma: Math.max(mag, KEY_CONSTANTS.MIN_KEY_CHROMA),
    lo,
    hi: lo + Math.max(smoothness, 1e-4),
  }
}

/**
 * Normalized key distance: 0 = exactly the key (or a more saturated version of it),
 * 0.75 = neutral gray, > 0.75 = other hues. Similarity is measured on this scale.
 */
export function keyDistance(r: number, g: number, b: number, p: KeyParams): number {
  const y = 0.299 * r + 0.587 * g + 0.114 * b
  const cb = -0.168736 * r - 0.331264 * g + 0.5 * b
  const cr = 0.5 * r - 0.418688 * g - 0.081312 * b
  const gain = Math.min(KEY_CONSTANTS.MAX_SHADOW_GAIN, Math.max(1, p.keyY / Math.max(y, 1e-3)))
  const pcb = cb * gain
  const pcr = cr * gain
  const along = pcb * p.dirCb + pcr * p.dirCr
  const perp = Math.hypot(pcb - along * p.dirCb, pcr - along * p.dirCr)
  // Pixels beyond the key's saturation in the same hue are "even greener": no penalty.
  const short = Math.max(p.chroma - along, 0) * KEY_CONSTANTS.ALONG_WEIGHT
  return Math.hypot(short, perp) / p.chroma
}

/** Alpha for one pixel from precomputed params (hot path of the CPU fallback). */
export function keyAlphaFast(r: number, g: number, b: number, p: KeyParams): number {
  const a = smoothstep(p.lo, p.hi, keyDistance(r, g, b, p))
  const y = 0.299 * r + 0.587 * g + 0.114 * b
  const dark = 1 - smoothstep(KEY_CONSTANTS.DARK_LO, KEY_CONSTANTS.DARK_HI, y)
  return Math.max(a, dark)
}

/** Alpha (1 = keep, 0 = removed) of a pixel against a key color. */
export function keyAlpha(px: RGB, key: RGB, similarity: number, smoothness: number): number {
  return keyAlphaFast(px[0], px[1], px[2], keyParams(key, similarity, smoothness))
}

/** Index of the key's dominant channel (1 = green screen, 2 = blue screen). */
export function dominantChannel(key: RGB): 0 | 1 | 2 {
  if (key[1] >= key[0] && key[1] >= key[2]) return 1
  return key[2] >= key[0] ? 2 : 0
}

/** BT.601 luma weights; spill removed from one channel is added back as this much grey. */
const LUMA: RGB = [0.299, 0.587, 0.114]
/** Extra despill at semi-transparent edges, where spill is strongest. */
export const SPILL_EDGE = 1.0

/**
 * Alpha-aware, luminance-preserving spill suppression (mirrors despillA in shaders.ts).
 * - Inside the subject (alpha = 1) the dominant channel is limited to the max of
 *   the other two, which keeps yellows and skin intact.
 * - At semi-transparent edges the limit moves to their average and the strength
 *   is boosted, because that is where the screen's glow sits.
 * - The removed amount's luma is added back as neutral grey so skin doesn't darken.
 */
export function despill(px: RGB, key: RGB, strength: number, alpha = 1): RGB {
  const out: RGB = [px[0], px[1], px[2]]
  if (strength <= 0) return out
  const ch = dominantChannel(key)
  const o1 = px[(ch + 1) % 3]
  const o2 = px[(ch + 2) % 3]
  const edge = 1 - Math.abs(2 * Math.min(1, Math.max(0, alpha)) - 1)
  const limit = Math.max(o1, o2) * (1 - edge) + ((o1 + o2) / 2) * edge
  const k = Math.min(1, Math.max(0, strength * (1 + SPILL_EDGE * edge)))
  const s = Math.max(px[ch] - limit, 0) * k
  if (s <= 0) return out
  out[ch] -= s
  const grey = s * LUMA[ch]
  for (let i = 0; i < 3; i++) out[i] = Math.min(1, out[i] + grey)
  return out
}

function rgbToHue(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  if (d === 0) return 0
  let h: number
  if (max === r) h = ((g - b) / d) % 6
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  h *= 60
  return h < 0 ? h + 360 : h
}

interface Cluster {
  samples: RGB[]
}

/**
 * Screen-like samples of the densest green/blue hue cluster, or null.
 * Rejects dull/gray/dark samples and non green-blue hues (skin, wood, red shirts).
 */
function screenCluster(samples: RGB[]): Cluster | null {
  if (samples.length === 0) return null
  const screenLike: { c: RGB; h: number }[] = []
  for (const c of samples) {
    const max = Math.max(c[0], c[1], c[2])
    const min = Math.min(c[0], c[1], c[2])
    const chroma = max - min
    if (max < 0.12 || chroma < 0.12 || chroma / max < 0.3) continue
    const h = rgbToHue(c[0], c[1], c[2])
    // 70..270 deg spans yellow-green through green, cyan and blue.
    if (h < 70 || h > 270) continue
    screenLike.push({ c, h })
  }
  const minCount = Math.max(3, Math.ceil(samples.length * 0.15))
  if (screenLike.length < minCount) return null

  // Densest 40-degree hue window, scanned in 5-degree steps.
  let bestCenter = 0
  let bestCount = -1
  for (let center = 70; center <= 270; center += 5) {
    let n = 0
    for (const s of screenLike) if (Math.abs(s.h - center) <= 20) n++
    if (n > bestCount) {
      bestCount = n
      bestCenter = center
    }
  }
  const cluster = screenLike.filter((s) => Math.abs(s.h - bestCenter) <= 25).map((s) => s.c)
  if (cluster.length < minCount) return null
  return { samples: cluster }
}

/**
 * Auto key: pick the screen color from border samples. The cluster is averaged
 * in linear light (what the sensor physically integrated), after dropping the
 * brightest/darkest 10% by luma so a stray hot spot or shadow can't drag it.
 * Returns null if too few samples look like a green or blue screen.
 */
export function pickKeyColor(samples: RGB[]): RGB | null {
  const cluster = screenCluster(samples)
  if (!cluster) return null
  const byLuma = [...cluster.samples].sort((a, b) => luma(a) - luma(b))
  const trim = Math.floor(byLuma.length * 0.1)
  return averageLinear(byLuma.slice(trim, byLuma.length - trim))
}

const luma = (c: RGB) => LUMA[0] * c[0] + LUMA[1] * c[1] + LUMA[2] * c[2]

export interface AutoKeyResult extends AutoThresholds {
  color: RGB
}

/**
 * Key colour + thresholds from border samples. Thresholds come from the keyD
 * spread of the screen samples themselves (see labKey.autoThresholds), and
 * `tooUneven` says the screen needs more light rather than a looser key.
 */
export function autoKeyFromSamples(samples: RGB[]): AutoKeyResult | null {
  const cluster = screenCluster(samples)
  if (!cluster) return null
  const color = pickKeyColor(samples)
  if (!color) return null
  const key = keyLabParams(color)
  const t = autoThresholds(cluster.samples.map((c) => keyDistRgb(c, key)))
  return { color, ...t }
}
