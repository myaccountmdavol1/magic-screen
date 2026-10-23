// Keyer quality harness runner.
//
//   npm run harness -- --label baseline [--helper off,on] [--only clean,specks]
//                      [--frames 60] [--size 640x360] [--warmup 10] [--cadence 2]
//                      [--no-timing] [--timing-only] [--dump] [--headed] [--port 5230]
//                      [--compare baseline] [--seg selfie:stretch,landscape:fit]
//                      [--models dir] [--tune segLo=0.4,gfRadius=6] [--timing-ids clean,webcam-beige]
//                      [--seg-timing] [--flags mirrorEdges=0,unmix=1]
//
// 1. generates the fixtures (cached by hash) with e2e/fixtures/gen/generate.ts
// 2. builds the page once with Vite and serves it statically (never port 5190: that's
//    the preview server)
// 3. opens e2e/harness/page/ in Playwright Chromium, which runs the real Compositor
// 4. writes e2e/harness/results/<label>.json and .md (and <label>-vs-<compare>.md)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_OUT, generateScenario } from '../fixtures/gen/generate.ts'
import { SCENARIOS } from '../fixtures/gen/scenarios.ts'
import { encodePNG } from '../fixtures/gen/png.ts'
import { compareMarkdown, toMarkdown, type Results, type RunResult, type TimingResult } from './report.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const webRoot = path.resolve(here, '..', '..')
const resultsDir = path.join(here, 'results')

interface Args {
  label: string
  helpers: string[]
  only: string[] | null
  frames: number | null
  W: number
  H: number
  warmup: number
  cadence: number
  timing: boolean
  scenarios: boolean
  dump: boolean
  headed: boolean
  port: number
  compare: string | null
  /** segmenter variants "model:input"; empty = app default */
  seg: string[]
  /** extra directory for /mediapipe/*.tflite not in public/ (model evaluation) */
  models: string | null
  tune: Record<string, number> | null
  /** Compositor.setKeyerFlags overrides (feature A/B) */
  flags: Record<string, number> | null
  timingIds: string[]
  /** C5: built-in world id whose front layer the timing run draws */
  front?: string
  segTiming: boolean
  mode: 'chroma' | 'segment' | null
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    label: 'run',
    helpers: ['off', 'on'],
    only: null,
    frames: null,
    W: 640,
    H: 360,
    warmup: 10,
    cadence: 2,
    timing: true,
    scenarios: true,
    dump: false,
    headed: false,
    port: 5230,
    compare: null,
    seg: [],
    models: null,
    tune: null,
    flags: null,
    timingIds: ['clean', 'webcam-beige'],
    segTiming: false,
    mode: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    const v = () => argv[++i]
    if (k === '--label') a.label = v()
    else if (k === '--helper') a.helpers = v().split(',').filter(Boolean)
    else if (k === '--only') a.only = v().split(',').filter(Boolean)
    else if (k === '--frames') a.frames = parseInt(v(), 10)
    else if (k === '--size') [a.W, a.H] = v().split('x').map(Number)
    else if (k === '--warmup') a.warmup = parseInt(v(), 10)
    else if (k === '--cadence') a.cadence = parseInt(v(), 10)
    else if (k === '--no-timing') a.timing = false
    else if (k === '--timing-only') a.scenarios = false
    else if (k === '--dump') a.dump = true
    else if (k === '--headed') a.headed = true
    else if (k === '--port') a.port = parseInt(v(), 10)
    else if (k === '--compare') a.compare = v()
    else if (k === '--seg') a.seg = v().split(',').filter(Boolean)
    else if (k === '--models') a.models = path.resolve(v())
    else if (k === '--tune')
      a.tune = Object.fromEntries(
        v()
          .split(',')
          .filter(Boolean)
          .map((kv) => {
            const [kk, vv] = kv.split('=')
            return [kk, Number(vv)]
          }),
      )
    else if (k === '--flags')
      a.flags = Object.fromEntries(
        v()
          .split(',')
          .filter(Boolean)
          .map((kv) => {
            const [kk, vv] = kv.split('=')
            return [kk, Number(vv)]
          }),
      )
    else if (k === '--timing-ids') a.timingIds = v().split(',').filter(Boolean)
    else if (k === '--seg-timing') a.segTiming = true
    else if (k === '--front') a.front = v()
    else if (k === '--mode') a.mode = v() as 'chroma' | 'segment'
    else throw new Error(`unknown option ${k}`)
  }
  if (a.port === 5190) throw new Error('port 5190 is the preview server; pick another')
  if (!/^[\w.-]+$/.test(a.label)) throw new Error('label: letters, digits, . _ - only')
  return a
}

