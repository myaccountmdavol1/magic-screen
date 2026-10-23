// Keyer quality harness page. Served by Vite (run.ts) and driven by Playwright.
// Feeds generated fixture frames to the REAL Compositor through a canvas at camera
// cadence (30 fps, real time, so fades / drift sampling / the Magic Helper cadence
// behave as in the app), reads back the matte and the composite after each
// render(), and scores them against the ground truth.
import { Compositor } from '../../../src/lib/keyer/Compositor'
import { getFrontImage } from '../../../src/assets/svg'
import { KEYER_TUNING } from '../../../src/lib/keyer/shaders'
import { HelperTrustTracker } from '../../../src/lib/helperTrust'
import { averageLinear, deltaE00, rgbToLab } from '../../../src/lib/keyer/labKey'
import type { SegInput, SegModel, Segmenter } from '../../../src/lib/segmenter'
import type { KeySettings, RGB } from '../../../src/types'
import { decodeFrameRGBA, parseY4M } from '../../fixtures/gen/y4m'
import { frameMetrics, meanMetrics, type FrameMetrics } from '../metrics'

/** off: chroma only. on: Magic Helper running ("auto" setting: core fill only after the
 *  shirt signal). force: helper "on" setting (core fill always). synth: "on" setting
 *  fed a deterministic mask made from the GT (blurred, 256 px wide, one frame late).
 *  synth-lagN: the same mask N frames late (a slow / late Magic Helper behind a moving kid). */
export type HelperVariant = 'off' | 'on' | 'force' | 'synth' | `synth-lag${number}`

export interface RunOptions {
  id: string
  helper: HelperVariant
  /** frames not scored at the start (temporal filters + ML fade settle) */
  warmup?: number
  /** run the segmenter every Nth frame */
  cadence?: number
  /** return the middle frame's matte + composite for previews */
  dump?: boolean
  /** segmenter model / input fit (default: the app's defaults) */
  seg?: { model?: SegModel; input?: SegInput }
  /** force the keying path instead of the auto decision (e.g. 'chroma' on a scene with
   *  no screen reproduces the "garbage matte halo" bug report) */
  mode?: 'chroma' | 'segment'
  /** Compositor segment-mode tuning overrides (experiments) */
  tune?: Record<string, number>
  /** Compositor.setKeyerFlags overrides (feature A/B) */
  flags?: Record<string, number>
}

interface Meta {
  id: string
  width: number
  height: number
  fps: number
  frames: number
  screen: 'green' | 'blue' | 'none'
}

const BG: [number, number, number] = [128, 128, 128]
const BG_CSS = 'rgb(128,128,128)'
const DEFAULT_KEY: KeySettings = { mode: 'chroma', color: [0.2, 0.75, 0.3], similarity: 0.4, smoothness: 0.08, spill: 0.6 }

const log = (s: string) => {
  const el = document.getElementById('log')
  if (el) el.textContent = s
}

async function fetchBytes(url: string, gz = false): Promise<Uint8Array> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  if (!gz) return new Uint8Array(await res.arrayBuffer())
  const stream = res.body!.pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

interface Fixture {
  meta: Meta
  cam: Uint8Array
  info: ReturnType<typeof parseY4M>
  alpha: Uint8Array
  fg: Uint8Array
}

async function loadFixture(id: string): Promise<Fixture> {
  const base = `/__fixtures/${id}`
  const meta = (await (await fetch(`${base}/meta.json`)).json()) as Meta
  const [cam, alpha, fg] = await Promise.all([
    fetchBytes(`${base}/cam.y4m`),
    fetchBytes(`${base}/alpha.u8.gz`, true),
    fetchBytes(`${base}/fg.rgb.gz`, true),
  ])
  return { meta, cam, info: parseY4M(cam), alpha, fg }
}

const segPromises = new Map<string, Promise<Segmenter>>()
function getSegmenter(o: RunOptions['seg'] = {}): Promise<Segmenter> {
  const k = JSON.stringify(o)
  let p = segPromises.get(k)
  if (!p) {
    p = import('../../../src/lib/segmenter').then((m) => m.createSegmenter(o))
    segPromises.set(k, p)
  }
  return p
}

