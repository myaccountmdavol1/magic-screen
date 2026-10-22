// Shared contracts for Magic Screen. See ../../SPEC.md for the module map.

/** RGB in 0..1 */
export type RGB = [number, number, number]

/** How the "Me" (foreground) layer becomes transparent. */
export type KeyMode =
  | 'chroma' // live WebGL chroma key against KeySettings.color
  | 'segment' // MediaPipe selfie segmentation mask ("no green screen" mode)
  | 'packed' // pre-keyed video: top half = straight FG RGB, bottom half = alpha (grayscale)
  | 'alpha' // source already has straight alpha (e.g. an RGBA PNG)
  | 'none' // no keying (opaque)

export interface KeySettings {
  mode: KeyMode
  color: RGB // key color, default pure-ish green [0.2, 0.75, 0.3]
  similarity: number // 0..1, how far from key color is still removed (default 0.4)
  smoothness: number // 0..1, edge softness (default 0.08)
  spill: number // 0..1, green spill suppression strength (default 0.6)
}

export type BackgroundKind = 'builtin' | 'image' | 'video' | 'color'

export interface BackgroundChoice {
  id: string
  kind: BackgroundKind
  name: string // spoken + aria label, e.g. "Outer Space"
  /** URL usable as <img>/<video> src: data:/blob:/relative URL. For 'color' it is a CSS color. */
  src: string
  /** builtin only: key into BUILTIN_BACKGROUNDS */
  builtinId?: string
}

/** A placed sticker on the stage. Coordinates are normalized to the stage (0..1), center-anchored. */
export interface PlacedSticker {
  uid: string // instance id
  stickerId: string // key into STICKERS
  x: number
  y: number
  scale: number // 1 = 20% of stage height
  rotation: number // radians
}

/** Placement of the keyed "Me" layer on the stage. Normalized: x,y = center offset (0.5,0.5 = centered). */
export interface MeTransform {
  x: number
  y: number
  scale: number // 1 = fill stage height
}

export type OutputKind = 'photo' | 'video'

export type StepId = 'world' | 'me' | 'stickers' | 'action' | 'keep'
export type ScreenId = 'home' | 'make' | 'teacher' | 'view'

export interface CaptureResult {
  kind: OutputKind
  /** The finished composite (what the child saw). */
  composite: Blob
  mime: string
  durationSec?: number
  thumbDataUrl: string
}

/** A saved creation in the gallery (IndexedDB). */
export interface Creation {
  id: string
  createdAt: number // epoch ms
  kind: OutputKind
  mime: string
  durationSec?: number
  thumbDataUrl: string
  /** blob is stored separately under the same id in the 'media' store */
}

export interface Settings {
  voice: boolean // spoken prompts (SpeechSynthesis)
  sounds: boolean // tap / success sound effects
  mirror: boolean // mirror front camera preview
  facing: 'user' | 'environment'
  resolution: '540p' | '720p' | '1080p'
  maxVideoSec: number // default 60
  countdownSec: number // default 3
  key: Omit<KeySettings, 'mode'>
  /** auto = use the green screen when one is found, otherwise the AI person cutout */
  greenScreenMode: 'auto' | 'chroma' | 'segment'
  /** -1 (looser, keeps more around the edge) .. +1 (tighter, trims more); 0 = default */
  outline: number
  /** Tier 2 "Magic Helper" (on-device MediaPipe person finder) in green screen mode. Teacher-only. */
  magicHelper: 'auto' | 'on' | 'off'
}
