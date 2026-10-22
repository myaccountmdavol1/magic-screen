// Procedural scene model for the keyer fixtures. Everything is linear-light RGB
// (Float32, 0..1) and resolution independent (sizes are fractions of frame height).
//
//   person  -> premultiplied colour P and coverage A, built from anti-aliased SDF
//              layers composited back to front with "over" (so alpha is exact)
//   plate   -> the backing (green/blue screen with lighting, wrinkles, specks,
//              or a cluttered classroom when there is no screen)
//
// generate.ts turns these into a camera frame: I = P + (1 - A) * B, then a camera
// model (white balance, flicker, noise, sRGB, 4:2:0, optional DCT blocks).
import { clamp01, rng, srgb, type Vec3 } from './color.ts'

// ---------- SDF primitives (pixel units) ----------

function sdCapsule(px: number, py: number, ax: number, ay: number, bx: number, by: number, r: number): number {
  const pax = px - ax
  const pay = py - ay
  const bax = bx - ax
  const bay = by - ay
  const len2 = bax * bax + bay * bay
  const h = len2 > 0 ? clamp01((pax * bax + pay * bay) / len2) : 0
  return Math.hypot(pax - bax * h, pay - bay * h) - r
}

/** Ellipse distance, first-order (exact on the boundary, good for 1-2 px of AA). */
function sdEllipse(px: number, py: number, cx: number, cy: number, rx: number, ry: number): number {
  const x = (px - cx) / rx
  const y = (py - cy) / ry
  const k0 = Math.hypot(x, y)
  const k1 = Math.hypot(x / rx, y / ry)
  return k1 > 1e-9 ? (k0 * (k0 - 1)) / k1 : -Math.min(rx, ry)
}

function sdRoundBox(px: number, py: number, cx: number, cy: number, hx: number, hy: number, r: number): number {
  const qx = Math.abs(px - cx) - hx + r
  const qy = Math.abs(py - cy) - hy + r
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}

/** Box-filter coverage of a pixel by the shape whose signed distance is d. */
const cover = (d: number) => clamp01(0.5 - d)

// ---------- layers ----------

interface Layer {
  /** pixel bbox, inclusive-exclusive */
  x0: number
  y0: number
  x1: number
  y1: number
  dist(x: number, y: number): number
  color(x: number, y: number, out: Vec3): void
  /** coverage multiplier (thin strands are not fully opaque) */
  opacity?: number
}

function bbox(cx: number, cy: number, rx: number, ry: number, W: number, H: number) {
  return {
    x0: Math.max(0, Math.floor(cx - rx - 2)),
    y0: Math.max(0, Math.floor(cy - ry - 2)),
    x1: Math.min(W, Math.ceil(cx + rx + 2)),
    y1: Math.min(H, Math.ceil(cy + ry + 2)),
  }
}

function capsuleLayer(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  r: number,
  W: number,
  H: number,
  color: (x: number, y: number, out: Vec3) => void,
): Layer {
  return {
    x0: Math.max(0, Math.floor(Math.min(ax, bx) - r - 2)),
    y0: Math.max(0, Math.floor(Math.min(ay, by) - r - 2)),
    x1: Math.min(W, Math.ceil(Math.max(ax, bx) + r + 2)),
    y1: Math.min(H, Math.ceil(Math.max(ay, by) + r + 2)),
    dist: (x, y) => sdCapsule(x, y, ax, ay, bx, by, r),
    color,
  }
}

const solid =
  (c: Vec3, k = 1) =>
  (_x: number, _y: number, o: Vec3) => {
    o[0] = c[0] * k
    o[1] = c[1] * k
    o[2] = c[2] * k
  }

