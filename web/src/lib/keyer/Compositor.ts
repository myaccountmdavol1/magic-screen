// Stage compositor: background (cover-fit) -> keyed "Me" layer (contain-fit,
// transformed, mirrored) -> stickers. WebGL2 when available, otherwise a
// Canvas2D path that keys on the CPU at reduced resolution.
//
// WebGL2 keying pipeline per new camera frame (see shaders.ts for the graph):
// LUT matte with temporal EMA → half-res guided filter (or tent) → ML fusion
// (Magic Helper garbage/core mattes) → choke → alpha-aware despill → light wrap.
import type { KeySettings, MeTransform, RGB } from '../../types'
import { fadeToward } from '../deviceTier'
import {
  BORDER_KEY,
  autoKeyFromSamples,
  autoKeyFromScreen,
  despill,
  dominantChannel,
  isScreenLike,
  robustBorderKey,
  type AutoKeyResult,
  type BorderCell,
  type BorderKeyStatus,
} from './autoKey'
import { bakeKeyLut, makeByteIndex, sampleKeyLut, uploadKeyLut } from './keyLut'
import {
  LUT_N,
  LUT_RANGE,
  averageLinear,
  combineThresholds,
  deltaE00,
  keyDistLab,
  keyLabFromLab,
  labToRgb,
  rgbToLab,
  sliderThresholds,
  srgbToLinear,
  type KeyLab,
  type Lab,
  type Thresholds,
} from './labKey'
import {
  BLUR_DOWN_FS,
  BOX4_FS,
  BOXR_FS,
  BOX_FS,
  CGF_COEF_FS,
  CHECKER_FS,
  CGF_PACK_FS,
  DS_BOX_FS,
  DS_DOWN_FS,
  DS_TUNING,
  FG_FS,
  FLATTEN_TUNING,
  GF_COEF_FS,
  GF_PACK_FS,
  GF_TEMPORAL_FS,
  GF_TEMPORAL_TUNING,
  IMAGE_FS,
  KEYER_TUNING,
  MASK_PREP_FS,
  MODE_IDS,
  PASS_VS,
  QUAD_VS,
  SAMPLE_FS,
  KEYER_FLAGS,
  SEG_TUNING,
  UNMIX_TUNING,
  matteFs,
  unmixPrepFs,
  type KeyerFlags,
  type SegTuning,
} from './shaders'

export type BackgroundSource = HTMLImageElement | HTMLVideoElement | HTMLCanvasElement | ImageBitmap
export type ForegroundSource = HTMLVideoElement | HTMLImageElement | HTMLCanvasElement
export type MaskSource = HTMLCanvasElement | ImageBitmap
export interface StickerDraw {
  image: HTMLImageElement | ImageBitmap
  x: number
  y: number
  scale: number
  rotation: number
}

/** Things the keyer noticed that the UI should tell a grown-up (or kid) about. */
export type KeyerSignal =
  | { type: 'uneven'; p95: number } // screen too wrinkled / badly lit for a clean key
  | { type: 'shirt' } // clothing is screen-coloured; the Magic Helper should step in
  | { type: 'dark'; L: number } // the screen is underlit: ask a grown-up for more light

export interface KeyerStats {
  tier: 'canvas2d' | 'webgl-tent' | 'webgl-full'
  /** true when the 3D LUT could not be created and the shader computes keyD per pixel */
  analyticKey: boolean
  /** recent frame interval (time between render() calls), for thermal backoff */
  frameP90Ms: number
  frameMeanMs: number
  /** mean main-thread time spent inside render() */
  renderCpuMs: number
  lo: number
  hi: number
  /** key colour currently baked into the LUT (follows white-balance drift) */
  keyColor: RGB
  autoKey: { p95: number; tooUneven: boolean } | null
  /** robust border key (item 6): status of the last auto-key look, null before the first */
  borderKey: BorderKeyStatus | null
  mlWeight: number
  coreWeight: number
  /** Magic Helper trust last set (1 = fresh / no trust model) */
  mlTrust: number
  /** foreground unmixing: target format in use, or off */
  unmix: 'rgba16f' | 'srgb8' | 'off'
  /** ms since the last ML mask arrived (Infinity if never) */
  maskAgeMs: number
  /** times the drift tracker re-baked the key */
  recalibrations: number
  /** diagnostics of the last async sample (drift + shirt check), null before the first */
  lastSample: {
    screenFrac: number
    method: 'ml' | 'holes'
    /** ML: share of "definitely kid" pixels the key removed. Holes: hole area share. */
    score: number
    /** holes only: mean keyD of holes minus mean keyD of the screen */
    keyDGap: number
  } | null
}

type Drawable = BackgroundSource | ForegroundSource

const DEFAULT_KEY: KeySettings = {
  mode: 'chroma',
  color: [0.2, 0.75, 0.3],
  similarity: 0.4,
  smoothness: 0.08,
  spill: 0.6,
}
/** Shown when no background is chosen yet (Talkline cream, #fff3cf). */
const EMPTY_BG: RGB = [1, 0.953, 0.812]
/** Sticker height at scale 1, as a fraction of stage height (see PlacedSticker). */
const STICKER_BASE = 0.2
/** CPU fallback keys at most this many rows; the result is upscaled on draw. */
const FALLBACK_PROC_HEIGHT = 270
/** Images are rasterized once (fixes SVG uploads on Safari) at most this big. */
const MAX_RASTER = 2048
/** The matte pass runs at camera resolution, capped at this width. */
const MAX_MATTE_W = 1280
/** ML mask prep width (selfie segmenter is 256 square). */
const PREP_W = 256
/** Drift tracker: readback frame width and period. */
const SAMPLE_W = 80
const RECAL_MS = 2000
/** Lab EMA weight per drift sample, and ΔE00 that triggers a re-bake. */
const RECAL_EMA = 0.2
const RECAL_REBAKE_DE = 2
const FRAME_RING = 90
/** Moving backgrounds: rebuild the light-wrap blur every Nth fresh background frame. */
const BG_BLUR_EVERY = 4
/** A hole whose keyD sits this far above the screen's is clothing, not an arm gap. */
const SHIRT_KEYD_GAP = 0.8

interface ShirtCheck {
  suspect: boolean
  diag: { score: number; keyDGap: number }
}

// ---------- source helpers ----------

function isVideo(s: unknown): s is HTMLVideoElement {
  return typeof HTMLVideoElement !== 'undefined' && s instanceof HTMLVideoElement
}
function isImage(s: unknown): s is HTMLImageElement {
  return typeof HTMLImageElement !== 'undefined' && s instanceof HTMLImageElement
}
function isCanvas(s: unknown): s is HTMLCanvasElement {
  return typeof HTMLCanvasElement !== 'undefined' && s instanceof HTMLCanvasElement
}

function sourceSize(s: Drawable): { w: number; h: number } {
  if (isVideo(s)) return { w: s.videoWidth, h: s.videoHeight }
  if (isImage(s)) return { w: s.naturalWidth || s.width, h: s.naturalHeight || s.height }
  return { w: s.width, h: s.height }
}

function isReady(s: Drawable): boolean {
  if (isVideo(s)) return s.readyState >= 2 && s.videoWidth > 0
  if (isImage(s)) return s.complete && sourceSize(s).w > 0
  const { w, h } = sourceSize(s)
  return w > 0 && h > 0
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(w))
  c.height = Math.max(1, Math.round(h))
  return c
}

function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Canvas2D unavailable')
  return ctx
}

/** Draw an <img> into a canvas once so every browser can upload it (SVG on Safari). */
function rasterize(img: HTMLImageElement): HTMLCanvasElement {
  const { w, h } = sourceSize(img)
  const k = Math.min(1, MAX_RASTER / Math.max(w, h))
  const c = makeCanvas(w * k, h * k)
  c.getContext('2d')?.drawImage(img, 0, 0, c.width, c.height)
  return c
}

let colorCtx: CanvasRenderingContext2D | null = null
function parseCssColor(css: string): RGB {
  try {
    colorCtx ??= makeCanvas(1, 1).getContext('2d', { willReadFrequently: true })
    if (!colorCtx) return EMPTY_BG
    colorCtx.clearRect(0, 0, 1, 1)
    colorCtx.fillStyle = '#000'
    colorCtx.fillStyle = css
    colorCtx.fillRect(0, 0, 1, 1)
    const d = colorCtx.getImageData(0, 0, 1, 1).data
    return [d[0] / 255, d[1] / 255, d[2] / 255]
  } catch {
    return EMPTY_BG
  }
}

const sameColor = (a: RGB, b: RGB) =>
  Math.abs(a[0] - b[0]) < 1e-4 && Math.abs(a[1] - b[1]) < 1e-4 && Math.abs(a[2] - b[2]) < 1e-4

type VideoWithVfc = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number
  cancelVideoFrameCallback?: (h: number) => void
}

/**
 * Tracks whether a source has new pixels since its last upload, so video
 * textures are only re-uploaded when the decoder produced a new frame.
 */
class TrackedSource {
  uploaded = false
  private frameDirty = true
  private lastTime = -1
  private vfcHandle: number | null = null
  private lastVfcAt = 0
  private raster: HTMLCanvasElement | null = null
  readonly src: Drawable

  constructor(src: Drawable) {
    this.src = src
    const v = src as VideoWithVfc
    if (isVideo(src) && typeof v.requestVideoFrameCallback === 'function') {
      const onFrame = () => {
        this.frameDirty = true
        this.lastVfcAt = performance.now()
        this.vfcHandle = v.requestVideoFrameCallback!(onFrame)
      }
      this.vfcHandle = v.requestVideoFrameCallback(onFrame)
    }
  }

  ready(): boolean {
    return isReady(this.src)
  }

  size() {
    return sourceSize(this.src)
  }

  needsUpload(): boolean {
    if (!this.ready()) return false
    if (!this.uploaded) return true
    const s = this.src
    if (isVideo(s)) {
      const moved = s.currentTime !== this.lastTime
      if (this.vfcHandle === null) return moved
      if (this.frameDirty) return true
      // Safety net: seeks while paused, or detached videos whose frame callbacks
      // stall, still refresh via the currentTime check.
      return moved && (s.paused || performance.now() - this.lastVfcAt > 250)
    }
    // Canvases (generated frames) may change at any time.
    return isCanvas(s)
  }

  /** What to hand to texImage2D / drawImage. */
  uploadable(): TexImageSource {
    const s = this.src
    if (isImage(s)) {
      this.raster ??= rasterize(s)
      return this.raster
    }
    return s
  }

  markUploaded() {
    this.uploaded = true
    this.frameDirty = false
    if (isVideo(this.src)) this.lastTime = this.src.currentTime
  }

  /** Forget GPU state (context restored). */
  reset() {
    this.uploaded = false
    this.frameDirty = true
  }

  dispose() {
    const v = this.src as VideoWithVfc
    if (this.vfcHandle !== null && typeof v.cancelVideoFrameCallback === 'function') {
      v.cancelVideoFrameCallback(this.vfcHandle)
    }
    this.vfcHandle = null
  }
}

// ---------- GL helpers ----------

type Uniforms = Record<string, WebGLUniformLocation | null>

interface Prog {
  p: WebGLProgram
  u: Uniforms
}

/** An offscreen colour target. */
interface Target {
  tex: WebGLTexture
  fbo: WebGLFramebuffer
  w: number
  h: number
}

interface Pending {
  fence: WebGLSync
  w: number
  h: number
  at: number
}

interface GlState {
  gl: WebGL2RenderingContext
  vao: WebGLVertexArrayObject
  buffer: WebGLBuffer
  image: Prog
  fg: Prog
  matte: Prog
  gfPack: Prog
  box: Prog
  gfCoef: Prog
  maskPrep: Prog
  blurDown: Prog
  sample: Prog
  cgfPack: Prog
  box4: Prog
  boxR: Prog
  cgfCoef: Prog
  unmixPrep: Prog
  dsDown: Prog
  dsBox: Prog
  gfTemporal: Prog
  checker: Prog
  /** item 5: coefficient history ping-pong (half res, RGBA16F) */
  gfHist: [Target, Target] | null
  /** speck / hole box sums (item 4) at 1/4 matte res; RGBA16F when floatOk */
  dsT: [Target, Target] | null
  /** shader computes keyD itself (3D LUT unavailable) */
  analytic: boolean
  /** RGBA16F render targets work → guided filter */
  floatOk: boolean
  bgTex: WebGLTexture
  fgTex: WebGLTexture
  maskTex: WebGLTexture
  lutTex: WebGLTexture | null
  stickerTex: Map<HTMLImageElement | ImageBitmap, WebGLTexture>
  /** C5 front layer (desk, fence...): texture + which image it currently holds */
  frontTex: WebGLTexture
  frontFor: HTMLImageElement | ImageBitmap | null
  matteT: [Target, Target] | null
  gfT: [Target, Target, Target] | null
  prepT: [Target, Target] | null
  bgBlurT: [Target, Target] | null
  sampleT: Target | null
  /** colour guided filter (segment mode): two MRT sets of 4 + coefficient ping-pong */
  cgf: CgfTargets | null
  /** MRT (4 draw buffers) available */
  mrtOk: boolean
  /** foreground unmixing targets (item 3); null until first needed or when unavailable */
  unT: UnmixTargets | null
  /** unmixing state: untried, the target format in use, or off (no usable format) */
  unmixFmt: 'untried' | 'rgba16f' | 'srgb8' | 'off'
  pbo: WebGLBuffer | null
  pending: Pending | null
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)
  if (!sh) throw new Error('createShader failed')
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(sh)
    gl.deleteShader(sh)
    throw new Error(`Shader compile failed: ${log}`)
  }
  return sh
}