/** IoU of the raw ML mask (> 0.5) against the GT (> 0.5), mask pixels mapped to frame pixels. */
function maskIoU(m: { data: Uint8Array; w: number; h: number }, gt: Uint8Array, W: number, H: number): number {
  let inter = 0
  let uni = 0
  for (let y = 0; y < m.h; y++) {
    const gy = Math.min(H - 1, Math.floor(((y + 0.5) * H) / m.h))
    for (let x = 0; x < m.w; x++) {
      const gx = Math.min(W - 1, Math.floor(((x + 0.5) * W) / m.w))
      const a = m.data[y * m.w + x] > 127
      const b = gt[gy * W + gx] > 127
      if (a && b) inter++
      if (a || b) uni++
    }
  }
  return uni ? inter / uni : 1
}

/**
 * "Sloppy segmenter" stand-in for the AI cutout: GT -> 256-wide mask, grown by
 * `grow` mask px (max filter, like a mask that spills onto the wall), blurred, and
 * shifted by a deterministic ±`jitter` px per update (mask wobble). Tests whether
 * the edge refinement snaps back to the real boundary.
 */
function sloppyMask(gt: Uint8Array, W: number, H: number, k: number, grow: number, jitter: number) {
  const base = synthMask(gt, W, H)
  const { w, h } = base
  const src = base.data
  const out = new Uint8Array(w * h)
  const jx = jitter ? Math.round(Math.sin(k * 1.7) * jitter) : 0
  const jy = jitter ? Math.round(Math.cos(k * 2.3) * jitter) : 0
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let m = 0
      for (let dy = -grow; dy <= grow; dy++)
        for (let dx = -grow; dx <= grow; dx++) {
          if (dx * dx + dy * dy > grow * grow) continue
          const yy = Math.min(h - 1, Math.max(0, y + dy - jy))
          const xx = Math.min(w - 1, Math.max(0, x + dx - jx))
          m = Math.max(m, src[yy * w + xx])
        }
      out[y * w + x] = m
    }
  return { data: out, w, h }
}

/** GT alpha -> 256-wide blurred "coarse helper" mask (box average + 5x5 box blur). */
function synthMask(gt: Uint8Array, W: number, H: number) {
  const mw = 256
  const mh = Math.max(1, Math.round((mw * H) / W))
  const small = new Float32Array(mw * mh)
  for (let y = 0; y < mh; y++) {
    const y0 = Math.floor((y * H) / mh)
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * H) / mh))
    for (let x = 0; x < mw; x++) {
      const x0 = Math.floor((x * W) / mw)
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * W) / mw))
      let s = 0
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) s += gt[yy * W + xx]
      small[y * mw + x] = s / ((y1 - y0) * (x1 - x0))
    }
  }
  const out = new Uint8Array(mw * mh)
  const r = 2
  for (let y = 0; y < mh; y++)
    for (let x = 0; x < mw; x++) {
      let s = 0
      let c = 0
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          const yy = y + dy
          const xx = x + dx
          if (yy < 0 || yy >= mh || xx < 0 || xx >= mw) continue
          s += small[yy * mw + xx]
          c++
        }
      out[y * mw + x] = Math.round(s / c)
    }
  return { data: out, w: mw, h: mh }
}

function readComposite(gl: WebGL2RenderingContext, W: number, H: number): Uint8Array {
  const raw = new Uint8Array(W * H * 4)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, raw)
  const out = new Uint8Array(W * H * 4)
  const row = W * 4
  for (let y = 0; y < H; y++) out.set(raw.subarray((H - 1 - y) * row, (H - y) * row), y * row)
  return out
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)))

function toB64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export function glInfo() {
  const c = document.createElement('canvas')
  const gl = c.getContext('webgl2')
  if (!gl) return { webgl2: false }
  const dbg = gl.getExtension('WEBGL_debug_renderer_info')
  return {
    webgl2: true,
    renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
    floatColorBuffer: !!gl.getExtension('EXT_color_buffer_float') || !!gl.getExtension('EXT_color_buffer_half_float'),
    userAgent: navigator.userAgent,
  }
}

