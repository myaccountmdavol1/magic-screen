// "Laptop webcam, no green screen" fixture: an adult close-up modelled on a real
// bug report (bald head, dark glasses, beard, light shirt with a lanyard, in front
// of a beige cinderblock wall with a door frame and an office chair). Drawn with
// more photographic cues than the cartoon kids (ellipsoid shading, skin texture,
// ears, nose, beard, sloped shoulders) so the person segmenter sees a person.
// Linear-light RGB, sizes are fractions of frame height (same model as scene.ts).
import { clamp01, rng, srgb, type Vec3 } from './color.ts'

/** Polynomial smooth minimum (blends two SDFs over k px). */
function smin(a: number, b: number, k: number): number {
  const h = clamp01(0.5 + (0.5 * (b - a)) / k)
  return b + (a - b) * h - k * h * (1 - h)
}
function sdCapsule(px: number, py: number, ax: number, ay: number, bx: number, by: number, r: number): number {
  const pax = px - ax
  const pay = py - ay
  const bax = bx - ax
  const bay = by - ay
  const len2 = bax * bax + bay * bay
  const h = len2 > 0 ? clamp01((pax * bax + pay * bay) / len2) : 0
  return Math.hypot(pax - bax * h, pay - bay * h) - r
}
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
const cover = (d: number) => clamp01(0.5 - d)

/** Cheap deterministic value noise in [-1, 1] (pixel units, `s` = feature size). */
function vnoise(x: number, y: number, s: number, seed: number): number {
  const fx = x / s
  const fy = y / s
  const ix = Math.floor(fx)
  const iy = Math.floor(fy)
  const tx = fx - ix
  const ty = fy - iy
  const h = (i: number, j: number) => {
    let n = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ seed
    n = Math.imul(n ^ (n >>> 13), 1274126177)
    return ((n ^ (n >>> 16)) >>> 0) / 2147483648 - 1
  }
  const sx = tx * tx * (3 - 2 * tx)
  const sy = ty * ty * (3 - 2 * ty)
  const a = h(ix, iy) + (h(ix + 1, iy) - h(ix, iy)) * sx
  const b = h(ix, iy + 1) + (h(ix + 1, iy + 1) - h(ix, iy + 1)) * sx
  return a + (b - a) * sy
}

interface Layer {
  x0: number
  y0: number
  x1: number
  y1: number
  dist(x: number, y: number): number
  color(x: number, y: number, out: Vec3): void
}

function box(cx: number, cy: number, rx: number, ry: number, W: number, H: number) {
  return {
    x0: Math.max(0, Math.floor(cx - rx - 3)),
    y0: Math.max(0, Math.floor(cy - ry - 3)),
    x1: Math.min(W, Math.ceil(cx + rx + 3)),
    y1: Math.min(H, Math.ceil(cy + ry + 3)),
  }
}

