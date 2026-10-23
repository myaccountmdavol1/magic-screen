// CIELAB key metric ("keyD") shared by the LUT bake, the CPU fallback, the
// auto-key and the tests. See docs/research/realtime/recommendation.md §Tier 1.
//
// Why not ΔE76/94/00 for alpha: with a saturated reference (a green screen) they
// rate a sage shirt closer to the screen than the screen's own shadow. keyD is
// shadow-normalised (a,b scaled by keyL/L), one-sided (more saturated than the
// key still counts as screen) and only lightly penalises pixels brighter than
// the key, which separates screen variants (≤ ~3.5) from skin/hair/shirts (≥ 25).
import type { RGB } from '../../types'

export const MAX_SHADOW_GAIN = 2.0
export const L_WEIGHT = 0.2
export const LUT_N = 48
/** keyD values are stored in the LUT as keyD / LUT_RANGE (saturating at 1). */
export const LUT_RANGE = 48
/**
 * Below L* ≈ 4..10 the a/b channels are sensor noise: keep those pixels (pupils,
 * black clothes). Was 6..14; QA on a dim, noisy (low-light front camera) clip
 * showed the dark corners of the screen itself dipping into that band and
 * sparkling as kept speckles (static-region leak 0.7% → 0.1%, flicker ÷3).
 * Black hair doesn't need the guard: its keyD is ~50 even at L* 10.
 */
export const DARK_L_LO = 4
export const DARK_L_HI = 10
/** A key with less chroma than this has no reliable hue; fall back to green's direction. */
export const MIN_KEY_C = 8

export type Lab = [number, number, number]

export interface KeyLab {
  L: number
  a: number
  b: number
  /** unit vector of the key's (a, b) direction */
  dirA: number
  dirB: number
  /** key chroma (floored at MIN_KEY_C) */
  C: number
}

export interface Thresholds {
  lo: number
  hi: number
}

export interface AutoThresholds extends Thresholds {
  p95: number
  /** The screen is too uneven to key cleanly: ask a grown-up for more light. */
  tooUneven: boolean
}

export function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

export function linearToSrgb(v: number): number {
  const c = Math.min(1, Math.max(0, v))
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
}

const EPS = 216 / 24389 // (6/29)^3
const KAPPA = 24389 / 27

function labF(t: number): number {
  return t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116
}

/** Linear RGB (0..1) → CIELAB (D65). The matrix has the D65 white folded in. */
export function linearToLab(r: number, g: number, b: number): Lab {
  const fx = labF(0.433953 * r + 0.376214 * g + 0.189842 * b)
  const fy = labF(0.2126729 * r + 0.7151522 * g + 0.072175 * b)
  const fz = labF(0.017757 * r + 0.109468 * g + 0.872775 * b)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

/** sRGB (0..1) → CIELAB (L 0..100). */
export function rgbToLab(c: RGB): Lab {
  return linearToLab(srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2]))
}

function labFInv(f: number): number {
  const t = f * f * f
  return t > EPS ? t : (116 * f - 16) / KAPPA
}

/** CIELAB → sRGB (0..1, clamped). Used to report a drift-tracked key colour. */
export function labToRgb(lab: Lab): RGB {
  const fy = (lab[0] + 16) / 116
  const x = labFInv(fy + lab[1] / 500) * 0.95047
  const y = labFInv(fy)
  const z = labFInv(fy - lab[2] / 200) * 1.08883
  const r = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z
  const g = -0.969266 * x + 1.8760108 * y + 0.041556 * z
  const b = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z
  return [linearToSrgb(r), linearToSrgb(g), linearToSrgb(b)]
}

const GREEN_LAB = rgbToLab([0, 1, 0])

/** Precompute the key's Lab parameters (what the LUT bake and analytic shader use). */
export function keyLabFromLab(lab: Lab): KeyLab {
  let C = Math.hypot(lab[1], lab[2])
  let dirA: number
  let dirB: number
  if (C < 1e-3) {
    // A grey "key" has no hue: assume a green screen, the overwhelmingly common case.
    const gC = Math.hypot(GREEN_LAB[1], GREEN_LAB[2])
    dirA = GREEN_LAB[1] / gC
    dirB = GREEN_LAB[2] / gC
  } else {
    dirA = lab[1] / C
    dirB = lab[2] / C
  }
  C = Math.max(C, MIN_KEY_C)
  return { L: lab[0], a: lab[1], b: lab[2], dirA, dirB, C }
}

export function keyLabParams(key: RGB): KeyLab {
  return keyLabFromLab(rgbToLab(key))
}

/** keyD of a Lab colour against the key, in ΔE-like units. */
export function keyDistLab(lab: Lab, k: KeyLab): number {
  const L = lab[0]
  const g = Math.min(MAX_SHADOW_GAIN, Math.max(1, k.L / Math.max(L, 1)))
  const a = lab[1] * g
  const b = lab[2] * g
  const along = a * k.dirA + b * k.dirB
  const perp = Math.hypot(a - along * k.dirA, b - along * k.dirB)
  const shortfall = Math.max(k.C - along, 0)
  const over = Math.max(L * g - k.L, 0) * L_WEIGHT
  return Math.sqrt(shortfall * shortfall + perp * perp + over * over)
}