/** Composite layers back to front into premultiplied P (3n) and coverage A (n). */
export function rasterLayers(layers: Layer[], W: number, P: Float32Array, A: Float32Array) {
  const c: Vec3 = [0, 0, 0]
  for (const L of layers) {
    const op = L.opacity ?? 1
    for (let y = L.y0; y < L.y1; y++) {
      for (let x = L.x0; x < L.x1; x++) {
        const cov = cover(L.dist(x + 0.5, y + 0.5)) * op
        if (cov <= 0) continue
        L.color(x + 0.5, y + 0.5, c)
        const i = y * W + x
        const k = 1 - cov
        P[i * 3] = c[0] * cov + P[i * 3] * k
        P[i * 3 + 1] = c[1] * cov + P[i * 3 + 1] * k
        P[i * 3 + 2] = c[2] * cov + P[i * 3 + 2] * k
        A[i] = cov + A[i] * k
      }
    }
  }
}

// ---------- person ----------

export interface PersonOpts {
  kind: 'kid' | 'teacher'
  skin: Vec3
  hair: Vec3
  shirt: Vec3
  stripe: Vec3 | null
  /** flyaway hair strands */
  strands: number
  /** strand length, fraction of frame height */
  strandLen: number
  strandOpacity: number
  /** waving forearm: Hz and amplitude (radians) */
  waveHz: number
  waveAmp: number
  /** side-to-side body sway, fraction of height */
  sway: number
  glasses: boolean
  lanyard: boolean
}

export const KID: PersonOpts = {
  kind: 'kid',
  skin: srgb(0.87, 0.66, 0.53),
  hair: srgb(0.24, 0.15, 0.09),
  shirt: srgb(0.78, 0.2, 0.22),
  stripe: srgb(0.95, 0.85, 0.78),
  strands: 40,
  strandLen: 0.035,
  strandOpacity: 0.75,
  waveHz: 0.6,
  waveAmp: 0.35,
  sway: 0.015,
  glasses: false,
  lanyard: false,
}

export const TEACHER: PersonOpts = {
  ...KID,
  kind: 'teacher',
  skin: srgb(0.8, 0.6, 0.47),
  hair: srgb(0.3, 0.2, 0.13),
  shirt: srgb(0.32, 0.36, 0.55),
  stripe: null,
  strands: 70,
  strandLen: 0.04,
  waveHz: 0.25,
  waveAmp: 0,
  sway: 0.012,
  glasses: true,
  lanyard: true,
}

export interface Strand {
  /** root as angle on the hair ellipse (radians, 0 = right, -pi/2 = top) */
  phi: number
  /** direction offset from the outward normal */
  tilt: number
  len: number
  curl: number
  width: number
  opacity: number
  tone: number
  phase: number
}

export function makeStrands(o: PersonOpts, seed: number): Strand[] {
  const r = rng(seed)
  const out: Strand[] = []
  for (let i = 0; i < o.strands; i++) {
    out.push({
      phi: -Math.PI + 0.25 + r() * (Math.PI - 0.5) + (r() < 0.25 ? (r() < 0.5 ? -0.5 : 0.5) : 0),
      tilt: (r() - 0.5) * 1.2,
      len: o.strandLen * (0.35 + 0.65 * r()),
      curl: (r() - 0.5) * 2.2,
      width: 0.35 + 0.6 * r(),
      opacity: o.strandOpacity * (0.6 + 0.4 * r()),
      tone: 0.9 + 0.5 * r(),
      phase: r() * Math.PI * 2,
    })
  }
  return out
}

/**
 * Rasterise the person at time t (seconds) into P/A (cleared by the caller).
 * Returns the person's bbox (for shadows) — not needed by most callers.
 */
