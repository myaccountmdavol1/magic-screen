// Keyer quality harness page. Served by Vite (run.ts) and driven by Playwright.
// Feeds generated fixture frames to the REAL Compositor through a canvas at camera
// cadence (30 fps, real time, so fades / drift sampling / the Magic Helper cadence
// behave as in the app), reads back the matte and the composite after each
// render(), and scores them against the ground truth.
import { Compositor } from '../../../src/lib/keyer/Compositor'
import type { Segmenter } from '../../../src/lib/segmenter'
import type { KeySettings, RGB } from '../../../src/types'
import { decodeFrameRGBA, parseY4M } from '../../fixtures/gen/y4m'
import { frameMetrics, meanMetrics, type FrameMetrics } from '../metrics'

/** off: chroma only. on: Magic Helper running ("auto" setting: core fill only after the
 *  shirt signal). force: helper "on" setting (core fill always). synth: "on" setting
 *  fed a deterministic mask made from the GT (blurred, 256 px wide, one frame late). */
export type HelperVariant = 'off' | 'on' | 'force' | 'synth'

export interface RunOptions {
  id: string
  helper: HelperVariant
  /** frames not scored at the start (temporal filters + ML fade settle) */
  warmup?: number
  /** run the segmenter every Nth frame */
  cadence?: number
  /** return the middle frame's matte + composite for previews */
  dump?: boolean
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

let segPromise: Promise<Segmenter> | null = null
function getSegmenter(): Promise<Segmenter> {
  segPromise ??= import('../../../src/lib/segmenter').then((m) => m.createSegmenter())
  return segPromise
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

  // frame 0 + the app's auto decision: screen found -> chroma with that key,
  // no screen -> AI cutout (segment) mode
  decodeFrameRGBA(fx.cam, fx.info, 0, img.data)
  sctx.putImageData(img, 0, 0)
  const found = c.sampleBorderColor()
  const mode: KeySettings['mode'] = found ? 'chroma' : 'segment'
  const key: KeySettings = { ...DEFAULT_KEY, mode, color: (found ?? DEFAULT_KEY.color) as RGB }
  c.setKey(key)

  const segMode = mode === 'segment'
  const wantSeg = segMode || o.helper === 'on' || o.helper === 'force'
  const seg = wantSeg ? await getSegmenter() : null
  let shirtSignal = false
  c.onSignal = (s) => {
    if (s.type === 'shirt') {
      shirtSignal = true
      if (o.helper !== 'off') c.setCoreFill(true)
    }
  }
  c.setCoreFill(o.helper === 'force' || o.helper === 'synth')

  const per: FrameMetrics[] = []
  const segMs: number[] = []
  /** share of mask pixels the segmenter calls 'person' (sanity check) */
  const maskPerson: number[] = []
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
        c.setMaskData(m.data, m.w, m.h)
        c.setMlWeight(1)
        let hi = 0
        for (let i = 0; i < m.data.length; i++) if (m.data[i] > 127) hi++
        maskPerson.push(hi / m.data.length)
      }
    } else if (o.helper === 'synth' && !segMode && k % cadence === 0 && k > 0) {
      const m = synthMask(fx.alpha.subarray((k - 1) * n, k * n), W, H)
      c.setMaskData(m.data, m.w, m.h)
      c.setMlWeight(1)
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
    cadence: wantSeg || o.helper === 'synth' ? cadence : 0,
    metrics: meanMetrics(per),
    series: { sad: per.map((m) => +m.sad.toFixed(3)) },
    info: {
      tier: stats.tier,
      analyticKey: stats.analyticKey,
      keyColor: stats.keyColor.map((v) => +v.toFixed(4)),
      sampledKey: found ? found.map((v) => +v.toFixed(4)) : null,
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
  c.setBackground(BG_CSS)
  c.setForeground(src, { mirror: true, live: true })
  sctx.drawImage(bitmaps[0], 0, 0)
  const found = c.sampleBorderColor()
  c.setKey({ ...DEFAULT_KEY, color: (found ?? DEFAULT_KEY.color) as RGB })
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
    if (o.helper === 'synth' && k % 2 === 0) {
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
    frames,
    tier: stats.tier,
    cpuMedian: q(cpu, 0.5),
    cpuP90: q(cpu, 0.9),
    syncMedian: q(sync, 0.5),
    syncP90: q(sync, 0.9),
    gpuMedian: gpu.length ? q(gpu, 0.5) : null,
    gpuP90: gpu.length ? q(gpu, 0.9) : null,
    crossOriginIsolated: self.crossOriginIsolated,
  }
}

declare global {
  interface Window {
    harness: { runScenario: typeof runScenario; timing: typeof timing; glInfo: typeof glInfo; ready: boolean }
  }
}
window.harness = { runScenario, timing, glInfo, ready: true }
log('keyer harness ready')