export function keyDistRgb(c: RGB, k: KeyLab): number {
  return keyDistLab(rgbToLab(c), k)
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

/** 1 for near-black pixels (always kept), 0 above DARK_L_HI. */
export function darkGuard(L: number): number {
  return 1 - smoothstep(DARK_L_LO, DARK_L_HI, L)
}

/** Analytic alpha (1 = keep). The LUT and the GPU path reproduce this. */
export function labAlpha(c: RGB, k: KeyLab, t: Thresholds): number {
  const lab = rgbToLab(c)
  return Math.max(smoothstep(t.lo, t.hi, keyDistLab(lab, k)), darkGuard(lab[0]))
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

/** Teacher sliders → keyD thresholds. Sliders never need a LUT re-bake. */
export function sliderThresholds(similarity: number, smoothness: number): Thresholds {
  const lo = 4 + 16 * clamp01(similarity)
  return { lo, hi: lo + 6 + 12 * clamp01(smoothness) }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))
  return s[i]
}

/**
 * Thresholds from keyD of confirmed screen samples. A poor (wrinkled, badly lit)
 * screen is reported rather than papered over with a looser key that would eat kids.
 */
export function autoThresholds(dists: number[]): AutoThresholds {
  const p95 = percentile(dists, 0.95)
  const lo = Math.min(14, Math.max(4, p95 + 2))
  return { lo, hi: lo + 12, p95, tooUneven: p95 > 12 }
}

/**
 * Final thresholds: the auto-key only ever raises the floor (so an uneven screen
 * still keys), the teacher's sliders can always make the key stricter or looser above it.
 */
export function combineThresholds(slider: Thresholds, auto: Thresholds | null): Thresholds {
  if (!auto) return slider
  return { lo: Math.max(slider.lo, auto.lo), hi: Math.max(slider.hi, auto.hi) }
}

/** Mean of sRGB samples taken in linear light (what the camera physically averaged). */
export function averageLinear(samples: RGB[]): RGB | null {
  if (samples.length === 0) return null
  let r = 0
  let g = 0
  let b = 0
  for (const s of samples) {
    r += srgbToLinear(s[0])
    g += srgbToLinear(s[1])
    b += srgbToLinear(s[2])
  }
  const n = samples.length
  return [linearToSrgb(r / n), linearToSrgb(g / n), linearToSrgb(b / n)]
}

/** Median of a list (mean of the middle two for even lengths); NaN when empty. */
export function median(xs: readonly number[]): number {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * CIEDE2000 (kC = kH = 1; kL = 1 unless given, > 1 weights lightness differences less).
 * For warnings, drift checks and key voting only, never for alpha.
 */
export function deltaE00(l1: Lab, l2: Lab, kL = 1): number {
  const rad = Math.PI / 180
  const C1 = Math.hypot(l1[1], l1[2])
  const C2 = Math.hypot(l2[1], l2[2])
  const Cb7 = Math.pow((C1 + C2) / 2, 7)
  const G = 0.5 * (1 - Math.sqrt(Cb7 / (Cb7 + 6103515625)))
  const a1 = (1 + G) * l1[1]
  const a2 = (1 + G) * l2[1]
  const c1 = Math.hypot(a1, l1[2])
  const c2 = Math.hypot(a2, l2[2])
  const hue = (b: number, a: number) => {
    if (a === 0 && b === 0) return 0
    const h = Math.atan2(b, a) / rad
    return h < 0 ? h + 360 : h
  }
  const h1 = hue(l1[2], a1)
  const h2 = hue(l2[2], a2)
  const dL = l2[0] - l1[0]
  const dC = c2 - c1
  let dh = 0
  if (c1 * c2 !== 0) {
    dh = h2 - h1
    if (dh > 180) dh -= 360
    else if (dh < -180) dh += 360
  }
  const dH = 2 * Math.sqrt(c1 * c2) * Math.sin((dh * rad) / 2)
  const Lb = (l1[0] + l2[0]) / 2
  const cb = (c1 + c2) / 2
  let hb = h1 + h2
  if (c1 * c2 !== 0) {
    if (Math.abs(h1 - h2) <= 180) hb /= 2
    else hb = hb < 360 ? (hb + 360) / 2 : (hb - 360) / 2
  }
  const T =
    1 -
    0.17 * Math.cos((hb - 30) * rad) +
    0.24 * Math.cos(2 * hb * rad) +
    0.32 * Math.cos((3 * hb + 6) * rad) -
    0.2 * Math.cos((4 * hb - 63) * rad)
  const dTheta = 30 * Math.exp(-Math.pow((hb - 275) / 25, 2))
  const cb7 = Math.pow(cb, 7)
  const RC = 2 * Math.sqrt(cb7 / (cb7 + 6103515625))
  const Lm = (Lb - 50) * (Lb - 50)
  const SL = 1 + (0.015 * Lm) / Math.sqrt(20 + Lm)
  const SC = 1 + 0.045 * cb
  const SH = 1 + 0.015 * cb * T
  const RT = -Math.sin(2 * dTheta * rad) * RC
  const l = dL / (kL * SL)
  const c = dC / SC
  const h = dH / SH
  return Math.sqrt(l * l + c * c + h * h + RT * c * h)
}