export async function runScenario(o: RunOptions) {
  const fx = await loadFixture(o.id)
  const { width: W, height: H, frames, fps } = fx.meta
  const warmup = Math.min(frames - 2, o.warmup ?? 10)
  const cadence = Math.max(1, o.cadence ?? 2)
  const n = W * H
  const host = document.getElementById('stage')!
  host.replaceChildren()
  const stage = document.createElement('canvas')
  const src = document.createElement('canvas')
  src.width = W
  src.height = H
  host.append(stage)
  const sctx = src.getContext('2d', { willReadFrequently: false })!
  const img = new ImageData(W, H)

  const c = new Compositor(stage, { width: W, height: H })
  if (!c.isWebGL) throw new Error('Compositor fell back to Canvas2D: no WebGL2 in this browser')
  const gl = stage.getContext('webgl2') as WebGL2RenderingContext
  c.setBackground(BG_CSS)
  c.setForeground(src, { mirror: false, live: true })
  c.setOutline(0)
  if (o.tune) c.setSegTuning(o.tune)
  if (o.flags) c.setKeyerFlags(o.flags)

  // frame 0 + the app's auto decision: screen found -> chroma with that key,
  // no screen -> AI cutout (segment) mode
  decodeFrameRGBA(fx.cam, fx.info, 0, img.data)
  sctx.putImageData(img, 0, 0)
  let darkSignal: number | null = null
  c.onSignal = (s) => {
    if (s.type === 'dark') darkSignal = +s.L.toFixed(1)
  }
  const found = c.sampleBorderColor()
  // True screen colour as the camera saw it on frame 0: linear mean of GT-background
  // pixels in the top / side border bands (what a perfect auto key would pick).
  let trueKey: RGB | null = null
  if (fx.meta.screen !== 'none') {
    const band = Math.round(Math.min(W, H) * 0.12)
    const px: RGB[] = []
    for (let y = 0; y < H - band; y += 2)
      for (let x = 0; x < W; x += 2) {
        if (x >= band && x < W - band && y >= band) continue
        const i = y * W + x
        if (fx.alpha[i] !== 0) continue
        px.push([img.data[i * 4] / 255, img.data[i * 4 + 1] / 255, img.data[i * 4 + 2] / 255])
      }
    trueKey = averageLinear(px)
  }
  const keyDE = (k: RGB | null) => (k && trueKey ? +deltaE00(rgbToLab(k), rgbToLab(trueKey)).toFixed(2) : null)
  const mode: KeySettings['mode'] = o.mode ?? (found ? 'chroma' : 'segment')
  const key: KeySettings = { ...DEFAULT_KEY, mode, color: (found ?? DEFAULT_KEY.color) as RGB }
  c.setKey(key)

  const segMode = mode === 'segment'
  const wantSeg = segMode || o.helper === 'on' || o.helper === 'force'
  // seg model "sloppy-<grow>-<jitter>": a GT-derived bad mask instead of MediaPipe (segment scenarios)
  const sloppy = /^sloppy-(\d+)-(\d+)$/.exec(String(o.seg?.model ?? ''))
  const seg = wantSeg && !sloppy ? await getSegmenter(o.seg) : null
  let shirtSignal = false
  c.onSignal = (s) => {
    if (s.type === 'dark') darkSignal = +s.L.toFixed(1)
    if (s.type === 'shirt') {
      shirtSignal = true
      if (o.helper !== 'off') c.setCoreFill(true)
    }
  }
  const lagM = /^synth-lag(\d+)$/.exec(o.helper)
  const synthLike = o.helper === 'synth' || !!lagM
  const lag = lagM ? Math.max(1, +lagM[1]) : 1
  c.setCoreFill(o.helper === 'force' || synthLike)

  // Magic Helper trust, exactly as useStage runs it: camera-frame clock = k × interval.
  const trust = new HelperTrustTracker()
  trust.setFrameMs(1000 / fps)
  const trustSeries: number[] = []
  const onHelperMask = (m: { data: Uint8Array; w: number; h: number }, capturedFrame: number) => {
    c.setMaskData(m.data, m.w, m.h)
    c.setMlWeight(1)
    if (!segMode) {
      trust.onMask(m.data, m.w, m.h, (capturedFrame * 1000) / fps)
      c.setMlDilate(trust.dilate(KEYER_TUNING.dilate))
    }
  }

  const per: FrameMetrics[] = []
  const segMs: number[] = []
  /** share of mask pixels the segmenter calls 'person' (sanity check) */
  const maskPerson: number[] = []
  const ious: number[] = []
  let segMaskSize = ''
  const kept: { k: number; alpha: Uint8Array; comp: Uint8Array | null }[] = []
  let dump: { frame: number; matte: string; comp: string } | null = null
  const dumpAt = Math.floor((warmup + frames) / 2)
  const interval = 1000 / fps
  const t0 = performance.now()
  for (let k = 0; k < frames; k++) {
    await sleep(t0 + k * interval - performance.now())
    if (k > 0) {
      decodeFrameRGBA(fx.cam, fx.info, k, img.data)
      sctx.putImageData(img, 0, 0)
    }
    if (seg && k % cadence === 0) {
      const ts = performance.now()
      const m = seg.segment(src, ts)
      segMs.push(performance.now() - ts)
      if (m) {
        segMaskSize = `${m.w}x${m.h}`
        onHelperMask(m, k)
        let hi = 0
        for (let i = 0; i < m.data.length; i++) if (m.data[i] > 127) hi++
        maskPerson.push(hi / m.data.length)
        ious.push(maskIoU(m, fx.alpha.subarray(k * n, (k + 1) * n), W, H))
      }
    } else if (sloppy && segMode && k % cadence === 0) {
      const m = sloppyMask(fx.alpha.subarray(Math.max(0, k - 1) * n, Math.max(1, k) * n), W, H, k, +sloppy[1], +sloppy[2])
      c.setMaskData(m.data, m.w, m.h)
      c.setMlWeight(1)
      ious.push(maskIoU(m, fx.alpha.subarray(k * n, (k + 1) * n), W, H))
    } else if (synthLike && !segMode && k % cadence === 0 && k >= lag) {
      const m = synthMask(fx.alpha.subarray((k - lag) * n, (k - lag + 1) * n), W, H)
      onHelperMask(m, k - lag)
    }
    if (!segMode) {
      const t = trust.trust((k * 1000) / fps)
      c.setMlTrust(t)
      if (k >= warmup) trustSeries.push(t)
    }
    c.render()
    const matte = c.debugReadMatte()
    if (!matte || matte.w !== W || matte.h !== H) throw new Error('matte readback failed')
    const alpha = matte.data
    // Keep the 30 fps pacing honest: only copy now, score after the clip.
    if (k >= warmup - 1) kept.push({ k, alpha, comp: k >= warmup ? readComposite(gl, W, H) : null })
    log(`${o.id} [${o.helper}] frame ${k + 1}/${frames}`)
  }
  const late = performance.now() - t0 - frames * interval
  const keyCh = fx.meta.screen === 'green' ? 1 : fx.meta.screen === 'blue' ? 2 : null
  for (let j = 0; j < kept.length; j++) {
    const { k, alpha, comp } = kept[j]
    if (!comp) continue
    const prev = j > 0 && kept[j - 1].k === k - 1 ? kept[j - 1] : null
    per.push(
      frameMetrics({
        W,
        H,
        alpha,
        gt: fx.alpha.subarray(k * n, (k + 1) * n),
        prevAlpha: prev?.alpha ?? null,
        prevGt: prev ? fx.alpha.subarray((k - 1) * n, k * n) : null,
        recentGt: [1, 2, 3].filter((d) => k - d >= 0).map((d) => fx.alpha.subarray((k - d) * n, (k - d + 1) * n)),
        comp,
        gtFg: fx.fg.subarray(k * n * 3, (k + 1) * n * 3),
        bg: BG,
        keyCh,
      }),
    )
    if (o.dump && k === dumpAt) dump = { frame: k, matte: toB64(alpha), comp: toB64(comp) }
  }
  const stats = c.getStats()
  c.destroy({ releaseContext: true })
  return {
    id: o.id,
    helper: o.helper,
    mode,
    width: W,
    height: H,
    frames,
    scored: per.length,
    cadence: wantSeg || synthLike ? cadence : 0,
    metrics: meanMetrics(per),
    series: { sad: per.map((m) => +m.sad.toFixed(3)) },
    info: {
      tier: stats.tier,
      analyticKey: stats.analyticKey,
      /** foreground unmixing target format in use (rgba16f | srgb8 | off) */
      unmix: stats.unmix,
      keyColor: stats.keyColor.map((v) => +v.toFixed(4)),
      sampledKey: found ? found.map((v) => +v.toFixed(4)) : null,
      /** ΔE00 of the frame-0 auto key / the final tracked key vs the true screen colour */
      sampledKeyDE: keyDE(found),
      finalKeyDE: mode === 'chroma' ? keyDE(stats.keyColor) : null,
      keyStatus: stats.borderKey ?? null,
      /** "add more light" signal: median screen L when it fired */
      darkSignal,
      lo: +stats.lo.toFixed(3),
      hi: +stats.hi.toFixed(3),
      autoKey: stats.autoKey,
      recalibrations: stats.recalibrations,
      mlWeight: +stats.mlWeight.toFixed(3),
      coreWeight: +stats.coreWeight.toFixed(3),
      shirtSignal,
      segmenter: seg ? seg.delegate : null,
      /** ms the clip ran behind real time (pacing check; ~0 is good) */
      lateMs: Math.round(late),
      maskPersonFrac: maskPerson.length ? +(maskPerson.reduce((x, y) => x + y, 0) / maskPerson.length).toFixed(3) : null,
      trustMean: trustSeries.length ? +(trustSeries.reduce((x, y) => x + y, 0) / trustSeries.length).toFixed(3) : null,
      trustMin: trustSeries.length ? +Math.min(...trustSeries).toFixed(3) : null,
      maskIoU: ious.length ? +(ious.reduce((x, y) => x + y, 0) / ious.length).toFixed(4) : null,
      maskSize: seg ? segMaskSize : null,
      seg: seg ? (o.seg ?? null) : null,
      segMsMedian: segMs.length ? +segMs.sort((a, b) => a - b)[segMs.length >> 1].toFixed(2) : null,
    },
    dump,
  }
}

