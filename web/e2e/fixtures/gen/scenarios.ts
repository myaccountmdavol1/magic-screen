// Keyer fixture scenarios. Each one isolates a classroom failure mode; generate.ts
// renders it with exact ground-truth alpha. Keep ids stable: harness results and
// gates refer to them.
import { srgb } from './color.ts'
import { KID, TEACHER, type PersonOpts, type PlateOpts } from './scene.ts'

export interface Scenario {
  id: string
  title: string
  /** what the scenario is meant to stress (shown in reports) */
  stresses: string
  frames?: number
  person: PersonOpts
  plate: PlateOpts
  /** cast shadow of the child on the screen (darkening, 0..1) */
  shadow?: number
  /** screen light bouncing onto the child's rim (0..1) */
  spill?: number
  /** motion-blur sub-frames (box shutter over `shutter` of the frame interval) */
  subframes?: number
  shutter?: number
  /** Poisson-Gaussian sensor noise in linear light: var = a*I + b */
  noise?: { a: number; b: number }
  /** IJG quality for 8x8 DCT block artifacts (lower = blockier) */
  jpegQuality?: number
  /** auto-white-balance / exposure drift strength over the clip */
  awb?: number
  /** fluorescent flicker (rolling bands + global pulse) strength */
  flicker?: number
  /** global exposure gain in linear light (dim room < 1) */
  exposure?: number
}

const PLATE: PlateOpts = { screen: 'green', vignette: 0.12, hotspot: 0, falloff: 0, wrinkles: 0, specks: 0 }
const MILD_NOISE = { a: 0.00015, b: 0.000002 }
const BASE = { person: KID, plate: PLATE, spill: 0.08, noise: MILD_NOISE }

export const SCENARIOS: Scenario[] = [
  { id: 'clean', title: 'Clean screen', stresses: 'baseline: even light, slow wave', ...BASE },
  {
    id: 'uneven-light',
    title: 'Hotspot + falloff',
    stresses: 'uneven lighting: hotspot, dim side with colour shift',
    ...BASE,
    plate: { ...PLATE, hotspot: 0.55, falloff: 0.45 },
  },
  {
    id: 'shadow-wrinkles',
    title: 'Shadow + wrinkles',
    stresses: "kid's cast shadow on the screen, fabric folds",
    ...BASE,
    plate: { ...PLATE, wrinkles: 1 },
    shadow: 0.5,
  },
  {
    id: 'hair-spill',
    title: 'Spill on wispy hair',
    stresses: 'green spill on hair edges, many sub-pixel strands (unmixing)',
    ...BASE,
    person: { ...KID, hair: srgb(0.85, 0.7, 0.42), strands: 170, strandLen: 0.075, strandOpacity: 0.8 },
    spill: 0.45,
  },
  {
    id: 'motion-blur',
    title: 'Fast wave, motion blur',
    stresses: 'fast waving arm integrated over 8 sub-frames (180° shutter)',
    ...BASE,
    person: { ...KID, waveHz: 2.5, waveAmp: 0.55 },
    subframes: 8,
    shutter: 0.5,
  },
  { id: 'noise', title: 'Sensor noise', stresses: 'heavy Poisson-Gaussian noise (dim room)', ...BASE, noise: { a: 0.002, b: 0.00005 } },
  { id: 'compression', title: 'Compression blocks', stresses: '8x8 DCT blocking + chroma smear (q=30)', ...BASE, jpegQuality: 30 },
  { id: 'awb-drift', title: 'White-balance drift', stresses: 'auto white balance + exposure drift over 3 s', ...BASE, frames: 90, awb: 1 },
  { id: 'flicker', title: 'Fluorescent flicker', stresses: 'rolling flicker bands + global pulse', ...BASE, frames: 90, flicker: 1 },
  {
    id: 'green-shirt',
    title: 'Green shirt',
    stresses: 'screen-coloured clothing (needs the Magic Helper core fill)',
    ...BASE,
    person: { ...KID, shirt: srgb(0.24, 0.62, 0.3), stripe: srgb(0.3, 0.7, 0.36) },
  },
  {
    id: 'yellow-shirt',
    title: 'Yellow shirt',
    stresses: 'yellow clothing must stay yellow (despill limit)',
    ...BASE,
    person: { ...KID, shirt: srgb(0.95, 0.82, 0.15), stripe: srgb(0.85, 0.9, 0.3) },
  },
  {
    id: 'blue-screen',
    title: 'Blue screen',
    stresses: 'blue backing (auto key must find blue; spill channel = B)',
    ...BASE,
    person: { ...KID, shirt: srgb(0.85, 0.3, 0.2), stripe: srgb(0.95, 0.85, 0.75) },
    plate: { ...PLATE, screen: 'blue' },
  },
  { id: 'specks', title: 'Tape + clips', stresses: 'small specks on the screen (tape strips, clips)', ...BASE, plate: { ...PLATE, specks: 16 } },
  {
    id: 'specks-edge',
    title: 'Specks at the frame edge',
    stresses: 'tape / clips cut by the frame edge (despeckle must not mirror them into big blobs)',
    ...BASE,
    plate: { ...PLATE, specks: 6, edgeSpecks: 9 },
  },
  {
    id: 'closeup',
    title: 'Close-up, teal shirt',
    stresses: 'kid close to the iPad: shirt (teal, near the screen hue) covers the lower side borders; auto key must not drift onto it',
    ...BASE,
    person: {
      ...KID,
      shirt: srgb(0.22, 0.6, 0.45),
      stripe: null,
      strands: 60,
      strandLen: 0.05,
      geom: { headY: 0.45, rx: 0.2, ry: 0.27, hairY: 0.4, hairRx: 0.22, hairRy: 0.24, hairCut: 0.42, neckTop: 0.62, torsoTop: 0.5, torsoHW: 1.0, torsoR: 0.12 },
    },
  },
  {
    id: 'dim-screen',
    title: 'Dim screen',
    stresses: 'unlit screen in a dim room (low exposure + noise): key must hold and ask for more light',
    ...BASE,
    noise: { a: 0.0006, b: 0.00001 },
    exposure: 0.12,
  },
  {
    id: 'harsh-light',
    title: 'Strong hotspot + falloff',
    stresses: 'one lamp: bright hotspot, dark colour-shifted far side, heavy vignette (screen flattening, item 7)',
    ...BASE,
    plate: { ...PLATE, vignette: 0.35, hotspot: 1.1, falloff: 0.75 },
  },
  {
    id: 'deep-shadow',
    title: 'Deep cast shadow',
    stresses: "kid stands close to the sheet: dark cast shadow + folds (screen flattening, item 7)",
    ...BASE,
    plate: { ...PLATE, wrinkles: 1.6 },
    shadow: 0.85,
  },
  {
    id: 'classroom',
    title: 'No green screen',
    stresses: 'teacher at a desk in a cluttered classroom: AI cutout (segment) path',
    person: TEACHER,
    plate: { ...PLATE, screen: 'none' },
    noise: MILD_NOISE,
  },
  {
    id: 'webcam-beige',
    title: 'Laptop webcam, beige wall',
    stresses: 'no green screen: bald head + beard + glasses against a skin-toned wall, door frame (AI cutout path)',
    person: { ...TEACHER, kind: 'webcam', strands: 0 },
    plate: { ...PLATE, screen: 'none', room: 'office' },
    noise: { a: 0.0006, b: 0.000008 },
  },
]

export function scenarioById(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id)
}
