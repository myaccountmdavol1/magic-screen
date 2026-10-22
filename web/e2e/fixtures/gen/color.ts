// Shared colour + random helpers for the keyer fixture generator and the harness.
// Plain TypeScript with no imports, so Node (native type stripping), Vite and
// Vitest can all load it.

export type Vec3 = [number, number, number]

/** IEC 61966-2-1 piecewise sRGB decode (0..1). */
export function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

/** IEC 61966-2-1 piecewise sRGB encode (0..1, clamped). */
export function linearToSrgb(v: number): number {
  const c = v < 0 ? 0 : v > 1 ? 1 : v
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
}

/** 4096-entry encode table: linear (0..1) -> sRGB byte. Much faster than pow per pixel. */
const ENC_N = 4096
const ENC = new Uint8Array(ENC_N + 1)
for (let i = 0; i <= ENC_N; i++) ENC[i] = Math.round(linearToSrgb(i / ENC_N) * 255)
export function linToByte(v: number): number {
  const i = v <= 0 ? 0 : v >= 1 ? ENC_N : (v * ENC_N + 0.5) | 0
  return ENC[i]
}

/** Byte -> linear lookup. */
export const BYTE_TO_LIN = new Float32Array(256)
for (let i = 0; i < 256; i++) BYTE_TO_LIN[i] = srgbToLinear(i / 255)

export function srgb(r: number, g: number, b: number): Vec3 {
  return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)]
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0))
  return t * t * (3 - 2 * t)
}

/** Seeded PRNG (mulberry32). Deterministic across Node and browsers. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Standard normal from a uniform source (Box–Muller, one value per call). */
export function gauss(rand: () => number): number {
  const u = Math.max(1e-12, rand())
  const v = rand()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/** Stable 32-bit string hash (FNV-1a), for cache keys and per-scenario seeds. */
export function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