export interface TimingOptions {
  id: string
  helper: 'off' | 'synth'
  width?: number
  height?: number
  frames?: number
  warmup?: number
  flags?: Record<string, number>
  /** C5: draw this built-in world's front layer (desk, fence...) over the child */
  front?: string
}

/**
 * render() cost at stage resolution (default 1280x720) with the camera frame scaled
 * to the same size. cpu = time inside render(); sync = render() + a 1 px readPixels
 * (waits for the GPU to finish the frame). Paced by requestAnimationFrame.
 */
export async function timing(o: TimingOptions) {
  const fx = await loadFixture(o.id)
  const SW = o.width ?? 1280
  const SH = o.height ?? 720
  const frames = o.frames ?? 150
  const warm = o.warmup ?? 30
  const { width: W, height: H } = fx.meta
  const n = W * H
  const small = document.createElement('canvas')
  small.width = W
  small.height = H
  const img = new ImageData(W, H)
  const N = Math.min(fx.meta.frames, 30)
  const bitmaps: ImageBitmap[] = []
  const masks: { data: Uint8Array; w: number; h: number }[] = []
  for (let k = 0; k < N; k++) {
    decodeFrameRGBA(fx.cam, fx.info, k, img.data)
    small.getContext('2d')!.putImageData(img, 0, 0)
    bitmaps.push(await createImageBitmap(small, { resizeWidth: SW, resizeHeight: SH, resizeQuality: 'high' }))
    masks.push(synthMask(fx.alpha.subarray(k * n, (k + 1) * n), W, H))
  }
  const host = document.getElementById('stage')!
  host.replaceChildren()
  const stage = document.createElement('canvas')
  host.append(stage)
  const src = document.createElement('canvas')
  src.width = SW
  src.height = SH
  const sctx = src.getContext('2d')!
  const c = new Compositor(stage, { width: SW, height: SH })
  const gl = stage.getContext('webgl2') as WebGL2RenderingContext
  if (o.flags) c.setKeyerFlags(o.flags)
  c.setBackground(BG_CSS)
  if (o.front) c.setForegroundOverlay(await getFrontImage(o.front))
  c.setForeground(src, { mirror: true, live: true })
  sctx.drawImage(bitmaps[0], 0, 0)
  const found = c.sampleBorderColor()
  // Same auto decision as the app: no screen -> AI cutout (segment) mode, fed masks.
  const segMode = !found
  c.setKey({ ...DEFAULT_KEY, mode: segMode ? 'segment' : 'chroma', color: (found ?? DEFAULT_KEY.color) as RGB })
  const px = new Uint8Array(4)
  const cpu: number[] = []
  const sync: number[] = []
  const gpu: number[] = []
  // GPU time via EXT_disjoint_timer_query_webgl2 when the browser exposes it
  const tq = gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null
  const pendingQ: { q: WebGLQuery; keep: boolean }[] = []
  const drainQueries = () => {
    while (pendingQ.length && gl.getQueryParameter(pendingQ[0].q, gl.QUERY_RESULT_AVAILABLE)) {
      const { q, keep } = pendingQ.shift()!
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number
      if (keep && tq && !gl.getParameter(tq.GPU_DISJOINT_EXT)) gpu.push(ns / 1e6)
      gl.deleteQuery(q)
    }
  }
  for (let k = 0; k < warm + frames; k++) {
    await new Promise((r) => requestAnimationFrame(r))
    sctx.drawImage(bitmaps[k % N], 0, 0)
    if ((o.helper === 'synth' || segMode) && k % 2 === 0) {
      const m = masks[k % N]
      c.setMaskData(m.data, m.w, m.h)
      c.setMlWeight(1)
    }
    const q = tq ? gl.createQuery() : null
    if (q && tq) gl.beginQuery(tq.TIME_ELAPSED_EXT, q)
    const a = performance.now()
    c.render()
    const b = performance.now()
    if (q && tq) {
      gl.endQuery(tq.TIME_ELAPSED_EXT)
      pendingQ.push({ q, keep: k >= warm })
    }
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
    const d = performance.now()
    if (k >= warm) {
      cpu.push(b - a)
      sync.push(d - a)
    }
    drainQueries()
    log(`timing ${o.helper} ${k + 1}/${warm + frames}`)
  }
  for (let i = 0; i < 10 && pendingQ.length; i++) {
    await new Promise((r) => requestAnimationFrame(r))
    drainQueries()
  }
  const stats = c.getStats()
  c.destroy({ releaseContext: true })
  const q = (xs: number[], p: number) => {
    const s = [...xs].sort((x, y) => x - y)
    return +s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))].toFixed(3)
  }
  return {
    id: o.id,
    helper: o.helper,
    stage: `${SW}x${SH}`,
    mode: segMode ? 'segment' : 'chroma',
    frames,
    tier: stats.tier,
    unmix: stats.unmix,
    cpuMedian: q(cpu, 0.5),
    cpuP90: q(cpu, 0.9),
    syncMedian: q(sync, 0.5),
    syncP90: q(sync, 0.9),
    gpuMedian: gpu.length ? q(gpu, 0.5) : null,
    gpuP90: gpu.length ? q(gpu, 0.9) : null,
    crossOriginIsolated: self.crossOriginIsolated,
  }
}