function raster(layers: Layer[], W: number, P: Float32Array, A: Float32Array) {
  const c: Vec3 = [0, 0, 0]
  for (const L of layers) {
    for (let y = L.y0; y < L.y1; y++) {
      for (let x = L.x0; x < L.x1; x++) {
        const cov = cover(L.dist(x + 0.5, y + 0.5))
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

const SKIN = srgb(0.78, 0.6, 0.5)
const BEARD = srgb(0.2, 0.15, 0.12)
const SHIRT = srgb(0.8, 0.82, 0.86)
const FRAME = srgb(0.07, 0.07, 0.08)
const LANYARD = srgb(0.12, 0.3, 0.22)

/** Render the webcam adult at time t into premultiplied P / coverage A (pre-cleared). */
export function renderWebcamPerson(t: number, W: number, H: number, P: Float32Array, A: Float32Array) {
  const u = H
  // talking-head motion: slow sway, a nod, the head moving a little on the body
  const bx = W * 0.5 + 0.01 * u * Math.sin((2 * Math.PI * t) / 3.3)
  const hx = bx + 0.018 * u * Math.sin((2 * Math.PI * t) / 2.1 + 0.4)
  const hy = 0.37 * u + 0.008 * u * Math.sin((2 * Math.PI * t) / 1.3)
  const hrx = 0.165 * u
  const hry = 0.215 * u
  const layers: Layer[] = []
  const light = [-0.35, -0.45, 0.82] // from upper left, towards the camera

  // --- body: neck + sloped shoulders + chest, one smooth silhouette ---
  const neckY0 = hy + 0.12 * u
  const shY = 0.78 * u
  const bodyDist = (x: number, y: number) => {
    const neck = sdCapsule(x, y, hx, neckY0, bx, 0.74 * u, 0.085 * u)
    const shL = sdCapsule(x, y, bx - 0.1 * u, 0.73 * u, bx - 0.5 * u, 0.9 * u, 0.11 * u)
    const shR = sdCapsule(x, y, bx + 0.1 * u, 0.73 * u, bx + 0.5 * u, 0.9 * u, 0.11 * u)
    const chest = sdRoundBox(x, y, bx, 1.05 * u, 0.6 * u, 0.25 * u, 0.12 * u)
    return smin(smin(smin(shL, shR, 0.06 * u), chest, 0.08 * u), neck, 0.05 * u)
  }
  layers.push({
    x0: 0,
    y0: Math.max(0, Math.floor(neckY0 - 0.1 * u)),
    x1: W,
    y1: H,
    dist: bodyDist,
    color: (x, y, out) => {
      // neck skin above the collar line, shirt below
      const collar = 0.73 * u + 0.05 * u * Math.min(1, Math.abs(x - bx) / (0.09 * u)) ** 2
      const nx = (x - bx) / (0.65 * u)
      const fold = 0.05 * vnoise(x + 3 * y, y, 0.06 * u, 11) + 0.03 * vnoise(x, y, 0.02 * u, 12)
      if (y < collar && Math.abs(x - hx) < 0.1 * u) {
        const k = 0.62 + 0.1 * (1 - Math.abs(x - hx) / (0.1 * u)) // neck in the head's shadow
        out[0] = SKIN[0] * k
        out[1] = SKIN[1] * k
        out[2] = SKIN[2] * k
        return
      }
      const k = (0.86 - 0.22 * nx * nx - 0.1 * clamp01((y - shY) / (0.3 * u))) * (1 + fold)
      // collar edge: a soft darker line
      const ce = Math.exp(-(((y - collar) / (0.006 * u)) ** 2)) * 0.35
      out[0] = SHIRT[0] * k * (1 - ce)
      out[1] = SHIRT[1] * k * (1 - ce)
      out[2] = SHIRT[2] * k * (1 - ce)
    },
  })

  // --- ears ---
  for (const s of [-1, 1]) {
    const ex = hx + s * (hrx - 0.01 * u)
    const ey = hy + 0.01 * u
    layers.push({
      ...box(ex, ey, 0.035 * u, 0.06 * u, W, H),
      dist: (x, y) => sdEllipse(x, y, ex, ey, 0.032 * u, 0.058 * u),
      color: (x, y, out) => {
        const k = 0.7 + 0.12 * vnoise(x, y, 0.01 * u, 21)
        out[0] = SKIN[0] * k * 1.03
        out[1] = SKIN[1] * k
        out[2] = SKIN[2] * k
      },
    })
  }

  // --- head (bald, shaded ellipsoid, skin texture, side stubble, beard) ---
  const beardTop = hy + 0.06 * u
  layers.push({
    ...box(hx, hy + 0.02 * u, hrx, hry + 0.03 * u, W, H),
    // jaw slightly squarer than an ellipse, beard adds a little below the chin
    dist: (x, y) =>
      smin(sdEllipse(x, y, hx, hy, hrx, hry), sdEllipse(x, y, hx, hy + 0.1 * u, hrx * 0.86, hry * 0.62), 0.03 * u),
    color: (x, y, out) => {
      const dx = (x - hx) / hrx
      const dy = (y - hy) / hry
      const nz = Math.sqrt(Math.max(0.02, 1 - dx * dx - dy * dy))
      const lam = Math.max(0, dx * light[0] + dy * light[1] + nz * light[2])
      let k = 0.35 + 0.65 * lam
      // specular highlight on the scalp
      const sp = Math.exp(-(((dx + 0.25) ** 2 + (dy + 0.62) ** 2) / 0.03))
      k += 0.25 * sp
      k *= 1 + 0.04 * vnoise(x, y, 0.012 * u, 31) + 0.02 * vnoise(x, y, 0.004 * u, 32)
      let c: Vec3 = [SKIN[0] * k, SKIN[1] * k, SKIN[2] * k]
      // side stubble (short dark hair band above the ears)
      const side = clamp01((Math.abs(dx) - 0.78) / 0.1) * clamp01(1 - Math.abs(dy - 0.02) / 0.3)
      // beard: lower face, jaw line + chin, with a moustache
      const inBeard = y > beardTop + 0.04 * u * (1 - Math.abs(dx)) ** 2 && Math.abs(dx) < 1.02
      const mouthZone = Math.abs(dx) < 0.32 && Math.abs(y - (hy + 0.115 * u)) < 0.018 * u
      const tex = 0.75 + 0.25 * vnoise(x, y, 0.005 * u, 41)
      let b = inBeard ? (mouthZone ? 0.4 : 0.92) : 0
      // cheeks above the jaw thin out towards the nose
      if (inBeard && Math.abs(dx) < 0.55 && y < hy + 0.1 * u) b *= clamp01(Math.abs(dx) * 1.2 + (y - beardTop) / (0.05 * u))
      b = Math.max(b, 0.6 * side)
      if (b > 0) {
        const bk = (0.55 + 0.45 * lam) * tex
        c = [c[0] + (BEARD[0] * bk - c[0]) * b, c[1] + (BEARD[1] * bk - c[1]) * b, c[2] + (BEARD[2] * bk - c[2]) * b]
      }
      out[0] = c[0]
      out[1] = c[1]
      out[2] = c[2]
    },
  })

  // --- face features ---
  const eyeY = hy - 0.025 * u
  const eyeDX = 0.068 * u
  const dark = srgb(0.1, 0.07, 0.06)
  const white = srgb(0.85, 0.82, 0.8)
  for (const s of [-1, 1]) {
    const ex = hx + s * eyeDX
    layers.push({ ...box(ex, eyeY, 0.03 * u, 0.015 * u, W, H), dist: (x, y) => sdEllipse(x, y, ex, eyeY, 0.026 * u, 0.012 * u), color: (_x, _y, o) => o.splice(0, 3, ...white) })
    layers.push({ ...box(ex, eyeY, 0.012 * u, 0.012 * u, W, H), dist: (x, y) => sdEllipse(x, y, ex, eyeY, 0.01 * u, 0.011 * u), color: (_x, _y, o) => o.splice(0, 3, ...dark) })
    // brow
    layers.push({
      x0: Math.max(0, Math.floor(ex - 0.05 * u)),
      y0: Math.max(0, Math.floor(eyeY - 0.07 * u)),
      x1: Math.min(W, Math.ceil(ex + 0.05 * u)),
      y1: Math.min(H, Math.ceil(eyeY - 0.02 * u)),
      dist: (x, y) => sdCapsule(x, y, ex - s * 0.035 * u, eyeY - 0.045 * u, ex + s * 0.04 * u, eyeY - 0.05 * u, 0.008 * u),
      color: (_x, _y, o) => o.splice(0, 3, ...BEARD),
    })
  }
  // nose shadow + nostrils
  layers.push({
    ...box(hx + 0.01 * u, hy + 0.05 * u, 0.03 * u, 0.04 * u, W, H),
    dist: (x, y) => sdEllipse(x, y, hx + 0.012 * u, hy + 0.05 * u, 0.026 * u, 0.035 * u),
    color: (x, y, o) => {
      const k = 0.55 + 0.25 * clamp01((hx - x) / (0.026 * u) + 0.5)
      o[0] = SKIN[0] * k
      o[1] = SKIN[1] * k
      o[2] = SKIN[2] * k
    },
  })
  // mouth (dark gap inside the beard)
  layers.push({
    ...box(hx, hy + 0.115 * u, 0.05 * u, 0.012 * u, W, H),
    dist: (x, y) => sdEllipse(x, y, hx, hy + 0.115 * u, 0.045 * u, 0.008 * u * (1.2 + Math.sin(2 * Math.PI * 2.2 * t))),
    color: (_x, _y, o) => o.splice(0, 3, ...srgb(0.25, 0.1, 0.1)),
  })
  // glasses: rounded rectangles + bridge + temples to the ears
  const gw = 0.052 * u
  const gh = 0.034 * u
  const th = 0.006 * u
  for (const s of [-1, 1]) {
    const ex = hx + s * eyeDX
    layers.push({
      ...box(ex, eyeY, gw + th, gh + th, W, H),
      dist: (x, y) => Math.abs(sdRoundBox(x, y, ex, eyeY, gw, gh, 0.012 * u)) - th,
      color: (_x, _y, o) => o.splice(0, 3, ...FRAME),
    })
    const tx0 = ex + s * gw
    const tx1 = hx + s * (hrx - 0.004 * u)
    layers.push({
      x0: Math.max(0, Math.floor(Math.min(tx0, tx1) - th - 2)),
      y0: Math.max(0, Math.floor(eyeY - 0.03 * u)),
      x1: Math.min(W, Math.ceil(Math.max(tx0, tx1) + th + 2)),
      y1: Math.min(H, Math.ceil(eyeY + 0.03 * u)),
      dist: (x, y) => sdCapsule(x, y, tx0, eyeY - 0.015 * u, tx1, eyeY - 0.005 * u, th * 0.8),
      color: (_x, _y, o) => o.splice(0, 3, ...FRAME),
    })
  }
  layers.push({
    ...box(hx, eyeY, eyeDX, 0.01 * u, W, H),
    dist: (x, y) => sdCapsule(x, y, hx - eyeDX + gw, eyeY - 0.01 * u, hx + eyeDX - gw, eyeY - 0.01 * u, th * 0.8),
    color: (_x, _y, o) => o.splice(0, 3, ...FRAME),
  })

  // lanyard straps from behind the neck down the chest (inside the silhouette)
  for (const s of [-1, 1]) {
    const x0 = bx + s * 0.075 * u
    const y0 = 0.74 * u
    const x1 = bx + s * 0.03 * u
    const y1 = 1.05 * u
    layers.push({
      x0: Math.max(0, Math.floor(Math.min(x0, x1) - 0.02 * u)),
      y0: Math.floor(y0 - 0.01 * u),
      x1: Math.min(W, Math.ceil(Math.max(x0, x1) + 0.02 * u)),
      y1: H,
      dist: (x, y) => sdCapsule(x, y, x0, y0, x1, y1, 0.007 * u),
      color: (x, y, o) => {
        const k = 0.8 + 0.2 * vnoise(x, y, 0.006 * u, 51)
        o[0] = LANYARD[0] * k
        o[1] = LANYARD[1] * k
        o[2] = LANYARD[2] * k
      },
    })
  }

  raster(layers, W, P, A)
}

/**
 * Beige cinderblock wall lit from the window side, a pale door frame and a grey
 * door on the right, the top of a dark office chair behind the left shoulder.
 */
export function makeOffice(W: number, H: number, seed: number): Float32Array {
  const r = rng(seed)
  const out = new Float32Array(W * H * 3)
  const wall = srgb(205 / 255, 190 / 255, 160 / 255)
  const mortar = srgb(180 / 255, 166 / 255, 140 / 255)
  const bw = 0.2 * H
  const bh = 0.1 * H
  const tones: number[] = []
  for (let i = 0; i < 4096; i++) tones.push(0.95 + 0.07 * r())
  for (let y = 0; y < H; y++) {
    const row = Math.floor(y / bh)
    const fy = y - row * bh
    for (let x = 0; x < W; x++) {
      const off = row % 2 ? bw / 2 : 0
      const col = Math.floor((x + off) / bw)
      const fx = x + off - col * bw
      const m = Math.min(fx, bw - fx, fy, bh - fy)
      const mt = clamp01((m - 0.6) / 1.4)
      const tone = tones[(row * 97 + col * 31) & 4095] * (1 + 0.03 * vnoise(x, y, 0.01 * H, 61))
      const light = 1.12 - 0.35 * ((x + 0.5) / W) - 0.15 * ((y + 0.5) / H)
      const i = (y * W + x) * 3
      for (let c = 0; c < 3; c++) out[i + c] = (wall[c] * tone * mt + mortar[c] * (1 - mt)) * light
    }
  }
  const paint = (x0: number, y0: number, x1: number, y1: number, f: (x: number, y: number, o: Vec3) => void) => {
    const c: Vec3 = [0, 0, 0]
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(H, Math.ceil(y1)); y++) {
      const cy = clamp01(Math.min(y + 1 - y0, y1 - y))
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, Math.ceil(x1)); x++) {
        const cov = cy * clamp01(Math.min(x + 1 - x0, x1 - x))
        f(x, y, c)
        const i = (y * W + x) * 3
        for (let k = 0; k < 3; k++) out[i + k] = out[i + k] * (1 - cov) + c[k] * cov
      }
    }
  }
  // door frame (painted metal, pale grey) and a grey door, on the right
  const fx0 = 0.6 * W
  const fx1 = 0.7 * W
  paint(fx0, 0.04 * H, W, H, (x, y, o) => {
    const k = 0.95 - 0.1 * ((y + 0.5) / H)
    o.splice(0, 3, ...srgb(0.74 * k, 0.74 * k, 0.72 * k))
  })
  paint(fx1, 0.1 * H, W, H, (x, y, o) => {
    const k = 0.85 + 0.05 * vnoise(x, y, 0.05 * H, 71)
    o.splice(0, 3, ...srgb(0.52 * k, 0.53 * k, 0.55 * k))
  })
  // shadow line where the frame meets the door
  paint(fx1, 0.1 * H, fx1 + 0.01 * H, H, (_x, _y, o) => o.splice(0, 3, ...srgb(0.3, 0.3, 0.32)))
  // office chair back: dark rounded shape at lower left
  const ccx = 0.2 * W
  const ccy = 0.78 * H
  for (let y = Math.floor(0.55 * H); y < H; y++) {
    for (let x = 0; x < Math.ceil(0.42 * W); x++) {
      const cov = cover(sdRoundBox(x + 0.5, y + 0.5, ccx, ccy, 0.2 * H, 0.26 * H, 0.08 * H))
      if (cov <= 0) continue
      const k = 0.8 + 0.2 * vnoise(x, y, 0.03 * H, 81)
      const c = srgb(0.16 * k, 0.16 * k, 0.17 * k)
      const i = (y * W + x) * 3
      for (let q = 0; q < 3; q++) out[i + q] = out[i + q] * (1 - cov) + c[q] * cov
    }
  }
  return out
}