export function renderPerson(o: PersonOpts, strands: Strand[], t: number, W: number, H: number, P: Float32Array, A: Float32Array) {
  const u = H
  const teacher = o.kind === 'teacher'
  const cx = W * 0.5 + o.sway * u * Math.sin((2 * Math.PI * t) / 3.1)
  const bob = 0.004 * u * Math.sin((2 * Math.PI * t) / 1.7)
  const g = teacher
    ? { headY: 0.4, rx: 0.12, ry: 0.15, hairY: 0.355, hairRx: 0.135, hairRy: 0.13, hairCut: 0.37, neckTop: 0.5, torsoTop: 0.66, torsoHW: 0.32, torsoR: 0.15 }
    : { headY: 0.34, rx: 0.105, ry: 0.13, hairY: 0.3, hairRx: 0.118, hairRy: 0.115, hairCut: 0.315, neckTop: 0.44, torsoTop: 0.56, torsoHW: 0.2, torsoR: 0.1 }
  const hx = cx + (teacher ? 0.01 * u * Math.sin((2 * Math.PI * t) / 2.3) : 0)
  const hy = g.headY * u + bob
  const hrx = g.rx * u
  const hry = g.ry * u
  const layers: Layer[] = []

  const shirtColor = (x: number, y: number, out: Vec3) => {
    const top = g.torsoTop * u
    let c = o.shirt
    if (o.stripe) {
      const p = (y - top) / (0.05 * u)
      const f = p - Math.floor(p)
      // anti-aliased stripe edges (1 px ramp)
      const ramp = 1 / (0.05 * u)
      const s = clamp01((Math.min(f, 0.5) - 0.25) / ramp + 0.5) - clamp01((f - 0.75) / ramp + 0.5)
      const st = o.stripe
      c = [o.shirt[0] + (st[0] - o.shirt[0]) * s, o.shirt[1] + (st[1] - o.shirt[1]) * s, o.shirt[2] + (st[2] - o.shirt[2]) * s]
    }
    const k = 0.72 + 0.28 * Math.cos(clamp01(Math.abs(x - cx) / (g.torsoHW * u)) * 1.3)
    out[0] = c[0] * k
    out[1] = c[1] * k
    out[2] = c[2] * k
  }
  const skinShade = (k: number) => (_x: number, _y: number, out: Vec3) => {
    out[0] = o.skin[0] * k
    out[1] = o.skin[1] * k
    out[2] = o.skin[2] * k
  }

  // back arm (viewer's left), angled out so there is a background gap by the torso
  if (!teacher) {
    const s1x = cx - 0.17 * u
    const s1y = 0.62 * u
    const e1x = cx - 0.27 * u
    const e1y = 0.8 * u
    const w1x = cx - 0.3 * u
    const w1y = 1.0 * u
    layers.push(capsuleLayer(s1x, s1y, e1x, e1y, 0.045 * u, W, H, shirtColor))
    layers.push(capsuleLayer(e1x, e1y, w1x, w1y, 0.038 * u, W, H, skinShade(0.85)))
  }

  // torso (to the bottom of the frame)
  {
    const top = g.torsoTop * u
    const hw = g.torsoHW * u
    const hh = 0.5 * u + 0.1 * u
    const cy = top + hh
    layers.push({
      ...bbox(cx, cy, hw, hh, W, H),
      dist: (x, y) => sdRoundBox(x, y, cx, cy, hw, hh, g.torsoR * u),
      color: shirtColor,
    })
  }
  // neck
  layers.push(capsuleLayer(hx, g.neckTop * u, cx, g.torsoTop * u + 0.02 * u, (teacher ? 0.055 : 0.042) * u, W, H, skinShade(0.8)))

  // head with simple round shading
  layers.push({
    ...bbox(hx, hy, hrx, hry, W, H),
    dist: (x, y) => sdEllipse(x, y, hx, hy, hrx, hry),
    color: (x, y, out) => {
      const dx = (x - hx) / hrx
      const dy = (y - hy) / hry
      const k = 0.74 + 0.26 * Math.sqrt(Math.max(0, 1 - dx * dx - dy * dy))
      out[0] = o.skin[0] * k
      out[1] = o.skin[1] * k
      out[2] = o.skin[2] * k
    },
  })
  // face: eyes, brows, mouth (opaque features inside the head; alpha unchanged)
  const eyeY = hy - 0.01 * u
  const eyeDX = 0.042 * u * (teacher ? 1.1 : 1)
  const dark = srgb(0.12, 0.08, 0.07)
  for (const s of [-1, 1]) {
    const ex = hx + s * eyeDX
    layers.push({ ...bbox(ex, eyeY, 0.014 * u, 0.014 * u, W, H), dist: (x, y) => sdEllipse(x, y, ex, eyeY, 0.012 * u, 0.014 * u), color: solid(dark) })
    layers.push(capsuleLayer(ex - 0.018 * u, eyeY - 0.03 * u, ex + 0.018 * u, eyeY - 0.034 * u, 0.005 * u, W, H, solid(o.hair, 0.8)))
  }
  layers.push(capsuleLayer(hx - 0.028 * u, hy + 0.06 * u, hx + 0.028 * u, hy + 0.06 * u, 0.007 * u, W, H, solid(srgb(0.7, 0.3, 0.3))))

  // glasses: two rings + bridge + temples to the head sides
  if (o.glasses) {
    const frame = srgb(0.08, 0.08, 0.1)
    const rr = 0.034 * u
    const th = 0.0045 * u
    for (const s of [-1, 1]) {
      const ex = hx + s * eyeDX
      layers.push({
        ...bbox(ex, eyeY, rr + th, rr + th, W, H),
        dist: (x, y) => Math.abs(Math.hypot(x - ex, y - eyeY) - rr) - th,
        color: solid(frame),
      })
      layers.push(capsuleLayer(ex + s * rr, eyeY - 0.004 * u, hx + s * (hrx + 0.004 * u), eyeY + 0.004 * u, th, W, H, solid(frame)))
    }
    layers.push(capsuleLayer(hx - eyeDX + rr, eyeY, hx + eyeDX - rr, eyeY, th, W, H, solid(frame)))
  }

  // hair cap (top of the head, a little wider than it)
  {
    const hcx = hx
    const hcy = g.hairY * u + bob
    const rx = g.hairRx * u
    const ry = g.hairRy * u
    const cut = g.hairCut * u + bob
    layers.push({
      ...bbox(hcx, hcy, rx, ry, W, H),
      dist: (x, y) => Math.max(sdEllipse(x, y, hcx, hcy, rx, ry), y - cut - (Math.abs(x - hcx) > rx * 0.8 ? 0.05 * u : 0)),
      color: (x, y, out) => {
        const k = 0.85 + 0.15 * Math.sin(x * 0.9 + y * 0.35)
        out[0] = o.hair[0] * k
        out[1] = o.hair[1] * k
        out[2] = o.hair[2] * k
      },
    })
  }

  // lanyard + badge (inside the silhouette)
  if (o.lanyard) {
    const blue = srgb(0.15, 0.3, 0.75)
    const ny = g.torsoTop * u
    layers.push(capsuleLayer(cx - 0.05 * u, ny - 0.01 * u, cx - 0.005 * u, ny + 0.18 * u, 0.007 * u, W, H, solid(blue)))
    layers.push(capsuleLayer(cx + 0.05 * u, ny - 0.01 * u, cx + 0.005 * u, ny + 0.18 * u, 0.007 * u, W, H, solid(blue)))
    const by = ny + 0.23 * u
    layers.push({
      ...bbox(cx, by, 0.04 * u, 0.05 * u, W, H),
      dist: (x, y) => sdRoundBox(x, y, cx, by, 0.035 * u, 0.045 * u, 0.006 * u),
      color: solid(srgb(0.93, 0.93, 0.9)),
    })
  }

  // front, waving arm (viewer's right): sleeve, forearm, hand, fingers
  if (!teacher) {
    const w = 2 * Math.PI * o.waveHz * t
    const sx = cx + 0.17 * u
    const sy = 0.62 * u
    const a1 = 0.6 + 0.12 * Math.sin(w - 0.6)
    const ex = sx + 0.19 * u * Math.cos(a1)
    const ey = sy - 0.19 * u * Math.sin(a1)
    const a2 = Math.PI / 2 + o.waveAmp * Math.sin(w)
    const wx = ex + 0.17 * u * Math.cos(a2)
    const wy = ey - 0.17 * u * Math.sin(a2)
    layers.push(capsuleLayer(sx, sy, ex, ey, 0.045 * u, W, H, shirtColor))
    layers.push(capsuleLayer(ex, ey, wx, wy, 0.037 * u, W, H, skinShade(0.9)))
    const hcx = wx + 0.035 * u * Math.cos(a2)
    const hcy = wy - 0.035 * u * Math.sin(a2)
    layers.push({ ...bbox(hcx, hcy, 0.05 * u, 0.05 * u, W, H), dist: (x, y) => sdEllipse(x, y, hcx, hcy, 0.042 * u, 0.042 * u), color: skinShade(0.95) })
    for (let f = 0; f < 4; f++) {
      const fa = a2 + (f - 1.5) * 0.28
      const bx = hcx + 0.03 * u * Math.cos(fa)
      const by = hcy - 0.03 * u * Math.sin(fa)
      const tx = bx + 0.045 * u * Math.cos(fa)
      const ty = by - 0.045 * u * Math.sin(fa)
      layers.push(capsuleLayer(bx, by, tx, ty, 0.011 * u, W, H, skinShade(0.92)))
    }
    // thumb
    const ta = a2 - 1.3
    layers.push(capsuleLayer(hcx, hcy, hcx + 0.06 * u * Math.cos(ta), hcy - 0.06 * u * Math.sin(ta), 0.012 * u, W, H, skinShade(0.9)))
  }

  rasterLayers(layers, W, P, A)

  // flyaway strands: polylines (union of capsules), sub-pixel widths, partial opacity
  const hcx = hx
  const hcy = g.hairY * u + bob
  const rx = g.hairRx * u
  const ry = g.hairRy * u
  const c: Vec3 = [0, 0, 0]
  const pts = new Float32Array(14)
  for (const s of strands) {
    const phi = s.phi + 0.04 * Math.sin(2 * Math.PI * 0.7 * t + s.phase)
    const px0 = hcx + rx * 0.96 * Math.cos(phi)
    const py0 = hcy + ry * 0.96 * Math.sin(phi)
    // outward normal of the ellipse, tilted
    let nx = Math.cos(phi) / rx
    let ny = Math.sin(phi) / ry
    const nl = Math.hypot(nx, ny)
    nx /= nl
    ny /= nl
    let ang = Math.atan2(ny, nx) + s.tilt + 0.15 * Math.sin(2 * Math.PI * 0.9 * t + s.phase)
    const L = s.len * u
    pts[0] = px0
    pts[1] = py0
    let minx = px0
    let maxx = px0
    let miny = py0
    let maxy = py0
    for (let k = 1; k <= 6; k++) {
      ang += (s.curl / 6) * 0.6
      pts[k * 2] = pts[k * 2 - 2] + (L / 6) * Math.cos(ang)
      pts[k * 2 + 1] = pts[k * 2 - 1] + (L / 6) * Math.sin(ang)
      minx = Math.min(minx, pts[k * 2])
      maxx = Math.max(maxx, pts[k * 2])
      miny = Math.min(miny, pts[k * 2 + 1])
      maxy = Math.max(maxy, pts[k * 2 + 1])
    }
    const r = s.width / 2
    // strands thinner than a pixel cover at most their width
    const thin = Math.min(1, s.width)
    const x0 = Math.max(0, Math.floor(minx - 2))
    const x1 = Math.min(W, Math.ceil(maxx + 2))
    const y0 = Math.max(0, Math.floor(miny - 2))
    const y1 = Math.min(H, Math.ceil(maxy + 2))
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        let d = 1e9
        for (let k = 0; k < 6; k++) {
          const dd = sdCapsule(x + 0.5, y + 0.5, pts[k * 2], pts[k * 2 + 1], pts[k * 2 + 2], pts[k * 2 + 3], Math.max(r, 0.5))
          if (dd < d) d = dd
        }
        // fade towards the tip is folded into opacity via distance along: keep simple
        const cov = cover(d) * thin * s.opacity
        if (cov <= 0) continue
        c[0] = Math.min(1, o.hair[0] * s.tone)
        c[1] = Math.min(1, o.hair[1] * s.tone)
        c[2] = Math.min(1, o.hair[2] * s.tone)
        const i = y * W + x
        const k = 1 - cov
        P[i * 3] = c[0] * cov + P[i * 3] * k
        P[i * 3 + 1] = c[1] * cov + P[i * 3 + 1] * k
        P[i * 3 + 2] = c[2] * cov + P[i * 3 + 2] * k
        A[i] = cov + A[i] * k
      }
    }
  }
}

