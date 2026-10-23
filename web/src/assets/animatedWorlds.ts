// Animated "moving" worlds: picture-book scenes drawn live on a canvas (no video files).
//
// Same style as the still worlds in backgrounds.ts (flat SVG, thick same-hue outlines,
// Talkline palette), split into two kinds of art:
//   - a static layer (sky, ground, scenery): one SVG, rasterized ONCE to an offscreen
//     canvas at the instance size;
//   - sprites (fish, flakes, clouds, rocket...): small SVGs, each rasterized ONCE to its
//     own little canvas, then stamped with drawImage + setTransform every frame.
// A frame is therefore one full-size drawImage plus a few dozen small ones: no per-frame
// SVG parsing, no per-frame allocations (particle parameters live in typed arrays).
//
// Time: every motion is a function of the world clock t (seconds, wrapping at LOOP) and
// uses whole-number cycles per LOOP, so the animation loops seamlessly and the same t
// always gives the same picture. The clock only advances while running and clamps big
// gaps (hidden tab, stop/start), so resuming never jumps.
//
// Reduced motion (prefers-reduced-motion or options.reducedMotion): the clock runs at
// REDUCED_SPEED, twinkles are softer and there are no lightning flashes or lava pops.
//
// The lower-middle of every scene stays open: that is where the keyed child stands.

export interface AnimatedWorldInstance {
  /** Draw target; hand it to Compositor.setBackground(). Size = create(width, height). */
  canvas: HTMLCanvasElement
  /** Resume the clock (idempotent). Instances are created running. */
  start(): void
  /** Freeze the clock (idempotent). frame() still redraws the frozen pose. */
  stop(): void
  /** Advance + draw one frame; the stage calls this from its rAF loop. */
  frame(nowMs: number): void
  /** Release the canvases and listeners. The instance is inert afterwards. */
  destroy(): void
  /** Resolves once the static layer and all sprites are rasterized (or failed). */
  readonly ready: Promise<void>
  /** Jump the clock to `seconds` (wrapped to the loop). For posters/tests/screenshots. */
  seek(seconds: number): void
  readonly running: boolean
}

export interface AnimatedWorldOptions {
  /** Override the prefers-reduced-motion media query. */
  reducedMotion?: boolean
}

export interface AnimatedWorld {
  id: string
  name: string
  thumbColor: string
  /** still poster for the world picker tile (1920x1080 SVG, like BackgroundDef.svg) */
  posterSvg: string
  create(width: number, height: number, options?: AnimatedWorldOptions): AnimatedWorldInstance
}

/** Loop length in seconds. Every motion completes a whole number of cycles per loop. */
export const LOOP_SECONDS = 60
/** Clock speed under reduced motion. */
export const REDUCED_SPEED = 0.4
const MAX_STEP_MS = 100

// ---------------------------------------------------------------- art helpers
// (copied from backgrounds.ts on purpose: that file is not imported so the two can
// evolve independently)
const FONT = `font-family="'Arial Rounded MT Bold','Arial Black',Arial,Helvetica,sans-serif" font-weight="900"`
const r = (n: number): number => Math.round(n)
const STROKE_DEFAULTS = 'stroke-linejoin="round" stroke-linecap="round" stroke-width="8"'

const vgrad = (id: string, ...stops: [number, string][]): string =>
  `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">${stops.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('')}</linearGradient>`
const fill = (id: string): string => `<rect width="1920" height="1080" fill="url(#${id})" stroke="none"/>`
const at = (x: number, y: number, s = 1, rot = 0, flip = false): string =>
  `transform="translate(${r(x)} ${r(y)})${rot ? ` rotate(${rot})` : ''}${s !== 1 || flip ? ` scale(${flip ? -s : s} ${s})` : ''}"`

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const starPts = (cx: number, cy: number, R: number, ri: number, n = 5): string => {
  const out: string[] = []
  for (let i = 0; i < n * 2; i++) {
    const a = (Math.PI * i) / n - Math.PI / 2
    const d = i % 2 === 0 ? R : ri
    out.push(`${r(cx + d * Math.cos(a))},${r(cy + d * Math.sin(a))}`)
  }
  return out.join(' ')
}
const twinkle = (cx: number, cy: number, s: number): string =>
  `M${cx} ${cy - s}Q${cx} ${cy} ${cx + s} ${cy}Q${cx} ${cy} ${cx} ${cy + s}Q${cx} ${cy} ${cx - s} ${cy}Q${cx} ${cy} ${cx} ${cy - s}Z`
function dots(n: number, seed: number, maxY: number, color = '#fff'): string {
  const rand = rng(seed)
  let out = ''
  for (let i = 0; i < n; i++) {
    out += `<circle cx="${r(rand() * 1920)}" cy="${r(rand() * maxY)}" r="${(2 + rand() * 4).toFixed(1)}" opacity="${(0.5 + rand() * 0.5).toFixed(2)}"/>`
  }
  return `<g fill="${color}" stroke="none">${out}</g>`
}
const CLOUD = 'M-110 40Q-150 40-150 5Q-150-30-110-30Q-105-80-50-85Q0-90 20-50Q40-70 70-60Q110-50 105-15Q150-10 150 20Q150 40 120 40Z'
const cloud = (x: number, y: number, s: number, f = '#fff', st = '#93c5fd'): string =>
  `<path d="${CLOUD}" ${at(x, y, s)} fill="${f}" stroke="${st}" stroke-width="${r(8 / s)}"/>`
const line2 = (d: string, dark: string, light: string, w: number): string =>
  `<path d="${d}" fill="none" stroke="${dark}" stroke-width="${w}"/><path d="${d}" fill="none" stroke="${light}" stroke-width="${r(w * 0.6)}"/>`
const sunFace = (x: number, y: number, rad: number): string =>
  `<g ${at(x, y)}><circle r="${rad + 26}" fill="#fde047" opacity=".35" stroke="none"/><circle r="${rad}" fill="#fde047" stroke="#f59e0b"/><g fill="#7c2d12" stroke="none"><circle cx="${r(-rad * 0.32)}" cy="${r(-rad * 0.1)}" r="${r(rad * 0.09)}"/><circle cx="${r(rad * 0.32)}" cy="${r(-rad * 0.1)}" r="${r(rad * 0.09)}"/></g><path d="M${r(-rad * 0.35)} ${r(rad * 0.2)}Q0 ${r(rad * 0.55)} ${r(rad * 0.35)} ${r(rad * 0.2)}" fill="none" stroke="#7c2d12" stroke-width="7"/></g>`

const sceneSvg = (defs: string, body: string, w = 1920, h = 1080): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" width="${w}" height="${h}" preserveAspectRatio="none"><defs>${defs}</defs><g ${STROKE_DEFAULTS}>${body}</g></svg>`

