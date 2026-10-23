// Built-in "worlds": hand-built flat SVG illustrations (1920x1080) in a kindergarten
// picture-book style using the Talkline palette. Shapes have thick same-hue outlines and
// skies use soft gradients. Each scene keeps the lower-middle area fairly open, because
// that is where the keyed child lands by default.
//
// Repeated details (stars, fish, leaves, trees) come from small generator helpers, so the
// strings stay small (well under 8KB each) and are still plain static SVG once built.
// Gradient/pattern ids are prefixed per scene so two scenes inlined in one document
// cannot collide.

export interface BackgroundDef {
  id: string
  name: string // spoken + aria label
  svg: string // 1920x1080 viewBox, with width/height set so Safari rasterizes crisply
  thumbColor: string // dominant colour, used for tile placeholders
  /**
   * Optional "TV front layer" (ease-of-use C5): a 1920x1080 SVG, transparent except for a
   * desk / fence / bushes that the stage draws OVER the child (under stickers). It hides
   * the bottom of the cutout, which is where the AI cutout is weakest.
   */
  front?: string
  /** Optional home spot for the child in this world (default: centred, full height). */
  home?: { x: number; y: number; scale: number }
}

// ---------------------------------------------------------------- helpers
const FONT = `font-family="'Arial Rounded MT Bold','Arial Black',Arial,Helvetica,sans-serif" font-weight="900"`
const r = (n: number): number => Math.round(n)