/** Fixed texture unit per sampler name; set once after linking. */
function link(gl: WebGL2RenderingContext, vs: string, fs: string, units: Record<string, number> = {}): Prog {
  const p = gl.createProgram()
  if (!p) throw new Error('createProgram failed')
  const v = compile(gl, gl.VERTEX_SHADER, vs)
  const f = compile(gl, gl.FRAGMENT_SHADER, fs)
  gl.attachShader(p, v)
  gl.attachShader(p, f)
  gl.bindAttribLocation(p, 0, 'a_pos')
  gl.linkProgram(p)
  gl.deleteShader(v)
  gl.deleteShader(f)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) {
    throw new Error(`Program link failed: ${gl.getProgramInfoLog(p)}`)
  }
  const u: Uniforms = {}
  const n = (gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number) ?? 0
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i)
    if (info) u[info.name] = gl.getUniformLocation(p, info.name)
  }
  gl.useProgram(p)
  // Every sampler gets its own unit: WebGL rejects draws where samplers of
  // different types (2D vs 3D) share one, and the default for all is unit 0.
  for (const [name, unit] of Object.entries(units)) {
    if (u[name]) gl.uniform1i(u[name], unit)
  }
  return { p, u }
}

function newTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const t = gl.createTexture()
  if (!t) throw new Error('createTexture failed')
  gl.bindTexture(gl.TEXTURE_2D, t)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  // 1x1 transparent placeholder so sampling an un-uploaded texture is defined.
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4))
  return t
}

/**
 * @param wrap CLAMP_TO_EDGE (default) or MIRRORED_REPEAT. Filter taps past the frame
 *   edge then read mirrored interior texels instead of the edge texel repeated, so box
 *   filters and the guided filter are not pulled toward one edge texel where an arm
 *   leaves the frame (plan item 1; idea from CorridorKey's reflect padding). Never
 *   for targets whose box sums count area (a speck at the edge would count double).
 */
function createTarget(gl: WebGL2RenderingContext, w: number, h: number, float: boolean, wrap: number = gl.CLAMP_TO_EDGE): Target | null {
  const tex = newTexture(gl)
  if (wrap !== gl.CLAMP_TO_EDGE) {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap)
  }
  if (float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null)
  else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
  const fbo = gl.createFramebuffer()
  if (!fbo) {
    gl.deleteTexture(tex)
    return null
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  if (!ok) {
    gl.deleteFramebuffer(fbo)
    gl.deleteTexture(tex)
    return null
  }
  return { tex, fbo, w, h }
}

function deleteTargets(gl: WebGL2RenderingContext, list: readonly (Target | null | undefined)[] | null) {
  if (!list) return
  for (const t of list) {
    if (!t) continue
    gl.deleteFramebuffer(t.fbo)
    gl.deleteTexture(t.tex)
  }
}

function makeTargets<N extends number>(gl: WebGL2RenderingContext, n: N, w: number, h: number, float: boolean, wrap?: number) {
  const out: Target[] = []
  for (let i = 0; i < n; i++) {
    const t = createTarget(gl, w, h, float, wrap)
    if (!t) {
      deleteTargets(gl, out)
      return null
    }
    out.push(t)
  }
  return out
}

interface Mrt {
  fbo: WebGLFramebuffer
  tex: WebGLTexture[]
  w: number
  h: number
}
interface CgfTargets {
  a: Mrt
  b: Mrt
  coef: [Target, Target]
}

/** n RGBA16F textures behind one framebuffer (multiple render targets). */
function createMrt(gl: WebGL2RenderingContext, w: number, h: number, n: number, wrap: number = gl.CLAMP_TO_EDGE): Mrt | null {
  const tex: WebGLTexture[] = []
  const fbo = gl.createFramebuffer()
  if (!fbo) return null
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
  for (let i = 0; i < n; i++) {
    const t = newTexture(gl)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0)
    tex.push(t)
  }
  gl.drawBuffers(tex.map((_, i) => gl.COLOR_ATTACHMENT0 + i))
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  if (!ok) {
    gl.deleteFramebuffer(fbo)
    for (const t of tex) gl.deleteTexture(t)
    return null
  }
  return { fbo, tex, w, h }
}

function deleteMrt(gl: WebGL2RenderingContext, m: Mrt | null | undefined) {
  if (!m) return
  gl.deleteFramebuffer(m.fbo)
  for (const t of m.tex) gl.deleteTexture(t)
}

function deleteCgf(gl: WebGL2RenderingContext, c: CgfTargets | null) {
  if (!c) return
  deleteMrt(gl, c.a)
  deleteMrt(gl, c.b)
  deleteTargets(gl, c.coef)
}

/** Unmix pyramids: F (foreground donors) + ping-pong screen plate B, mipmapped. */
interface UnmixTargets {
  F: WebGLTexture
  B: [WebGLTexture, WebGLTexture]
  /** fbo[i] = F on attachment 0, B[i] on attachment 1 */
  fbo: [WebGLFramebuffer, WebGLFramebuffer]
  w: number
  h: number
  levels: number
  format: 'rgba16f' | 'srgb8'
  wrap: number
}

function deleteUnmix(gl: WebGL2RenderingContext, u: UnmixTargets | null) {
  if (!u) return
  for (const f of u.fbo) gl.deleteFramebuffer(f)
  for (const t of [u.F, ...u.B]) gl.deleteTexture(t)
}

/**
 * Allocate the unmix pyramids with immutable mip storage. RGBA16F needs renderable
 * half floats; SRGB8_ALPHA8 is colour-renderable and mipmappable in core WebGL2 and
 * its sRGB encoding keeps small premultiplied values precise. Returns null if the
 * format can't be rendered to or mipmapped here.
 */
function createUnmix(gl: WebGL2RenderingContext, w: number, h: number, format: 'rgba16f' | 'srgb8', wrap: number): UnmixTargets | null {
  const levels = Math.max(1, Math.min(5, Math.floor(Math.log2(Math.max(w, h))) + 1))
  const internal = format === 'rgba16f' ? gl.RGBA16F : gl.SRGB8_ALPHA8
  // Drain earlier errors so the probe below is ours (bounded: a lost context keeps
  // reporting CONTEXT_LOST_WEBGL).
  for (let i = 0; i < 8 && gl.getError() !== gl.NO_ERROR; i++) {
    /* keep draining */
  }
  const mk = () => {
    const t = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texStorage2D(gl.TEXTURE_2D, levels, internal, w, h)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap)
    return t
  }
  const F = mk()
  const B: [WebGLTexture, WebGLTexture] = [mk(), mk()]
  const fbo: WebGLFramebuffer[] = []
  let ok = true
  for (let i = 0; i < 2; i++) {
    const f = gl.createFramebuffer()!
    fbo.push(f)
    gl.bindFramebuffer(gl.FRAMEBUFFER, f)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, F, 0)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, B[i], 0)
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1])
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) ok = false
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  if (ok) {
    // Mipmap generation must work too (it is what the final pass samples).
    for (const t of [F, ...B]) {
      gl.bindTexture(gl.TEXTURE_2D, t)
      gl.generateMipmap(gl.TEXTURE_2D)
    }
    if (gl.getError() !== gl.NO_ERROR) ok = false
  }
  const u: UnmixTargets = { F, B, fbo: fbo as [WebGLFramebuffer, WebGLFramebuffer], w, h, levels, format, wrap }
  if (!ok) {
    deleteUnmix(gl, u)
    return null
  }
  return u
}

interface Rect {
  cx: number
  cy: number
  w: number
  h: number
}

export class Compositor {
  /** Optional listener for keyer signals (uneven screen, screen-coloured shirt). */
  onSignal: ((s: KeyerSignal) => void) | null = null

  private _width: number
  private _height: number
  private readonly canvas: HTMLCanvasElement
  private glState: GlState | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private contextLost = false

  private bg: TrackedSource | null = null
  private bgColor: RGB = EMPTY_BG
  private fg: TrackedSource | null = null
  private mirror = false
  private fgLive = false
  private key: KeySettings = DEFAULT_KEY
  private me: MeTransform = { x: 0.5, y: 0.5, scale: 1 }
  private stickers: StickerDraw[] = []
  /** C5: world front layer drawn over the Me layer, under stickers (cover-fit like the bg) */
  private front: HTMLImageElement | ImageBitmap | null = null
  private frontRaster: HTMLCanvasElement | null = null
  private stickerRasters = new Map<HTMLImageElement, HTMLCanvasElement>()

  // key model
  private keyLab: KeyLab
  /** dominant channel of the (tracked) key: 1 = green screen, 2 = blue */
  private spillCh: 0 | 1 | 2 = 1
  private lutData: Uint8Array
  private lutDirty = true
  private thresholds: Thresholds
  private autoCal: AutoKeyResult | null = null
  /** Drift-tracked key in Lab (EMA of clearly-background pixels). */
  private trackedLab: Lab
  private recalibrations = 0
  /** robust border key (item 6): last status */
  private borderStatus: BorderKeyStatus | null = null
  private readonly byteIndex = makeByteIndex(LUT_N)

  // mask (Magic Helper / segment mode)
  private maskSrc: TrackedSource | null = null
  private maskData: { data: Uint8Array; w: number; h: number } | null = null
  private maskDirty = false
  private maskTexFormat: 'none' | 'r8' | 'rgba' = 'none'
  private maskTexSize = { w: 0, h: 0 }
  private maskAt = -Infinity
  private maskCanvas2d: HTMLCanvasElement | null = null
  private mlTarget = 0
  private mlWeight = 0
  private coreTarget = 0
  private coreWeight = 0
  /** Magic Helper trust (helperTrust.ts) and garbage dilation (fraction of width) */
  private mlTrust = 1
  private mlDilate: number = KEYER_TUNING.dilate
  private outline = 0
  /** P2 item 11: show the keyed layer over a checker instead of the background */
  private checker = false
  private seg: SegTuning = { ...SEG_TUNING }
  private flags: KeyerFlags = { ...KEYER_FLAGS }
  private cgfValid = false

  // pipeline state
  private matteIdx = 0
  private matteValid = false
  private matteHasPrev = false
  private matteDirty = true
  private gfValid = false
  private prepIdx = 0
  private prepValid = false
  private prepHasPrev = false
  private unIdx = 0
  private unValid = false
  private unHasPrev = false
  private dsValid = false
  private gfHistIdx = 0
  private gfHistHasPrev = false
  /** the coefficients FINAL_ALPHA reads come from the history (item 5) this frame */
  private gfHistValid = false
  private bgBlurDirty = true
  private bgBlurValid = false
  /** The last blur rebuild actually drew the background (not just the clear colour). */
  private bgBlurHadBg = false
  /** Fresh background uploads since the last blur rebuild (moving worlds throttle). */
  private bgFreshSinceBlur = 0
  private lastSampleAt = 0
  private shirtHits = 0
  private lastSample: KeyerStats['lastSample'] = null
  private shirtSignalled = false

  // stats
  private frameTimes = new Float32Array(FRAME_RING)
  private frameCount = 0
  private lastRenderAt = 0
  private cpuMsAvg = 0

  // CPU fallback scratch canvases
  private work: HTMLCanvasElement | null = null
  private workAlpha: HTMLCanvasElement | null = null
  private scratch: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null

  private readonly onLost = (e: Event) => {
    // preventDefault tells the browser we want a webglcontextrestored event.
    e.preventDefault()
    this.contextLost = true
  }
  private readonly onRestored = () => {
    this.contextLost = false
    const gl = this.glState?.gl
    this.glState = null
    if (gl) {
      try {
        this.initGl(gl)
      } catch (err) {
        console.warn('[Compositor] WebGL2 restore failed', err)
      }
    }
    for (const t of [this.bg, this.fg, this.maskSrc]) t?.reset()
    this.resetPipeline()
  }

  /**
   * @param opts.webgl false skips WebGL2 entirely (used for a retry on a fresh canvas
   *   after WebGL2 initialisation failed, since a canvas that handed out a webgl2
   *   context can never give a 2D one).
   */
  constructor(canvas: HTMLCanvasElement, opts?: { width?: number; height?: number; webgl?: boolean }) {
    this.canvas = canvas
    this._width = Math.round(opts?.width ?? (canvas.width || 1280))
    this._height = Math.round(opts?.height ?? (canvas.height || 720))
    canvas.width = this._width
    canvas.height = this._height

    this.trackedLab = rgbToLab(DEFAULT_KEY.color)
    this.keyLab = keyLabFromLab(this.trackedLab)
    this.lutData = bakeKeyLut(this.keyLab)
    this.spillCh = dominantChannel(DEFAULT_KEY.color)
    this.thresholds = sliderThresholds(DEFAULT_KEY.similarity, DEFAULT_KEY.smoothness)

    let gl: WebGL2RenderingContext | null = null
    try {
      if (opts?.webgl === false) throw new Error('WebGL2 disabled')
      gl = canvas.getContext('webgl2', {
        alpha: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: true, // captureStream / toBlob read the last frame
        antialias: false,
        depth: false,
        stencil: false,
      })
    } catch {
      gl = null
    }
    if (gl) {
      try {
        this.initGl(gl)
        canvas.addEventListener('webglcontextlost', this.onLost)
        canvas.addEventListener('webglcontextrestored', this.onRestored)
      } catch (err) {
        console.warn('[Compositor] WebGL2 init failed', err)
        this.glState = null
      }
    }
    if (!this.glState) {
      // A canvas that already has a webgl2 context cannot give us a 2D one.
      this.ctx = canvas.getContext('2d')
      if (!this.ctx) throw new Error('Neither WebGL2 nor Canvas2D is available')
    }
  }