// ---------- backing plates ----------

export interface PlateOpts {
  screen: 'green' | 'blue' | 'none'
  vignette: number
  /** hotspot strength (added light, fraction) */
  hotspot: number
  /** falloff across the frame (fraction lost at the far side) + slight colour shift */
  falloff: number
  /** fabric wrinkle strength */
  wrinkles: number
  /** number of tape/clip specks */
  specks: number
}

export const SCREEN_GREEN: Vec3 = srgb(55 / 255, 165 / 255, 85 / 255)
export const SCREEN_BLUE: Vec3 = srgb(35 / 255, 85 / 255, 190 / 255)

/** Static backing plate (linear RGB, 3n). The cast shadow is applied per frame. */
export function makePlate(o: PlateOpts, W: number, H: number, seed: number): Float32Array {
  if (o.screen === 'none') return makeClassroom(W, H, seed)
  const r = rng(seed)
  const base = o.screen === 'green' ? SCREEN_GREEN : SCREEN_BLUE
  const out = new Float32Array(W * H * 3)
  // fabric folds: mostly vertical lines hanging from the top, a few diagonal
  const folds: { x: number; ang: number; w: number; a: number }[] = []
  const nf = Math.round(10 * o.wrinkles)
  for (let i = 0; i < nf; i++) folds.push({ x: r() * W, ang: (r() - 0.5) * 0.7, w: (0.004 + 0.01 * r()) * H, a: 0.1 + 0.2 * r() })
  const hx = 0.68 * W
  const hy = 0.3 * H
  const hs = 0.22 * H
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const nx = (x + 0.5) / W - 0.5
      const ny = (y + 0.5) / H - 0.5
      let k = 1 - o.vignette * (nx * nx * 1.2 + ny * ny * 2)
      if (o.hotspot) k += o.hotspot * Math.exp(-((x - hx) ** 2 + (y - hy) ** 2) / (2 * hs * hs))
      let cr = 1
      let cb = 1
      if (o.falloff) {
        const f = (x + 0.5) / W
        k *= 1 - o.falloff * (1 - f)
        cr = 1 - 0.12 * (1 - f) * (o.falloff / 0.45)
        cb = 1 + 0.1 * (1 - f) * (o.falloff / 0.45)
      }
      if (o.wrinkles) {
        let w = 0.04 * o.wrinkles * Math.sin(x * 0.045 + 2 * Math.sin(y * 0.013)) + 0.03 * o.wrinkles * Math.sin(y * 0.03 + x * 0.01)
        for (const f of folds) {
          const d = (x - f.x - (y - H * 0.5) * Math.tan(f.ang)) / f.w
          if (d > -4 && d < 6) w += -f.a * Math.exp(-d * d) + 0.5 * f.a * Math.exp(-((d - 1.8) ** 2))
        }
        k *= 1 + w
      }
      const i = (y * W + x) * 3
      out[i] = base[0] * k * cr
      out[i + 1] = base[1] * k
      out[i + 2] = base[2] * k * cb
    }
  }
  // specks: tape strips (off-white) and clips (black/silver), fixed on the screen
  for (let s = 0; s < o.specks; s++) {
    const tape = r() < 0.6
    const cx = (0.04 + 0.92 * r()) * W
    const cy = (r() < 0.5 ? 0.03 + 0.25 * r() : 0.03 + 0.94 * r()) * H
    const hw = (tape ? 0.006 + 0.01 * r() : 0.004 + 0.004 * r()) * H
    const hh = (tape ? 0.012 + 0.02 * r() : 0.006 + 0.006 * r()) * H
    const ang = (r() - 0.5) * 1.2
    const col = tape ? srgb(0.9, 0.88, 0.82) : r() < 0.5 ? srgb(0.08, 0.08, 0.09) : srgb(0.62, 0.64, 0.66)
    const ca = Math.cos(ang)
    const sa = Math.sin(ang)
    const R = Math.hypot(hw, hh) + 2
    for (let y = Math.max(0, Math.floor(cy - R)); y < Math.min(H, Math.ceil(cy + R)); y++) {
      for (let x = Math.max(0, Math.floor(cx - R)); x < Math.min(W, Math.ceil(cx + R)); x++) {
        const dx = x + 0.5 - cx
        const dy = y + 0.5 - cy
        const lx = dx * ca + dy * sa
        const ly = -dx * sa + dy * ca
        const cov = cover(sdRoundBox(lx, ly, 0, 0, hw, hh, 0.5))
        if (cov <= 0) continue
        const i = (y * W + x) * 3
        for (let c = 0; c < 3; c++) out[i + c] = out[i + c] * (1 - cov) + col[c] * cov
      }
    }
  }
  return out
}