const svgUrl = (svg: string): string => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.replace(/\s+/g, ' ').trim())}`

// ---------------------------------------------------------------- time helpers
const TAU = Math.PI * 2
/** sin wave with k whole cycles per loop. */
const wave = (t: number, k: number, ph = 0): number => Math.sin(TAU * ((k * t) / LOOP_SECONDS + ph))
/** 0..1 sawtooth with k whole cycles per loop. */
const cyc = (t: number, k: number, ph = 0): number => {
  const v = (k * t) / LOOP_SECONDS + ph
  return v - Math.floor(v)
}
const DEG = Math.PI / 180

// ---------------------------------------------------------------- engine types
interface SpriteDef {
  /** inner SVG markup in local coordinates; the local origin is the pivot */
  svg: string
  /** local viewBox [x, y, w, h]; include the outline (half the stroke width) */
  box: [number, number, number, number]
  /** raster resolution multiplier for sprites drawn larger than 1:1 */
  res?: number
}

/** The tiny drawing vocabulary a world's draw() uses. Implemented for canvas and SVG. */
interface Painter {
  /** Stamp a sprite with its pivot at (x, y). sx/sy scale (negative sx flips), rot in degrees. */
  sprite(name: string, x: number, y: number, sx?: number, sy?: number, rot?: number, alpha?: number): void
  /** Swaying seaweed/grass blade rooted at (x, baseY), height h, phase in radians. */
  weed(x: number, baseY: number, h: number, phase: number, amp: number, dark: string, light: string, w: number): void
  /** Full-frame colour wash (lightning flash). */
  wash(color: string, alpha: number): void
}

interface WorldSpec {
  id: string
  name: string
  thumbColor: string
  defs: string
  body: string
  sprites: Record<string, SpriteDef>
  draw(p: Painter, t: number, rm: boolean): void
  /** clock position used for the poster */
  posterT: number
}

/** Seaweed geometry shared by both painters: fills `out` with 3 quadratic segments (cx,cy,x,y). */
const weedScratch = new Float32Array(12)
function weedGeometry(x: number, baseY: number, h: number, phase: number, amp: number, out: Float32Array): void {
  let px = x
  let py = baseY
  for (let i = 1; i <= 3; i++) {
    const f = i / 3
    const nx = x + amp * f * Math.sin(phase - i * 0.7)
    const ny = baseY - h * f
    const j = (i - 1) * 4
    out[j] = (px + nx) / 2 + (i % 2 === 1 ? -34 : 34)
    out[j + 1] = (py + ny) / 2
    out[j + 2] = nx
    out[j + 3] = ny
    px = nx
    py = ny
  }
}

// ---------------------------------------------------------------- shared sprite art
const CLOUD_BOX: [number, number, number, number] = [-158, -94, 316, 142]
const cloudSprite = (f = '#fff', st = '#93c5fd'): SpriteDef => ({ svg: `<path d="${CLOUD}" fill="${f}" stroke="${st}"/>`, box: CLOUD_BOX })
const puffSprite = (f: string, st: string): SpriteDef => ({
  svg: `<g fill="${f}" stroke="${st}"><circle cx="-26" cy="8" r="34"/><circle cx="28" cy="10" r="30"/><circle cx="0" cy="-16" r="40"/></g><g fill="${f}" stroke="none"><circle cx="-26" cy="8" r="30"/><circle cx="28" cy="10" r="26"/><circle cx="0" cy="-16" r="36"/></g>`,
  box: [-66, -62, 128, 108],
})

// ================================================================ 1. Under the Sea (moving)
const fishArt = (f: string, st: string): SpriteDef => ({
  svg: `<g stroke="${st}"><path d="M-62 0L-115-42Q-100 0-115 42Z" fill="${f}"/><path d="M-12-36Q10-72 38-40" fill="${f}"/><path d="M-70 0C-45-48 45-52 80 0C45 52-45 48-70 0Z" fill="${f}"/><path d="M8-38Q-6 0 8 38" fill="none" stroke-opacity=".5"/><circle cx="42" cy="-10" r="11" fill="#1e293b" stroke="none"/><circle cx="45" cy="-14" r="4" fill="#fff" stroke="none"/><path d="M46 16Q58 22 66 12" fill="none" stroke="#1e293b" stroke-width="6"/></g>`,
  box: [-124, -70, 210, 125],
})

const SEA_FISH: [string, number, number, number, number, number][] = [
  // sprite, lane y, scale, direction, cycles per loop, phase
  ['fishY', 180, 0.95, 1, 3, 0],
  ['fishP', 300, 0.75, -1, 4, 0.3],
  ['fishO', 420, 1.05, 1, 2, 0.62],
  ['fishG', 100, 0.55, -1, 5, 0.1],
  ['fishV', 360, 0.6, -1, 3, 0.78],
]
// bubbles: x, cycles, phase, scale, wobble cycles, start y
const SEA_BUBBLES = (() => {
  const rand = rng(21)
  const cols = [290, 320, 270, 1650, 1690, 120, 1830, 470, 1500, 1780]
  const n = 18
  const a = new Float32Array(n * 6)
  for (let i = 0; i < n; i++) {
    const c = cols[i % cols.length]
    a[i * 6] = c + (rand() - 0.5) * 40
    a[i * 6 + 1] = 3 + Math.floor(rand() * 4)
    a[i * 6 + 2] = rand()
    a[i * 6 + 3] = 0.45 + rand() * 0.75
    a[i * 6 + 4] = 20 + Math.floor(rand() * 20)
    a[i * 6 + 5] = i % cols.length < 3 ? 900 : 1000
  }
  return a
})()
const SEA_WEEDS: [number, number, string, string, number][] = [
  [110, 520, '#15803d', '#4ade80', 6],
  [200, 380, '#166534', '#22c55e', 7],
  [1700, 300, '#166534', '#22c55e', 8],
  [1830, 380, '#15803d', '#4ade80', 6],
  [1765, 220, '#15803d', '#86efac', 9],
]

const seaWorld: WorldSpec = {
  id: 'sea-moving',
  name: 'Under the Sea (moving)',
  thumbColor: '#0ea5e9',
  posterT: 7,
  defs: vgrad('aw-se-g', [0, '#7dd3fc'], [0.45, '#0ea5e9'], [1, '#0369a1']),
  body:
    fill('aw-se-g') +
    `<g fill="#fff" opacity=".12" stroke="none"><path d="M300 0h170L720 1080H530Z"/><path d="M900 0h120l170 1080h-150Z"/><path d="M1500 0h150l-40 1080h-170Z"/></g>` +
    `<path d="M0 880Q120 760 260 830Q370 740 500 860V1080H0ZM1400 870Q1540 760 1660 840Q1780 760 1920 840V1080H1400Z" fill="#0284c7" opacity=".55" stroke="none"/>` +
    `<path d="M0 940C300 900 600 960 960 930S1600 890 1920 940V1080H0Z" fill="#fde68a" stroke="#eab308"/>` +
    `<g fill="#facc15" opacity=".5" stroke="none"><circle cx="420" cy="1040" r="6"/><circle cx="760" cy="1060" r="5"/><circle cx="1180" cy="1040" r="6"/><circle cx="1520" cy="1060" r="5"/><circle cx="980" cy="1000" r="4"/></g>` +
    line2('M1560 990V880M1560 925L1515 860V820M1560 900L1612 845V800M1612 845L1650 830', '#be185d', '#f472b6', 34) +
    `<polygon points="${starPts(560, 1010, 46, 21)}" fill="#fb923c" stroke="#c2410c"/><polygon points="${starPts(1390, 1030, 30, 14)}" fill="#f9a8d4" stroke="#db2777"/>` +
    // treasure chest (bubbles rise from it)
    `<g ${at(290, 985)}><rect x="-95" y="-70" width="190" height="96" rx="12" fill="#b45309" stroke="#78350f"/><path d="M-95-70Q-95-140 0-140Q95-140 95-70Z" fill="#d97706" stroke="#78350f"/><path d="M-95-70H95M-40-136V24M40-136V24" fill="none" stroke="#78350f" stroke-width="10"/><rect x="-18" y="-86" width="36" height="40" rx="8" fill="#fde047" stroke="#ca8a04"/><circle cy="-64" r="6" fill="#78350f" stroke="none"/><g fill="#fde047" stroke="#ca8a04" stroke-width="5"><circle cx="-112" cy="18" r="14"/><circle cx="104" cy="22" r="12"/></g></g>` +
    `<path d="M1240 1040a40 40 0 0 1 80 0Z" fill="#fef3c7" stroke="#d97706"/><path d="M1280 1002V1040M1262 1008L1270 1040M1298 1008L1290 1040" stroke="#d97706" stroke-width="5"/>`,
  sprites: {
    fishY: fishArt('#fbbf24', '#d97706'),
    fishP: fishArt('#f472b6', '#be185d'),
    fishO: fishArt('#fb923c', '#c2410c'),
    fishG: fishArt('#4ade80', '#15803d'),
    fishV: fishArt('#a78bfa', '#7c3aed'),
    bubble: {
      svg: `<circle r="18" fill="#e0f2fe" fill-opacity=".35" stroke="#f0f9ff" stroke-width="5"/><path d="M-9-4q1-6 7-8" fill="none" stroke="#fff" stroke-width="5"/>`,
      box: [-22, -22, 44, 44],
      res: 1.3,
    },
    jelly: {
      svg:
        line2('M-30 20q-12 30 0 60t0 60M0 24q-12 30 0 60t0 60M30 20q-12 30 0 60t0 60', '#c026d3', '#f0abfc', 14) +
        `<path d="M-60 26Q-60-50 0-50Q60-50 60 26Q30 14 0 26Q-30 14-60 26Z" fill="#f0abfc" stroke="#c026d3"/><path d="M-34-20q12-16 30-18" fill="none" stroke="#fff" stroke-opacity=".7" stroke-width="8"/><g fill="#701a75" stroke="none"><circle cx="-18" cy="-2" r="6"/><circle cx="18" cy="-2" r="6"/></g><path d="M-8 10q8 6 16 0" fill="none" stroke="#701a75" stroke-width="5"/>`,
      box: [-66, -56, 132, 210],
    },
    crab: {
      svg:
        `<g fill="none" stroke="#b91c1c" stroke-width="10"><path d="M-44 8L-86 34L-96 58M-40 22L-74 52L-80 74M44 8L86 34L96 58M40 22L74 52L80 74"/><path d="M-42-12L-78-48M42-12L78-48"/></g>` +
        `<g fill="#f87171" stroke="#b91c1c"><path d="M-80-50m-26 0a26 26 0 1 0 26-26L-80-50Z"/><path d="M80-50m26 0a26 26 0 1 1-26-26L80-50Z"/><ellipse rx="64" ry="40"/></g>` +
        `<path d="M-18-34V-64M18-34V-64" stroke="#b91c1c" stroke-width="8"/><g fill="#fff" stroke="#b91c1c" stroke-width="5"><circle cx="-18" cy="-70" r="13"/><circle cx="18" cy="-70" r="13"/></g><g fill="#1e293b" stroke="none"><circle cx="-16" cy="-70" r="6"/><circle cx="20" cy="-70" r="6"/></g><path d="M-16 6Q0 18 16 6" fill="none" stroke="#7f1d1d" stroke-width="6"/>`,
      box: [-114, -112, 228, 194],
    },
  },
  draw(p, t, rm) {
    for (let i = 0; i < SEA_WEEDS.length; i++) {
      const [x, h, dark, light, k] = SEA_WEEDS[i]
      p.weed(x, 995, h, TAU * ((k * t) / LOOP_SECONDS) + i, rm ? 22 : 40, dark, light, 34)
    }
    for (let i = 0; i < SEA_FISH.length; i++) {
      const [name, y, s, dir, k, ph] = SEA_FISH[i]
      const u = cyc(t, k, ph)
      const x = dir > 0 ? -220 + u * 2360 : 2140 - u * 2360
      const wag = 1 + 0.05 * wave(t, 90 + i * 12)
      p.sprite(name, x, y + 16 * wave(t, 7 + i, i * 0.2), dir * s * wag, s, 4 * wave(t, 14 + i * 3, 0.1 * i))
    }
    p.sprite('jelly', 1560 + 40 * wave(t, 2), 290 + 50 * wave(t, 5), 1 - 0.05 * wave(t, 10), 1 + 0.07 * wave(t, 10))
    const B = SEA_BUBBLES
    for (let i = 0; i < B.length / 6; i++) {
      const j = i * 6
      const u = cyc(t, B[j + 1], B[j + 2])
      const y0 = B[j + 5]
      const s = B[j + 3] * (0.7 + 0.3 * u)
      p.sprite('bubble', B[j] + 12 * wave(t, B[j + 4], B[j + 2]), y0 - u * (y0 + 60), s, s, 0, u > 0.9 ? (1 - u) * 10 : 1)
    }
    p.sprite('crab', 1620 + 150 * wave(t, 3), 975 - 4 * Math.abs(wave(t, 48)), 0.8, 0.8, 3 * wave(t, 24))
  },
}

// ================================================================ 2. Outer Space (moving)
const SPACE_STARS: [number, number, number, number][] = [
  // x, y, size, cycles
  [760, 420, 0.8, 11],
  [1180, 300, 1, 9],
  [180, 560, 0.65, 13],
  [1840, 620, 0.7, 10],
  [980, 90, 0.6, 12],
  [430, 860, 0.65, 8],
  [1380, 980, 0.55, 14],
  [1650, 330, 0.6, 7],
  [620, 140, 0.5, 15],
]
const ROCKET_BODY =
  '<path d="M-55 0L-105 85L-48 64ZM55 0L105 85L48 64Z" fill="#ef4444" stroke="#b91c1c"/>' +
  '<path d="M0-150C52-110 62-40 56 66H-56C-62-40-52-110 0-150Z" fill="#f8fafc" stroke="#64748b"/>' +
  '<path d="M0-150C25-130 38-112 44-92H-44C-38-112-25-130 0-150Z" fill="#ef4444" stroke="#b91c1c"/>' +
  '<circle cy="-28" r="27" fill="#7dd3fc" stroke="#64748b"/><path d="M-12-38q6-8 16-8" fill="none" stroke="#fff" stroke-width="7"/>' +
  '<path d="M0 0V60" stroke="#ef4444" stroke-width="10" fill="none"/>'

const spaceWorld: WorldSpec = {
  id: 'space-moving',
  name: 'Outer Space (moving)',
  thumbColor: '#3b2a8f',
  posterT: 6.5,
  defs: vgrad('aw-sp-g', [0, '#1e1b4b'], [0.55, '#3b2a8f'], [1, '#7c3aed']),
  body:
    fill('aw-sp-g') +
    `<ellipse cx="1300" cy="760" rx="560" ry="200" fill="#a78bfa" opacity=".22" stroke="none"/><ellipse cx="560" cy="330" rx="420" ry="150" fill="#f472b6" opacity=".14" stroke="none"/>` +
    dots(80, 7, 1080) +
    `<circle cx="1490" cy="170" r="56" fill="#f472b6" stroke="#be185d"/><circle cx="1472" cy="156" r="12" fill="#ec4899" stroke="none"/><circle cx="1510" cy="190" r="8" fill="#ec4899" stroke="none"/>` +
    `<circle cx="1730" cy="900" r="125" fill="#2dd4bf" stroke="#0f766e" stroke-width="10"/><g fill="#5eead4" stroke="#0f766e" stroke-width="6"><circle cx="1690" cy="860" r="26"/><circle cx="1770" cy="940" r="18"/><circle cx="1680" cy="960" r="12"/></g>`,
  sprites: {
    star: { svg: `<path d="${twinkle(0, 0, 30)}" fill="#fde68a" stroke="none"/>`, box: [-32, -32, 64, 64], res: 1.2 },
    planet: {
      svg: `<g transform="rotate(-18)"><ellipse rx="240" ry="56" fill="none" stroke="#b45309" stroke-width="34"/><ellipse rx="240" ry="56" fill="none" stroke="#fde047" stroke-width="18"/><circle r="135" fill="#fb923c" stroke="#c2410c" stroke-width="10"/><path d="M-126-44Q0-14 126-44M-118 54Q0 84 118 54" fill="none" stroke="#fdba74" stroke-width="22"/><path d="M-70-92q30-20 70-22" fill="none" stroke="#fff" stroke-opacity=".6" stroke-width="12"/><path d="M-240 0A240 56 0 0 0 240 0" fill="none" stroke="#b45309" stroke-width="34"/><path d="M-240 0A240 56 0 0 0 240 0" fill="none" stroke="#fde047" stroke-width="18"/></g>`,
      box: [-262, -150, 524, 300],
    },
    rocket: { svg: ROCKET_BODY, box: [-110, -156, 220, 248] },
    flame: {
      // pivot at the nozzle (rocket y=62)
      svg: '<path d="M-35 0Q0 113 35 0Z" fill="#fbbf24" stroke="#f97316"/><path d="M-16 2Q0 58 16 2Z" fill="#fef08a" stroke="none"/>',
      box: [-40, -6, 80, 96],
    },
    ufo: {
      svg: `<ellipse cy="-24" rx="58" ry="50" fill="#a5f3fc" stroke="#0891b2"/><path d="M-26-46q12-14 30-14" fill="none" stroke="#fff" stroke-width="8"/><ellipse rx="120" ry="34" fill="#c4b5fd" stroke="#6d28d9"/><g fill="#fde047" stroke="#ca8a04" stroke-width="5"><circle cx="-70" cy="4" r="10"/><circle cy="12" r="10"/><circle cx="70" cy="4" r="10"/></g>`,
      box: [-126, -80, 252, 120],
    },
    beam: { svg: `<path d="M-40 0L-110 230H110L40 0Z" fill="#fef9c3" stroke="none"/>`, box: [-112, -2, 224, 234] },
    astro: {
      svg:
        `<g stroke="#64748b"><rect x="-48" y="-34" width="96" height="84" rx="18" fill="#cbd5e1"/><rect x="-34" y="38" width="28" height="52" rx="12" fill="#f8fafc"/><rect x="6" y="38" width="28" height="52" rx="12" fill="#f8fafc"/></g>` +
        line2('M-30 0L-70-44', '#64748b', '#f8fafc', 34) +
        line2('M30 4L66 44', '#64748b', '#f8fafc', 34) +
        `<g stroke="#64748b"><rect x="-38" y="-26" width="76" height="82" rx="26" fill="#f8fafc"/><circle cy="-62" r="46" fill="#f8fafc"/><rect x="-32" y="-86" width="64" height="44" rx="20" fill="#38bdf8" stroke="#0369a1"/></g><path d="M-18-74q8-6 18-6" fill="none" stroke="#fff" stroke-width="7"/><circle cx="-14" cy="10" r="9" fill="#ef4444" stroke="none"/><rect x="2" y="2" width="22" height="14" rx="4" fill="#fde047" stroke="none"/>`,
      box: [-96, -114, 182, 210],
    },
    comet: {
      svg: `<path d="M4-2L286-86L256-46L276-26Z" fill="#fde68a" opacity=".6" stroke="none"/><circle r="22" fill="#fef9c3" stroke="#facc15"/>`,
      box: [-28, -90, 318, 118],
    },
  },
  draw(p, t, rm) {
    for (let i = 0; i < SPACE_STARS.length; i++) {
      const [x, y, s, k] = SPACE_STARS[i]
      const w = 0.5 + 0.5 * wave(t, k, i * 0.13)
      const sc = 1.5 * s * (rm ? 0.85 + 0.15 * w : 0.6 + 0.4 * w)
      p.sprite('star', x, y, sc, sc, 0, rm ? 0.85 + 0.15 * w : 0.6 + 0.4 * w)
    }
    p.sprite('planet', 330 + 10 * wave(t, 1), 290 + 14 * wave(t, 2), 1, 1, 4 * wave(t, 1, 0.25))
    // comet streak: briefly, once per cycle
    const cp = cyc(t, 4, 0.5)
    if (cp < 0.12) {
      const u = cp / 0.12
      p.sprite('comet', 1750 - u * 900, 70 + u * 260, 0.9, 0.9, 0, Math.sin(Math.PI * u))
    }
    const ux = 220 + 30 * wave(t, 2)
    const uy = 700 + 22 * wave(t, 6)
    p.sprite('beam', ux, uy + 20, 1, 1, 0, 0.18 + (rm ? 0.04 : 0.12) * (0.5 + 0.5 * wave(t, 20)))
    p.sprite('ufo', ux, uy, 1, 1, 5 * wave(t, 3))
    p.sprite('astro', 1560 + 30 * wave(t, 2, 0.3), 560 + 40 * wave(t, 3), 0.8, 0.8, 18 * wave(t, 1) + 6 * wave(t, 5))
    // rocket on a gentle arc, bottom-left to top-right, over the child's head
    const rp = cyc(t, 5, 0.05)
    if (rp < 0.72) {
      const u = rp / 0.72
      const x = -250 + u * 2420
      const y = 600 - u * 470 - 90 * Math.sin(Math.PI * u)
      const dy = -470 - 90 * Math.PI * Math.cos(Math.PI * u)
      const rot = Math.atan2(dy, 2420) + Math.PI / 2
      const s = 0.8
      const flick = 0.8 + 0.3 * Math.abs(wave(t, 210))
      p.sprite('flame', x - Math.sin(rot) * 62 * s, y + Math.cos(rot) * 62 * s, s, s * flick, rot / DEG)
      p.sprite('rocket', x, y, s, s, rot / DEG)
    }
  },
}

// ================================================================ 3. Snow Day
const cap = (px: number, py: number, dl: number, dr: number, h = 90): string =>
  `<path d="M${px - dl * h} ${py + h}L${px} ${py}L${px + dr * h} ${py + h}L${r(px + dr * h * 0.55)} ${py + h - 22}L${r(px + dr * h * 0.2)} ${py + h + 8}L${r(px - dl * h * 0.2)} ${py + h - 20}L${r(px - dl * h * 0.6)} ${py + h + 6}Z" fill="#fff" stroke="#60a5fa"/>`
const pine = (x: number, y: number, s: number): string =>
  `<g ${at(x, y, s)} stroke-width="${r(8 / s)}"><rect x="-16" y="-40" width="32" height="44" fill="#92400e" stroke="#78350f"/><g fill="#16a34a" stroke="#14532d"><path d="M-110-30L0-160L110-30Z"/><path d="M-90-110L0-230L90-110Z"/><path d="M-66-190L0-290L66-190Z"/></g><path d="M-66-190Q-30-176 0-196Q30-176 66-190M-90-110Q-40-94 0-116Q44-94 90-110" fill="none" stroke="#fff" stroke-width="${r(14 / s)}"/></g>`
const CABIN_X = 330
const CABIN_Y = 985
const CHIMNEY = { x: CABIN_X + 82, y: CABIN_Y - 300 }

/** Snowflake layers: [count, cycles min, cycles spread, sway amp, seed]. Arrays: x0, k, phase, swayK, swayPh, size. */
function flakes(n: number, kMin: number, kSpread: number, seed: number): Float32Array {
  const rand = rng(seed)
  const a = new Float32Array(n * 6)
  for (let i = 0; i < n; i++) {
    a[i * 6] = rand() * 1980 - 30
    a[i * 6 + 1] = kMin + Math.floor(rand() * kSpread)
    a[i * 6 + 2] = rand()
    a[i * 6 + 3] = 3 + Math.floor(rand() * 5)
    a[i * 6 + 4] = rand()
    a[i * 6 + 5] = 0.7 + rand() * 0.6
  }
  return a
}
const FLAKES_FAR = flakes(60, 2, 2, 41)
const FLAKES_MID = flakes(42, 4, 2, 42)
const FLAKES_NEAR = flakes(18, 6, 2, 43)

function drawFlakes(p: Painter, t: number, a: Float32Array, name: string, amp: number, spin: boolean, alpha: number): void {
  for (let i = 0; i < a.length / 6; i++) {
    const j = i * 6
    const u = cyc(t, a[j + 1], a[j + 2])
    const s = a[j + 5]
    const x = a[j] + 70 * u + amp * wave(t, a[j + 3], a[j + 4])
    p.sprite(name, x, u * 1180 - 50, s, s, spin ? 360 * cyc(t, a[j + 3] - 1, a[j + 4]) : 0, alpha)
  }
}

const snowWorld: WorldSpec = {
  id: 'snow-moving',
  name: 'Snow Day',
  thumbColor: '#bfdbfe',
  posterT: 4,
  defs: vgrad('aw-sn-g', [0, '#93c5fd'], [0.6, '#dbeafe'], [1, '#f8fafc']),
  body:
    fill('aw-sn-g') +
    `<circle cx="1560" cy="150" r="70" fill="#fef9c3" stroke="#fde047"/>` +
    `<path d="M0 760L260 420L460 600L720 300L980 620L1200 380L1450 640L1680 360L1920 600V1080H0Z" fill="#bfdbfe" stroke="#60a5fa"/>` +
    cap(260, 420, 0.76, 1.1, 70) + cap(720, 300, 0.87, 0.84) + cap(1200, 380, 0.92, 0.96) + cap(1680, 360, 0.82, 1, 80) +
    `<path d="M-100 900L380 380L760 900Z" fill="#93c5fd" stroke="#3b82f6"/><path d="M1150 900L1560 330L2020 900Z" fill="#93c5fd" stroke="#3b82f6"/>` +
    cap(380, 380, 0.92, 0.73, 110) + cap(1560, 330, 0.72, 0.8, 120) +
    `<path d="M0 860Q480 800 960 850T1920 830V1080H0Z" fill="#f8fafc" stroke="#93c5fd"/>` +
    pine(620, 870, 0.55) + pine(1330, 860, 0.55) + pine(90, 950, 1.1) + pine(1640, 920, 0.95) + pine(1810, 960, 1.2) +
    // log cabin with a smoking chimney
    `<g ${at(CABIN_X, CABIN_Y)}><rect x="60" y="-292" width="44" height="120" fill="#9a3412" stroke="#7c2d12"/><rect x="54" y="-304" width="56" height="20" rx="10" fill="#fff" stroke="#93c5fd"/>` +
    `<rect x="-130" y="-150" width="260" height="150" fill="#b45309" stroke="#78350f"/><path d="M-130-112H130M-130-74H130M-130-36H130" fill="none" stroke="#92400e" stroke-width="7"/>` +
    `<path d="M-175-140L0-262L175-140Z" fill="#dc2626" stroke="#991b1b"/><path d="M-186-134L0-272L186-134Q160-120 140-134Q115-118 92-136L0-222L-92-136Q-115-118-140-134Q-160-120-186-134Z" fill="#fff" stroke="#93c5fd"/>` +
    `<rect x="-34" y="-96" width="68" height="96" rx="12" fill="#7c2d12" stroke="#451a03"/><circle cx="20" cy="-46" r="6" fill="#fde047" stroke="none"/>` +
    `<rect x="52" y="-118" width="62" height="56" rx="6" fill="#fde047" stroke="#78350f"/><path d="M83-118V-62M52-90H114" stroke="#78350f" stroke-width="6"/><rect x="-116" y="-118" width="62" height="56" rx="6" fill="#fde047" stroke="#78350f"/><path d="M-85-118V-62M-116-90H-54" stroke="#78350f" stroke-width="6"/></g>` +
    `<path d="M0 990Q500 940 1000 980T1920 970V1090H0Z" fill="#fff" stroke="#bfdbfe"/>` +
    // snowman
    `<g ${at(1480, 1000)}><g fill="#fff" stroke="#93c5fd"><circle cy="-70" r="80"/><circle cy="-195" r="60"/><circle cy="-290" r="44"/></g><path d="M-48-240Q0-218 48-240" fill="none" stroke="#ef4444" stroke-width="20"/><path d="M30-236L52-180" stroke="#ef4444" stroke-width="18"/><path d="M-50-326H50M-32-326V-376H32V-326" fill="#1e293b" stroke="#1e293b" stroke-width="12"/><g fill="#1e293b" stroke="none"><circle cx="-14" cy="-300" r="6"/><circle cx="14" cy="-300" r="6"/><circle cy="-200" r="7"/><circle cy="-170" r="7"/><circle cy="-90" r="7"/></g><path d="M0-288L34-280L0-276Z" fill="#fb923c" stroke="#ea580c" stroke-width="4"/><path d="M-58-200L-120-240M58-200L120-250" stroke="#92400e" stroke-width="9"/></g>`,
  sprites: {
    cloud: cloudSprite('#fff', '#93c5fd'),
    smoke: puffSprite('#f1f5f9', '#94a3b8'),
    dotFar: { svg: `<circle r="6" fill="#fff" stroke="#bfdbfe" stroke-width="3"/>`, box: [-8, -8, 16, 16], res: 1.4 },
    dotMid: { svg: `<circle r="9" fill="#fff" stroke="#93c5fd" stroke-width="4"/>`, box: [-12, -12, 24, 24], res: 1.4 },
    crystal: { svg: line2('M0-26V26M-22-13L22 13M-22 13L22-13', '#60a5fa', '#fff', 10), box: [-30, -32, 60, 64], res: 1.4 },
  },
  draw(p, t, rm) {
    p.sprite('cloud', -260 + cyc(t, 1, 0.15) * 2440, 110, 0.85, 0.85)
    p.sprite('cloud', -260 + cyc(t, 2, 0.55) * 2440, 230, 0.6, 0.6)
    p.sprite('cloud', -260 + cyc(t, 1, 0.75) * 2440, 70, 0.55, 0.55)
    for (let i = 0; i < 5; i++) {
      const u = cyc(t, 12, i / 5)
      const s = 0.35 + u * 0.85
      p.sprite('smoke', CHIMNEY.x + u * 110 + 14 * wave(t, 20, i * 0.3), CHIMNEY.y + 14 - u * 300, s, s, 0, Math.min(1, u * 6) * (1 - u) * 0.95)
    }
    drawFlakes(p, t, FLAKES_FAR, 'dotFar', 18, false, 0.75)
    drawFlakes(p, t, FLAKES_MID, 'dotMid', 26, false, 0.95)
    drawFlakes(p, t, FLAKES_NEAR, 'crystal', rm ? 24 : 40, true, 1)
  },
}

// ================================================================ 4. Rainy Weather Map
const LAND =
  'M330 310Q440 260 560 268L900 276Q1040 250 1180 256Q1270 280 1330 300Q1380 262 1430 270L1520 300Q1570 250 1620 262Q1670 300 1640 350Q1580 400 1580 470Q1590 530 1520 600Q1450 660 1440 740Q1460 800 1430 830Q1390 840 1360 760Q1330 700 1250 700Q1150 690 1080 760Q1020 820 960 810Q910 790 880 720Q820 680 720 682L560 650Q440 620 380 540Q330 470 310 400Q300 340 330 310Z'
const badge = (x: number, y: number, t: string): string =>
  `<rect x="${x - 72}" y="${y}" width="144" height="70" rx="35" fill="#fff" stroke="#1d4ed8"/><text x="${x}" y="${y + 51}" text-anchor="middle" ${FONT} font-size="44" textLength="${t.length > 3 ? 104 : 84}" lengthAdjust="spacingAndGlyphs" fill="#1b4f9c" stroke="none">${t}</text>`
const W_CLOUD = 'M-70 40Q-110 40-108 8Q-104-20-74-22Q-66-66-20-70Q22-72 36-36Q70-50 92-24Q112 0 100 24Q96 40 76 40Z'
const SUN = { x: 420, y: 430 }
// rain drops per cloud: offset x, cycles, phase
const RAIN_A = (() => {
  const rand = rng(51)
  const n = 18
  const a = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    a[i * 3] = -120 + (240 * (i + rand() * 0.8)) / n
    a[i * 3 + 1] = 40 + Math.floor(rand() * 12)
    a[i * 3 + 2] = rand()
  }
  return a
})()
const RAIN_B = (() => {
  const rand = rng(52)
  const n = 15
  const a = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    a[i * 3] = -105 + (210 * (i + rand() * 0.8)) / n
    a[i * 3 + 1] = 40 + Math.floor(rand() * 12)
    a[i * 3 + 2] = rand()
  }
  return a
})()
function drawRain(p: Painter, t: number, a: Float32Array, cx: number, cy: number, fallH: number, s: number): void {
  for (let i = 0; i < a.length / 3; i++) {
    const u = cyc(t, a[i * 3 + 1], a[i * 3 + 2])
    p.sprite('drop', cx + a[i * 3] * s - u * 30, cy + 30 * s + u * fallH, 1.5 * s, 1.5 * s, 8, 1 - u * u * u)
  }
}

const weatherWorld: WorldSpec = {
  id: 'weather-moving',
  name: 'Rainy Weather Map',
  thumbColor: '#2563eb',
  posterT: 3,
  defs:
    vgrad('aw-we-g', [0, '#38bdf8'], [1, '#1d4ed8']) +
    `<pattern id="aw-we-p" width="120" height="120" patternUnits="userSpaceOnUse"><path d="M120 0H0V120" fill="none" stroke="#fff" stroke-opacity=".14" stroke-width="3"/></pattern><clipPath id="aw-we-c"><path d="${LAND}"/></clipPath>`,
  body:
    fill('aw-we-g') +
    `<rect width="1920" height="1080" fill="url(#aw-we-p)" stroke="none"/>` +
    `<path d="${LAND}" fill="#86efac" stroke="#15803d" stroke-width="14"/>` +
    `<g clip-path="url(#aw-we-c)" fill="none" stroke="#15803d" stroke-opacity=".3" stroke-width="5" stroke-dasharray="2 18"><path d="M640 200V720M960 200V820M1260 200V720M300 470H1700"/></g>` +
    `<g fill="#7dd3fc" stroke="#0284c7" stroke-width="6"><path d="M1160 300q30-20 50 6q-10 30-40 24q-24-10-10-30z"/><path d="M1240 320q30-14 46 10q-14 22-40 16z"/></g>` +
    `<g fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="7"><path d="M120 820q30-20 60 0t60 0M1620 760q30-20 60 0t60 0M600 900q30-20 60 0t60 0M1500 960q30-20 60 0t60 0"/></g>` +
    `<g ${at(SUN.x, SUN.y)}><circle r="54" fill="#fde047" stroke="#f59e0b"/><g fill="#92400e" stroke="none"><circle cx="-17" cy="-8" r="6"/><circle cx="17" cy="-8" r="6"/></g><path d="M-20 12Q0 30 20 12" fill="none" stroke="#92400e" stroke-width="6"/></g>` +
    badge(SUN.x, SUN.y + 92, '75°') +
    `<rect x="48" y="44" width="470" height="104" rx="52" fill="#f97316" stroke="#c2410c"/><g ${at(118, 96, 0.42)}><circle r="54" fill="#fde047" stroke="#f59e0b" stroke-width="19"/></g><text x="186" y="120" ${FONT} font-size="62" textLength="300" lengthAdjust="spacingAndGlyphs" fill="#fff" stroke="none">WEATHER</text>` +
    `<rect x="1580" y="48" width="290" height="88" rx="44" fill="#fff" stroke="#1d4ed8"/><text x="1725" y="110" text-anchor="middle" ${FONT} font-size="52" textLength="200" lengthAdjust="spacingAndGlyphs" fill="#1b4f9c" stroke="none">RAINY</text>`,
  sprites: {
    rays: {
      svg: `<g stroke="#f59e0b" stroke-width="14">${[0, 45, 90, 135, 180, 225, 270, 315].map((a) => `<path d="M0-70V-92" transform="rotate(${a})"/>`).join('')}</g>`,
      box: [-100, -100, 200, 200],
    },
    rainCloud: { svg: `<path d="${W_CLOUD}" transform="scale(1.5)" fill="#cbd5e1" stroke="#475569" stroke-width="6"/><path d="M-60 6q20-30 60-30" transform="scale(1.5)" fill="none" stroke="#fff" stroke-opacity=".7" stroke-width="6"/>`, box: [-168, -112, 330, 180] },
    whiteCloud: { svg: `<path d="${W_CLOUD}" transform="scale(1.2)" fill="#fff" stroke="#64748b" stroke-width="7"/>`, box: [-136, -90, 266, 144] },
    drop: { svg: `<path d="M0-14q-12 20 0 28q12-8 0-28z" fill="#38bdf8" stroke="#0369a1" stroke-width="5"/>`, box: [-12, -18, 24, 36], res: 1.3 },
    bolt: { svg: `<path d="M14-70L-26 4H2L-18 74L34-14H6L28-70Z" fill="#fde047" stroke="#ca8a04" stroke-width="7"/>`, box: [-32, -76, 70, 154] },
  },
  draw(p, t, rm) {
    p.sprite('rays', SUN.x, SUN.y, 1, 1, 360 * cyc(t, 3))
    p.sprite('whiteCloud', 800 + 150 * wave(t, 2), 240 + 10 * wave(t, 5))
    const ax = 1250 + 120 * wave(t, 1)
    const ay = 380 + 8 * wave(t, 4)
    const bx = 1570 + 80 * wave(t, 1, 0.5)
    const by = 610 + 8 * wave(t, 3, 0.3)
    drawRain(p, t, RAIN_A, ax, ay, 300, 1)
    drawRain(p, t, RAIN_B, bx, by, 230, 0.85)
    let flash = 0
    if (!rm) {
      const lp = cyc(t, 5, 0.2)
      if (lp < 0.04) {
        const on = lp < 0.012 || (lp > 0.02 && lp < 0.036)
        if (on) {
          p.sprite('bolt', ax - 30, ay + 150, 1.3, 1.3, 6)
          flash = lp < 0.012 ? 0.28 : 0.18
        }
      }
    }
    p.sprite('rainCloud', ax, ay)
    p.sprite('rainCloud', bx, by, 0.85, 0.85)
    if (flash > 0) p.wash('#fff', flash)
  },
}

// ================================================================ 5. Volcano (Dinosaur Land)
const FROND = 'M0 0Q80-70 210 0Q90-16 0 0Z'
const palm = (x: number, y: number, s: number, flip = false): string =>
  `<g ${at(x, y, s, 0, flip)}>${line2('M0 0Q-30-170 40-330', '#78350f', '#b45309', 44)}<g ${at(40, -330)} fill="#22c55e" stroke="#15803d">${[-170, -130, -80, -35, 10]
    .map((a) => `<path d="${FROND}" transform="rotate(${a})"/>`)
    .join('')}</g><g fill="#92400e" stroke="#78350f" stroke-width="6"><circle cx="28" cy="-312" r="16"/><circle cx="56" cy="-316" r="16"/></g></g>`
const CRATER = { x: 570, y: 372 }
const DINO_B = 'M-170-40Q-180-170-40-190Q80-200 160-140Q290-80 380-30Q220-40 170-20Q20 10-170-40Z'
const DINO_N = 'M-150-150Q-160-300-220-420Q-240-470-292-472Q-350-472-350-430Q-350-398-298-398Q-266-394-256-340Q-226-220-40-180Z'

const volcanoWorld: WorldSpec = {
  id: 'volcano-moving',
  name: 'Volcano',
  thumbColor: '#a3e635',
  posterT: 20,
  defs: vgrad('aw-vo-g', [0, '#7dd3fc'], [0.6, '#fde68a'], [1, '#fdba74']),
  body:
    fill('aw-vo-g') +
    `<circle cx="1700" cy="150" r="80" fill="#fde047" stroke="#f59e0b"/>` +
    `<path d="M900 760L1060 560L1180 680L1330 520L1500 740Z" fill="#c4b5fd" stroke="#8b5cf6"/>` +
    `<path d="M200 820L480 380Q570 352 660 380L920 820Z" fill="#a16207" stroke="#713f12"/><path d="M480 380Q570 352 660 380L630 440Q612 474 600 430Q580 510 560 430Q540 474 522 442Z" fill="#f97316" stroke="#c2410c"/><path d="M360 640Q560 600 760 640" fill="none" stroke="#713f12" stroke-width="8" opacity=".5"/>` +
    `<path d="M0 800Q300 740 640 790T1300 780T1920 790V1080H0Z" fill="#a3e635" stroke="#4d7c0f"/>` +
    `<path d="M0 930Q480 890 960 920T1920 910V1080H0Z" fill="#84cc16" stroke="#4d7c0f"/>` +
    `<g fill="#65a30d" stroke="none"><path d="M300 960l10-30 10 30zM760 1000l10-30 10 30zM1220 970l10-30 10 30zM1600 1010l10-30 10 30z"/></g>` +
    palm(150, 980, 1) + palm(1820, 1000, 0.85, true),
  sprites: {
    cloud: cloudSprite('#fff', '#93c5fd'),
    smoke: puffSprite('#e5e7eb', '#9ca3af'),
    glow: { svg: `<ellipse rx="96" ry="34" fill="#fde047" stroke="none"/>`, box: [-98, -36, 196, 72] },
    blob: { svg: `<circle r="14" fill="#f97316" stroke="#c2410c" stroke-width="6"/>`, box: [-18, -18, 36, 36], res: 1.3 },
    dino: {
      svg:
        `<g fill="#16a34a" stroke="#15803d"><rect x="-140" y="-70" width="56" height="86" rx="24"/><rect x="-60" y="-70" width="56" height="80" rx="24"/><rect x="70" y="-70" width="56" height="86" rx="24"/><rect x="140" y="-70" width="56" height="80" rx="24"/></g>` +
        `<g fill="#4ade80" stroke="#15803d" stroke-width="18"><path d="${DINO_B}"/><path d="${DINO_N}"/></g>` +
        `<g fill="#4ade80" stroke="none"><path d="${DINO_B}"/><path d="${DINO_N}"/></g><g fill="#22c55e" stroke="none"><circle cx="-40" cy="-130" r="22"/><circle cx="40" cy="-150" r="16"/><circle cx="70" cy="-100" r="20"/><circle cx="-100" cy="-90" r="14"/></g><circle cx="-300" cy="-440" r="10" fill="#1e293b" stroke="none"/><path d="M-340-414Q-320-404-300-410" fill="none" stroke="#15803d" stroke-width="6"/><circle cx="-268" cy="-416" r="10" fill="#f9a8d4" stroke="none"/>`,
      box: [-362, -484, 754, 506],
    },
    wings: { svg: `<path d="M-6 0Q-60-76-136-22Q-60-24-6 10ZM6 0Q60-76 136-22Q60-24 6 10Z" fill="#c084fc" stroke="#7e22ce"/>`, box: [-142, -64, 284, 80] },
    ptero: {
      svg: `<ellipse rx="40" ry="17" fill="#c084fc" stroke="#7e22ce"/><path d="M-40-12L-30-44L-18-14Z" fill="#a855f7" stroke="#7e22ce" stroke-width="6"/><circle cx="-44" cy="-6" r="18" fill="#c084fc" stroke="#7e22ce"/><path d="M-58-4L-100 6L-58 12Z" fill="#fde047" stroke="#ca8a04" stroke-width="5"/><circle cx="-48" cy="-10" r="5" fill="#1e293b" stroke="none"/><path d="M38 0L66 10L38 10Z" fill="#c084fc" stroke="#7e22ce" stroke-width="6"/>`,
      box: [-104, -48, 176, 72],
    },
    egg: {
      svg: `<path d="M-40 0Q-40-80 0-80Q40-80 40 0Z" fill="#fef3c7" stroke="#d97706"/><g fill="#fdba74" stroke="none"><circle cx="-14" cy="-44" r="8"/><circle cx="16" cy="-24" r="6"/></g><path d="M-38-14L-20-30L-6-14L10-32L26-16L40-26" fill="none" stroke="#d97706" stroke-width="6"/>`,
      box: [-46, -86, 92, 92],
    },
    nest: { svg: `<ellipse rx="90" ry="30" fill="#a16207" stroke="#713f12"/><path d="M-60-6q20 10 40 0t40 0t40 0" fill="none" stroke="#713f12" stroke-width="6"/>`, box: [-96, -36, 192, 72] },
  },
  draw(p, t, rm) {
    p.sprite('cloud', -260 + cyc(t, 1, 0.62) * 2440, 170, 0.8, 0.8)
    p.sprite('cloud', -260 + cyc(t, 1, 0.12) * 2440, 110, 0.6, 0.6)
    p.sprite('glow', CRATER.x, CRATER.y + 4, 1, 1, 0, 0.25 + 0.35 * (0.5 + 0.5 * wave(t, rm ? 6 : 15)))
    for (let i = 0; i < 5; i++) {
      const u = cyc(t, 10, i / 5)
      const s = 0.45 + u * 1.1
      p.sprite('smoke', CRATER.x + u * 170 + 22 * wave(t, 20, i * 0.3), CRATER.y - 30 - u * 300, s, s, 0, Math.min(1, u * 5) * (1 - u))
    }
    if (!rm) {
      for (let i = 0; i < 3; i++) {
        const u = cyc(t, 15, i / 3)
        if (u < 0.5) {
          const v = u / 0.5
          const dir = i === 1 ? 0.4 : i === 0 ? -1 : 1
          p.sprite('blob', CRATER.x + dir * v * 120, CRATER.y + 10 - 4 * 130 * v * (1 - v), 1, 1, 0, v > 0.85 ? (1 - v) / 0.15 : 1)
        }
      }
    }
    // pterodactyl crossing right to left, flapping
    const pu = cyc(t, 4, 0.3)
    const px = 2120 - pu * 2440
    const py = 240 + 34 * wave(t, 12)
    const flap = 0.62 + 0.38 * wave(t, 100)
    p.sprite('wings', px + 6, py - 2, 0.9, 0.9 * flap)
    p.sprite('ptero', px, py, 0.9, 0.9)
    // the long-neck dino breathes and sways from its feet
    p.sprite('dino', 1470, 900, 1, 1 + 0.015 * wave(t, 8), 1.5 * wave(t, 4))
    const env = Math.max(0, wave(t, 6))
    p.sprite('egg', 420, 962, 1, 1, (rm ? 4 : 9) * env * env * env * wave(t, 90))
    p.sprite('nest', 420, 962)
  },
}

// ================================================================ 6. Rainbow Sky
const BANDS: [string, string][] = [
  ['#fb7185', '#e11d48'],
  ['#fdba74', '#ea580c'],
  ['#fde047', '#ca8a04'],
  ['#86efac', '#16a34a'],
  ['#7dd3fc', '#0284c7'],
  ['#c4b5fd', '#7c3aed'],
]
const lolly = (x: number, y: number, c: string, st: string): string =>
  `<g ${at(x, y)}>${line2('M0 0V-160', '#cbd5e1', '#fff', 22)}<circle cy="-210" r="70" fill="${c}" stroke="${st}"/><path d="M0-210m-10 0a10 10 0 0 1 20 0a20 20 0 0 1-40 0a30 30 0 0 1 60 0a40 40 0 0 1-80 0" fill="none" stroke="#fff" stroke-width="10"/></g>`
const RB_STARS: [number, number][] = [
  [300, 200],
  [520, 120],
  [1420, 120],
  [1500, 340],
  [420, 380],
]
const RB_SPARKLES: [number, number, number, number][] = [
  // x, y, size, cycles
  [180, 300, 0.9, 9],
  [640, 260, 0.6, 11],
  [1280, 250, 0.7, 10],
  [1820, 360, 0.8, 12],
  [960, 170, 0.55, 13],
  [110, 640, 0.7, 8],
  [1840, 620, 0.65, 14],
  [760, 420, 0.5, 15],
  [1180, 430, 0.5, 7],
  [1700, 260, 0.6, 16],
]
const RB_HEARTS: [number, number, number, number][] = [
  // x, scale, cycles, phase
  [230, 1.5, 4, 0],
  [380, 1.2, 3, 0.45],
  [1560, 1.3, 4, 0.6],
  [1760, 1.5, 3, 0.15],
]

const rainbowWorld: WorldSpec = {
  id: 'rainbow-moving',
  name: 'Rainbow Sky',
  thumbColor: '#fbcfe8',
  posterT: 5,
  defs: vgrad('aw-ra-g', [0, '#bae6fd'], [0.5, '#fbcfe8'], [1, '#fef9c3']),
  body:
    fill('aw-ra-g') +
    BANDS.map(([light, dark], i) => {
      const rad = 820 - i * 60
      const d = `M${960 - rad} 1000A${rad} ${rad} 0 0 1 ${960 + rad} 1000`
      return `<path d="${d}" fill="none" stroke="${dark}" stroke-width="62" stroke-linecap="butt"/><path d="${d}" fill="none" stroke="${light}" stroke-width="48" stroke-linecap="butt"/>`
    }).join('') +
    sunFace(1720, 170, 80) +
    cloud(170, 930, 1.5) + cloud(1750, 930, 1.5) +
    `<path d="M0 1000Q300 880 600 980T1200 970T1920 960V1080H0Z" fill="#f9a8d4" stroke="#db2777"/>` +
    `<path d="M0 1050Q480 1000 960 1040T1920 1030V1090H0Z" fill="#a7f3d0" stroke="#10b981"/>` +
    lolly(520, 990, '#c4b5fd', '#7c3aed') + lolly(1420, 985, '#fdba74', '#ea580c'),
  sprites: {
    cloud: cloudSprite('#fff', '#93c5fd'),
    star: { svg: `<polygon points="${starPts(0, 0, 26, 11)}" fill="#fde047" stroke="#ca8a04" stroke-width="5"/>`, box: [-30, -30, 60, 56], res: 1.3 },
    sparkle: { svg: `<path d="${twinkle(0, 0, 30)}" fill="#fff" stroke="#ec4899" stroke-width="5"/>`, box: [-34, -34, 68, 68], res: 1.6 },
    heart: { svg: `<path d="M0 26C-30 8-30-20-14-24C-6-26 0-20 0-14C0-20 6-26 14-24C30-20 30 8 0 26Z" fill="#f472b6" stroke="#be185d" stroke-width="5"/>`, box: [-30, -28, 60, 58], res: 1.5 },
    balloon: {
      svg:
        `<path d="M-30 64L-26 104M30 64L26 104" stroke="#92400e" stroke-width="5"/><rect x="-32" y="100" width="64" height="44" rx="8" fill="#d97706" stroke="#92400e"/><path d="M-32 116H32" stroke="#92400e" stroke-width="5"/>` +
        `<path d="M0-160C-100-160-120-60-84-12Q-56 30-30 64H30Q56 30 84-12C120-60 100-160 0-160Z" fill="#fb7185" stroke="#e11d48"/>` +
        `<path d="M0-160C-44-150-56-50-14 64H14C56-50 44-150 0-160Z" fill="#fde047" stroke="#e11d48" stroke-width="6"/>` +
        `<path d="M-50-120q20-26 50-30" fill="none" stroke="#fff" stroke-opacity=".7" stroke-width="10"/>`,
      box: [-114, -166, 228, 316],
    },
    bwings: {
      svg: `<g fill="#c4b5fd" stroke="#7c3aed" stroke-width="6"><path d="M0 0C-40-64-96-44-74 0C-96 30-44 54 0 6Z"/><path d="M0 0C40-64 96-44 74 0C96 30 44 54 0 6Z"/></g><g fill="#f9a8d4" stroke="none"><circle cx="-46" cy="-14" r="10"/><circle cx="46" cy="-14" r="10"/></g>`,
      box: [-92, -52, 184, 92],
    },
    bbody: {
      svg: `<ellipse rx="9" ry="30" fill="#7c3aed" stroke="#5b21b6" stroke-width="4"/><path d="M-4-28Q-14-50-24-54M4-28Q14-50 24-54" fill="none" stroke="#5b21b6" stroke-width="4"/>`,
      box: [-28, -58, 56, 92],
    },
  },
  draw(p, t, rm) {
    p.sprite('cloud', -260 + cyc(t, 1, 0.1) * 2440, 270, 0.75, 0.75)
    p.sprite('cloud', -260 + cyc(t, 1, 0.6) * 2440, 140, 0.9, 0.9)
    p.sprite('cloud', -260 + cyc(t, 2, 0.35) * 2440, 70, 0.5, 0.5)
    for (let i = 0; i < RB_STARS.length; i++) {
      const [x, y] = RB_STARS[i]
      const s = 1 + 0.12 * wave(t, 6 + i, i * 0.2)
      p.sprite('star', x, y, s, s, 12 * wave(t, 3 + i, i * 0.17))
    }
    for (let i = 0; i < RB_SPARKLES.length; i++) {
      const [x, y, sz, k] = RB_SPARKLES[i]
      const w = 0.5 + 0.5 * wave(t, k, i * 0.21)
      const s = 1.5 * sz * (rm ? 0.75 + 0.25 * w : 0.3 + 0.7 * w)
      p.sprite('sparkle', x, y, s, s, 0, rm ? 0.85 : 0.35 + 0.65 * w)
    }
    for (let i = 0; i < RB_HEARTS.length; i++) {
      const [x, s, k, ph] = RB_HEARTS[i]
      const u = cyc(t, k, ph)
      p.sprite('heart', x + 26 * wave(t, 10, ph), 900 - u * 760, s, s, 10 * wave(t, 8, ph), Math.sin(Math.PI * u))
    }
    p.sprite('balloon', 1590 + 40 * wave(t, 1), 470 + 30 * wave(t, 3), 0.95, 0.95, 3 * wave(t, 2))
    for (let i = 0; i < 2; i++) {
      const cx = i === 0 ? 330 : 1650
      const cy = i === 0 ? 640 : 780
      const x = cx + 100 * wave(t, 3, i * 0.4)
      const y = cy + 60 * wave(t, 7, i * 0.3)
      const fl = 0.3 + 0.7 * Math.abs(wave(t, rm ? 40 : 110, i * 0.25))
      const tilt = 14 * wave(t, 3, i * 0.4 + 0.25)
      p.sprite('bwings', x, y, 0.85 * fl, 0.85, tilt)
      p.sprite('bbody', x, y, 0.85, 0.85, tilt)
    }
  },
}

const SPECS: WorldSpec[] = [seaWorld, spaceWorld, snowWorld, weatherWorld, volcanoWorld, rainbowWorld]

// ---------------------------------------------------------------- SVG painter (posters)
function posterFor(spec: WorldSpec): string {
  let out = ''
  const fmt = (n: number): string => (Math.round(n * 100) / 100).toString()
  const painter: Painter = {
    sprite(name, x, y, sx = 1, sy = sx, rot = 0, alpha = 1) {
      if (!spec.sprites[name] || alpha <= 0.01) return
      out += `<use href="#aw-${spec.id}-${name}" transform="translate(${fmt(x)} ${fmt(y)})${rot ? ` rotate(${fmt(rot)})` : ''} scale(${fmt(sx)} ${fmt(sy)})"${alpha < 1 ? ` opacity="${fmt(alpha)}"` : ''}/>`
    },
    weed(x, baseY, h, phase, amp, dark, light, w) {
      const g = weedScratch
      weedGeometry(x, baseY, h, phase, amp, g)
      let d = `M${fmt(x)} ${fmt(baseY)}`
      for (let i = 0; i < 3; i++) d += `Q${fmt(g[i * 4])} ${fmt(g[i * 4 + 1])} ${fmt(g[i * 4 + 2])} ${fmt(g[i * 4 + 3])}`
      out += line2(d, dark, light, w)
    },
    wash(color, alpha) {
      out += `<rect width="1920" height="1080" fill="${color}" opacity="${fmt(alpha)}" stroke="none"/>`
    },
  }
  spec.draw(painter, spec.posterT, false)
  const defs = Object.entries(spec.sprites)
    .map(([name, s]) => `<g id="aw-${spec.id}-${name}">${s.svg}</g>`)
    .join('')
  return sceneSvg(spec.defs + defs, spec.body + out)
}

// ---------------------------------------------------------------- canvas painter + instance
interface SpriteRaster {
  cv: HTMLCanvasElement | null
  x: number
  y: number
  w: number
  h: number
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(w))
  c.height = Math.max(1, Math.round(h))
  return c
}

function get2d(c: HTMLCanvasElement, opaque = false): CanvasRenderingContext2D | null {
  try {
    return (c.getContext('2d', opaque ? { alpha: false } : undefined) as CanvasRenderingContext2D | null) ?? null
  } catch {
    return null
  }
}

/** Rasterize an SVG string into a fresh canvas (async: Image decode). Resolves null on failure. */
function rasterize(svg: string, w: number, h: number, alive: () => boolean): Promise<HTMLCanvasElement | null> {
  return new Promise((resolve) => {
    if (typeof Image === 'undefined') return resolve(null)
    let img: HTMLImageElement
    try {
      img = new Image(w, h)
    } catch {
      return resolve(null)
    }
    let settled = false
    const done = (v: HTMLCanvasElement | null) => {
      if (settled) return
      settled = true
      img.onload = img.onerror = null
      resolve(v)
    }
    img.onload = () => {
      const paint = () => {
        if (!alive()) return done(null)
        const c = makeCanvas(w, h)
        const ctx = get2d(c)
        if (!ctx) return done(null)
        try {
          ctx.drawImage(img, 0, 0, c.width, c.height)
          done(c)
        } catch {
          done(null)
        }
      }
      // decode() can reject for SVG on some Safari versions although the image loaded.
      if (typeof img.decode === 'function') img.decode().then(paint, paint)
      else paint()
    }
    img.onerror = () => done(null)
    img.src = svgUrl(svg)
  })
}

function systemPrefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

function createInstance(spec: WorldSpec, width: number, height: number, options: AnimatedWorldOptions = {}): AnimatedWorldInstance {
  const canvas = makeCanvas(width || 1280, height || 720)
  const W = canvas.width
  const H = canvas.height
  const ctx = get2d(canvas, true)
  // cover-fit the 1920x1080 world into the canvas
  const S = Math.max(W / 1920, H / 1080)
  const OX = (W - 1920 * S) / 2
  const OY = (H - 1080 * S) / 2

  let destroyed = false
  let running = true
  let t = 0
  let last = -1
  let reduced = options.reducedMotion ?? systemPrefersReducedMotion()
  let staticLayer: HTMLCanvasElement | null = null
  const alive = () => !destroyed

  let mql: MediaQueryList | null = null
  const onMotionChange = (e: MediaQueryListEvent) => {
    reduced = e.matches
  }
  if (options.reducedMotion === undefined && typeof matchMedia === 'function') {
    try {
      mql = matchMedia('(prefers-reduced-motion: reduce)')
      mql.addEventListener?.('change', onMotionChange)
    } catch {
      mql = null
    }
  }

  // ---- rasterize static layer + sprites (once)
  const sprites = new Map<string, SpriteRaster>()
  const jobs: Promise<unknown>[] = []
  if (ctx) {
    jobs.push(
      rasterize(sceneSvg(spec.defs, spec.body, Math.round(1920 * S), Math.round(1080 * S)), Math.round(1920 * S), Math.round(1080 * S), alive).then((c) => {
        staticLayer = c
      }),
    )
    for (const [name, def] of Object.entries(spec.sprites)) {
      const [bx, by, bw, bh] = def.box
      const res = def.res ?? 1
      const pw = Math.max(2, Math.ceil(bw * S * res))
      const ph = Math.max(2, Math.ceil(bh * S * res))
      const entry: SpriteRaster = { cv: null, x: bx, y: by, w: bw, h: bh }
      sprites.set(name, entry)
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${bx} ${by} ${bw} ${bh}" width="${pw}" height="${ph}" preserveAspectRatio="none"><g ${STROKE_DEFAULTS}>${def.svg}</g></svg>`
      jobs.push(
        rasterize(svg, pw, ph, alive).then((c) => {
          entry.cv = c
        }),
      )
    }
  }
  const ready = Promise.all(jobs).then(() => undefined)

  const painter: Painter = {
    sprite(name, x, y, sx = 1, sy = sx, rot = 0, alpha = 1) {
      const sp = sprites.get(name)
      if (!sp || !sp.cv || alpha <= 0.01 || !ctx) return
      const a = rot * DEG
      const c = Math.cos(a) * S
      const s = Math.sin(a) * S
      ctx.setTransform(c * sx, s * sx, -s * sy, c * sy, OX + x * S, OY + y * S)
      ctx.globalAlpha = alpha > 1 ? 1 : alpha
      ctx.drawImage(sp.cv, sp.x, sp.y, sp.w, sp.h)
    },
    weed(x, baseY, h, phase, amp, dark, light, w) {
      if (!ctx) return
      const g = weedScratch
      weedGeometry(x, baseY, h, phase, amp, g)
      ctx.setTransform(S, 0, 0, S, OX, OY)
      ctx.globalAlpha = 1
      ctx.beginPath()
      ctx.moveTo(x, baseY)
      ctx.quadraticCurveTo(g[0], g[1], g[2], g[3])
      ctx.quadraticCurveTo(g[4], g[5], g[6], g[7])
      ctx.quadraticCurveTo(g[8], g[9], g[10], g[11])
      ctx.strokeStyle = dark
      ctx.lineWidth = w
      ctx.stroke()
      ctx.strokeStyle = light
      ctx.lineWidth = Math.round(w * 0.6)
      ctx.stroke()
    },
    wash(color, alpha) {
      if (!ctx) return
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.globalAlpha = alpha
      ctx.fillStyle = color
      ctx.fillRect(0, 0, W, H)
    },
  }

  if (ctx) {
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.imageSmoothingEnabled = true
  }

  const paint = () => {
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = 1
    if (staticLayer) ctx.drawImage(staticLayer, Math.round(OX), Math.round(OY))
    else {
      ctx.fillStyle = spec.thumbColor
      ctx.fillRect(0, 0, W, H)
    }
    spec.draw(painter, t, reduced)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = 1
  }

  return {
    canvas,
    ready,
    get running() {
      return running
    },
    start() {
      if (destroyed || running) return
      running = true
      last = -1 // the first frame after a resume does not advance: no jump
    },
    stop() {
      running = false
      last = -1
    },
    seek(seconds: number) {
      const v = seconds % LOOP_SECONDS
      t = Number.isFinite(v) ? (v < 0 ? v + LOOP_SECONDS : v) : 0
    },
    frame(nowMs: number) {
      if (destroyed) return
      if (running && Number.isFinite(nowMs)) {
        if (last >= 0) {
          let dt = nowMs - last
          if (dt < 0) dt = 0
          else if (dt > MAX_STEP_MS) dt = MAX_STEP_MS
          t += (dt / 1000) * (reduced ? REDUCED_SPEED : 1)
          if (t >= LOOP_SECONDS) t -= LOOP_SECONDS * Math.floor(t / LOOP_SECONDS)
        }
        last = nowMs
      }
      paint()
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      running = false
      mql?.removeEventListener?.('change', onMotionChange)
      for (const sp of sprites.values()) {
        if (sp.cv) sp.cv.width = sp.cv.height = 0
        sp.cv = null
      }
      sprites.clear()
      if (staticLayer) staticLayer.width = staticLayer.height = 0
      staticLayer = null
      // free the backing store (Safari caps total canvas memory)
      canvas.width = canvas.height = 0
    },
  }
}

// ---------------------------------------------------------------- public list
const posterCache = new Map<string, string>()

export const ANIMATED_WORLDS: AnimatedWorld[] = SPECS.map((spec) => ({
  id: spec.id,
  name: spec.name,
  thumbColor: spec.thumbColor,
  get posterSvg() {
    let svg = posterCache.get(spec.id)
    if (!svg) {
      svg = posterFor(spec)
      posterCache.set(spec.id, svg)
    }
    return svg
  },
  create: (width: number, height: number, options?: AnimatedWorldOptions) => createInstance(spec, width, height, options),
}))

export function getAnimatedWorld(id: string): AnimatedWorld | undefined {
  return ANIMATED_WORLDS.find((w) => w.id === id)
}