  get width() {
    return this._width
  }
  get height() {
    return this._height
  }
  /** True when running the WebGL2 path (false = Canvas2D + CPU fallback). */
  get isWebGL() {
    return this.glState !== null
  }

  resize(width: number, height: number): void {
    this._width = Math.max(1, Math.round(width))
    this._height = Math.max(1, Math.round(height))
    this.canvas.width = this._width
    this.canvas.height = this._height
    this.bgBlurDirty = true
    this.resetTemporal()
  }

  setBackground(src: BackgroundSource | string | null): void {
    this.bgBlurDirty = true
    if (typeof src === 'string') {
      this.replaceBg(null)
      this.bgColor = parseCssColor(src)
      return
    }
    this.bgColor = EMPTY_BG
    if (src !== this.bg?.src) this.replaceBg(src)
  }

  /**
   * @param opts.live treat a canvas source as a live camera (drift tracking + shirt
   *   check run). Videos are always live. Used by the quality harness, which feeds
   *   generated frames through a canvas.
   */
  setForeground(src: ForegroundSource | null, opts?: { mirror?: boolean; live?: boolean }): void {
    this.mirror = !!opts?.mirror
    this.fgLive = !!opts?.live
    if (src === this.fg?.src) return
    this.fg?.dispose()
    this.fg = src ? new TrackedSource(src) : null
    // New camera: forget the old matte history, ML mattes and shirt verdicts.
    this.resetTemporal()
    this.prepValid = false
    this.shirtHits = 0
    this.shirtSignalled = false
  }

  setKey(k: KeySettings): void {
    const colorChanged = !sameColor(k.color, this.key.color)
    this.key = { ...k, color: [...k.color] as RGB }
    if (colorChanged) {
      this.trackedLab = rgbToLab(k.color)
      this.rebake(this.trackedLab)
    }
    this.updateThresholds()
    this.matteDirty = true
    // A still preview (Teacher) renders once per change: don't blend in the old key.
    this.matteHasPrev = false
    this.gfHistHasPrev = false
  }

  /** Legacy mask API (canvas/bitmap, R channel = person). Prefer setMaskData. */
  setMask(src: MaskSource | null): void {
    if (src !== this.maskSrc?.src) {
      this.maskSrc?.dispose()
      this.maskSrc = src ? new TrackedSource(src) : null
    }
    if (src) {
      this.maskData = null
      this.maskDirty = true
      this.maskAt = performance.now()
    } else if (!this.maskData) {
      this.clearMask()
    }
  }

  /**
   * Magic Helper / segment mode: person confidence (0..255), row-major, top row
   * first, camera space (unmirrored). Uploaded straight into an R8 texture.
   * Pass null to drop the mask.
   */
  setMaskData(data: Uint8Array | null, w = 0, h = 0): void {
    if (!data || w <= 0 || h <= 0 || data.length < w * h) {
      this.maskData = null
      if (!this.maskSrc) this.clearMask()
      return
    }
    this.maskSrc?.dispose()
    this.maskSrc = null
    this.maskData = { data, w, h }
    this.maskDirty = true
    this.maskAt = performance.now()
  }

  /** How much the Magic Helper's mattes count (0..1). Fades over 300 ms. */
  setMlWeight(w: number): void {
    this.mlTarget = Math.min(1, Math.max(0, w))
  }

  /**
   * Trust in the current Magic Helper mask, 0..1 (helperTrust.ts: mask age in camera
   * frames, motion, model confidence). Low trust fades the core fill first, then the
   * garbage kill. 1 (the default) behaves exactly like no trust model.
   */
  setMlTrust(t: number): void {
    this.mlTrust = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 1
  }

  /** Garbage-matte dilation as a fraction of frame width (wider while the kid moves fast). */
  setMlDilate(frac: number): void {
    if (Number.isFinite(frac) && frac > 0) this.mlDilate = Math.min(0.15, frac)
  }

  /**
   * Let the Magic Helper's core matte fill in "definitely a kid" areas the key
   * removed (a screen-coloured shirt). Off by default: a loose or lagging mask
   * would otherwise paint bits of green screen back in around arms and necks.
   * Fades like setMlWeight; only applies while the ML weight is up.
   */
  setCoreFill(on: boolean): void {
    this.coreTarget = on ? 1 : 0
  }

  /**
   * "Check the key" view for grown-ups: the keyed layer is drawn over a grey checker
   * with one magenta band instead of the background, so holes, specks and green
   * fringes are easy to see. WebGL2 only (the Canvas2D fallback ignores it).
   */
  setCheckerboard(on: boolean): void {
    this.checker = !!on
  }

  /**
   * Outline control, -1 (looser) .. +1 (tighter). Moves where the AI cutout puts
   * its edge and how hard the final matte is choked (both modes).
   */
  setOutline(v: number): void {
    const o = Math.min(1, Math.max(-1, Number.isFinite(v) ? v : 0))
    if (o === this.outline) return
    this.outline = o
    this.matteDirty = true
  }

  /**
   * Harness / experiments: override AI cutout (segment mode) tuning. Unknown keys
   * are ignored. Not part of the app API.
   */
  setSegTuning(t: Partial<Record<keyof SegTuning, number>>): void {
    for (const [k, v] of Object.entries(t)) {
      if (k in this.seg && typeof v === 'number' && Number.isFinite(v)) (this.seg as unknown as Record<string, number>)[k] = v
    }
    this.matteDirty = true
    this.matteHasPrev = false
    this.gfHistHasPrev = false
  }

  /**
   * Harness / experiments: switch keyer features (KeyerFlags, 1 = on). Call before the
   * first render(): target wrap modes are fixed when targets are allocated. Not part
   * of the app API.
   */
  setKeyerFlags(f: Partial<Record<keyof KeyerFlags, number>>): void {
    for (const [k, v] of Object.entries(f)) {
      if (k in this.flags && typeof v === 'number' && Number.isFinite(v)) (this.flags as unknown as Record<string, number>)[k] = v
    }
    this.matteDirty = true
    this.matteHasPrev = false
    this.gfHistHasPrev = false
  }

  /** Item 5 runs the coefficient EMA (chroma mode, guided filter available). */
  private gfTemporalOn(st: GlState): boolean {
    return this.flags.gfTemporal > 0 && !!st.gfT && !!st.gfHist
  }

  /** Full-res matte EMA in chroma mode: lower while the coefficient EMA runs (item 5). */
  private chromaMatteTemporal(st: GlState): number {
    if (!this.gfTemporalOn(st)) return KEYER_TUNING.temporal
    return this.flags.gfMatteT >= 0 ? this.flags.gfMatteT : GF_TEMPORAL_TUNING.matteTemporal
  }

  private unmixProj(): number {
    return this.flags.unmixProj >= 0 ? this.flags.unmixProj : UNMIX_TUNING.proj
  }

  /** Wrap mode for filter targets (item 1). */
  private edgeWrap(gl: WebGL2RenderingContext): number {
    return this.flags.mirrorEdges > 0 ? gl.MIRRORED_REPEAT : gl.CLAMP_TO_EDGE
  }

  /** Segment-mode confidence ramp: a narrow window so the edge is crisp, not blobby. */
  private segRamp(): [number, number] {
    const center = this.seg.preCenter + 0.22 * this.outline
    return [center - this.seg.preHalf, center + this.seg.preHalf]
  }

  /** Segment-mode ramp after the colour guided filter (the Outline control moves it too). */
  private postRamp(): [number, number] {
    const center = this.seg.postCenter + (this.seg.postHalf < 0.5 ? 0.15 * this.outline : 0)
    return [center - this.seg.postHalf, center + this.seg.postHalf]
  }

  private chokeAmount(): number {
    const base = this.key.mode === 'segment' ? this.seg.choke : this.flags.choke > 0 ? this.flags.choke : KEYER_TUNING.choke
    return base * Math.pow(2, this.outline)
  }

  /** Forget matte history (camera switch, resize, tab hidden, context restored). */
  resetTemporal(): void {
    this.matteHasPrev = false
    this.prepHasPrev = false
    this.unHasPrev = false
    this.gfHistHasPrev = false
    this.matteDirty = true
  }

  setMe(t: MeTransform): void {
    this.me = { ...t }
  }

  /**
   * C5 "TV front layer": a full-stage picture (desk, fence, bushes...) that is transparent
   * except where it covers the child. Drawn after the keyed Me layer and before stickers,
   * cover-fit exactly like the background so the two line up. Hidden in checker view.
   */
  setForegroundOverlay(img: HTMLImageElement | ImageBitmap | null): void {
    if (img === this.front) return
    this.front = img
    this.frontRaster = null
  }

  setStickers(list: StickerDraw[]): void {
    this.stickers = list.map((s) => ({ ...s }))
    const live = new Set(list.map((s) => s.image))
    const st = this.glState
    if (st) {
      for (const [img, tex] of st.stickerTex) {
        if (!live.has(img)) {
          st.gl.deleteTexture(tex)
          st.stickerTex.delete(img)
        }
      }
    }
    for (const img of this.stickerRasters.keys()) {
      if (!live.has(img)) this.stickerRasters.delete(img)
    }
  }

  render(): void {
    const t0 = performance.now()
    if (this.lastRenderAt > 0) {
      const dt = t0 - this.lastRenderAt
      this.frameTimes[this.frameCount % FRAME_RING] = dt
      this.frameCount++
      // Cap dt so a long pause (hidden tab) doesn't snap the ML weight in one frame.
      this.mlWeight = fadeToward(this.mlWeight, this.mlTarget, Math.min(dt, 100))
      this.coreWeight = fadeToward(this.coreWeight, this.coreTarget, Math.min(dt, 100))
    }
    this.lastRenderAt = t0
    if (this.glState) {
      if (!this.contextLost) this.renderGl(this.glState)
    } else if (this.ctx) {
      this.render2d(this.ctx)
    }
    const cpu = performance.now() - t0
    this.cpuMsAvg = this.cpuMsAvg === 0 ? cpu : this.cpuMsAvg * 0.9 + cpu * 0.1
  }

  /** Auto key: robust color of the foreground's border band, or null if no screen is visible. */
  sampleBorderColor(): RGB | null {
    const fg = this.fg
    if (!fg || !fg.ready()) return null
    const { w, h } = this.colorSize()
    const sw = 96
    const sh = Math.max(8, Math.round((sw * h) / w))
    const c = makeCanvas(sw, sh)
    const ctx = ctx2d(c)
    try {
      ctx.drawImage(fg.uploadable() as CanvasImageSource, 0, 0, w, h, 0, 0, sw, sh)
      const d = ctx.getImageData(0, 0, sw, sh).data
      const band = Math.max(2, Math.round(Math.min(sw, sh) * 0.12))
      const samples: RGB[] = []
      // Item 6: each sample also lands in one of 24 border cells (10 across the top,
      // 7 down each side) so the key can be voted by position.
      const nTop = BORDER_KEY.topCells
      const nSide = BORDER_KEY.sideCells
      const cellOf: number[] = []
      const sideRows = Math.max(1, sh - 2 * band)
      // Top band + side bands only. Kids are cut off by the bottom edge, so a
      // screen-coloured shirt there would join the screen cluster, fake a
      // "patchy screen" (p95 up) and loosen the key until the shirt vanishes.
      for (let y = 0; y < sh - band; y++) {
        for (let x = 0; x < sw; x++) {
          if (x >= band && x < sw - band && y >= band) continue
          const i = (y * sw + x) * 4
          samples.push([d[i] / 255, d[i + 1] / 255, d[i + 2] / 255])
          const side = Math.min(nSide - 1, Math.floor(((y - band) * nSide) / sideRows))
          cellOf.push(y < band ? Math.min(nTop - 1, Math.floor((x * nTop) / sw)) : x < band ? nTop + side : nTop + nSide + side)
        }
      }
      const found = autoKeyFromSamples(samples)
      if (!found) {
        this.borderStatus = null
        return null
      }
      const result = this.robustKey(samples, cellOf, found)
      if (!result) return this.autoCal?.color ?? found.color
      this.autoCal = result
      // Same colour as now: setKey won't be called again, so apply thresholds here.
      if (sameColor(result.color, this.key.color)) this.updateThresholds()
      if (result.tooUneven) this.onSignal?.({ type: 'uneven', p95: result.p95 })
      return result.color
    } catch {
      return null // tainted cross-origin source
    }
  }