/** ms per segment() call (inference + mask readback) for a model / input fit, on a 1280x720 frame. */
export async function segTiming(o: { id: string; seg?: RunOptions['seg']; frames?: number }) {
  const fx = await loadFixture(o.id)
  const { width: W, height: H } = fx.meta
  const small = document.createElement('canvas')
  small.width = W
  small.height = H
  const img = new ImageData(W, H)
  decodeFrameRGBA(fx.cam, fx.info, 0, img.data)
  small.getContext('2d')!.putImageData(img, 0, 0)
  const src = document.createElement('canvas')
  src.width = 1280
  src.height = 720
  src.getContext('2d')!.drawImage(small, 0, 0, 1280, 720)
  const seg = await getSegmenter(o.seg)
  const times: number[] = []
  const n = o.frames ?? 60
  for (let k = 0; k < n + 10; k++) {
    await new Promise((r) => requestAnimationFrame(r))
    const t0 = performance.now()
    seg.segment(src, t0)
    if (k >= 10) times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  return { seg: o.seg ?? null, delegate: seg.delegate, median: +times[times.length >> 1].toFixed(2), p90: +times[Math.floor(times.length * 0.9)].toFixed(2) }
}

declare global {
  interface Window {
    harness: { runScenario: typeof runScenario; timing: typeof timing; segTiming: typeof segTiming; glInfo: typeof glInfo; ready: boolean }
  }
}
window.harness = { runScenario, timing, segTiming, glInfo, ready: true }
log('keyer harness ready')
