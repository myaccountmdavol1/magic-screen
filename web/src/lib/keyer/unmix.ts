// Foreground unmixing (plan item 3): CPU mirror of the FG_FS edge-band code, for
// unit tests. All colours are LINEAR RGB in 0..1.
//
// An edge pixel is I = a·F + (1 − a)·B. Blur-fusion (Forte & Pitié 2021) estimates
// the child's colour without dividing by a:
//   F = F̂ + a·(I − a·F̂ − (1 − a)·B̂)
// with F̂ / B̂ the local foreground / screen colours. The "a" of this colour solve is
// the colour-line fraction of I between B̂ and F̂ (projection), where they differ
// clearly; the key's alpha is too opaque at edges for the colour solve. The
// correction is capped. Original code (clean room); no CorridorKey code.

export type Lin = [number, number, number]

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}

/** Fraction of I along the B̂ → F̂ colour line (0 = screen, 1 = child). */
export function projectionAlpha(I: Lin, Fh: Lin, Bh: Lin): number {
  const d = [Fh[0] - Bh[0], Fh[1] - Bh[1], Fh[2] - Bh[2]]
  const d2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2]
  const p = (I[0] - Bh[0]) * d[0] + (I[1] - Bh[1]) * d[1] + (I[2] - Bh[2]) * d[2]
  return clamp01(p / Math.max(d2, 1e-4))
}

/**
 * Unmixed foreground colour. `a` is the key alpha; `proj` (0..1) blends in the
 * colour-line alpha where F̂ and B̂ differ clearly; `cap` limits the correction length.
 */
export function blurFusionF(I: Lin, a: number, Fh: Lin, Bh: Lin, opts: { proj?: number; cap?: number } = {}): Lin {
  const proj = opts.proj ?? 1
  const cap = opts.cap ?? Infinity
  const d2 = (Fh[0] - Bh[0]) ** 2 + (Fh[1] - Bh[1]) ** 2 + (Fh[2] - Bh[2]) ** 2
  const au = a + (projectionAlpha(I, Fh, Bh) - a) * proj * smoothstep(0.01, 0.05, d2)
  const corr = [0, 1, 2].map((i) => au * (I[i] - au * Fh[i] - (1 - au) * Bh[i]))
  const len = Math.hypot(corr[0], corr[1], corr[2])
  const k = len > cap ? cap / len : 1
  return [clamp01(Fh[0] + corr[0] * k), clamp01(Fh[1] + corr[1] * k), clamp01(Fh[2] + corr[2] * k)]
}

/**
 * Item 16 (P2): blend alpha pulled toward the colour-line fraction aP where F̂ and B̂
 * differ clearly (d2 = |F̂ − B̂|², linear). `taper` stops the line from lowering alpha
 * where the key is nearly opaque (an opaque rim lit by spill looks "part screen").
 * Mirrors FG_FS; the soft band only (a < 0.996).
 */
export function projBlendAlpha(a: number, aP: number, d2: number, strength: number, taper = 1, unW = 1): number {
  if (strength <= 0 || a >= 0.996) return a
  const wT = aP < a ? 1 - taper * smoothstep(0.8, 0.99, a) : 1
  return a + (aP - a) * strength * smoothstep(0.01, 0.05, d2) * unW * wT
}