  /**
   * Item 6: vote the key by border cell. Returns the auto-key to apply, or null to
   * keep the current one (border covered / no clear majority with a key in use).
   * Falls back to the plain cluster result when there is nothing better.
   */
  private robustKey(samples: RGB[], cellOf: number[], found: AutoKeyResult): AutoKeyResult | null {
    if (this.flags.robustKey <= 0) {
      this.borderStatus = null
      return found
    }
    const nCells = BORDER_KEY.topCells + 2 * BORDER_KEY.sideCells
    const all = new Array<number>(nCells).fill(0)
    const scr: RGB[][] = Array.from({ length: nCells }, () => [])
    samples.forEach((c, i) => {
      all[cellOf[i]]++
      if (isScreenLike(c)) scr[cellOf[i]].push(c)
    })
    // A cell counts only if most of it looks like backing (a hand or shirt edge in it is fine).
    const cells: BorderCell[] = scr.map((list, i) => {
      const mean = list.length >= 0.5 * all[i] ? averageLinear(list) : null
      return mean ? { lab: rgbToLab(mean), n: list.length } : { lab: [0, 0, 0], n: 0 }
    })
    const prev = this.autoCal ? rgbToLab(this.autoCal.color) : null
    const rb = robustBorderKey(cells, prev, {
      kL: this.flags.bkKL > 0 ? this.flags.bkKL : undefined,
      inlierDE: this.flags.bkDE > 0 ? this.flags.bkDE : undefined,
    })
    this.borderStatus = rb.status
    if ((rb.status === 'ok' || rb.status === 'too-dark') && rb.inliers.length) {
      if (rb.status === 'too-dark' && rb.key) this.onSignal?.({ type: 'dark', L: rb.key[0] })
      return autoKeyFromScreen(rb.inliers.flatMap((i) => scr[i])) ?? found
    }
    // Covered / ambiguous: keep the key in use rather than jump to a shirt.
    return prev ? null : found
  }

  /** Magic finger: normalized stage point -> average color of the fg pixels under it. */
  sampleColorAt(nx: number, ny: number): RGB | null {
    const fg = this.fg
    const rect = this.fgRect()
    if (!fg || !rect || !fg.ready()) return null
    let u = (nx * this._width - (rect.cx - rect.w / 2)) / rect.w
    const v = (ny * this._height - (rect.cy - rect.h / 2)) / rect.h
    if (u < 0 || u > 1 || v < 0 || v > 1) return null
    if (this.mirror) u = 1 - u
    const { w, h } = this.colorSize()
    const r = 2 // 5x5 neighbourhood averages out sensor noise
    const sx = Math.min(Math.max(Math.floor(u * w) - r, 0), Math.max(0, w - (2 * r + 1)))
    const sy = Math.min(Math.max(Math.floor(v * h) - r, 0), Math.max(0, h - (2 * r + 1)))
    const n = 2 * r + 1
    const c = makeCanvas(n, n)
    const ctx = ctx2d(c)
    try {
      ctx.drawImage(fg.uploadable() as CanvasImageSource, sx, sy, n, n, 0, 0, n, n)
      const d = ctx.getImageData(0, 0, n, n).data
      const px: RGB[] = []
      for (let i = 0; i < d.length; i += 4) px.push([d[i] / 255, d[i + 1] / 255, d[i + 2] / 255])
      return averageLinear(px)
    } catch {
      return null
    }
  }

  /**
   * How close a colour is to the current key, for "is this shirt screen-coloured?"
   * checks: keyD in ΔE-like units and whether it would (partly) disappear.
   */
  keyDistanceOf(c: RGB): { keyD: number; screenColored: boolean } {
    const keyD = keyDistLab(rgbToLab(c), this.keyLab)
    return { keyD, screenColored: keyD < this.thresholds.hi + 4 }
  }

  getStats(): KeyerStats {
    const n = Math.min(this.frameCount, FRAME_RING)
    const times = Array.from(this.frameTimes.subarray(0, n)).sort((a, b) => a - b)
    const p90 = n ? times[Math.min(n - 1, Math.ceil(0.9 * n) - 1)] : NaN
    const mean = n ? times.reduce((s, v) => s + v, 0) / n : NaN
    const st = this.glState
    return {
      tier: !st ? 'canvas2d' : st.floatOk ? 'webgl-full' : 'webgl-tent',
      analyticKey: !!st?.analytic,
      frameP90Ms: p90,
      frameMeanMs: mean,
      renderCpuMs: this.cpuMsAvg,
      lo: this.thresholds.lo,
      hi: this.thresholds.hi,
      keyColor: labToRgb(this.trackedLab),
      autoKey: this.autoCal ? { p95: this.autoCal.p95, tooUneven: this.autoCal.tooUneven } : null,
      borderKey: this.borderStatus,
      mlWeight: this.mlWeight,
      coreWeight: this.coreWeight,
      mlTrust: this.mlTrust,
      unmix: st && this.flags.unmix > 0 && (st.unmixFmt === 'rgba16f' || st.unmixFmt === 'srgb8') ? st.unmixFmt : 'off',
      maskAgeMs: performance.now() - this.maskAt,
      recalibrations: this.recalibrations,
      lastSample: this.lastSample,
    }
  }

  /** PNG of the current foreground alpha at native resolution (white = me), unmirrored. */
  async renderMatte(): Promise<Blob> {
    const fg = this.fg
    if (!fg || !fg.ready()) throw new Error('No foreground to matte')
    let { w, h } = this.colorSize()
    let pixels: Uint8ClampedArray
    if (this.glState && !this.contextLost) {
      const max = this.glState.gl.getParameter(this.glState.gl.MAX_RENDERBUFFER_SIZE) as number
      const k = Math.min(1, max / Math.max(w, h))
      w = Math.round(w * k)
      h = Math.round(h * k)
      pixels = this.matteGl(this.glState, w, h)
    } else {
      pixels = this.matteCpu(w, h)
    }
    const out = makeCanvas(w, h)
    const img = new ImageData(w, h)
    img.data.set(pixels)
    ctx2d(out).putImageData(img, 0, 0)
    return new Promise<Blob>((resolve, reject) =>
      out.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png'),
    )
  }

  /**
   * Free everything. `releaseContext` also drops the WebGL context itself; pass it
   * only when the canvas is really going away (Safari caps live contexts and frees
   * them lazily), never where StrictMode may remount on the same canvas.
   */
  destroy(opts?: { releaseContext?: boolean }): void {
    this.canvas.removeEventListener('webglcontextlost', this.onLost)
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored)
    for (const t of [this.bg, this.fg, this.maskSrc]) t?.dispose()
    this.bg = this.fg = this.maskSrc = null
    this.maskData = null
    this.onSignal = null
    const st = this.glState
    if (st && !st.gl.isContextLost()) {
      this.freeGl(st)
      if (opts?.releaseContext) st.gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
    this.glState = null
    this.ctx = null
    this.stickerRasters.clear()
    this.front = this.frontRaster = null
  }

  // ---------- key model ----------

  private rebake(lab: Lab) {
    this.keyLab = keyLabFromLab(lab)
    this.lutData = bakeKeyLut(this.keyLab)
    this.spillCh = dominantChannel(labToRgb(lab))
    this.lutDirty = true
  }

  private updateThresholds() {
    const slider = sliderThresholds(this.key.similarity, this.key.smoothness)
    const auto = this.autoCal && sameColor(this.autoCal.color, this.key.color) ? this.autoCal : null
    this.thresholds = combineThresholds(slider, auto)
    this.matteDirty = true
  }

  private clearMask() {
    this.maskDirty = false
    this.maskAt = -Infinity
    this.prepValid = false
    this.prepHasPrev = false
    this.matteDirty = true
    this.mlWeight = 0
  }

  private hasMask(): boolean {
    return !!this.maskData || !!this.maskSrc?.ready()
  }

  private resetPipeline() {
    this.matteValid = false
    this.unValid = false
    this.dsValid = false
    this.gfValid = false
    this.gfHistValid = false
    this.cgfValid = false
    this.prepValid = false
    this.bgBlurDirty = true
    this.bgBlurValid = false
    this.lutDirty = true
    this.maskTexFormat = 'none'
    this.maskDirty = this.hasMask()
    this.resetTemporal()
  }

  // ---------- geometry ----------

  /** Size of the foreground's color image (packed video = top half). */
  private colorSize(): { w: number; h: number } {
    const s = this.fg ? this.fg.size() : { w: 0, h: 0 }
    return this.key.mode === 'packed' ? { w: s.w, h: Math.floor(s.h / 2) } : s
  }

  /** Contain-fit the fg into the stage, then apply the Me transform. */
  private fgRect(): Rect | null {
    const { w, h } = this.colorSize()
    if (!w || !h) return null
    const W = this._width
    const H = this._height
    const aspect = w / h
    let bw: number
    let bh: number
    if (aspect > W / H) {
      bw = W
      bh = W / aspect
    } else {
      bh = H
      bw = H * aspect
    }
    return { cx: this.me.x * W, cy: this.me.y * H, w: bw * this.me.scale, h: bh * this.me.scale }
  }

  private bgRect(w: number, h: number): Rect {
    const k = Math.max(this._width / w, this._height / h)
    return { cx: this._width / 2, cy: this._height / 2, w: w * k, h: h * k }
  }

  private stickerRect(s: StickerDraw): Rect | null {
    const { w, h } = sourceSize(s.image as Drawable)
    if (!w || !h) return null
    const sh = this._height * STICKER_BASE * s.scale
    return { cx: s.x * this._width, cy: s.y * this._height, w: (sh * w) / h, h: sh }
  }

  private replaceBg(src: BackgroundSource | null) {
    this.bg?.dispose()
    this.bg = src ? new TrackedSource(src) : null
  }

  // ---------- WebGL2 setup ----------

  private initGl(gl: WebGL2RenderingContext) {
    const image = link(gl, QUAD_VS, IMAGE_FS, { u_tex: 0 })
    const fg = link(gl, QUAD_VS, FG_FS, { u_fg: 0, u_matte: 1, u_gfAB: 2, u_maskPrep: 3, u_bgBlur: 4, u_cgf: 5, u_unF: 6, u_unB: 7, u_dsMass: 9 })
    const dsDown = link(gl, PASS_VS, DS_DOWN_FS, { u_matte: 0 })
    const dsBox = link(gl, PASS_VS, DS_BOX_FS, { u_src: 0 })
    const gfTemporal = link(gl, PASS_VS, GF_TEMPORAL_FS, { u_cur: 0, u_prev: 1 })
    const checker = link(gl, PASS_VS, CHECKER_FS)
    const gfPack = link(gl, PASS_VS, GF_PACK_FS, { u_matte: 0 })
    const box = link(gl, PASS_VS, BOX_FS, { u_src: 0 })
    const gfCoef = link(gl, PASS_VS, GF_COEF_FS, { u_means: 0 })
    const maskPrep = link(gl, PASS_VS, MASK_PREP_FS, { u_mask: 0, u_prevPrep: 1 })
    const blurDown = link(gl, QUAD_VS, BLUR_DOWN_FS, { u_tex: 0 })
    const sample = link(gl, PASS_VS, SAMPLE_FS, { u_fg: 0, u_matte: 1, u_maskPrep: 2 })
    const cgfPack = link(gl, PASS_VS, CGF_PACK_FS, { u_fg: 0, u_matte: 1 })
    const box4 = link(gl, PASS_VS, BOX4_FS, { u_s0: 0, u_s1: 1, u_s2: 2, u_s3: 3 })
    const boxR = link(gl, PASS_VS, BOXR_FS, { u_src: 0 })
    const cgfCoef = link(gl, PASS_VS, CGF_COEF_FS, { u_m0: 0, u_m1: 1, u_m2: 2, u_m3: 3 })
    const matteUnits = { u_fg: 0, u_mask: 1, u_prev: 2, u_keyLut: 3, u_plate: 4 }
    // Unmix prep: never units 6/7 (where FG_FS binds the textures this pass writes).
    const unmixUnits = { u_fg: 0, u_matte: 1, u_gfAB: 2, u_maskPrep: 3, u_prevB: 4, u_cgf: 5, u_keyLut: 8, u_dsMass: 9 }

    // The 3D LUT is core WebGL2, but keep the analytic shader as a safety net.
    let analytic = false
    let lutTex: WebGLTexture | null = gl.createTexture()
    let matte: Prog
    let unmixPrep: Prog
    try {
      if (!lutTex) throw new Error('createTexture failed')
      uploadKeyLut(gl, lutTex, this.lutData, LUT_N)
      if (gl.getError() !== gl.NO_ERROR) throw new Error('RG8 3D texture upload failed')
      matte = link(gl, PASS_VS, matteFs(false), matteUnits)
      unmixPrep = link(gl, PASS_VS, unmixPrepFs(false), unmixUnits)
    } catch (err) {
      console.warn('[Compositor] LUT key unavailable, using analytic key', err)
      if (lutTex) gl.deleteTexture(lutTex)
      lutTex = null
      analytic = true
      matte = link(gl, PASS_VS, matteFs(true), matteUnits)
      unmixPrep = link(gl, PASS_VS, unmixPrepFs(true), unmixUnits)
    }

    const vao = gl.createVertexArray()
    const buffer = gl.createBuffer()
    if (!vao || !buffer) throw new Error('GL buffer alloc failed')
    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false) // straight alpha end to end

    // Guided filter needs renderable half floats (iOS 15+/most desktops).
    let floatOk = false
    if (gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float')) {
      const probe = createTarget(gl, 4, 4, true)
      floatOk = !!probe
      deleteTargets(gl, [probe])
    }

