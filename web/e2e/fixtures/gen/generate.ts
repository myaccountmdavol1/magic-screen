// Keyer fixture generator: short Y4M clips with exact per-frame ground-truth alpha.
//
//   node e2e/fixtures/gen/generate.ts [--only clean,specks] [--frames 60] [--size 640x360] [--out dir] [--force]
//
// (Node >= 22.18 runs TypeScript directly; no build step, no extra dependencies.)
//
// Per scenario, in <out>/<id>/:
//   cam.y4m       camera clip (C420jpeg, full-range BT.601, 30 fps) -> keyer input
//   alpha.u8.gz   ground-truth alpha, frames x W x H bytes (gzip)
//   fg.rgb.gz     ground-truth straight foreground colour (camera-referred sRGB, no
//                 spill, no noise; 0 where alpha = 0), frames x W x H x 3 (gzip)
//   meta.json     size, fps, frames, screen colour, hash (outputs are cached by hash)
//
// Image model (linear light): I = P_obs + (1 - A) * B, with P/A the person's
// premultiplied colour/coverage averaged over motion-blur sub-frames, P_obs = P plus
// screen spill on the rim, B the backing plate (with the child's cast shadow). Then
// the camera: white balance x exposure x flicker, Poisson-Gaussian noise, sRGB,
// 4:2:0, optional 8x8 DCT blocks. The ground-truth composite over any background
// Bn is A * F_gt + (1 - A) * Bn, F_gt = camera gains applied to P / A.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { dctQuantizePlane } from './codec.ts'
import { clamp01, gauss, hash32, linToByte, linearToSrgb, rng, smoothstep } from './color.ts'
import { SCENARIOS, type Scenario } from './scenarios.ts'
import { boxBlur1, makePlate, makeStrands, renderPerson, SCREEN_BLUE, SCREEN_GREEN } from './scene.ts'
import { planesToFrame, rgbToPlanes420, y4mHeader } from './y4m.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_OUT = path.resolve(here, '..', 'out')
const FPS = 30

interface Args {
  out: string
  only: string[] | null
  frames: number | null
  W: number
  H: number
  force: boolean
  quiet: boolean
}

function parseArgs(argv: string[]): Args {
  const a: Args = { out: DEFAULT_OUT, only: null, frames: null, W: 640, H: 360, force: false, quiet: false }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    const v = () => argv[++i]
    if (k === '--out') a.out = path.resolve(v())
    else if (k === '--only') a.only = v().split(',').filter(Boolean)
    else if (k === '--frames') a.frames = Math.max(2, parseInt(v(), 10))
    else if (k === '--size') {
      const [w, h] = v().split('x').map(Number)
      a.W = w
      a.H = h
    } else if (k === '--force') a.force = true
    else if (k === '--quiet') a.quiet = true
    else if (k === '--list') {
      for (const s of SCENARIOS) console.log(`${s.id.padEnd(16)} ${s.stresses}`)
      process.exit(0)
    } else throw new Error(`unknown option ${k}`)
  }
  return a
}

function sourceHash(): string {
  const h = createHash('sha1')
  for (const f of fs.readdirSync(here).sort()) if (f.endsWith('.ts')) h.update(fs.readFileSync(path.join(here, f)))
  return h.digest('hex')
}

function cameraGains(sc: Scenario, p: number): [number, number, number] {
  const e = sc.exposure ?? 1
  if (!sc.awb) return [e, e, e]
  const s = smoothstep(0.1, 0.8, p) * sc.awb
  const ex = (1 - 0.12 * s) * e
  return [(1 + 0.14 * s) * ex, (1 + 0.02 * s) * ex, (1 - 0.12 * s) * ex]
}

function flickerRow(sc: Scenario, y: number, H: number, tSec: number): number {
  if (!sc.flicker) return 1
  const f = sc.flicker
  return (1 + 0.04 * f * Math.sin(2 * Math.PI * 3.7 * tSec)) * (1 + 0.06 * f * Math.sin(2 * Math.PI * ((y / H) * 1.3 - 1.1 * tSec)))
}