async function main() {
  const a = parseArgs(process.argv.slice(2))
  const list = a.only ? SCENARIOS.filter((s) => a.only!.includes(s.id)) : SCENARIOS
  if (!list.length) throw new Error('no scenarios selected')

  console.log(`fixtures -> ${path.relative(webRoot, DEFAULT_OUT)}`)
  const needed = new Set(list.map((s) => s.id))
  if (a.timing) for (const id of a.timingIds) needed.add(id)
  for (const sc of SCENARIOS.filter((s) => needed.has(s.id))) generateScenario(sc, a.W, a.H, a.frames, DEFAULT_OUT, false, false)

  // One-shot production build of the harness page (no dev server: no HMR or
  // dependency re-optimisation reloading the page mid-run, and production shaders/JS
  // for the timing run), served by a tiny static server with the fixtures.
  // One build dir per port, so two runs (e.g. an A/B pair) can't wipe each other's page.
  const buildDir = path.join(webRoot, 'node_modules', a.port === 5230 ? '.keyer-harness' : `.keyer-harness-${a.port}`)
  const { build } = await import('vite')
  await build({
    configFile: false,
    root: webRoot,
    base: '/',
    logLevel: 'warn',
    publicDir: path.join(webRoot, 'public'),
    build: {
      outDir: buildDir,
      emptyOutDir: true,
      rollupOptions: { input: path.join(here, 'page', 'index.html') },
    },
  })
  const http = await import('node:http')
  const TYPES: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.wasm': 'application/wasm',
  }
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0])
    const fixtures = urlPath.startsWith('/__fixtures/')
    let root = fixtures ? DEFAULT_OUT : buildDir
    let file = path.resolve(root, urlPath.replace(/^\/(__fixtures\/)?/, ''))
    // Candidate models under evaluation live outside public/ (never precached).
    if (a.models && urlPath.startsWith('/mediapipe/') && urlPath.endsWith('.tflite') && !fs.existsSync(file)) {
      root = a.models
      file = path.resolve(root, path.basename(urlPath))
    }
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, {
      // Raw bytes, no content-encoding: the page gunzips with DecompressionStream.
      'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
      // cross-origin isolation -> fine-grained performance.now() for the timing run
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    })
    fs.createReadStream(file).pipe(res)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(a.port, '127.0.0.1', () => resolve())
  })
  const url = `http://127.0.0.1:${a.port}/e2e/harness/page/index.html`

  const { chromium } = await import('@playwright/test')
  const browser = await chromium.launch({
    headless: !a.headed,
    // Use the real GPU where the platform allows (macOS: ANGLE on Metal); timings on a
    // software rasterizer would say nothing about real devices.
    args: ['--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  })
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`  [page ${m.type()}] ${m.text()}`)
  })
  page.on('pageerror', (e) => console.log(`  [page error] ${e.message}`))
  const runs: RunResult[] = []
  const timing: TimingResult[] = []
  const segTimes: unknown[] = []
  let env: Record<string, unknown> = {}
  try {
    await page.goto(url)
    await page.waitForFunction(() => window.harness?.ready === true, null, { timeout: 60_000 })
    env = await page.evaluate(() => window.harness.glInfo())
    console.log(`renderer: ${String(env.renderer)}`)
    const dumpDir = path.join(resultsDir, a.label)
    if (a.scenarios) {
      for (const sc of list) {
        // Scenarios without a screen run the segment path whatever the helper setting,
        // so one helper variant is enough there.
        const helpers = sc.plate.screen === 'none' && !a.mode ? a.helpers.slice(0, 1) : a.helpers
        const segs = a.seg.length ? a.seg : ['']
        for (const segV of segs)
        for (const helper0 of helpers) {
          const t0 = Date.now()
          const [model, input] = segV ? segV.split(':') : []
          const seg = segV ? { model, input } : undefined
          const helper = segV ? `${helper0}@${segV}` : helper0
          const r = await page.evaluate(
            (o) => window.harness.runScenario(o as Parameters<typeof window.harness.runScenario>[0]),
            { id: sc.id, helper: helper0, warmup: a.warmup, cadence: a.cadence, dump: a.dump, seg, tune: a.tune ?? undefined, flags: a.flags ?? undefined, mode: a.mode ?? undefined },
          )
          r.helper = helper
          if (r.dump) {
            fs.mkdirSync(dumpDir, { recursive: true })
            const m = Buffer.from(r.dump.matte, 'base64')
            const c = Buffer.from(r.dump.comp, 'base64')
            const rgb = new Uint8Array(r.width * r.height * 3)
            for (let i = 0; i < r.width * r.height; i++) rgb.set(c.subarray(i * 4, i * 4 + 3), i * 3)
            fs.writeFileSync(path.join(dumpDir, `${sc.id}-${helper.replace(/[@:]/g, '_')}-matte.png`), encodePNG(new Uint8Array(m), r.width, r.height, 1))
            fs.writeFileSync(path.join(dumpDir, `${sc.id}-${helper.replace(/[@:]/g, '_')}-comp.png`), encodePNG(rgb, r.width, r.height, 3))
          }
          const { dump: _dump, ...rest } = r
          runs.push(rest as unknown as RunResult)
          const m = r.metrics
          console.log(
            `  ${sc.id.padEnd(16)} ${helper.padEnd(5)} ${r.mode.padEnd(7)} SAD ${m.sad?.toFixed(2)} edge ${m.sadEdge?.toFixed(2)} conn ${m.conn?.toFixed(2)} flicker ${m.flicker?.toFixed(2)} spill ${m.spill?.toFixed(2) ?? '-'} unmixΔE ${m.unmixDE?.toFixed(2) ?? '-'} isl ${m.islands?.toFixed(2)} ghost ${m.ghost?.toFixed(2) ?? '-'} dtSSD ${m.dtSSD?.toFixed(2) ?? '-'} keyΔE ${String(r.info.sampledKeyDE ?? '-')}/${String(r.info.finalKeyDE ?? '-')} iou ${String(r.info.maskIoU ?? '-')} (${((Date.now() - t0) / 1000).toFixed(1)} s)`,
          )
        }
      }
    }
    if (a.segTiming) {
      for (const segV of a.seg.length ? a.seg : ['selfie:stretch']) {
        const [model, input] = segV.split(':')
        const t = await page.evaluate((o) => window.harness.segTiming(o as Parameters<typeof window.harness.segTiming>[0]), {
          id: a.timingIds.includes('webcam-beige') ? 'webcam-beige' : list[0].id,
          seg: { model, input },
        })
        segTimes.push(t)
        console.log(`  segTiming ${segV.padEnd(20)} ${t.delegate} median ${t.median} ms p90 ${t.p90} ms`)
      }
    }
    if (a.timing) {
      for (const id of a.timingIds)
      for (const helper of (SCENARIOS.find((s) => s.id === id)?.plate.screen === 'none' ? ['off'] : ['off', 'synth']) as ('off' | 'synth')[]) {
        const t = await page.evaluate((o) => window.harness.timing(o), { id, helper, flags: a.flags ?? undefined, front: a.front })
        timing.push(t)
        console.log(`  timing ${id} ${helper.padEnd(5)} ${t.mode} ${t.stage} cpu ${t.cpuMedian.toFixed(3)} ms (p90 ${t.cpuP90.toFixed(3)}), gpu ${t.gpuMedian?.toFixed(3) ?? 'n/a'} ms (p90 ${t.gpuP90?.toFixed(3) ?? 'n/a'}), +sync ${t.syncMedian.toFixed(2)} ms`)
      }
    }
  } finally {
    await browser.close()
    await new Promise((r) => server.close(r))
  }

  const results: Results = {
    label: a.label,
    date: new Date().toISOString(),
    env: { ...env, node: process.version, platform: `${process.platform}-${process.arch}` },
    options: { size: `${a.W}x${a.H}`, frames: a.frames, warmup: a.warmup, cadence: a.cadence, helpers: a.helpers, seg: a.seg, tune: a.tune, flags: a.flags },
    segTiming: segTimes,
    runs,
    timing,
  }
  fs.mkdirSync(resultsDir, { recursive: true })
  const base = path.join(resultsDir, a.label)
  fs.writeFileSync(`${base}.json`, JSON.stringify(results, null, 2) + '\n')
  fs.writeFileSync(`${base}.md`, toMarkdown(results))
  console.log(`wrote ${path.relative(webRoot, base)}.json / .md`)
  if (a.compare) {
    const prev = JSON.parse(fs.readFileSync(path.join(resultsDir, `${a.compare}.json`), 'utf8')) as Results
    const md = compareMarkdown(prev, results)
    fs.writeFileSync(path.join(resultsDir, `${a.label}-vs-${a.compare}.md`), md)
    console.log(md)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