    this.glState = {
      gl,
      vao,
      buffer,
      image,
      fg,
      matte,
      gfPack,
      box,
      gfCoef,
      maskPrep,
      blurDown,
      sample,
      cgfPack,
      box4,
      boxR,
      cgfCoef,
      unmixPrep,
      dsDown,
      dsBox,
      dsT: null,
      gfTemporal,
      checker,
      gfHist: null,
      unT: null,
      unmixFmt: 'untried',
      mrtOk: floatOk && (gl.getParameter(gl.MAX_DRAW_BUFFERS) as number) >= 4,
      cgf: null,
      analytic,
      floatOk,
      bgTex: newTexture(gl),
      fgTex: newTexture(gl),
      maskTex: newTexture(gl),
      lutTex,
      stickerTex: new Map(),
      frontTex: newTexture(gl),
      frontFor: null,
      matteT: null,
      gfT: null,
      prepT: null,
      bgBlurT: null,
      sampleT: null,
      pbo: gl.createBuffer(),
      pending: null,
    }
    this.resetPipeline()
    this.lutDirty = false // just uploaded above
  }

  private freeGl(st: GlState) {
    const { gl } = st
    for (const p of [st.image, st.fg, st.matte, st.gfPack, st.box, st.gfCoef, st.maskPrep, st.blurDown, st.sample, st.cgfPack, st.box4, st.boxR, st.cgfCoef, st.unmixPrep, st.dsDown, st.dsBox, st.gfTemporal, st.checker]) {
      gl.deleteProgram(p.p)
    }
    gl.deleteBuffer(st.buffer)
    gl.deleteVertexArray(st.vao)
    for (const t of [st.bgTex, st.fgTex, st.maskTex, st.frontTex, ...st.stickerTex.values()]) gl.deleteTexture(t)
    if (st.lutTex) gl.deleteTexture(st.lutTex)
    deleteTargets(gl, st.matteT)
    deleteTargets(gl, st.gfT)
    deleteTargets(gl, st.prepT)
    deleteTargets(gl, st.bgBlurT)
    deleteTargets(gl, st.dsT)
    deleteTargets(gl, st.gfHist)
    deleteTargets(gl, [st.sampleT])
    deleteCgf(gl, st.cgf)
    deleteUnmix(gl, st.unT)
    if (st.pending) gl.deleteSync(st.pending.fence)
    if (st.pbo) gl.deleteBuffer(st.pbo)
  }

  /** Upload if there is a new frame. Returns whether the texture is valid and whether it changed. */
  private upload(gl: WebGL2RenderingContext, tex: WebGLTexture, t: TrackedSource, force = false) {
    if (!t.ready()) return { ok: t.uploaded, fresh: false }
    if (!force && !t.needsUpload()) return { ok: t.uploaded, fresh: false }
    gl.bindTexture(gl.TEXTURE_2D, tex)
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, t.uploadable())
      t.markUploaded()
      return { ok: true, fresh: true }
    } catch (err) {
      // e.g. a cross-origin video without CORS: skip this layer rather than crash the loop.
      console.warn('[Compositor] texture upload failed', err)
      return { ok: t.uploaded, fresh: false }
    }
  }

  private bind(gl: WebGL2RenderingContext, unit: number, tex: WebGLTexture | null, target: number = gl.TEXTURE_2D) {
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(target, tex)
  }

  private drawTo(gl: WebGL2RenderingContext, t: Target) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo)
    gl.viewport(0, 0, t.w, t.h)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  private setQuad(gl: WebGL2RenderingContext, u: Uniforms, r: Rect, rot: number, stageW: number, stageH: number) {
    gl.uniform2f(u.u_stage, stageW, stageH)
    gl.uniform2f(u.u_center, r.cx, r.cy)
    gl.uniform2f(u.u_size, r.w, r.h)
    gl.uniform1f(u.u_rot, rot)
  }

  // ---------- WebGL2 keying passes ----------

  /** (Re)allocate camera-sized targets when the camera resolution changes. */
  private ensureTargets(st: GlState, fw: number, fh: number) {
    const { gl } = st
    const mw = Math.min(fw, MAX_MATTE_W)
    const mh = Math.max(1, Math.round((fh * mw) / fw))
    if (!st.matteT || st.matteT[0].w !== mw || st.matteT[0].h !== mh) {
      deleteTargets(gl, st.matteT)
      deleteTargets(gl, st.gfT)
      deleteTargets(gl, st.dsT)
      deleteTargets(gl, st.gfHist)
      st.gfHist = st.floatOk
        ? (makeTargets(gl, 2, Math.ceil(mw / 2), Math.ceil(mh / 2), true, this.edgeWrap(gl)) as [Target, Target] | null)
        : null
      this.gfHistHasPrev = false
      this.gfHistValid = false
      // Box sums count area: clamp + the shader's off-frame rule, never mirrored (item 1).
      st.dsT = makeTargets(gl, 2, Math.max(1, Math.ceil(mw / 4)), Math.max(1, Math.ceil(mh / 4)), st.floatOk) as [Target, Target] | null
      this.dsValid = false
      const wrap = this.edgeWrap(gl)
      // P2 item 12: 16-bit history removes the 8-bit EMA residue (stuck values on still edges).
      st.matteT = makeTargets(gl, 2, mw, mh, st.floatOk && this.flags.matte16 > 0, wrap) as [Target, Target] | null
      st.gfT = st.floatOk
        ? (makeTargets(gl, 3, Math.ceil(mw / 2), Math.ceil(mh / 2), true, wrap) as [Target, Target, Target] | null)
        : null
      this.matteValid = false
      this.gfValid = false
      this.matteHasPrev = false
    }
    const pw = PREP_W
    const ph = Math.max(1, Math.round((PREP_W * fh) / fw))
    if (!st.prepT || st.prepT[0].w !== pw || st.prepT[0].h !== ph) {
      deleteTargets(gl, st.prepT)
      st.prepT = makeTargets(gl, 2, pw, ph, false, this.edgeWrap(gl)) as [Target, Target] | null
      this.prepValid = false
      this.prepHasPrev = false
    }
  }

  /** Upload the ML mask (if new). Returns true when a new mask arrived. */
  private uploadMask(st: GlState): boolean {
    if (!this.maskDirty) return false
    const { gl } = st
    if (this.maskData) {
      const { data, w, h } = this.maskData
      gl.bindTexture(gl.TEXTURE_2D, st.maskTex)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
      if (this.maskTexFormat !== 'r8' || this.maskTexSize.w !== w || this.maskTexSize.h !== h) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, data.subarray(0, w * h))
        // The prep pass dilates / erodes with taps past the edge (item 1).
        const wrap = this.edgeWrap(gl)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap)
        this.maskTexFormat = 'r8'
        this.maskTexSize = { w, h }
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED, gl.UNSIGNED_BYTE, data.subarray(0, w * h))
      }
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
    } else if (this.maskSrc) {
      if (!this.upload(gl, st.maskTex, this.maskSrc, true).ok) return false
      this.maskTexFormat = 'rgba'
    } else {
      return false
    }
    this.maskDirty = false
    return true
  }

  private runMaskPrep(st: GlState, fw: number, fh: number) {
    const { gl } = st
    const prep = st.prepT
    if (!prep) return
    const cur = 1 - this.prepIdx
    const prev = prep[this.prepIdx]
    gl.disable(gl.BLEND)
    gl.useProgram(st.maskPrep.p)
    const u = st.maskPrep.u
    this.bind(gl, 0, st.maskTex)
    this.bind(gl, 1, prev.tex)
    gl.uniform1i(u.u_hasPrev, this.prepHasPrev && this.prepValid ? 1 : 0)
    const step = (this.flags.helperTrust > 0 ? this.mlDilate : KEYER_TUNING.dilate) / 4
    gl.uniform2f(u.u_dilateStep, step, (step * fw) / fh)
    gl.uniform2f(u.u_texel, 1 / prep[cur].w, 1 / prep[cur].h)
    this.drawTo(gl, prep[cur])
    this.prepIdx = cur
    this.prepValid = true
    this.prepHasPrev = true
  }

  private runMatte(st: GlState, segment: boolean) {
    const { gl } = st
    const mt = st.matteT
    if (!mt) return
    if (this.lutDirty && st.lutTex) {
      uploadKeyLut(gl, st.lutTex, this.lutData, LUT_N)
      this.lutDirty = false
    }
    const cur = 1 - this.matteIdx
    const prev = mt[this.matteIdx]
    gl.disable(gl.BLEND)
    gl.useProgram(st.matte.p)
    const u = st.matte.u
    this.bind(gl, 0, st.fgTex)
    this.bind(gl, 1, st.maskTex)
    this.bind(gl, 2, prev.tex)
    this.bind(gl, 3, st.lutTex, gl.TEXTURE_3D)
    gl.uniform1i(u.u_src, segment ? 1 : 0)
    gl.uniform1i(u.u_hasMask, segment && this.hasMask() && this.maskTexFormat !== 'none' ? 1 : 0)
    gl.uniform1i(u.u_hasPrev, this.matteHasPrev && this.matteValid ? 1 : 0)
    gl.uniform1f(u.u_lo, this.thresholds.lo)
    gl.uniform1f(u.u_hi, this.thresholds.hi)
    gl.uniform1f(u.u_temporal, segment ? this.seg.temporal : this.chromaMatteTemporal(st))
    const [segLo, segHi] = this.segRamp()
    gl.uniform1f(u.u_segLo, segLo)
    gl.uniform1f(u.u_segHi, segHi)
    const fs = this.fg ? this.fg.size() : { w: 1, h: 1 }
    gl.uniform2f(u.u_ftexel, 1 / Math.max(1, fs.w), 1 / Math.max(1, fs.h))
    gl.uniform1i(u.u_ratioGuard, this.flags.ratioGuard > 0 ? 1 : 0)
    if (st.analytic) {
      const k = this.keyLab
      gl.uniform3f(u.u_keyLab, k.L, k.a, k.b)
      gl.uniform2f(u.u_keyDirAB, k.dirA, k.dirB)
      gl.uniform1f(u.u_keyC, k.C)
    }
    // Item 7: flatten the screen with the previous frame's plate (chroma + unmix plate only).
    const plate = !segment && this.flags.flatten > 0 && this.flags.unmix > 0 && this.unValid && st.unT ? st.unT : null
    this.bind(gl, 4, plate ? plate.B[this.unIdx] : null)
    gl.uniform1i(u.u_hasPlate, plate ? 1 : 0)
    gl.uniform1f(u.u_flatten, this.flags.flatten)
    if (plate) {
      const lod = this.flags.flattenLod >= 0 ? this.flags.flattenLod : FLATTEN_TUNING.lod
      gl.uniform1f(u.u_plateLod, Math.min(lod, plate.levels - 2))
      const k = labToRgb([this.keyLab.L, this.keyLab.a, this.keyLab.b])
      gl.uniform3f(u.u_keyLin, srgbToLinear(k[0]), srgbToLinear(k[1]), srgbToLinear(k[2]))
    }
    this.drawTo(gl, mt[cur])
    this.bind(gl, 4, null)
    gl.activeTexture(gl.TEXTURE0)
    this.matteIdx = cur
    this.matteValid = true
    this.matteHasPrev = true
    this.matteDirty = false
    if (!segment && (this.flags.despeckle > 0 || this.flags.holeFill > 0)) this.runDespeckle(st)
    else this.dsValid = false
    if (segment && this.seg.colorGF > 0 && this.runColorGuidedFilter(st)) {
      this.gfValid = false
      this.gfHistValid = false
    } else {
      this.cgfValid = false
      this.runGuidedFilter(st)
    }
    if (!segment && this.flags.unmix > 0) this.runUnmixPrep(st)
    else this.unValid = false
  }

  /** Shared uniforms of FINAL_ALPHA_GLSL (FG_FS and the unmix prep). */
  private setAlphaUniforms(st: GlState, u: Uniforms, mode: KeySettings['mode']) {
    const { gl } = st
    const mt = st.matteT
    gl.uniform1i(u.u_mode, MODE_IDS[mode])
    gl.uniform1i(u.u_hasGF, this.gfValid && st.gfT ? 1 : 0)
    const cgf = mode === 'segment' && this.cgfValid && st.cgf
    gl.uniform1i(u.u_hasCGF, cgf ? 1 : 0)
    const [postLo, postHi] = this.postRamp()
    gl.uniform2f(u.u_post, postLo, postHi)
    gl.uniform2f(u.u_mtexel, mt ? 1 / mt[0].w : 0, mt ? 1 / mt[0].h : 0)
    const ml = mode === 'chroma' && this.prepValid ? this.mlWeight : 0
    gl.uniform1f(u.u_mlWeight, ml)
    gl.uniform1f(u.u_mlTrust, this.flags.helperTrust > 0 ? this.mlTrust : 1)
    gl.uniform1f(u.u_coreWeight, this.coreWeight)
    gl.uniform1f(u.u_choke, this.chokeAmount())
    const ds = mode === 'chroma' && this.dsValid && st.dsT && mt
    gl.uniform1i(u.u_hasDs, ds ? 1 : 0)
    const area = mt ? mt[0].w * mt[0].h : 0
    const minArea = this.flags.dsMinArea >= 0 ? this.flags.dsMinArea : DS_TUNING.minArea
    const minHole = this.flags.dsMinHole >= 0 ? this.flags.dsMinHole : DS_TUNING.minHole
    gl.uniform1f(u.u_dsMinArea, this.flags.despeckle > 0 ? minArea * area : 0)
    gl.uniform1f(u.u_dsMinHole, this.flags.holeFill > 0 ? minHole * area : 0)
  }

  /** Bind the FINAL_ALPHA_GLSL inputs to units 1, 2, 3, 5. */
  private bindAlphaInputs(st: GlState, mode: KeySettings['mode']) {
    const { gl } = st
    const mt = st.matteT
    this.bind(gl, 1, mt ? mt[this.matteIdx].tex : null)
    const coef = this.gfHistValid && st.gfHist ? st.gfHist[this.gfHistIdx].tex : st.gfT ? st.gfT[1].tex : null
    this.bind(gl, 2, coef)
    this.bind(gl, 3, st.prepT ? st.prepT[this.prepIdx].tex : null)
    const cgf = mode === 'segment' && this.cgfValid && st.cgf ? st.cgf : null
    this.bind(gl, 5, cgf ? cgf.coef[0].tex : null)
    this.bind(gl, 9, mode === 'chroma' && this.dsValid && st.dsT ? st.dsT[0].tex : null)
  }

  /**
   * Speck removal + hole fill (item 4): child / screen coverage per 4x4 matte cell,
   * then a 17-cell box mean H and V. FINAL_ALPHA_GLSL reads the result. Fresh camera
   * frames only (runs inside the matte branch).
   */
  private runDespeckle(st: GlState) {
    const { gl } = st
    const d = st.dsT
    const mt = st.matteT
    if (!d || !mt) {
      this.dsValid = false
      return
    }
    gl.disable(gl.BLEND)
    this.bind(gl, 9, null) // feedback-loop rule: never bound while being written
    gl.useProgram(st.dsDown.p)
    this.bind(gl, 0, mt[this.matteIdx].tex)
    gl.uniform2f(st.dsDown.u.u_mtexel, 1 / mt[0].w, 1 / mt[0].h)
    this.drawTo(gl, d[0])
    gl.useProgram(st.dsBox.p)
    this.bind(gl, 0, d[0].tex)
    gl.uniform2f(st.dsBox.u.u_step, 1 / d[0].w, 0)
    this.drawTo(gl, d[1])
    this.bind(gl, 0, d[1].tex)
    gl.uniform2f(st.dsBox.u.u_step, 0, 1 / d[0].h)
    this.drawTo(gl, d[0])
    this.dsValid = true
  }

  /**
   * Foreground unmixing prep (item 3): local foreground donors F̂ and the screen
   * plate B̂ at 1/4 matte resolution, then mipmaps. Runs inside the matte branch,
   * i.e. once per camera frame, so the plate's learn / decay rates are per frame.
   */
  private runUnmixPrep(st: GlState) {
    const { gl } = st
    const mt = st.matteT
    if (!mt || st.unmixFmt === 'off') {
      this.unValid = false
      return
    }
    const w = Math.max(1, Math.ceil(mt[0].w / 4))
    const h = Math.max(1, Math.ceil(mt[0].h / 4))
    const wrap = this.edgeWrap(gl)
    const wantSrgb = this.flags.unmixSrgb8 > 0 || !st.floatOk
    const want: 'rgba16f' | 'srgb8' = wantSrgb ? 'srgb8' : 'rgba16f'
    let u = st.unT
    if (!u || u.w !== w || u.h !== h || u.wrap !== wrap || (st.unmixFmt === 'untried' && u.format !== want)) {
      deleteUnmix(gl, u)
      st.unT = null
      u = (want === 'rgba16f' ? createUnmix(gl, w, h, 'rgba16f', wrap) : null) ?? createUnmix(gl, w, h, 'srgb8', wrap)
      if (!u) {
        st.unmixFmt = 'off'
        this.unValid = false
        return
      }
      st.unT = u
      st.unmixFmt = u.format
      this.unHasPrev = false
    }
    const cur = 1 - this.unIdx
    gl.disable(gl.BLEND)
    gl.useProgram(st.unmixPrep.p)
    const pu = st.unmixPrep.u
    // Feedback-loop rule: nothing this pass writes may be bound to a unit it samples.
    // FG_FS binds F / B on units 6 and 7; clear them, then bind only the previous B.
    this.bind(gl, 6, null)
    this.bind(gl, 7, null)
    this.bind(gl, 0, st.fgTex)
    this.bindAlphaInputs(st, 'chroma')
    this.bind(gl, 4, u.B[this.unIdx])
    this.bind(gl, 8, st.lutTex, gl.TEXTURE_3D)
    this.setAlphaUniforms(st, pu, 'chroma')
    const hasPrev = this.unHasPrev && this.unValid
    gl.uniform1i(pu.u_hasPrevB, hasPrev ? 1 : 0)
    gl.uniform1f(pu.u_plateRate, hasPrev ? UNMIX_TUNING.plateRate : 1)
    gl.uniform1f(pu.u_plateDecay, UNMIX_TUNING.plateDecay)
    gl.uniform1f(pu.u_lo, this.thresholds.lo)
    gl.uniform1f(pu.u_hi, this.thresholds.hi)
    gl.uniform2f(pu.u_ptexel, 1 / w, 1 / h)
    gl.uniform1i(pu.u_taps, (this.flags.unmixTaps > 0 ? this.flags.unmixTaps : UNMIX_TUNING.prepTaps) === 1 ? 1 : 4)
    gl.uniform1f(pu.u_helperDonors, this.flags.flattenHelperDonors > 0 ? 1 : 0)
    gl.uniform2f(pu.u_keyHueDir, this.keyLab.dirA, this.keyLab.dirB)
    if (st.analytic) {
      const k = this.keyLab
      gl.uniform3f(pu.u_keyLab, k.L, k.a, k.b)
      gl.uniform2f(pu.u_keyDirAB, k.dirA, k.dirB)
      gl.uniform1f(pu.u_keyC, k.C)
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, u.fbo[cur])
    gl.viewport(0, 0, w, h)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    this.bind(gl, 4, null)
    this.bind(gl, 8, null, gl.TEXTURE_3D)
    for (const t of [u.F, u.B[cur]]) {
      gl.bindTexture(gl.TEXTURE_2D, t)
      gl.generateMipmap(gl.TEXTURE_2D)
    }
    gl.activeTexture(gl.TEXTURE0)
    this.unIdx = cur
    this.unValid = true
    this.unHasPrev = true
  }

  /**
   * Colour guided filter for the AI cutout at a small working size: pack (MRT) →
   * box² → coefficients → box². The fg pass applies a·I + b at full resolution.
   * Returns false when MRT / float targets are unavailable (luma filter instead).
   */
  private runColorGuidedFilter(st: GlState): boolean {
    const { gl } = st
    const mt = st.matteT
    if (!st.mrtOk || !mt) return false
    const gw = Math.max(16, Math.min(mt[0].w, Math.round(this.seg.gfW)))
    const gh = Math.max(9, Math.round((gw * mt[0].h) / mt[0].w))
    if (!st.cgf || st.cgf.a.w !== gw || st.cgf.a.h !== gh) {
      deleteCgf(gl, st.cgf)
      st.cgf = null
      // Clamp, not mirrored: mirroring here scored slightly worse on `classroom` (item 1).
      const a = createMrt(gl, gw, gh, 4)
      const b = createMrt(gl, gw, gh, 4)
      const coef = makeTargets(gl, 2, gw, gh, true) as [Target, Target] | null
      if (!a || !b || !coef) {
        deleteMrt(gl, a)
        deleteMrt(gl, b)
        deleteTargets(gl, coef)
        st.mrtOk = false
        return false
      }
      st.cgf = { a, b, coef }
    }
    const { a, b, coef } = st.cgf
    const r = Math.max(1, Math.min(16, Math.round(this.seg.gfRadius)))
    gl.disable(gl.BLEND)
    gl.viewport(0, 0, gw, gh)
    // pack
    gl.useProgram(st.cgfPack.p)
    this.bind(gl, 0, st.fgTex)
    this.bind(gl, 1, mt[this.matteIdx].tex)
    gl.uniform2f(st.cgfPack.u.u_otexel, 1 / gw, 1 / gh)
    gl.bindFramebuffer(gl.FRAMEBUFFER, a.fbo)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    // box: a -> (H) -> b -> (V) -> a
    gl.useProgram(st.box4.p)
    gl.uniform1i(st.box4.u.u_radius, r)
    for (const [src, dst, step] of [
      [a, b, [1 / gw, 0]],
      [b, a, [0, 1 / gh]],
    ] as const) {
      for (let i = 0; i < 4; i++) this.bind(gl, i, src.tex[i])
      gl.uniform2f(st.box4.u.u_step, step[0], step[1])
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }
    // coefficients -> coef[0], then box -> coef[1] -> coef[0]
    gl.useProgram(st.cgfCoef.p)
    for (let i = 0; i < 4; i++) this.bind(gl, i, a.tex[i])
    gl.uniform1f(st.cgfCoef.u.u_eps, this.seg.gfEps)
    this.drawTo(gl, coef[0])
    gl.useProgram(st.boxR.p)
    gl.uniform1i(st.boxR.u.u_radius, r)
    this.bind(gl, 0, coef[0].tex)
    gl.uniform2f(st.boxR.u.u_step, 1 / gw, 0)
    this.drawTo(gl, coef[1])
    this.bind(gl, 0, coef[1].tex)
    gl.uniform2f(st.boxR.u.u_step, 0, 1 / gh)
    this.drawTo(gl, coef[0])
    for (let i = 1; i < 4; i++) this.bind(gl, i, null)
    gl.activeTexture(gl.TEXTURE0)
    this.cgfValid = true
    return true
  }

  /** Fast guided filter at half res: pack → box² → coefficients → box². */
  private runGuidedFilter(st: GlState) {
    const { gl } = st
    const g = st.gfT
    const mt = st.matteT
    if (!g || !mt) {
      this.gfValid = false
      return
    }
    const [t0, t1, t2] = g
    gl.useProgram(st.gfPack.p)
    this.bind(gl, 0, mt[this.matteIdx].tex)
    this.drawTo(gl, t0)
    this.boxBlur(st, t0, t1)
    gl.useProgram(st.gfCoef.p)
    gl.uniform1f(st.gfCoef.u.u_eps, KEYER_TUNING.gfEps)
    this.bind(gl, 0, t0.tex)
    this.drawTo(gl, t1)
    this.boxBlur(st, t1, t2)
    this.gfValid = true
    // Item 5: EMA the coefficients (only here, i.e. once per camera frame).
    const hist = st.gfHist
    // Chroma only: in segment mode without the colour GF the luma GF keeps today's path.
    if (hist && this.gfTemporalOn(st) && this.key.mode === 'chroma') {
      const cur = 1 - this.gfHistIdx
      // Unit 2 may still hold a history texture from the last draw: clear it first.
      this.bind(gl, 2, null)
      gl.useProgram(st.gfTemporal.p)
      const u = st.gfTemporal.u
      this.bind(gl, 0, t1.tex)
      this.bind(gl, 1, hist[this.gfHistIdx].tex)
      gl.uniform1i(u.u_hasPrev, this.gfHistHasPrev && this.gfHistValid ? 1 : 0)
      gl.uniform1f(u.u_cTemporal, this.flags.gfCT >= 0 ? this.flags.gfCT : GF_TEMPORAL_TUNING.cTemporal)
      const g = this.flags.gfGuard
      gl.uniform2f(u.u_guard, g > 0 ? g / 4 : GF_TEMPORAL_TUNING.guardLo, g > 0 ? g : GF_TEMPORAL_TUNING.guardHi)
      this.drawTo(gl, hist[cur])
      this.bind(gl, 1, null)
      gl.activeTexture(gl.TEXTURE0)
      this.gfHistIdx = cur
      this.gfHistValid = true
      this.gfHistHasPrev = true
    } else {
      this.gfHistValid = false
      this.gfHistHasPrev = false
    }
  }

  /** Separable box radius 4: a → (H) → b → (V) → a. Result ends in `a`. */
  private boxBlur(st: GlState, a: Target, b: Target) {
    const { gl } = st
    gl.useProgram(st.box.p)
    this.bind(gl, 0, a.tex)
    gl.uniform2f(st.box.u.u_step, 1 / a.w, 0)
    this.drawTo(gl, b)
    this.bind(gl, 0, b.tex)
    gl.uniform2f(st.box.u.u_step, 0, 1 / b.h)
    this.drawTo(gl, a)
  }

  /** 1/8-stage blurred background for the light wrap. */
  private rebuildBgBlur(st: GlState, bgOk: boolean) {
    const { gl } = st
    const bw = Math.max(1, Math.round(this._width / 8))
    const bh = Math.max(1, Math.round(this._height / 8))
    if (!st.bgBlurT || st.bgBlurT[0].w !== bw || st.bgBlurT[0].h !== bh) {
      deleteTargets(gl, st.bgBlurT)
      st.bgBlurT = makeTargets(gl, 2, bw, bh, false) as [Target, Target] | null
    }
    const t = st.bgBlurT
    if (!t) {
      this.bgBlurValid = false
      return
    }
    gl.disable(gl.BLEND)
    gl.bindFramebuffer(gl.FRAMEBUFFER, t[0].fbo)
    gl.viewport(0, 0, bw, bh)
    gl.clearColor(this.bgColor[0], this.bgColor[1], this.bgColor[2], 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    if (bgOk && this.bg) {
      const s = this.bg.size()
      const r = this.bgRect(s.w, s.h)
      gl.useProgram(st.blurDown.p)
      this.bind(gl, 0, st.bgTex)
      this.setQuad(gl, st.blurDown.u, r, 0, this._width, this._height)
      gl.uniform2f(st.blurDown.u.u_footprint, this._width / bw / r.w, this._height / bh / r.h)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }
    this.boxBlur(st, t[0], t[1])
    this.bgBlurValid = true
    this.bgBlurDirty = false
    this.bgBlurHadBg = bgOk && !!this.bg
    this.bgFreshSinceBlur = 0
  }

  /**
   * Bring the fg texture and every keying pass up to date. Returns whether the
   * fg texture holds valid pixels.
   */
  private prepareFg(st: GlState): boolean {
    const fg = this.fg
    if (!fg) return false
    const { gl } = st
    const up = this.upload(gl, st.fgTex, fg)
    if (!up.ok) return false
    const mode = this.key.mode
    if (mode !== 'chroma' && mode !== 'segment') return true
    const { w: fw, h: fh } = this.colorSize()
    if (!fw || !fh) return true
    this.ensureTargets(st, fw, fh)
    const maskNew = this.uploadMask(st)
    if (maskNew && mode === 'chroma') this.runMaskPrep(st, fw, fh)
    if (up.fresh || this.matteDirty || !this.matteValid || (maskNew && mode === 'segment')) {
      this.runMatte(st, mode === 'segment')
    }
    return true
  }

  private drawFg(st: GlState, rect: Rect, stageW: number, stageH: number, matteOut: boolean): boolean {
    const { gl } = st
    const u = st.fg.u
    const fg = this.fg
    if (!fg || !fg.uploaded) return false
    const mode = this.key.mode
    const keyed = mode === 'chroma' || mode === 'segment'
    const mt = st.matteT
    gl.useProgram(st.fg.p)
    this.setQuad(gl, u, rect, 0, stageW, stageH)
    this.bind(gl, 0, st.fgTex)
    this.bindAlphaInputs(st, mode)
    this.bind(gl, 4, st.bgBlurT ? st.bgBlurT[0].tex : null)
    // The matte output needs the pyramids too when item 16 changes alpha with them.
    const un = mode === 'chroma' && (!matteOut || this.flags.projAlpha > 0) && this.flags.unmix > 0 && this.unValid && st.unT ? st.unT : null
    this.bind(gl, 6, un ? un.F : null)
    this.bind(gl, 7, un ? un.B[this.unIdx] : null)
    gl.uniform1i(u.u_hasUnmix, un ? 1 : 0)
    gl.uniform1f(u.u_unmix, UNMIX_TUNING.strength)
    gl.uniform1f(u.u_unCap, this.flags.unmixCap >= 0 ? this.flags.unmixCap : UNMIX_TUNING.cap)
    gl.uniform1f(u.u_unSpillKeep, this.flags.unmixSpillKeep >= 0 ? this.flags.unmixSpillKeep : UNMIX_TUNING.spillKeep)
    gl.uniform1f(u.u_unProj, this.unmixProj())
    gl.uniform1f(u.u_projAlpha, Math.max(0, this.flags.projAlpha))
    gl.uniform1i(u.u_projWide, this.flags.projAlphaWide > 0 ? 1 : 0)
    gl.uniform1f(u.u_projTaper, Math.max(0, this.flags.projTaper))
    this.setAlphaUniforms(st, u, mode)
    gl.uniform1i(u.u_mirror, matteOut ? 0 : this.mirror ? 1 : 0)
    gl.uniform1i(u.u_matteOut, matteOut ? 1 : 0)
    gl.uniform1i(u.u_hasMatte, keyed && this.matteValid && mt ? 1 : 0)
    gl.uniform1i(u.u_hasBgBlur, !matteOut && !this.checker && this.bgBlurValid ? 1 : 0)
    const ts = fg.size()
    gl.uniform2f(u.u_texel, 1 / Math.max(1, ts.w), 1 / Math.max(1, ts.h))
    gl.uniform1f(u.u_spill, mode === 'chroma' ? Math.min(1, Math.max(0, this.key.spill)) : 0)
    gl.uniform1f(u.u_wrap, mode === 'segment' ? this.seg.wrap : KEYER_TUNING.wrap)
    gl.uniform1i(u.u_spillCh, this.spillCh)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.activeTexture(gl.TEXTURE0)
    return true
  }

  private renderGl(st: GlState) {
    const { gl } = st
    const W = this._width
    const H = this._height
    gl.bindVertexArray(st.vao)

    // Offscreen passes first (they change the framebuffer binding and viewport).
    const fgOk = this.prepareFg(st)
    let bgOk = false
    if (this.bg) {
      const up = this.upload(gl, st.bgTex, this.bg)
      bgOk = up.ok
      // Moving worlds (canvas/video) upload a fresh frame nearly every frame. The light
      // wrap only tints the child's edges with a 1/8-size blur, so refresh it every
      // BG_BLUR_EVERY fresh frames instead of every frame (still images: first upload only).
      if (up.fresh && (!this.bgBlurHadBg || ++this.bgFreshSinceBlur >= BG_BLUR_EVERY)) this.bgBlurDirty = true
    }
    if (this.bgBlurDirty) this.rebuildBgBlur(st, bgOk)

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, W, H)
    gl.clearColor(this.bgColor[0], this.bgColor[1], this.bgColor[2], 1)
    gl.clear(gl.COLOR_BUFFER_BIT)

    // Background: opaque cover-fit, no blending needed.
    gl.disable(gl.BLEND)
    if (this.checker) {
      gl.useProgram(st.checker.p)
      gl.uniform2f(st.checker.u.u_stage, W, H)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    } else if (this.bg && bgOk) {
      const s = this.bg.size()
      gl.useProgram(st.image.p)
      this.bind(gl, 0, st.bgTex)
      this.setQuad(gl, st.image.u, this.bgRect(s.w, s.h), 0, W, H)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }

    // Straight-alpha "over" for the Me layer and stickers.
    gl.enable(gl.BLEND)
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    const rect = this.fgRect()
    if (rect && fgOk) this.drawFg(st, rect, W, H, false)

    const front = this.checker ? null : this.frontTexture(st)
    if (front) {
      gl.useProgram(st.image.p)
      this.bind(gl, 0, front.tex)
      this.setQuad(gl, st.image.u, this.bgRect(front.w, front.h), 0, W, H)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }

    if (this.stickers.length) {
      gl.useProgram(st.image.p)
      gl.activeTexture(gl.TEXTURE0)
      for (const s of this.stickers) {
        const tex = this.stickerTexture(st, s.image)
        const r = tex && this.stickerRect(s)
        if (!tex || !r) continue
        gl.bindTexture(gl.TEXTURE_2D, tex)
        this.setQuad(gl, st.image.u, r, s.rotation, W, H)
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      }
    }
    gl.disable(gl.BLEND)

    if (fgOk) this.driftTick(st)
  }

  /** Upload the front layer once per image (and again after a context restore). */
  private frontTexture(st: GlState): { tex: WebGLTexture; w: number; h: number } | null {
    const img = this.front
    if (!img || !isReady(img as Drawable)) return null
    const src = this.frontSource(img)
    if (st.frontFor !== img) {
      const { gl } = st
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, st.frontTex)
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src)
      } catch {
        return null
      }
      st.frontFor = img
    }
    return { tex: st.frontTex, w: src.width, h: src.height }
  }

  /** SVG images go through a canvas so Safari uploads them at their full raster size. */
  private frontSource(img: HTMLImageElement | ImageBitmap): HTMLCanvasElement | ImageBitmap {
    if (!isImage(img)) return img
    this.frontRaster ??= rasterize(img)
    return this.frontRaster
  }

  private stickerTexture(st: GlState, img: HTMLImageElement | ImageBitmap): WebGLTexture | null {
    const cached = st.stickerTex.get(img)
    if (cached) return cached
    if (!isReady(img as Drawable)) return null
    const { gl } = st
    const tex = newTexture(gl)
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.stickerSource(img))
    } catch {
      gl.deleteTexture(tex)
      return null
    }
    st.stickerTex.set(img, tex)
    return tex
  }

  private stickerSource(img: HTMLImageElement | ImageBitmap): HTMLCanvasElement | ImageBitmap {
    if (!isImage(img)) return img
    let r = this.stickerRasters.get(img)
    if (!r) {
      r = rasterize(img)
      this.stickerRasters.set(img, r)
    }
    return r
  }

  /**
   * Harness only: read back the matte of the last render() at camera resolution
   * (R = alpha, top row first, unmirrored) WITHOUT re-running any keying pass, so
   * temporal state is untouched. Null on the Canvas2D path or before a frame.
   */
  debugReadMatte(): { data: Uint8Array; w: number; h: number } | null {
    const st = this.glState
    const fg = this.fg
    if (!st || this.contextLost || !fg || !fg.uploaded) return null
    const { w, h } = this.colorSize()
    if (!w || !h) return null
    const { gl } = st
    gl.bindVertexArray(st.vao)
    const target = createTarget(gl, w, h, false)
    if (!target) return null
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo)
    gl.viewport(0, 0, w, h)
    gl.disable(gl.BLEND)
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    this.drawFg(st, { cx: w / 2, cy: h / 2, w, h }, w, h, true)
    const raw = new Uint8Array(w * h * 4)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    deleteTargets(gl, [target])
    gl.viewport(0, 0, this._width, this._height)
    const out = new Uint8Array(w * h)
    for (let y = 0; y < h; y++) {
      const src = (h - 1 - y) * w * 4
      for (let x = 0; x < w; x++) out[y * w + x] = raw[src + x * 4]
    }
    return { data: out, w, h }
  }

  private matteGl(st: GlState, w: number, h: number): Uint8ClampedArray {
    const { gl } = st
    gl.bindVertexArray(st.vao)
    if (!this.prepareFg(st)) throw new Error('Foreground not ready')
    const target = createTarget(gl, w, h, false)
    if (!target) throw new Error('Could not allocate matte target')
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo)
    gl.viewport(0, 0, w, h)
    gl.disable(gl.BLEND)
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    this.drawFg(st, { cx: w / 2, cy: h / 2, w, h }, w, h, true)
    const raw = new Uint8Array(w * h * 4)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    deleteTargets(gl, [target])
    gl.viewport(0, 0, this._width, this._height)
    // readPixels is bottom-up; QUAD_VS maps v = 0 to the top row, so flip.
    const out = new Uint8ClampedArray(w * h * 4)
    const row = w * 4
    for (let y = 0; y < h; y++) out.set(raw.subarray((h - 1 - y) * row, (h - y) * row), y * row)
    return out
  }

  // ---------- drift tracking + shirt check (async readback) ----------

  /**
   * Every ~2 s: render a tiny (camera colour, matte, ML core) frame and read it
   * back through a PIXEL_PACK_BUFFER + fence so the main thread never stalls on
   * the GPU. The result nudges the key toward the screen's current colour (iPad
   * auto white balance can't be locked) and looks for screen-coloured clothing.
   */
  private driftTick(st: GlState) {
    const { gl } = st
    if (st.pending) {
      const status = gl.clientWaitSync(st.pending.fence, 0, 0)
      if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) {
        const { w, h } = st.pending
        const data = new Uint8Array(w * h * 4)
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, st.pbo)
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, data)
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
        gl.deleteSync(st.pending.fence)
        st.pending = null
        this.processSample(data, w, h)
      } else if (status === gl.WAIT_FAILED || performance.now() - st.pending.at > 5000) {
        gl.deleteSync(st.pending.fence)
        st.pending = null
      }
      return
    }
    const now = performance.now()
    if (this.key.mode !== 'chroma' || !this.fg || !(this.fgLive || isVideo(this.fg.src)) || !this.matteValid || !st.pbo)
      return
    if (now - this.lastSampleAt < RECAL_MS) return
    this.lastSampleAt = now
    const { w: fw, h: fh } = this.colorSize()
    const sw = SAMPLE_W
    const sh = Math.max(1, Math.round((SAMPLE_W * fh) / fw))
    if (!st.sampleT || st.sampleT.w !== sw || st.sampleT.h !== sh) {
      deleteTargets(gl, [st.sampleT])
      st.sampleT = createTarget(gl, sw, sh, false)
      if (!st.sampleT) return
    }
    const mt = st.matteT
    if (!mt) return
    gl.disable(gl.BLEND)
    gl.useProgram(st.sample.p)
    this.bind(gl, 0, st.fgTex)
    this.bind(gl, 1, mt[this.matteIdx].tex)
    this.bind(gl, 2, st.prepT ? st.prepT[this.prepIdx].tex : null)
    gl.uniform1i(st.sample.u.u_hasPrep, this.prepValid && this.mlWeight > 0.5 ? 1 : 0)
    this.drawTo(gl, st.sampleT)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, st.pbo)
    gl.bufferData(gl.PIXEL_PACK_BUFFER, sw * sh * 4, gl.STREAM_READ)
    gl.readPixels(0, 0, sw, sh, gl.RGBA, gl.UNSIGNED_BYTE, 0)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
    if (fence) st.pending = { fence, w: sw, h: sh, at: now }
    gl.flush()
  }

  /** Rows are top-first (PASS_VS convention). a = matte nibble << 4 | ML core nibble. */
  private processSample(data: Uint8Array, w: number, h: number) {
    const n = w * h
    const screen: RGB[] = []
    for (let i = 0; i < n; i++) {
      if (data[i * 4 + 3] >> 4 === 0) screen.push([data[i * 4] / 255, data[i * 4 + 1] / 255, data[i * 4 + 2] / 255])
    }
    // 1) Drift: EMA the key toward the clearly-keyed pixels' mean (in Lab).
    if (screen.length >= n * 0.05) {
      const mean = averageLinear(screen)
      if (mean) {
        const lab = rgbToLab(mean)
        // Only follow colours that already key as screen: never drift onto a kid.
        if (keyDistLab(lab, this.keyLab) < this.thresholds.lo) {
          const t = this.trackedLab
          this.trackedLab = [
            t[0] + (lab[0] - t[0]) * RECAL_EMA,
            t[1] + (lab[1] - t[1]) * RECAL_EMA,
            t[2] + (lab[2] - t[2]) * RECAL_EMA,
          ]
          const baked: Lab = [this.keyLab.L, this.keyLab.a, this.keyLab.b]
          if (deltaE00(baked, this.trackedLab) > RECAL_REBAKE_DE) {
            this.rebake(this.trackedLab)
            this.recalibrations++
            this.matteDirty = true
          }
        }
      }
    }
    // 2) Screen-coloured clothing.
    const useMl = this.mlWeight > 0.5 && this.prepValid
    const check = useMl ? this.shirtFromMl(data, n) : this.shirtFromHoles(data, w, h)
    this.lastSample = { screenFrac: screen.length / n, method: useMl ? 'ml' : 'holes', ...check.diag }
    if (this.shirtSignalled) return
    const suspect = check.suspect
    this.shirtHits = suspect ? this.shirtHits + 1 : 0
    if (this.shirtHits >= 2) {
      this.shirtSignalled = true
      this.onSignal?.({ type: 'shirt' })
    }
  }

  /** ML says "definitely a kid" but the chroma key removed a good part of it. */
  private shirtFromMl(data: Uint8Array, n: number): ShirtCheck {
    let core = 0
    let keyed = 0
    for (let i = 0; i < n; i++) {
      const a = data[i * 4 + 3]
      if ((a & 15) >= 13) {
        core++
        if (a >> 4 <= 7) keyed++
      }
    }
    const score = core ? keyed / core : 0
    return { suspect: core >= n * 0.02 && score > 0.15, diag: { score, keyDGap: 0 } }
  }

  /**
   * Without ML: keyed-out regions not connected to the top/left/right border are
   * holes inside the kid (the bottom edge is excluded because shirts reach it).
   * Arm gaps are holes too, but they are real screen with the screen's keyD; a
   * shirt is a different (usually darker, hue-shifted) green with a higher keyD.
   */
  private shirtFromHoles(data: Uint8Array, w: number, h: number): ShirtCheck {
    const n = w * h
    const keyed = new Uint8Array(n)
    for (let i = 0; i < n; i++) keyed[i] = data[i * 4 + 3] >> 4 <= 7 ? 1 : 0
    const seen = new Uint8Array(n)
    const stack: number[] = []
    const push = (i: number) => {
      if (keyed[i] && !seen[i]) {
        seen[i] = 1
        stack.push(i)
      }
    }
    for (let x = 0; x < w; x++) push(x)
    for (let y = 0; y < h; y++) {
      push(y * w)
      push(y * w + w - 1)
    }
    while (stack.length) {
      const i = stack.pop()!
      const x = i % w
      if (x > 0) push(i - 1)
      if (x < w - 1) push(i + 1)
      if (i >= w) push(i - w)
      if (i < n - w) push(i + w)
    }
    let holeN = 0
    let holeD = 0
    let screenN = 0
    let screenD = 0
    for (let i = 0; i < n; i++) {
      if (!keyed[i]) continue
      const [d] = sampleKeyLut(this.lutData, LUT_N, data[i * 4] / 255, data[i * 4 + 1] / 255, data[i * 4 + 2] / 255)
      if (seen[i]) {
        screenN++
        screenD += d
      } else {
        holeN++
        holeD += d
      }
    }
    const gap = holeN && screenN ? holeD / holeN - screenD / screenN : 0
    const diag = { score: holeN / n, keyDGap: gap }
    return { suspect: holeN >= n * 0.03 && screenN >= n * 0.05 && gap > SHIRT_KEYD_GAP, diag }
  }

  // ---------- Canvas2D + CPU fallback ----------

  private render2d(ctx: CanvasRenderingContext2D) {
    const W = this._width
    const H = this._height
    const [r, g, b] = this.bgColor
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = 1
    ctx.fillStyle = `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`
    ctx.fillRect(0, 0, W, H)

    if (this.bg?.ready()) {
      const s = this.bg.size()
      const rect = this.bgRect(s.w, s.h)
      this.safeDraw(ctx, this.bg.uploadable() as CanvasImageSource, rect)
    }

    const rect = this.fgRect()
    const layer = rect && this.fg?.ready() ? this.keyedLayer2d() : null
    if (rect && layer) {
      ctx.save()
      ctx.translate(rect.cx, rect.cy)
      if (this.mirror) ctx.scale(-1, 1)
      this.safeDraw(ctx, layer, { cx: 0, cy: 0, w: rect.w, h: rect.h })
      ctx.restore()
    }

    if (this.front && !this.checker && isReady(this.front as Drawable)) {
      const src = this.frontSource(this.front)
      this.safeDraw(ctx, src, this.bgRect(src.width, src.height))
    }

    for (const s of this.stickers) {
      const sr = this.stickerRect(s)
      if (!sr || !isReady(s.image as Drawable)) continue
      ctx.save()
      ctx.translate(sr.cx, sr.cy)
      ctx.rotate(s.rotation)
      this.safeDraw(ctx, this.stickerSource(s.image), { cx: 0, cy: 0, w: sr.w, h: sr.h })
      ctx.restore()
    }
  }

  private safeDraw(ctx: CanvasRenderingContext2D, src: CanvasImageSource, r: Rect) {
    try {
      ctx.drawImage(src, r.cx - r.w / 2, r.cy - r.h / 2, r.w, r.h)
    } catch {
      /* source not decodable this frame */
    }
  }

  /** Produce the keyed fg as a small canvas (processing resolution). */
  private keyedLayer2d(): CanvasImageSource | null {
    const fg = this.fg
    if (!fg) return null
    const mode = this.key.mode
    const src = fg.uploadable() as CanvasImageSource
    // These need no per-pixel work: the browser already handles source alpha.
    if (mode === 'none' || mode === 'alpha') return src
    const { w, h } = this.colorSize()
    const k = Math.min(1, FALLBACK_PROC_HEIGHT / h)
    const pw = Math.max(1, Math.round(w * k))
    const ph = Math.max(1, Math.round(h * k))
    const pixels = this.keyPixels(pw, ph, w, h)
    if (!pixels) return src
    this.work ??= makeCanvas(pw, ph)
    if (this.work.width !== pw || this.work.height !== ph) {
      this.work.width = pw
      this.work.height = ph
    }
    const img = new ImageData(pw, ph)
    img.data.set(pixels)
    ctx2d(this.work).putImageData(img, 0, 0)
    return this.work
  }

  /** A drawable for the current mask (2D path), or null. */
  private maskDrawable(): CanvasImageSource | null {
    if (this.maskSrc?.ready()) return this.maskSrc.uploadable() as CanvasImageSource
    const m = this.maskData
    if (!m) return null
    this.maskCanvas2d ??= makeCanvas(m.w, m.h)
    const c = this.maskCanvas2d
    if (this.maskDirty || c.width !== m.w || c.height !== m.h) {
      c.width = m.w
      c.height = m.h
      const img = new ImageData(m.w, m.h)
      for (let i = 0, j = 0; i < m.w * m.h; i++, j += 4) {
        img.data[j] = img.data[j + 1] = img.data[j + 2] = m.data[i]
        img.data[j + 3] = 255
      }
      ctx2d(c).putImageData(img, 0, 0)
      this.maskDirty = false
    }
    return c
  }

  /**
   * Straight-alpha RGBA of the fg at (pw, ph), keyed per the current mode.
   * Shared by the 2D render path and the CPU matte.
   */
  private keyPixels(pw: number, ph: number, w: number, h: number): Uint8ClampedArray | null {
    const fg = this.fg
    if (!fg) return null
    const src = fg.uploadable() as CanvasImageSource
    const mode = this.key.mode
    const scratch = this.readScratch(pw, ph)
    try {
      scratch.ctx.clearRect(0, 0, pw, ph)
      scratch.ctx.drawImage(src, 0, 0, w, h, 0, 0, pw, ph)
      const data = scratch.ctx.getImageData(0, 0, pw, ph).data
      if (mode === 'chroma') {
        this.cpuChroma(data, pw, ph)
      } else if (mode === 'packed') {
        const a = this.alphaScratch(pw, ph)
        a.clearRect(0, 0, pw, ph)
        a.drawImage(src, 0, h, w, h, 0, 0, pw, ph)
        const ad = a.getImageData(0, 0, pw, ph).data
        for (let i = 0; i < data.length; i += 4) data[i + 3] = ad[i]
      } else if (mode === 'segment') {
        const mask = this.maskDrawable()
        if (mask) {
          const a = this.alphaScratch(pw, ph)
          a.clearRect(0, 0, pw, ph)
          a.drawImage(mask, 0, 0, pw, ph)
          const ad = a.getImageData(0, 0, pw, ph).data
          for (let i = 0; i < data.length; i += 4) {
            const t = Math.min(1, Math.max(0, (ad[i] / 255 - 0.3) / 0.4))
            data[i + 3] = Math.round(t * t * (3 - 2 * t) * 255)
          }
        }
      } else if (mode === 'none') {
        for (let i = 3; i < data.length; i += 4) data[i] = 255
      }
      return data
    } catch {
      return null
    }
  }

  private readScratch(w: number, h: number): { ctx: CanvasRenderingContext2D } {
    if (!this.scratch) {
      const canvas = makeCanvas(w, h)
      this.scratch = { canvas, ctx: ctx2d(canvas) }
    }
    if (this.scratch.canvas.width !== w || this.scratch.canvas.height !== h) {
      this.scratch.canvas.width = w
      this.scratch.canvas.height = h
    }
    return this.scratch
  }

  private alphaScratch(pw: number, ph: number): CanvasRenderingContext2D {
    this.workAlpha ??= makeCanvas(pw, ph)
    if (this.workAlpha.width !== pw || this.workAlpha.height !== ph) {
      this.workAlpha.width = pw
      this.workAlpha.height = ph
    }
    return ctx2d(this.workAlpha)
  }

  /** CPU chroma key (nearest LUT cell) + 3x3 tent-filtered matte + choke + despill, in place. */
  private cpuChroma(data: Uint8ClampedArray, w: number, h: number) {
    const { lo, hi } = this.thresholds
    const spill = Math.min(1, Math.max(0, this.key.spill))
    const spillKey = labToRgb(this.trackedLab)
    const lut = this.lutData
    const idx = this.byteIndex
    const N = LUT_N
    const raw = new Float32Array(w * h)
    const span = hi - lo
    for (let i = 0, j = 0; j < raw.length; i += 4, j++) {
      const cell = (idx[data[i]] + N * (idx[data[i + 1]] + N * idx[data[i + 2]])) * 2
      const t = Math.min(1, Math.max(0, ((lut[cell] / 255) * LUT_RANGE - lo) / span))
      raw[j] = Math.max(t * t * (3 - 2 * t), lut[cell + 1] / 255)
    }
    const choke = this.chokeAmount()
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - 1) * w
      const y1 = y * w
      const y2 = Math.min(h - 1, y + 1) * w
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - 1)
        const x2 = Math.min(w - 1, x + 1)
        const tent =
          (raw[y0 + x0] + raw[y0 + x2] + raw[y2 + x0] + raw[y2 + x2] +
            2 * (raw[y0 + x] + raw[y2 + x] + raw[y1 + x0] + raw[y1 + x2]) +
            4 * raw[y1 + x]) / 16
        const a = Math.min(1, Math.max(0, (Math.pow(tent, choke) - 0.02) / 0.96))
        const i = (y1 + x) * 4
        if (spill > 0 && a > 0) {
          const d = despill([data[i] / 255, data[i + 1] / 255, data[i + 2] / 255], spillKey, spill, a)
          data[i] = d[0] * 255
          data[i + 1] = d[1] * 255
          data[i + 2] = d[2] * 255
        }
        data[i + 3] = a * 255
      }
    }
  }

  private matteCpu(w: number, h: number): Uint8ClampedArray {
    const data = this.keyPixels(w, h, w, h)
    const out = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < out.length; i += 4) {
      const a = data ? data[i + 3] : 255
      out[i] = out[i + 1] = out[i + 2] = a
      out[i + 3] = 255
    }
    return out
  }
}