/** Beige cinderblock classroom wall, door frame, shelves with books, a poster. */
export function makeClassroom(W: number, H: number, seed: number): Float32Array {
  const r = rng(seed)
  const out = new Float32Array(W * H * 3)
  const wall = srgb(214 / 255, 200 / 255, 170 / 255)
  const mortar = srgb(190 / 255, 178 / 255, 152 / 255)
  const bw = 0.17 * H
  const bh = 0.085 * H
  const blockTone: number[] = []
  for (let i = 0; i < 4096; i++) blockTone.push(0.95 + 0.08 * r())
  for (let y = 0; y < H; y++) {
    const row = Math.floor(y / bh)
    const fy = y - row * bh
    for (let x = 0; x < W; x++) {
      const off = row % 2 ? bw / 2 : 0
      const col = Math.floor((x + off) / bw)
      const fx = x + off - col * bw
      const m = Math.min(fx, bw - fx, fy, bh - fy)
      const mt = clamp01((m - 0.8) / 1.2) // ~2px mortar line
      const tone = blockTone[(row * 97 + col * 31) & 4095] * (0.97 + 0.03 * Math.sin(x * 1.7 + y * 2.3) * Math.sin(x * 0.7 - y * 1.1))
      const light = 1.08 - 0.25 * Math.abs((x + 0.5) / W - 0.45) - 0.12 * ((y + 0.5) / H)
      const i = (y * W + x) * 3
      for (let c = 0; c < 3; c++) out[i + c] = (wall[c] * tone * mt + mortar[c] * (1 - mt)) * light
    }
  }
  const rect = (x0: number, y0: number, x1: number, y1: number, col: Vec3) => {
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(H, Math.ceil(y1)); y++) {
      const cy = clamp01(Math.min(y + 1 - y0, y1 - y))
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, Math.ceil(x1)); x++) {
        const cov = cy * clamp01(Math.min(x + 1 - x0, x1 - x))
        const i = (y * W + x) * 3
        for (let c = 0; c < 3; c++) out[i + c] = out[i + c] * (1 - cov) + col[c] * cov
      }
    }
  }
  // door: frame trim, wooden door, window, handle
  const dx0 = 0.05 * W
  const dx1 = 0.24 * W
  rect(dx0 - 0.02 * H, 0.1 * H, dx1 + 0.02 * H, H, srgb(0.55, 0.42, 0.3))
  rect(dx0, 0.13 * H, dx1, H, srgb(0.6, 0.42, 0.27))
  rect(dx0 + 0.04 * W, 0.2 * H, dx1 - 0.04 * W, 0.45 * H, srgb(0.72, 0.8, 0.85))
  rect(dx1 - 0.03 * W, 0.6 * H, dx1 - 0.015 * W, 0.63 * H, srgb(0.75, 0.72, 0.6))
  // poster
  rect(0.3 * W, 0.08 * H, 0.42 * W, 0.3 * H, srgb(0.95, 0.92, 0.6))
  rect(0.31 * W, 0.1 * H, 0.41 * W, 0.18 * H, srgb(0.3, 0.6, 0.85))
  rect(0.31 * W, 0.2 * H, 0.36 * W, 0.28 * H, srgb(0.85, 0.35, 0.3))
  rect(0.365 * W, 0.2 * H, 0.41 * W, 0.28 * H, srgb(0.35, 0.65, 0.35))
  // shelves with books
  const sx0 = 0.7 * W
  const sx1 = 0.98 * W
  rect(sx0 - 0.01 * W, 0.3 * H, sx1 + 0.01 * W, H, srgb(0.48, 0.35, 0.24))
  rect(sx0, 0.32 * H, sx1, H, srgb(0.36, 0.27, 0.19))
  const bookCols: Vec3[] = [srgb(0.8, 0.2, 0.2), srgb(0.2, 0.45, 0.8), srgb(0.95, 0.75, 0.2), srgb(0.3, 0.65, 0.35), srgb(0.6, 0.3, 0.6), srgb(0.9, 0.5, 0.2), srgb(0.85, 0.85, 0.8)]
  for (const sy of [0.5, 0.72, 0.94]) {
    rect(sx0, sy * H, sx1, sy * H + 0.025 * H, srgb(0.62, 0.47, 0.32))
    let x = sx0 + 0.005 * W
    while (x < sx1 - 0.02 * W) {
      const bwid = (0.012 + 0.02 * r()) * W
      const bht = (0.1 + 0.07 * r()) * H
      rect(x, sy * H - bht, Math.min(sx1, x + bwid), sy * H, bookCols[Math.floor(r() * bookCols.length)])
      x += bwid + 0.002 * W
    }
  }
  return out
}

// ---------- helpers ----------

/** Separable box blur (radius r), clamp-to-edge, on a single channel. */
export function boxBlur1(src: Float32Array, W: number, H: number, r: number): Float32Array {
  const tmp = new Float32Array(W * H)
  const out = new Float32Array(W * H)
  const n = 2 * r + 1
  for (let y = 0; y < H; y++) {
    let s = 0
    for (let k = -r; k <= r; k++) s += src[y * W + Math.min(W - 1, Math.max(0, k))]
    for (let x = 0; x < W; x++) {
      tmp[y * W + x] = s / n
      s += src[y * W + Math.min(W - 1, x + r + 1)] - src[y * W + Math.max(0, x - r)]
    }
  }
  for (let x = 0; x < W; x++) {
    let s = 0
    for (let k = -r; k <= r; k++) s += tmp[Math.min(H - 1, Math.max(0, k)) * W + x]
    for (let y = 0; y < H; y++) {
      out[y * W + x] = s / n
      s += tmp[Math.min(H - 1, y + r + 1) * W + x] - tmp[Math.max(0, y - r) * W + x]
    }
  }
  return out
}