const scene = (defs: string, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" width="1920" height="1080"><defs>${defs}</defs><g stroke-linejoin="round" stroke-linecap="round" stroke-width="8">${body}</g></svg>`

const vgrad = (id: string, ...stops: [number, string][]): string =>
  `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">${stops.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('')}</linearGradient>`

const fill = (id: string): string => `<rect width="1920" height="1080" fill="url(#${id})" stroke="none"/>`

/** translate/rotate/scale transform attribute; negative s.x flips horizontally. */
const at = (x: number, y: number, s = 1, rot = 0, flip = false): string =>
  `transform="translate(${r(x)} ${r(y)})${rot ? ` rotate(${rot})` : ''}${s !== 1 || flip ? ` scale(${flip ? -s : s} ${s})` : ''}"`

/** Deterministic PRNG so scenes are identical on every load. */
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

/** Field of small dot stars inside y < maxY. */
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

/** A thick line drawn twice (dark wide, light narrow) so it gets a same-hue outline. */
const line2 = (d: string, dark: string, light: string, w: number): string =>
  `<path d="${d}" fill="none" stroke="${dark}" stroke-width="${w}"/><path d="${d}" fill="none" stroke="${light}" stroke-width="${r(w * 0.6)}"/>`

const sunFace = (x: number, y: number, rad: number): string =>
  `<g ${at(x, y)}><circle r="${rad + 26}" fill="#fde047" opacity=".35" stroke="none"/><circle r="${rad}" fill="#fde047" stroke="#f59e0b"/><g fill="#7c2d12" stroke="none"><circle cx="${r(-rad * 0.32)}" cy="${r(-rad * 0.1)}" r="${r(rad * 0.09)}"/><circle cx="${r(rad * 0.32)}" cy="${r(-rad * 0.1)}" r="${r(rad * 0.09)}"/></g><path d="M${r(-rad * 0.35)} ${r(rad * 0.2)}Q0 ${r(rad * 0.55)} ${r(rad * 0.35)} ${r(rad * 0.2)}" fill="none" stroke="#7c2d12" stroke-width="7"/></g>`

// ---------------------------------------------------------------- 1. Outer Space
const ROCKET =
  '<path d="M-35 62Q0 175 35 62Z" fill="#fbbf24" stroke="#f97316"/><path d="M-16 64Q0 120 16 64Z" fill="#fef08a" stroke="none"/>' +
  '<path d="M-55 0L-105 85L-48 64ZM55 0L105 85L48 64Z" fill="#ef4444" stroke="#b91c1c"/>' +
  '<path d="M0-150C52-110 62-40 56 66H-56C-62-40-52-110 0-150Z" fill="#f8fafc" stroke="#64748b"/>' +
  '<path d="M0-150C25-130 38-112 44-92H-44C-38-112-25-130 0-150Z" fill="#ef4444" stroke="#b91c1c"/>' +
  '<circle cy="-28" r="27" fill="#7dd3fc" stroke="#64748b"/><path d="M-12-38q6-8 16-8" fill="none" stroke="#fff" stroke-width="7"/>'

const space = scene(
  vgrad('sp-g', [0, '#1e1b4b'], [0.55, '#3b2a8f'], [1, '#7c3aed']),
  fill('sp-g') +
    `<ellipse cx="1300" cy="760" rx="560" ry="200" fill="#a78bfa" opacity=".22" stroke="none"/><ellipse cx="560" cy="330" rx="420" ry="150" fill="#f472b6" opacity=".14" stroke="none"/>` +
    dots(80, 7, 1080) +
    `<g fill="#fde68a" stroke="none">${[
      [760, 420, 22],
      [1180, 300, 28],
      [180, 560, 18],
      [1840, 620, 20],
      [980, 90, 16],
      [620, 820, 18],
      [1380, 980, 16],
    ]
      .map(([x, y, s]) => `<path d="${twinkle(x, y, s)}"/>`)
      .join('')}</g>` +
    // comet
    `<path d="M842 152L560 236L590 196L570 176Z" fill="#fde68a" opacity=".55" stroke="none"/><circle cx="846" cy="150" r="22" fill="#fef9c3" stroke="#facc15"/>` +
    // ringed planet: back ring, planet, front half of ring
    `<g transform="translate(330 290) rotate(-18)"><ellipse rx="240" ry="56" fill="none" stroke="#b45309" stroke-width="34"/><ellipse rx="240" ry="56" fill="none" stroke="#fde047" stroke-width="18"/><circle r="135" fill="#fb923c" stroke="#c2410c" stroke-width="10"/><path d="M-126-44Q0-14 126-44M-118 54Q0 84 118 54" fill="none" stroke="#fdba74" stroke-width="22"/><path d="M-70-92q30-20 70-22" fill="none" stroke="#fff" stroke-opacity=".6" stroke-width="12"/><path d="M-240 0A240 56 0 0 0 240 0" fill="none" stroke="#b45309" stroke-width="34"/><path d="M-240 0A240 56 0 0 0 240 0" fill="none" stroke="#fde047" stroke-width="18"/></g>` +
    `<circle cx="1490" cy="170" r="56" fill="#f472b6" stroke="#be185d"/><circle cx="1472" cy="156" r="12" fill="#ec4899" stroke="none"/><circle cx="1510" cy="190" r="8" fill="#ec4899" stroke="none"/>` +
    `<circle cx="1730" cy="900" r="125" fill="#2dd4bf" stroke="#0f766e" stroke-width="10"/><g fill="#5eead4" stroke="#0f766e" stroke-width="6"><circle cx="1690" cy="860" r="26"/><circle cx="1770" cy="940" r="18"/><circle cx="1680" cy="960" r="12"/></g>` +
    // UFO
    `<g ${at(220, 700)}><ellipse cy="-24" rx="58" ry="50" fill="#a5f3fc" stroke="#0891b2"/><ellipse rx="120" ry="34" fill="#c4b5fd" stroke="#6d28d9"/><g fill="#fde047" stroke="#ca8a04" stroke-width="5"><circle cx="-70" cy="4" r="10"/><circle cy="12" r="10"/><circle cx="70" cy="4" r="10"/></g></g>` +
    `<g ${at(1570, 470, 1, 32)}>${ROCKET}</g>`,
)

// ---------------------------------------------------------------- 2. Under the Sea
const fish = (x: number, y: number, s: number, f: string, st: string, flip = false): string =>
  `<g ${at(x, y, s, 0, flip)} stroke="${st}" stroke-width="${r(8 / s)}"><path d="M-62 0L-115-42Q-100 0-115 42Z" fill="${f}"/><path d="M-12-36Q10-72 38-40" fill="${f}"/><path d="M-70 0C-45-48 45-52 80 0C45 52-45 48-70 0Z" fill="${f}"/><path d="M8-38Q-6 0 8 38" fill="none" stroke-opacity=".5"/><circle cx="42" cy="-10" r="11" fill="#1e293b" stroke="none"/><circle cx="45" cy="-14" r="4" fill="#fff" stroke="none"/><path d="M46 16Q58 22 66 12" fill="none" stroke="#1e293b" stroke-width="${r(6 / s)}"/></g>`
const weed = (x: number, h: number, dark: string, light: string): string =>
  line2(`M${x} 1010q-34-${r(h / 6)} 0-${r(h / 3)}t0-${r(h / 3)}t0-${r(h / 3)}`, dark, light, 34)

const sea = scene(
  vgrad('se-g', [0, '#7dd3fc'], [0.45, '#0ea5e9'], [1, '#0369a1']),
  fill('se-g') +
    `<g fill="#fff" opacity=".12" stroke="none"><path d="M300 0h170L720 1080H530Z"/><path d="M900 0h120l170 1080h-150Z"/><path d="M1500 0h150l-40 1080h-170Z"/></g>` +
    `<path d="M0 880Q120 760 260 830Q370 740 500 860V1080H0ZM1400 870Q1540 760 1660 840Q1780 760 1920 840V1080H1400Z" fill="#0284c7" opacity=".55" stroke="none"/>` +
    weed(110, 520, '#15803d', '#4ade80') +
    weed(200, 380, '#166534', '#22c55e') +
    weed(1830, 360, '#15803d', '#4ade80') +
    `<path d="M0 940C300 900 600 960 960 930S1600 890 1920 940V1080H0Z" fill="#fde68a" stroke="#eab308"/>` +
    line2('M1620 990V880M1620 925L1575 860V820M1620 900L1672 845V800M1672 845L1710 830', '#be185d', '#f472b6', 34) +
    `<polygon points="${starPts(430, 1000, 52, 24)}" ${at(0, 0)} fill="#fb923c" stroke="#c2410c"/><polygon points="${starPts(1360, 1015, 34, 16)}" fill="#f9a8d4" stroke="#db2777"/>` +
    `<path d="M560 1030a40 40 0 0 1 80 0Z" fill="#fef3c7" stroke="#d97706"/><path d="M600 992V1030M582 998L590 1030M618 998L610 1030" stroke="#d97706" stroke-width="5"/>` +
    // jellyfish
    `<g ${at(1180, 150)}>${line2('M-30 20q-12 30 0 60t0 60M0 24q-12 30 0 60t0 60M30 20q-12 30 0 60t0 60', '#c026d3', '#f0abfc', 14)}<path d="M-60 26Q-60-50 0-50Q60-50 60 26Q30 14 0 26Q-30 14-60 26Z" fill="#f0abfc" stroke="#c026d3"/><g fill="#701a75" stroke="none"><circle cx="-18" cy="-6" r="6"/><circle cx="18" cy="-6" r="6"/></g></g>` +
    fish(390, 260, 1, '#fbbf24', '#d97706') +
    fish(1530, 230, 0.8, '#f472b6', '#be185d', true) +
    fish(1640, 580, 1.1, '#fb923c', '#c2410c', true) +
    fish(300, 640, 0.75, '#a78bfa', '#7c3aed') +
    fish(760, 150, 0.55, '#4ade80', '#15803d', true) +
    `<g fill="#fff" fill-opacity=".25" stroke="#e0f2fe" stroke-width="5">${[
      [520, 210, 16], [560, 150, 10], [540, 90, 22], [1440, 520, 14], [1470, 450, 20], [1450, 380, 10],
      [250, 420, 18], [280, 340, 11], [1760, 300, 16], [1720, 220, 24], [960, 360, 12], [1000, 280, 18],
    ]
      .map(([x, y, rr]) => `<circle cx="${x}" cy="${y}" r="${rr}"/>`)
      .join('')}</g>`,
)

// ---------------------------------------------------------------- 3. Jungle
const LEAF = 'M0 0C60-55 170-55 240 0C170 55 60 55 0 0Z'
const leaf = (x: number, y: number, rot: number, s: number, f: string, st: string): string =>
  `<g ${at(x, y, s, rot)} stroke="${st}" stroke-width="${r(8 / s)}"><path d="${LEAF}" fill="${f}"/><path d="M14 0H220" fill="none"/></g>`
const flower = (x: number, y: number, s: number): string =>
  `<g ${at(x, y, s)}><g fill="#f472b6" stroke="#be185d" stroke-width="7">${[0, 72, 144, 216, 288]
    .map((a) => `<circle cx="${r(24 * Math.cos((a * Math.PI) / 180))}" cy="${r(24 * Math.sin((a * Math.PI) / 180))}" r="22"/>`)
    .join('')}</g><circle r="14" fill="#fde047" stroke="#ca8a04" stroke-width="6"/></g>`
const G1: [string, string] = ['#22c55e', '#15803d']
const G2: [string, string] = ['#4ade80', '#16a34a']
const G3: [string, string] = ['#16a34a', '#14532d']
const leaves = (list: [number, number, number, number, [string, string]][]): string =>
  list.map(([x, y, rot, s, c]) => leaf(x, y, rot, s, c[0], c[1])).join('')

const jungle = scene(
  vgrad('ju-g', [0, '#fef9c3'], [0.5, '#d9f99d'], [1, '#86efac']),
  fill('ju-g') +
    `<circle cx="1460" cy="170" r="95" fill="#fde047" opacity=".7" stroke="none"/>` +
    `<path d="M0 700Q90 560 210 650Q300 540 430 640Q520 570 610 660Q700 600 760 680L1160 680Q1230 590 1330 660Q1420 560 1530 650Q1640 560 1740 640Q1830 580 1920 640V1080H0Z" fill="#4ade80" stroke="#16a34a"/>` +
    `<path d="M0 820Q120 720 260 800Q380 720 520 810L1400 810Q1520 720 1650 800Q1790 710 1920 790V1080H0Z" fill="#22c55e" stroke="#15803d"/>` +
    `<path d="M0 940Q480 900 960 930T1920 920V1080H0Z" fill="#65a30d" stroke="#3f6212"/>` +
    `<path d="M70 960V-10H190V960Z" fill="#a16207" stroke="#713f12"/><path d="M1740 960V-10H1860V960Z" fill="#a16207" stroke="#713f12"/>` +
    line2('M560-10Q610 160 540 300T560 520', '#15803d', '#4ade80', 18) +
    line2('M1300-10Q1350 120 1290 250T1320 420', '#15803d', '#4ade80', 18) +
    leaves([
      [548, 220, 150, 0.35, G2], [560, 330, 20, 0.35, G1], [548, 450, 160, 0.35, G2],
      [1320, 140, 20, 0.35, G1], [1296, 260, 160, 0.35, G2],
      [-20, -20, 40, 1.2, G1], [-40, 120, 15, 1.1, G2], [200, -30, 55, 0.9, G2],
      [1940, -20, 140, 1.2, G1], [1960, 120, 165, 1.1, G2], [1720, -30, 125, 0.9, G2],
      [-30, 1080, -40, 1.2, G3], [-20, 960, -15, 1, G1],
      [1950, 1080, -140, 1.2, G3], [1940, 960, -165, 1, G1],
    ]) +
    leaves([
      [470, 960, -120, 0.75, G1], [470, 960, -90, 0.85, G2], [470, 960, -60, 0.75, G3],
      [1450, 960, -120, 0.75, G3], [1450, 960, -90, 0.85, G2], [1450, 960, -60, 0.75, G1],
    ]) +
    flower(250, 160, 1) + flower(1690, 230, 0.9) + flower(300, 930, 0.8) + flower(1610, 960, 0.9) +
    // parrot perched on the right vine
    line2('M1750 560Q1520 510 1250 545', '#713f12', '#a16207', 30) +
    leaf(1250, 545, 200, 0.4, G2[0], G2[1]) +
    `<g ${at(1340, 450)}><path d="M-8 70L-26 200L12 84Z" fill="#3b82f6" stroke="#1d4ed8"/><path d="M8 70L30 190L22 70Z" fill="#fde047" stroke="#ca8a04"/><path d="M-14 80V100M10 80V100" stroke="#334155" stroke-width="10"/><path d="M0-70Q42-70 46-20Q50 40 20 82L-12 82Q-46 30-36-20Q-30-70 0-70Z" fill="#ef4444" stroke="#b91c1c"/><path d="M-30-6Q-62 50-14 104Q22 50 8-6Z" fill="#3b82f6" stroke="#1d4ed8"/><path d="M-26 12Q-40 40-18 72" fill="none" stroke="#fde047" stroke-width="12"/><path d="M28-48Q66-48 58-10Q48-22 30-24Z" fill="#fde047" stroke="#ca8a04"/><circle cx="10" cy="-36" r="14" fill="#fff" stroke="#b91c1c" stroke-width="5"/><circle cx="14" cy="-36" r="6" fill="#1e293b" stroke="none"/></g>`,
)

// ---------------------------------------------------------------- 4. Dinosaur Land
const FROND = 'M0 0Q80-70 210 0Q90-16 0 0Z'
const palm = (x: number, y: number, s: number, flip = false): string =>
  `<g ${at(x, y, s, 0, flip)}>${line2('M0 0Q-30-170 40-330', '#78350f', '#b45309', 44)}<g ${at(40, -330)} fill="#22c55e" stroke="#15803d">${[-170, -130, -80, -35, 10]
    .map((a) => `<path d="${FROND}" transform="rotate(${a})"/>`)
    .join('')}</g><g fill="#92400e" stroke="#78350f" stroke-width="6"><circle cx="28" cy="-312" r="16"/><circle cx="56" cy="-316" r="16"/></g></g>`

const dino = scene(
  vgrad('di-g', [0, '#7dd3fc'], [0.6, '#fde68a'], [1, '#fdba74']),
  fill('di-g') +
    `<circle cx="1700" cy="150" r="80" fill="#fde047" stroke="#f59e0b"/>` +
    cloud(1250, 170, 0.8) + cloud(260, 120, 0.6) +
    `<path d="M900 760L1060 560L1180 680L1330 520L1500 740Z" fill="#c4b5fd" stroke="#8b5cf6"/>` +
    // volcano with lava and smoke
    cloud(600, 250, 0.7, '#e5e7eb', '#9ca3af') + cloud(690, 130, 0.5, '#e5e7eb', '#9ca3af') +
    `<path d="M200 820L480 380Q570 352 660 380L920 820Z" fill="#a16207" stroke="#713f12"/><path d="M480 380Q570 352 660 380L630 440Q612 474 600 430Q580 510 560 430Q540 474 522 442Z" fill="#f97316" stroke="#c2410c"/><path d="M360 640Q560 600 760 640" fill="none" stroke="#713f12" stroke-width="8" opacity=".5"/>` +
    `<g fill="#f97316" stroke="#c2410c" stroke-width="6"><circle cx="500" cy="300" r="14"/><circle cx="660" cy="290" r="11"/><circle cx="580" cy="250" r="9"/></g>` +
    // pterodactyl
    `<g ${at(1080, 260)}><path d="M-110 0Q-50-50 0 0Q50-50 110 0Q50-14 0 18Q-50-14-110 0Z" fill="#c084fc" stroke="#7e22ce"/><path d="M-8 4L-48 18L-8 20Z" fill="#fde047" stroke="#ca8a04" stroke-width="5"/></g>` +
    `<path d="M0 800Q300 740 640 790T1300 780T1920 790V1080H0Z" fill="#a3e635" stroke="#4d7c0f"/>` +
    `<path d="M0 930Q480 890 960 920T1920 910V1080H0Z" fill="#84cc16" stroke="#4d7c0f"/>` +
    // long-neck dino facing the centre: thick outline pass, then a fill-only pass hides inner seams
    `<g ${at(1470, 900)}><g fill="#16a34a" stroke="#15803d"><rect x="-140" y="-70" width="56" height="86" rx="24"/><rect x="-60" y="-70" width="56" height="80" rx="24"/><rect x="70" y="-70" width="56" height="86" rx="24"/><rect x="140" y="-70" width="56" height="80" rx="24"/></g>` +
    `<g fill="#4ade80" stroke="#15803d" stroke-width="18"><path id="di-b" d="M-170-40Q-180-170-40-190Q80-200 160-140Q290-80 380-30Q220-40 170-20Q20 10-170-40Z"/><path id="di-n" d="M-150-150Q-160-300-220-420Q-240-470-292-472Q-350-472-350-430Q-350-398-298-398Q-266-394-256-340Q-226-220-40-180Z"/></g>` +
    `<g fill="#4ade80" stroke="none"><use href="#di-b"/><use href="#di-n"/></g><g fill="#22c55e" stroke="none"><circle cx="-40" cy="-130" r="22"/><circle cx="40" cy="-150" r="16"/><circle cx="70" cy="-100" r="20"/><circle cx="-100" cy="-90" r="14"/></g><circle cx="-300" cy="-440" r="10" fill="#1e293b" stroke="none"/><path d="M-340-414Q-320-404-300-410" fill="none" stroke="#15803d" stroke-width="6"/><circle cx="-268" cy="-416" r="10" fill="#f9a8d4" stroke="none"/></g>` +
    // egg nest
    `<g ${at(420, 980)}><path d="M-40-30Q-40-110 0-110Q40-110 40-30Z" fill="#fef3c7" stroke="#d97706"/><g fill="#fdba74" stroke="none"><circle cx="-14" cy="-70" r="8"/><circle cx="16" cy="-50" r="6"/></g><path d="M-38-40L-20-56L-6-40L10-58L26-42L40-52" fill="none" stroke="#d97706" stroke-width="6"/><ellipse cx="0" cy="-20" rx="90" ry="30" fill="#a16207" stroke="#713f12"/></g>` +
    palm(150, 980, 1) + palm(1820, 1000, 0.85, true),
)

// ---------------------------------------------------------------- 5. Big City
const WIN = 56
const building = (x: number, w: number, h: number, f: string, st: string): string => {
  const top = 960 - h
  // Window overlay aligned to the user-space pattern grid so windows never get sliced.
  const wx = Math.ceil((x + 16) / WIN) * WIN
  const ww = Math.floor((x + w - 16 - wx) / WIN) * WIN
  const wy = Math.ceil((top + 24) / 72) * 72
  const wh = Math.floor((900 - wy) / 72) * 72
  return `<rect x="${x}" y="${top}" width="${w}" height="${h + 20}" rx="14" fill="${f}" stroke="${st}"/>${ww > 0 && wh > 0 ? `<rect x="${wx}" y="${wy}" width="${ww}" height="${wh}" fill="url(#ci-w)" stroke="none"/>` : ''}`
}
const tree = (x: number, y: number, s: number): string =>
  `<g ${at(x, y, s)}><rect x="-12" y="-80" width="24" height="80" fill="#a16207" stroke="#713f12" stroke-width="6"/><circle cy="-120" r="62" fill="#4ade80" stroke="#15803d"/></g>`

const city = scene(
  vgrad('ci-g', [0, '#7dd3fc'], [1, '#e0f2fe']) +
    `<pattern id="ci-w" width="${WIN}" height="72" patternUnits="userSpaceOnUse"><rect x="14" y="16" width="28" height="38" rx="7" fill="#fef9c3" stroke="#fff" stroke-width="3"/></pattern>`,
  fill('ci-g') +
    sunFace(230, 170, 80) + cloud(760, 150, 0.7) + cloud(1180, 250, 0.55) +
    // hot air balloon
    `<g ${at(1520, 200)}><path d="M-22 80H22V112H-22Z" fill="#b45309" stroke="#78350f" stroke-width="6"/><path d="M-30 60L-22 82M30 60L22 82" stroke="#78350f" stroke-width="5"/><path d="M0-90C60-90 80-40 70 0C60 40 30 60 0 64C-30 60-60 40-70 0C-80-40-60-90 0-90Z" fill="#f472b6" stroke="#be185d"/><path d="M0-90C-26-60-26 30 0 64C26 30 26-60 0-90Z" fill="#fde047" stroke="#be185d" stroke-width="6"/></g>` +
    `<g fill="#c7d2fe" stroke="#a5b4fc">${[
      [60, 560], [300, 640], [470, 520], [700, 620], [880, 580], [1060, 650], [1260, 560], [1480, 600], [1680, 540],
    ]
      .map(([x, top]) => `<rect x="${x}" y="${top}" width="170" height="${960 - top}" rx="10"/>`)
      .join('')}</g>` +
    building(-20, 230, 600, '#fb923c', '#c2410c') +
    building(196, 200, 420, '#60a5fa', '#1d4ed8') +
    building(390, 180, 520, '#f472b6', '#be185d') +
    building(560, 170, 330, '#a78bfa', '#6d28d9') +
    building(730, 230, 250, '#fde047', '#ca8a04') +
    building(960, 230, 220, '#34d399', '#047857') +
    building(1190, 180, 350, '#60a5fa', '#1d4ed8') +
    building(1360, 200, 560, '#fbbf24', '#b45309') +
    building(1550, 180, 440, '#f87171', '#b91c1c') +
    building(1720, 220, 640, '#a78bfa', '#6d28d9') +
    `<path d="M1830 320V250" stroke="#6d28d9" stroke-width="10"/><circle cx="1830" cy="240" r="14" fill="#f87171" stroke="#b91c1c" stroke-width="6"/><path d="M1400 400V350H1470V400M1410 350Q1435 320 1460 350" fill="#e2e8f0" stroke="#64748b" stroke-width="7"/>` +
    `<rect x="-10" y="940" width="1940" height="44" fill="#e2e8f0" stroke="#94a3b8"/><rect x="-10" y="984" width="1940" height="110" fill="#64748b" stroke="#475569"/><path d="M0 1036H1920" stroke="#fff" stroke-width="10" stroke-dasharray="60 50" stroke-linecap="butt"/>` +
    tree(150, 950, 0.9) + tree(640, 950, 0.8) + tree(1300, 950, 0.8) + tree(1820, 950, 0.9),
)

// ---------------------------------------------------------------- 6. Weather Map
const LAND =
  'M330 310Q440 260 560 268L900 276Q1040 250 1180 256Q1270 280 1330 300Q1380 262 1430 270L1520 300Q1570 250 1620 262Q1670 300 1640 350Q1580 400 1580 470Q1590 530 1520 600Q1450 660 1440 740Q1460 800 1430 830Q1390 840 1360 760Q1330 700 1250 700Q1150 690 1080 760Q1020 820 960 810Q910 790 880 720Q820 680 720 682L560 650Q440 620 380 540Q330 470 310 400Q300 340 330 310Z'
const badge = (x: number, y: number, t: string): string =>
  `<rect x="${x - 72}" y="${y}" width="144" height="70" rx="35" fill="#fff" stroke="#1d4ed8"/><text x="${x}" y="${y + 51}" text-anchor="middle" ${FONT} font-size="44" textLength="${t.length > 3 ? 104 : 84}" lengthAdjust="spacingAndGlyphs" fill="#1b4f9c" stroke="none">${t}</text>`
const wSun = (x: number, y: number, s = 1): string =>
  `<g ${at(x, y, s)}><g stroke="#f59e0b" stroke-width="14">${[0, 45, 90, 135, 180, 225, 270, 315]
    .map((a) => `<path d="M0-70V-92" transform="rotate(${a})"/>`)
    .join('')}</g><circle r="54" fill="#fde047" stroke="#f59e0b"/></g>`
const W_CLOUD = 'M-70 40Q-110 40-108 8Q-104-20-74-22Q-66-66-20-70Q22-72 36-36Q70-50 92-24Q112 0 100 24Q96 40 76 40Z'
const wCloud = (x: number, y: number, f = '#fff', st = '#64748b'): string =>
  `<path d="${W_CLOUD}" ${at(x, y)} fill="${f}" stroke="${st}"/>`

const weather = scene(
  vgrad('we-g', [0, '#38bdf8'], [1, '#1d4ed8']) +
    `<pattern id="we-p" width="120" height="120" patternUnits="userSpaceOnUse"><path d="M120 0H0V120" fill="none" stroke="#fff" stroke-opacity=".14" stroke-width="3"/></pattern><clipPath id="we-c"><path d="${LAND}"/></clipPath>`,
  fill('we-g') +
    `<rect width="1920" height="1080" fill="url(#we-p)" stroke="none"/>` +
    `<path d="${LAND}" fill="#86efac" stroke="#15803d" stroke-width="14"/>` +
    `<g clip-path="url(#we-c)" fill="none" stroke="#15803d" stroke-opacity=".3" stroke-width="5" stroke-dasharray="2 18"><path d="M640 200V720M960 200V820M1260 200V720M300 470H1700"/></g>` +
    `<g fill="#7dd3fc" stroke="#0284c7" stroke-width="6"><path d="M1160 300q30-20 50 6q-10 30-40 24q-24-10-10-30z"/><path d="M1240 320q30-14 46 10q-14 22-40 16z"/></g>` +
    `<g fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="7"><path d="M120 820q30-20 60 0t60 0M1620 760q30-20 60 0t60 0M600 900q30-20 60 0t60 0M1500 960q30-20 60 0t60 0"/></g>` +
    wSun(520, 400) + badge(520, 490, '75°') +
    wCloud(900, 390) + badge(900, 450, '68°') +
    `<g fill="#38bdf8" stroke="#0369a1" stroke-width="5">${[1230, 1270, 1310].map((x) => `<path d="M${x} 450q-12 20 0 28q12-8 0-28z"/>`).join('')}</g>` +
    wCloud(1270, 410, '#cbd5e1', '#475569') + badge(1270, 500, '60°') +
    wSun(1470, 590, 0.75) + wCloud(1500, 620) + badge(1500, 680, '72°') +
    `<g ${at(1720, 230)}>${line2('M0-40V40M-35-20L35 20M-35 20L35-20', '#0284c7', '#e0f2fe', 18)}</g>` + badge(1720, 290, '30°') +
    // TV-style header pills
    `<rect x="48" y="44" width="470" height="104" rx="52" fill="#f97316" stroke="#c2410c"/>${wSun(118, 96, 0.42)}<text x="186" y="120" ${FONT} font-size="62" textLength="300" lengthAdjust="spacingAndGlyphs" fill="#fff" stroke="none">WEATHER</text>` +
    `<rect x="1580" y="48" width="290" height="88" rx="44" fill="#fff" stroke="#1d4ed8"/><text x="1725" y="110" text-anchor="middle" ${FONT} font-size="52" textLength="200" lengthAdjust="spacingAndGlyphs" fill="#1b4f9c" stroke="none">TODAY</text>`,
)

// ---------------------------------------------------------------- 7. Castle
const tower = (x: number, top: number, w: number, roof: number): string =>
  `<rect x="${x - w / 2}" y="${top}" width="${w}" height="${860 - top}" fill="#e9d5ff" stroke="#7e22ce"/>` +
  `<path d="M${x} ${top - roof}V${top - roof - 70}" stroke="#7e22ce" stroke-width="7"/><path d="M${x + 4} ${top - roof - 70}L${x + 70} ${top - roof - 48}L${x + 4} ${top - roof - 26}Z" fill="#fde047" stroke="#ca8a04" stroke-width="6"/>` +
  `<path d="M${x - w / 2 - 22} ${top + 4}L${x} ${top - roof}L${x + w / 2 + 22} ${top + 4}Z" fill="#f472b6" stroke="#be185d"/>`
const archWin = (x: number, y: number): string =>
  `<path d="M${x - 22} ${y + 60}V${y + 20}A22 22 0 0 1 ${x + 22} ${y + 20}V${y + 60}Z" fill="#7e22ce" stroke="#581c87" stroke-width="6"/>`
const merlons = (x0: number, x1: number, y: number): string => {
  let d = `M${x0} ${y}`
  for (let x = x0; x < x1; x += 60) d += `V${y - 40}H${x + 30}V${y}H${x + 60}`
  return `<path d="${d}V${y + 30}H${x0}Z" fill="#e9d5ff" stroke="#7e22ce"/>`
}

const castle = scene(
  vgrad('ca-g', [0, '#c4b5fd'], [0.55, '#fbcfe8'], [1, '#fef3c7']),
  fill('ca-g') +
    cloud(260, 180, 0.8, '#fff', '#c4b5fd') + cloud(1640, 140, 0.9, '#fff', '#c4b5fd') + cloud(1300, 320, 0.45, '#fff', '#c4b5fd') +
    `<g fill="#fff" stroke="none">${[[480, 120, 20], [1440, 460, 16], [200, 460, 18], [1760, 420, 22]].map(([x, y, s]) => `<path d="${twinkle(x, y, s)}"/>`).join('')}</g>` +
    `<path d="M0 760Q400 620 900 720T1920 680V1080H0Z" fill="#a7f3d0" stroke="#34d399"/>` +
    tower(600, 340, 150, 200) + tower(1320, 340, 150, 200) +
    merlons(660, 1260, 470) + `<rect x="660" y="470" width="600" height="390" fill="#e9d5ff" stroke="#7e22ce"/>` +
    tower(960, 220, 190, 230) +
    `<path d="M${960 - 30} 300C${960 - 60} 270 ${960 - 40} 240 960 262C${960 + 40} 240 ${960 + 60} 270 ${960 + 30} 300L960 330Z" fill="#f472b6" stroke="#be185d" stroke-width="6"/>` +
    archWin(600, 440) + archWin(1320, 440) + archWin(760, 540) + archWin(1160, 540) +
    `<path d="M860 860V720A100 100 0 0 1 1060 720V860Z" fill="#b45309" stroke="#78350f"/><path d="M910 860V700M960 860V622M1010 860V700" stroke="#78350f" stroke-width="7"/>` +
    `<path d="M0 880Q480 820 960 870T1920 850V1080H0Z" fill="#4ade80" stroke="#16a34a"/>` +
    `<path d="M890 864Q850 960 740 1090H1180Q1070 960 1030 864Z" fill="#fde68a" stroke="#d97706"/>` +
    tree(180, 870, 1.1) + tree(1760, 880, 1.2) +
    `<g stroke="none">${[[340, 960, '#f472b6'], [420, 1010, '#fde047'], [560, 940, '#fff'], [1380, 950, '#f472b6'], [1500, 1010, '#fde047'], [1620, 960, '#fff'], [260, 1040, '#fff'], [1680, 1050, '#f472b6']]
      .map(([x, y, c]) => `<circle cx="${x}" cy="${y}" r="13" fill="${c}"/>`)
      .join('')}</g>`,
)

// ---------------------------------------------------------------- 8. Farm
const farm = scene(
  vgrad('fa-g', [0, '#7dd3fc'], [1, '#e0f2fe']),
  fill('fa-g') +
    `<g ${at(1700, 160)}><g stroke="#fbbf24" stroke-width="16">${[0, 45, 90, 135, 180, 225, 270, 315]
      .map((a) => `<path d="M0-108V-140" transform="rotate(${a})"/>`)
      .join('')}</g></g>${sunFace(1700, 160, 84)}` +
    cloud(420, 150, 0.8) + cloud(1050, 230, 0.6) +
    `<path d="M0 720Q500 600 1000 700T1920 660V1080H0Z" fill="#bbf7d0" stroke="#4ade80"/>` +
    `<path d="M0 820Q600 760 1200 800T1920 790V1080H0Z" fill="#86efac" stroke="#16a34a"/>` +
    // fence (outline pass then white pass)
    `<g stroke-linecap="butt">${line2('M600 770H1920M600 830H1920', '#94a3b8', '#fff', 30)}</g>${line2(
      Array.from({ length: 11 }, (_, i) => `M${660 + i * 124} 740V860`).join(''),
      '#94a3b8',
      '#fff',
      34,
    )}` +
    // barn + silo
    `<rect x="500" y="500" width="110" height="370" rx="10" fill="#cbd5e1" stroke="#64748b"/><path d="M500 510Q555 420 610 510Z" fill="#94a3b8" stroke="#64748b"/><path d="M500 600H610M500 700H610M500 800H610" stroke="#64748b" stroke-width="6"/>` +
    `<path d="M120 870V560L300 420L480 560V870Z" fill="#ef4444" stroke="#991b1b"/>${line2('M96 580L300 404L504 580', '#94a3b8', '#fff', 40)}` +
    `<rect x="220" y="690" width="160" height="180" fill="#dc2626" stroke="#fff" stroke-width="14"/><path d="M220 690L380 870M380 690L220 870" stroke="#fff" stroke-width="12"/><rect x="262" y="520" width="76" height="76" rx="8" fill="#fde68a" stroke="#fff" stroke-width="12"/>` +
    `<g ${at(660, 950)}><rect x="-70" y="-60" width="140" height="80" rx="20" fill="#fde047" stroke="#ca8a04"/><path d="M-36-56V16M0-58V18M36-56V16" stroke="#ca8a04" stroke-width="6"/></g>` +
    // chicken
    `<g ${at(420, 960)}><path d="M-40 0Q-50-60 0-60Q50-60 40 0Q20 24-20 24Q-40 20-40 0Z" fill="#fff" stroke="#94a3b8"/><path d="M-8-74Q0-90 8-74Q16-86 20-70L-8-62Z" fill="#ef4444" stroke="#b91c1c" stroke-width="5"/><path d="M-40-40L-62-32L-40-24Z" fill="#fbbf24" stroke="#d97706" stroke-width="5"/><circle cx="-18" cy="-40" r="6" fill="#1e293b" stroke="none"/><path d="M-6 24V40M14 24V40" stroke="#d97706" stroke-width="6"/></g>` +
    // cow facing the centre
    `<g ${at(1560, 900)}><path d="M120-60Q170-90 160-20" fill="none" stroke="#475569" stroke-width="8"/><g fill="#fff" stroke="#475569"><rect x="-130" y="-20" width="40" height="100" rx="16"/><rect x="-60" y="-20" width="40" height="100" rx="16"/><rect x="40" y="-20" width="40" height="100" rx="16"/><rect x="100" y="-20" width="40" height="100" rx="16"/><rect x="-160" y="-170" width="320" height="180" rx="80"/></g><g fill="#1f2937" stroke="none"><path d="M-60-170Q-20-120-70-80Q-120-100-110-150Z"/><path d="M40-60Q90-90 120-40Q100 0 50-10Z"/><circle cx="90" cy="-130" r="24"/></g><ellipse cx="0" cy="12" rx="34" ry="18" fill="#fbcfe8" stroke="#db2777" stroke-width="6"/>` +
    `<g ${at(-190, -170)}><path d="M-50-60L-70-90M50-60L70-90" stroke="#a16207" stroke-width="12"/><path d="M-60-40Q-110-60-100-24Q-80-16-58-24M60-40Q110-60 100-24Q80-16 58-24" fill="#fff" stroke="#475569"/><rect x="-62" y="-80" width="124" height="150" rx="56" fill="#fff" stroke="#475569"/><ellipse cy="36" rx="60" ry="38" fill="#fbcfe8" stroke="#db2777"/><g fill="#9d174d" stroke="none"><ellipse cx="-20" cy="34" rx="8" ry="11"/><ellipse cx="20" cy="34" rx="8" ry="11"/></g><g fill="#1e293b" stroke="none"><circle cx="-24" cy="-30" r="10"/><circle cx="24" cy="-30" r="10"/></g></g></g>`,
)

// ---------------------------------------------------------------- 9. The Moon
const crater = (x: number, y: number, rx: number, ry: number): string =>
  `<ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}" fill="#94a3b8" stroke="#64748b"/><ellipse cx="${x + r(rx * 0.08)}" cy="${y + r(ry * 0.2)}" rx="${r(rx * 0.75)}" ry="${r(ry * 0.6)}" fill="#64748b" opacity=".35" stroke="none"/>`

const moon = scene(
  vgrad('mo-g', [0, '#020617'], [0.6, '#1e1b4b'], [1, '#312e81']) + `<clipPath id="mo-c"><circle cx="1600" cy="250" r="130"/></clipPath>`,
  fill('mo-g') +
    dots(64, 21, 800) +
    `<g fill="#fde68a" stroke="none">${[[400, 160, 22], [900, 300, 18], [1240, 120, 24], [160, 520, 16], [1820, 560, 18]].map(([x, y, s]) => `<path d="${twinkle(x, y, s)}"/>`).join('')}</g>` +
    `<path d="M1140 330L900 420" stroke="#fef9c3" stroke-width="6" opacity=".6"/><circle cx="1146" cy="328" r="10" fill="#fef9c3" stroke="none"/>` +
    // Earth
    `<circle cx="1600" cy="250" r="170" fill="#60a5fa" opacity=".18" stroke="none"/><circle cx="1600" cy="250" r="130" fill="#3b82f6" stroke="none"/><g clip-path="url(#mo-c)"><path d="M1490 170Q1540 140 1580 180Q1600 230 1560 250Q1580 300 1540 330Q1490 320 1480 260Q1450 210 1490 170ZM1640 140Q1700 150 1720 200Q1690 230 1650 210Q1620 180 1640 140ZM1650 290Q1700 270 1740 300Q1720 360 1670 360Q1640 330 1650 290Z" fill="#4ade80" stroke="#15803d" stroke-width="6"/><path d="M1500 120Q1560 100 1610 120M1580 380Q1640 360 1700 380" fill="none" stroke="#fff" stroke-width="12" opacity=".8"/></g><circle cx="1600" cy="250" r="130" fill="none" stroke="#1d4ed8" stroke-width="10"/>` +
    `<path d="M0 780Q200 730 420 770Q700 720 980 760Q1300 710 1600 760Q1780 740 1920 770V1080H0Z" fill="#94a3b8" stroke="#64748b"/>` +
    crater(500, 800, 70, 16) + crater(1400, 785, 60, 14) +
    `<path d="M0 880Q400 840 800 870Q1300 830 1920 870V1080H0Z" fill="#cbd5e1" stroke="#64748b"/>` +
    crater(260, 965, 110, 30) + crater(1190, 1005, 150, 38) + crater(1660, 945, 90, 24) + crater(700, 1035, 80, 20) +
    // flag
    `${line2('M330 900V620', '#64748b', '#e5e7eb', 16)}<path d="M338 630H490Q470 670 490 712H338Z" fill="#f472b6" stroke="#be185d"/><polygon points="${starPts(405, 671, 26, 11)}" fill="#fde047" stroke="#ca8a04" stroke-width="5"/>` +
    // lander
    `<g ${at(1640, 870)}><path d="M-60-40L-100 20M60-40L100 20M0-40V20" stroke="#64748b" stroke-width="10"/><path d="M-120 20H-80M80 20H120" stroke="#64748b" stroke-width="12"/><rect x="-70" y="-110" width="140" height="80" rx="10" fill="#fbbf24" stroke="#b45309"/><path d="M-40-110V-30M0-110V-30M40-110V-30" stroke="#d97706" stroke-width="5"/><path d="M-50-110L-40-180H40L50-110Z" fill="#f8fafc" stroke="#64748b"/><circle cy="-148" r="18" fill="#7dd3fc" stroke="#64748b" stroke-width="6"/></g>`,
)

// ---------------------------------------------------------------- 10. Rainbow Land
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
const heart = (x: number, y: number, s: number): string =>
  `<path d="M0 26C-30 8-30-20-14-24C-6-26 0-20 0-14C0-20 6-26 14-24C30-20 30 8 0 26Z" ${at(x, y, s)} fill="#f472b6" stroke="#be185d" stroke-width="${r(5 / s)}"/>`

const rainbow = scene(
  vgrad('ra-g', [0, '#bae6fd'], [0.5, '#fbcfe8'], [1, '#fef9c3']),
  fill('ra-g') +
    BANDS.map(([light, dark], i) => {
      const rad = 820 - i * 60
      const d = `M${960 - rad} 1000A${rad} ${rad} 0 0 1 ${960 + rad} 1000`
      return `<path d="${d}" fill="none" stroke="${dark}" stroke-width="62" stroke-linecap="butt"/><path d="${d}" fill="none" stroke="${light}" stroke-width="48" stroke-linecap="butt"/>`
    }).join('') +
    sunFace(1720, 170, 80) +
    `<g fill="#fde047" stroke="#ca8a04" stroke-width="5">${[[300, 200], [520, 120], [1420, 120], [1500, 340], [420, 380]].map(([x, y]) => `<polygon points="${starPts(x, y, 26, 11)}"/>`).join('')}</g>` +
    heart(240, 400, 1.6) + heart(1640, 470, 1.4) + heart(960, 90, 1.2) +
    cloud(170, 930, 1.5) + cloud(1750, 930, 1.5) +
    `<path d="M0 1000Q300 880 600 980T1200 970T1920 960V1080H0Z" fill="#f9a8d4" stroke="#db2777"/>` +
    `<path d="M0 1050Q480 1000 960 1040T1920 1030V1090H0Z" fill="#a7f3d0" stroke="#10b981"/>` +
    lolly(520, 990, '#c4b5fd', '#7c3aed') + lolly(1420, 985, '#fdba74', '#ea580c'),
)

// ---------------------------------------------------------------- 11. Snowy Mountains
/** Snow cap polygon for a peak at (px,py) with the given left/right slopes. */
const cap = (px: number, py: number, dl: number, dr: number, h = 90): string =>
  `<path d="M${px - dl * h} ${py + h}L${px} ${py}L${px + dr * h} ${py + h}L${r(px + dr * h * 0.55)} ${py + h - 22}L${r(px + dr * h * 0.2)} ${py + h + 8}L${r(px - dl * h * 0.2)} ${py + h - 20}L${r(px - dl * h * 0.6)} ${py + h + 6}Z" fill="#fff" stroke="#60a5fa"/>`
const pine = (x: number, y: number, s: number): string =>
  `<g ${at(x, y, s)} stroke-width="${r(8 / s)}"><rect x="-16" y="-40" width="32" height="44" fill="#92400e" stroke="#78350f"/><g fill="#16a34a" stroke="#14532d"><path d="M-110-30L0-160L110-30Z"/><path d="M-90-110L0-230L90-110Z"/><path d="M-66-190L0-290L66-190Z"/></g><path d="M-66-190Q-30-176 0-196Q30-176 66-190M-90-110Q-40-94 0-116Q44-94 90-110" fill="none" stroke="#fff" stroke-width="${r(14 / s)}"/></g>`

const snowy = scene(
  vgrad('sn-g', [0, '#93c5fd'], [0.6, '#dbeafe'], [1, '#f8fafc']),
  fill('sn-g') +
    `<circle cx="300" cy="170" r="72" fill="#fef9c3" stroke="#fde047"/>` +
    `<path d="M0 760L260 420L460 600L720 300L980 620L1200 380L1450 640L1680 360L1920 600V1080H0Z" fill="#bfdbfe" stroke="#60a5fa"/>` +
    cap(260, 420, 0.76, 1.1, 70) + cap(720, 300, 0.87, 0.84) + cap(1200, 380, 0.92, 0.96) + cap(1680, 360, 0.82, 1, 80) +
    `<path d="M-100 900L380 380L760 900Z" fill="#93c5fd" stroke="#3b82f6"/><path d="M1150 900L1560 330L2020 900Z" fill="#93c5fd" stroke="#3b82f6"/>` +
    cap(380, 380, 0.92, 0.73, 110) + cap(1560, 330, 0.72, 0.8, 120) +
    `<path d="M0 860Q480 800 960 850T1920 830V1080H0Z" fill="#f8fafc" stroke="#93c5fd"/>` +
    pine(560, 870, 0.55) + pine(1350, 860, 0.55) + pine(120, 930, 1.15) + pine(280, 950, 0.85) + pine(1640, 920, 0.95) + pine(1800, 950, 1.25) +
    `<path d="M0 990Q500 940 1000 980T1920 970V1090H0Z" fill="#fff" stroke="#bfdbfe"/>` +
    // snowman
    `<g ${at(1470, 1000)}><g fill="#fff" stroke="#93c5fd"><circle cy="-70" r="80"/><circle cy="-195" r="60"/><circle cy="-290" r="44"/></g><path d="M-48-240Q0-218 48-240" fill="none" stroke="#ef4444" stroke-width="20"/><path d="M30-236L52-180" stroke="#ef4444" stroke-width="18"/><path d="M-50-326H50M-32-326V-376H32V-326" fill="#1e293b" stroke="#1e293b" stroke-width="12"/><g fill="#1e293b" stroke="none"><circle cx="-14" cy="-300" r="6"/><circle cx="14" cy="-300" r="6"/><circle cy="-200" r="7"/><circle cy="-170" r="7"/><circle cy="-90" r="7"/></g><path d="M0-288L34-280L0-276Z" fill="#fb923c" stroke="#ea580c" stroke-width="4"/><path d="M-58-200L-120-240M58-200L120-250" stroke="#92400e" stroke-width="9"/></g>` +
    dots(46, 33, 1000) +
    `<g ${at(820, 200)}>${line2('M0-26V26M-22-13L22 13M-22 13L22-13', '#60a5fa', '#fff', 10)}</g><g ${at(1110, 120)}>${line2('M0-20V20M-17-10L17 10M-17 10L17-10', '#60a5fa', '#fff', 9)}</g>`,
)

// ---------------------------------------------------------------- 12. News Desk
const news = scene(
  vgrad('ne-g', [0, '#1e3a8a'], [1, '#2563eb']) +
    vgrad('ne-d', [0, '#fb923c'], [1, '#ea580c']) +
    `<clipPath id="ne-c"><circle cx="1540" cy="290" r="130"/></clipPath>`,
  fill('ne-g') +
    `<g fill="#fff" opacity=".07" stroke="none"><path d="M220 0h140L760 1080H460Z"/><path d="M960 0h140L1300 1080H1060Z"/><path d="M1600 0h120l-200 1080h-160Z"/></g>` +
    `<g fill="#60a5fa" opacity=".3" stroke="none"><rect x="80" y="560" width="130" height="320" rx="10"/><rect x="230" y="480" width="110" height="400" rx="10"/><rect x="360" y="610" width="150" height="270" rx="10"/><rect x="1440" y="620" width="140" height="260" rx="10"/><rect x="1600" y="540" width="120" height="340" rx="10"/><rect x="1740" y="640" width="140" height="240" rx="10"/></g>` +
    // studio screen with a globe
    `<rect x="1250" y="110" width="580" height="380" rx="30" fill="#0c4a6e" stroke="#e0f2fe" stroke-width="14"/><circle cx="1540" cy="290" r="130" fill="#38bdf8" stroke="none"/><g clip-path="url(#ne-c)"><path d="M1450 210Q1500 190 1530 230Q1540 280 1500 300Q1510 350 1470 370Q1430 340 1430 290Q1410 240 1450 210ZM1580 190Q1640 200 1660 250Q1630 290 1590 270Q1560 230 1580 190ZM1590 330Q1640 320 1660 350Q1640 400 1600 390Z" fill="#4ade80" stroke="#15803d" stroke-width="6"/><path d="M1410 290H1670M1540 160V420M1540 160Q1460 290 1540 420M1540 160Q1620 290 1540 420" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="5"/></g><circle cx="1540" cy="290" r="130" fill="none" stroke="#0284c7" stroke-width="8"/>` +
    // KIDS NEWS banner + LIVE badge
    `<rect x="60" y="60" width="590" height="134" rx="34" fill="#ef4444" stroke="#b91c1c"/><polygon points="${starPts(140, 127, 44, 19)}" fill="#fde047" stroke="#ca8a04" stroke-width="6"/><text x="196" y="156" ${FONT} font-size="80" textLength="420" lengthAdjust="spacingAndGlyphs" fill="#fff" stroke="none">KIDS NEWS</text>` +
    `<rect x="64" y="220" width="190" height="72" rx="36" fill="#ec4899" stroke="#be185d"/><circle cx="106" cy="256" r="14" fill="#fff" stroke="none"/><text x="132" y="274" ${FONT} font-size="46" textLength="104" lengthAdjust="spacingAndGlyphs" fill="#fff" stroke="none">LIVE</text>` +
    // ticker strip above the desk, plus a desk mic and mug so it reads as a real studio
    `<rect x="0" y="680" width="1920" height="60" fill="#fde047" stroke="none"/><rect x="0" y="680" width="250" height="60" fill="#ef4444" stroke="none"/><text x="125" y="722" text-anchor="middle" ${FONT} font-size="34" fill="#fff" stroke="none">TODAY</text><text x="290" y="722" ${FONT} font-size="34" fill="#1e3a8a" stroke="none">Sunny day at school  ★  Snack time is at 10  ★  Recess is fun!</text>` +
    `<path d="M200 860H1720L1790 905H130Z" fill="#e2e8f0" stroke="#64748b"/>` +
    `<g stroke-width="8"><path d="M1560 860V800" stroke="#334155"/><rect x="1536" y="740" width="48" height="74" rx="24" fill="#475569" stroke="#1e293b"/><path d="M1520 862H1600" stroke="#1e293b"/><path d="M340 795H410V862H340Z" fill="#f472b6" stroke="#be185d"/><path d="M410 812Q440 812 440 830Q440 848 410 848" fill="none" stroke="#be185d"/></g><path d="M150 905H1770L1710 1100H210Z" fill="url(#ne-d)" stroke="#c2410c"/>` +
    `<rect x="700" y="940" width="520" height="104" rx="52" fill="#fff" stroke="#c2410c"/><text x="960" y="1012" text-anchor="middle" ${FONT} font-size="62" textLength="420" lengthAdjust="spacingAndGlyphs" fill="#1d4ed8" stroke="none">KIDS NEWS</text>` +
    `<g fill="#fde047" stroke="#ca8a04" stroke-width="5"><polygon points="${starPts(420, 990, 34, 15)}"/><polygon points="${starPts(1500, 990, 34, 15)}"/></g>`,
)


// ---------------------------------------------------------------- front layers (C5)
// Drawn OVER the child (under stickers), transparent everywhere else. Each one covers the
// bottom of the stage, where the AI cutout is weakest, and makes the scene look like TV.
// Same scene() wrapper so they share the style: thick same-hue outlines, round joins.

/** News Desk: the anchor desk (top, mic, mug, front panel) from the scene, now in front. */
const newsFront = scene(
  vgrad('nf-d', [0, '#fb923c'], [1, '#ea580c']),
  `<path d="M200 860H1720L1790 905H130Z" fill="#e2e8f0" stroke="#64748b"/>` +
    `<g stroke-width="8"><path d="M1560 860V800" stroke="#334155"/><rect x="1536" y="740" width="48" height="74" rx="24" fill="#475569" stroke="#1e293b"/><path d="M1520 862H1600" stroke="#1e293b"/><path d="M340 795H410V862H340Z" fill="#f472b6" stroke="#be185d"/><path d="M410 812Q440 812 440 830Q440 848 410 848" fill="none" stroke="#be185d"/></g>` +
    `<g ${at(560, 860)}><rect x="-80" y="-22" width="160" height="22" rx="4" fill="#fff" stroke="#94a3b8" stroke-width="6"/><rect x="-70" y="-38" width="150" height="18" rx="4" fill="#fef9c3" stroke="#ca8a04" stroke-width="6" transform="rotate(-4)"/></g>` +
    `<path d="M150 905H1770L1710 1100H210Z" fill="url(#nf-d)" stroke="#c2410c"/>` +
    `<path d="M190 935H1730" stroke="#fdba74" stroke-width="10"/>` +
    `<rect x="700" y="950" width="520" height="104" rx="52" fill="#fff" stroke="#c2410c"/><text x="960" y="1022" text-anchor="middle" ${FONT} font-size="62" textLength="420" lengthAdjust="spacingAndGlyphs" fill="#1d4ed8" stroke="none">KIDS NEWS</text>` +
    `<g fill="#fde047" stroke="#ca8a04" stroke-width="5"><polygon points="${starPts(420, 1000, 34, 15)}"/><polygon points="${starPts(1500, 1000, 34, 15)}"/></g>`,
)

/** Weather Map: a small presenter podium in the lower-left sea, under the child's home spot. */
const weatherFront = scene(
  '',
  `<g ${at(614, 1090)}><path d="M-200-200H200L175 0H-175Z" fill="#f97316" stroke="#c2410c"/><path d="M-185-160H185" stroke="#fdba74" stroke-width="10"/><path d="M-235-252H235L215-200H-215Z" fill="#fff" stroke="#1d4ed8"/>` +
    `${wSun(-132, -100, 0.46)}<text x="52" y="-74" text-anchor="middle" ${FONT} font-size="50" textLength="220" lengthAdjust="spacingAndGlyphs" fill="#fff" stroke="none">WEATHER</text></g>`,
)

/** Castle: a stone parapet with merlons and a royal shield. */
const parapetTop = (): string => {
  let d = 'M-20 1100V880'
  for (let x = -20; x < 1940; x += 200) d += `H${x + 40}V810H${x + 160}V880`
  return `${d}H1940V1100Z`
}
const castleFront = scene(
  '',
  `<path d="${parapetTop()}" fill="#ddd6fe" stroke="#6d28d9" stroke-width="10"/>` +
    `<g fill="none" stroke="#a78bfa" stroke-width="6">${Array.from({ length: 10 }, (_, i) => `<path d="M${i * 200 + 50} 845H${i * 200 + 130}"/>`).join('')}` +
    `<path d="M0 960H1920M0 1040H1920"/>${Array.from({ length: 13 }, (_, i) => `<path d="M${i * 160} 880V960M${i * 160 + 80} 960V1040M${i * 160} 1040V1080"/>`).join('')}</g>` +
    `<g ${at(960, 970)}><path d="M-80-90H80V0Q80 70 0 100Q-80 70-80 0Z" fill="#f472b6" stroke="#be185d"/><path d="M-44-34L-44 10H44V-34L22-10L0-46L-22-10Z" fill="#fde047" stroke="#ca8a04" stroke-width="6"/><circle cy="40" r="12" fill="#fff" stroke="#be185d" stroke-width="6"/></g>` +
    `<g fill="#4ade80" stroke="#15803d" stroke-width="6">${[[60, 900], [110, 960], [40, 1020], [1860, 910], [1820, 975], [1880, 1035]].map(([x, y]) => `<path d="M${x} ${y}c-30-30 0-60 26-30c26-30 56 0 26 30c-12 14-40 14-52 0z"/>`).join('')}</g>`,
)

/** Farm: a wooden fence with grass and flowers along the bottom. */
const post = (x: number): string =>
  `<path d="M${x - 30} 1100V846L${x} 812L${x + 30} 846V1100Z" fill="#f59e0b" stroke="#92400e"/><path d="M${x - 8} 870V1060" stroke="#d97706" stroke-width="6"/>`
const farmFront = scene(
  '',
  `<rect x="-20" y="880" width="1960" height="46" rx="10" fill="#fbbf24" stroke="#92400e"/><rect x="-20" y="966" width="1960" height="46" rx="10" fill="#fbbf24" stroke="#92400e"/>` +
    `<path d="M0 903H1920M0 989H1920" stroke="#f59e0b" stroke-width="6" stroke-dasharray="90 60"/>` +
    Array.from({ length: 11 }, (_, i) => post(60 + i * 180)).join('') +
    `<path d="M-20 1100V1040${Array.from({ length: 33 }, (_, i) => `Q${i * 60 + 10} ${1000 + (i % 3) * 8} ${i * 60 + 40} 1040`).join('')}V1100Z" fill="#4ade80" stroke="#16a34a"/>` +
    flower(250, 1048, 0.8) + flower(720, 1056, 0.7) + flower(1270, 1050, 0.8) + flower(1690, 1056, 0.7),
)

/** Under the Sea: a coral reef along the bottom, tall at the sides. */
const fan = (x: number, y: number, s: number, f: string, st: string): string =>
  `<g ${at(x, y, s)}><path d="M-110 0Q-130-150 0-170Q130-150 110 0Z" fill="${f}" stroke="${st}"/><path d="M0 0V-150M0 0L-70-120M0 0L70-120M0 0L-100-50M0 0L100-50" fill="none" stroke="${st}" stroke-width="7"/></g>`
const brain = (x: number, y: number, rr: number): string =>
  `<g ${at(x, y)}><path d="M${-rr} 10C${-rr} ${-rr * 1.3} ${rr} ${-rr * 1.3} ${rr} 10Z" fill="#c084fc" stroke="#7e22ce"/><path d="M${r(-rr * 0.7)} -10q${r(rr * 0.23)}-${r(rr * 0.4)} ${r(rr * 0.47)} 0t${r(rr * 0.47)} 0t${r(rr * 0.47)} 0M${r(-rr * 0.45)} ${r(-rr * 0.5)}q${r(rr * 0.22)}-${r(rr * 0.3)} ${r(rr * 0.45)} 0t${r(rr * 0.45)} 0" fill="none" stroke="#7e22ce" stroke-width="7"/></g>`
const seaFront = scene(
  '',
  weed(60, 420, '#15803d', '#4ade80') + weed(1880, 380, '#166534', '#22c55e') + weed(300, 260, '#166534', '#22c55e') + weed(1640, 240, '#15803d', '#4ade80') +
    line2('M170 1000V820M170 900L110 830V770M170 870L230 800V740M230 800L280 780', '#be185d', '#f472b6', 40) +
    line2('M1760 1000V840M1760 910L1700 850V790M1760 890L1820 830V770', '#c2410c', '#fb923c', 40) +
    fan(460, 1000, 0.9, '#fb923c', '#c2410c') + fan(1480, 1000, 1, '#f472b6', '#be185d') + fan(1990, 1000, 1.2, '#facc15', '#ca8a04') +
    line2('M640 990V900M640 940L600 890M640 925L684 880', '#7e22ce', '#c084fc', 30) + line2('M1290 990V910M1290 950L1250 905M1290 935L1330 895', '#be185d', '#f472b6', 30) +
    `<path d="M-20 1100V975C300 935 640 995 960 975S1600 935 1940 975V1100Z" fill="#fde68a" stroke="#eab308"/>` +
    brain(760, 1010, 80) + brain(1180, 1015, 66) +
    `<polygon points="${starPts(960, 1040, 40, 18)}" fill="#fb923c" stroke="#c2410c"/>` +
    `<g fill="#e2e8f0" stroke="#64748b">${[[560, 1050, 30], [1360, 1050, 24], [40, 1050, 34]].map(([x, y, rr]) => `<ellipse cx="${x}" cy="${y}" rx="${rr}" ry="${r(rr * 0.7)}"/>`).join('')}</g>`,
)

/** Jungle: a row of leafy bushes with flowers, taller at the sides. */
const bush = (x: number, y: number, s: number, c: [string, string]): string =>
  `<g ${at(x, y, s)} stroke="${c[1]}" stroke-width="${r(10 / s)}"><path d="M-185 260V-30a95 95 0 0 1 85-95a110 110 0 0 1 200 0a95 95 0 0 1 85 95V260Z" fill="${c[0]}"/><path d="M-120-50q20-30 50-34M40-150q30-14 60-4" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="${r(12 / s)}"/></g>`
const jungleFront = scene(
  '',
  leaves([
    [-40, 760, -40, 1.3, G3],
    [1960, 780, 220, 1.3, G3],
    [10, 860, -20, 1.1, G1],
    [1910, 870, 200, 1.1, G1],
  ]) +
    bush(120, 960, 1.15, G3) + bush(1800, 960, 1.15, G3) + bush(480, 1010, 0.95, G1) + bush(1440, 1010, 0.95, G1) + bush(960, 1050, 0.9, G2) + bush(780, 1080, 0.8, G3) + bush(1140, 1080, 0.8, G3) +
    flower(200, 880, 0.9) + flower(560, 940, 0.8) + flower(960, 975, 0.8) + flower(1360, 945, 0.8) + flower(1730, 880, 0.9) + flower(1040, 1040, 0.6),
)

/** Outer Space: the rocket's control panel, with buttons, a radar screen and a lever. */
const spaceFront = scene(
  vgrad('sf-t', [0, '#cbd5e1'], [1, '#94a3b8']),
  `<path d="M-20 930L180 860H1740L1940 930Z" fill="url(#sf-t)" stroke="#475569"/>` +
    `<rect x="-20" y="930" width="1960" height="170" fill="#475569" stroke="#1e293b"/>` +
    `<g stroke-width="6">${[
      [330, 896, '#ef4444', '#b91c1c'], [420, 896, '#fde047', '#ca8a04'], [510, 896, '#4ade80', '#15803d'], [600, 896, '#38bdf8', '#0369a1'],
      [1320, 896, '#f472b6', '#be185d'], [1410, 896, '#fde047', '#ca8a04'], [1500, 896, '#4ade80', '#15803d'], [1590, 896, '#a78bfa', '#6d28d9'],
    ].map(([x, y, f, st]) => `<ellipse cx="${x}" cy="${y}" rx="30" ry="16" fill="${f}" stroke="${st}"/>`).join('')}</g>` +
    `<rect x="780" y="955" width="360" height="125" rx="24" fill="#0f172a" stroke="#1e293b"/><g fill="none" stroke="#4ade80" stroke-width="5" opacity=".9"><circle cx="960" cy="1040" r="60"/><circle cx="960" cy="1040" r="30"/><path d="M960 1040L1010 1004"/></g><circle cx="992" cy="1016" r="9" fill="#fde047" stroke="none"/><text x="1090" y="1000" text-anchor="middle" ${FONT} font-size="26" fill="#4ade80" stroke="none">GO</text>` +
    `<g ${at(300, 1020)}><circle r="64" fill="#fde047" stroke="#ca8a04"/><circle r="44" fill="#ef4444" stroke="#b91c1c"/><path d="M-18-16q14-12 32-6" fill="none" stroke="#fff" stroke-opacity=".7" stroke-width="7"/></g>` +
    `<g ${at(1620, 1040)}><rect x="-90" y="-20" width="180" height="40" rx="20" fill="#1e293b" stroke="#0f172a"/><path d="M30 0L70-90" stroke="#94a3b8" stroke-width="18"/><circle cx="70" cy="-96" r="26" fill="#ef4444" stroke="#b91c1c"/></g>` +
    `<g stroke="#1e293b" stroke-width="5">${[480, 540, 600, 1320, 1380, 1440].map((x, i) => `<circle cx="${x}" cy="1000" r="14" fill="${['#4ade80', '#fde047', '#ef4444'][i % 3]}"/>`).join('')}</g>` +
    `<g fill="#334155" stroke="#1e293b" stroke-width="6">${[480, 540, 600, 1320, 1380, 1440].map((x) => `<rect x="${x - 14}" y="1036" width="28" height="44" rx="8"/>`).join('')}</g>`,
)

export const BUILTIN_BACKGROUNDS: BackgroundDef[] = [
  { id: 'space', name: 'Outer Space', svg: space, thumbColor: '#3b2a8f', front: spaceFront },
  { id: 'sea', name: 'Under the Sea', svg: sea, thumbColor: '#0ea5e9', front: seaFront },
  { id: 'jungle', name: 'Jungle', svg: jungle, thumbColor: '#22c55e', front: jungleFront },
  { id: 'dino', name: 'Dinosaur Land', svg: dino, thumbColor: '#a3e635' },
  { id: 'city', name: 'Big City', svg: city, thumbColor: '#7dd3fc' },
  { id: 'weather', name: 'Weather Map', svg: weather, thumbColor: '#2563eb', front: weatherFront, home: { x: 0.32, y: 0.6, scale: 0.64 } },
  { id: 'castle', name: 'Castle', svg: castle, thumbColor: '#e9d5ff', front: castleFront },
  { id: 'farm', name: 'Farm', svg: farm, thumbColor: '#86efac', front: farmFront },
  { id: 'moon', name: 'The Moon', svg: moon, thumbColor: '#1e1b4b' },
  { id: 'rainbow', name: 'Rainbow Land', svg: rainbow, thumbColor: '#fbcfe8' },
  { id: 'snow', name: 'Snowy Mountains', svg: snowy, thumbColor: '#bfdbfe' },
  { id: 'news', name: 'News Desk', svg: news, thumbColor: '#1e40af', front: newsFront, home: { x: 0.5, y: 0.56, scale: 0.85 } },
]

/** Lookup by id; undefined if unknown. */
export function getBackground(id: string): BackgroundDef | undefined {
  return BUILTIN_BACKGROUNDS.find((b) => b.id === id)
}