export function generateScenario(sc: Scenario, W: number, H: number, framesOverride: number | null, outDir: string, force: boolean, quiet: boolean) {
  const frames = framesOverride ?? sc.frames ?? 60
  const dir = path.join(outDir, sc.id)
  const hash = createHash('sha1').update(JSON.stringify({ sc, W, H, frames })).update(sourceHash()).digest('hex').slice(0, 16)
  const metaPath = path.join(dir, 'meta.json')
  if (!force && fs.existsSync(metaPath)) {
    try {
      if (JSON.parse(fs.readFileSync(metaPath, 'utf8')).hash === hash) {
        if (!quiet) console.log(`  ${sc.id}: cached`)
        return
      }
    } catch {
      /* regenerate */
    }
  }
  fs.mkdirSync(dir, { recursive: true })
  const t0 = Date.now()
  const seed = hash32(sc.id)
  const n = W * H
  const plate = makePlate(sc.plate, W, H, seed ^ 0x51)
  const strands = makeStrands(sc.person, seed ^ 0x77)
  const noiseRand = rng(seed ^ 0x99)
  const S = Math.max(1, sc.subframes ?? 1)
  const shutter = sc.shutter ?? 0.5
  const P = new Float32Array(n * 3)
  const A = new Float32Array(n)
  const Ps = new Float32Array(n * 3)
  const As = new Float32Array(n)
  const B = new Float32Array(n * 3)
  const rgb = new Uint8Array(n * 3)
  const alphaAll = new Uint8Array(n * frames)
  const fgAll = new Uint8Array(n * 3 * frames)
  const fd = fs.openSync(path.join(dir, 'cam.y4m'), 'w')
  fs.writeSync(fd, y4mHeader(W, H, FPS))
  const shadowShift = { x: Math.round(0.06 * W), y: Math.round(0.025 * H) }
  const shadowR = Math.max(2, Math.round(0.02 * H))
  const rimR = Math.max(2, Math.round(0.012 * H))
  const noise = sc.noise
  for (let f = 0; f < frames; f++) {
    const tSec = f / FPS
    // 1) person, averaged over sub-frames (premultiplied colour + coverage)
    P.fill(0)
    A.fill(0)
    for (let s = 0; s < S; s++) {
      Ps.fill(0)
      As.fill(0)
      const ts = S === 1 ? tSec : tSec + ((s + 0.5) / S - 0.5) * (shutter / FPS)
      renderPerson(sc.person, strands, ts, W, H, Ps, As)
      for (let i = 0; i < n * 3; i++) P[i] += Ps[i] / S
      for (let i = 0; i < n; i++) A[i] += As[i] / S
    }
    // 2) backing with the cast shadow
    B.set(plate)
    if (sc.shadow) {
      const sh = new Float32Array(n)
      for (let y = 0; y < H; y++) {
        const sy = y - shadowShift.y
        if (sy < 0) continue
        for (let x = shadowShift.x; x < W; x++) sh[y * W + x] = A[sy * W + x - shadowShift.x]
      }
      const blurred = boxBlur1(boxBlur1(sh, W, H, shadowR), W, H, shadowR)
      for (let i = 0; i < n; i++) {
        const k = 1 - sc.shadow * blurred[i]
        B[i * 3] *= k
        B[i * 3 + 1] *= k
        B[i * 3 + 2] *= k
      }
    }
    // 3) spill on the rim (light from the screen behind)
    const rim = sc.spill ? boxBlur1(A, W, H, rimR) : null
    // 4) camera
    const gains = cameraGains(sc, frames > 1 ? f / (frames - 1) : 0)
    const aOff = f * n
    const fOff = f * n * 3
    for (let y = 0; y < H; y++) {
      const fl = flickerRow(sc, y, H, tSec)
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        const a = A[i]
        const spill = rim && a > 0 ? (sc.spill as number) * clamp01(2 * (1 - rim[i])) * a : 0
        alphaAll[aOff + i] = Math.round(clamp01(a) * 255)
        for (let c = 0; c < 3; c++) {
          const g = gains[c] * fl
          const b = B[i * 3 + c]
          let v = (P[i * 3 + c] + spill * b + (1 - a) * b) * g
          if (noise) v += Math.sqrt(noise.a * Math.max(0, v) + noise.b) * gauss(noiseRand)
          rgb[i * 3 + c] = linToByte(v)
          if (a > 0.5 / 255) fgAll[fOff + i * 3 + c] = linToByte((P[i * 3 + c] / a) * g)
        }
      }
    }
    // 5) 4:2:0 (+ blocks) -> Y4M
    const planes = rgbToPlanes420(rgb, W, H, 3)
    if (sc.jpegQuality) {
      const cw = (W + 1) >> 1
      const ch = (H + 1) >> 1
      dctQuantizePlane(planes.Y, W, H, sc.jpegQuality, false)
      dctQuantizePlane(planes.U, cw, ch, sc.jpegQuality, true)
      dctQuantizePlane(planes.V, cw, ch, sc.jpegQuality, true)
    }
    fs.writeSync(fd, planesToFrame(planes))
  }
  fs.closeSync(fd)
  fs.writeFileSync(path.join(dir, 'alpha.u8.gz'), gzipSync(alphaAll, { level: 6 }))
  fs.writeFileSync(path.join(dir, 'fg.rgb.gz'), gzipSync(fgAll, { level: 6 }))
  const screenLin = sc.plate.screen === 'green' ? SCREEN_GREEN : sc.plate.screen === 'blue' ? SCREEN_BLUE : null
  const meta = {
    id: sc.id,
    title: sc.title,
    stresses: sc.stresses,
    width: W,
    height: H,
    fps: FPS,
    frames,
    screen: sc.plate.screen,
    /** nominal screen colour, sRGB 0..1 (before lighting) */
    screenColor: screenLin ? screenLin.map((v) => +linearToSrgb(v).toFixed(4)) : null,
    hash,
    generatedMs: Date.now() - t0,
  }
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2))
  if (!quiet) console.log(`  ${sc.id}: ${frames} frames ${W}x${H} in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
}

function main() {
  const a = parseArgs(process.argv.slice(2))
  const list = a.only ? SCENARIOS.filter((s) => a.only!.includes(s.id)) : SCENARIOS
  if (a.only && list.length !== a.only.length) {
    const known = new Set(SCENARIOS.map((s) => s.id))
    throw new Error(`unknown scenario(s): ${a.only.filter((i) => !known.has(i)).join(', ')}`)
  }
  if (!a.quiet) console.log(`keyer fixtures -> ${a.out}`)
  for (const sc of list) generateScenario(sc, a.W, a.H, a.frames, a.out, a.force, a.quiet)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
