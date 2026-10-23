// Test-only preview for src/assets/animatedWorlds.ts (not part of the app build).
//
//   /e2e/fixtures/animated-preview.html            all worlds, live, in a grid
//   ...?posters=1                                  the still poster tiles
//   ...?world=<id>&w=1280&h=720[&rm=1]             one world, paused (driven via window.__aw)
//
// window.__aw exposes helpers for the Playwright capture/bench script.
import { ANIMATED_WORLDS, type AnimatedWorldInstance } from '../../src/assets/animatedWorlds'

const params = new URLSearchParams(location.search)
const grid = document.getElementById('grid')!
const single = document.getElementById('single')!

interface BenchResult {
  id: string
  frames: number
  avgMs: number
  p95Ms: number
  maxMs: number
  flushedAvgMs: number
}

const live: AnimatedWorldInstance[] = []
let current: AnimatedWorldInstance | null = null

async function bench(width: number, height: number, frames: number, reducedMotion = false): Promise<BenchResult[]> {
  const out: BenchResult[] = []
  for (const world of ANIMATED_WORLDS) {
    const inst = world.create(width, height, { reducedMotion })
    await inst.ready
    const times = new Float64Array(frames)
    let now = 1000
    for (let i = 0; i < 30; i++) inst.frame((now += 16.67)) // warm up
    for (let i = 0; i < frames; i++) {
      const t0 = performance.now()
      inst.frame((now += 16.67))
      times[i] = performance.now() - t0
    }
    // wall time for a frame batch including a GPU flush (getImageData forces it)
    const T0 = performance.now()
    for (let i = 0; i < 60; i++) inst.frame((now += 16.67))
    inst.canvas.getContext('2d')?.getImageData(0, 0, 1, 1)
    const flushedMs = (performance.now() - T0) / 60
    const sorted = Array.from(times).sort((a, b) => a - b)
    out.push({
      id: world.id,
      frames,
      avgMs: +(sorted.reduce((a, b) => a + b, 0) / frames).toFixed(3),
      p95Ms: +sorted[Math.floor(frames * 0.95)].toFixed(3),
      maxMs: +sorted[frames - 1].toFixed(3),
      flushedAvgMs: +flushedMs.toFixed(3),
    })
    inst.destroy()
  }
  return out
}

declare global {
  interface Window {
    __aw: {
      ready: Promise<void>
      ids: string[]
      show(t: number): void
      bench: typeof bench
      pauseResumeCheck(): Promise<{ jumpFree: boolean; frozen: boolean }>
    }
  }
}

let readyResolve: () => void = () => {}
const readyP = new Promise<void>((r) => (readyResolve = r))

window.__aw = {
  ready: readyP,
  ids: ANIMATED_WORLDS.map((w) => w.id),
  show(t: number) {
    if (!current) return
    current.stop()
    current.seek(t)
    current.frame(performance.now())
  },
  bench,
  async pauseResumeCheck() {
    const inst = ANIMATED_WORLDS[0].create(320, 180)
    await inst.ready
    const ctx = inst.canvas.getContext('2d')!
    const snap = () => Array.from(ctx.getImageData(0, 0, 320, 180).data.filter((_, i) => i % 97 === 0)).join(',')
    inst.frame(1000)
    inst.frame(1016)
    inst.stop()
    const a = snap()
    inst.frame(5000)
    const frozen = snap() === a
    inst.start()
    inst.frame(60000) // first frame after resume must not advance
    const jumpFree = snap() === a
    inst.destroy()
    return { jumpFree, frozen }
  },
}

const worldId = params.get('world')
if (worldId) {
  const w = ANIMATED_WORLDS.find((x) => x.id === worldId)
  if (!w) throw new Error(`unknown world ${worldId}`)
  current = w.create(Number(params.get('w') ?? 1280), Number(params.get('h') ?? 720), {
    reducedMotion: params.get('rm') === '1',
  })
  single.appendChild(current.canvas)
  current.ready.then(() => {
    window.__aw.show(Number(params.get('t') ?? 0))
    readyResolve()
  })
} else if (params.get('posters')) {
  Promise.all(
    ANIMATED_WORLDS.map(
      (w) =>
        new Promise<void>((resolve) => {
          const fig = document.createElement('figure')
          const img = new Image()
          img.onload = img.onerror = () => resolve()
          img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(w.posterSvg)}`
          const cap = document.createElement('figcaption')
          cap.textContent = `${w.name} (poster)`
          fig.append(img, cap)
          grid.appendChild(fig)
        }),
    ),
  ).then(() => readyResolve())
} else {
  for (const w of ANIMATED_WORLDS) {
    const inst = w.create(960, 540)
    live.push(inst)
    const fig = document.createElement('figure')
    const cap = document.createElement('figcaption')
    cap.textContent = w.name
    fig.append(inst.canvas, cap)
    grid.appendChild(fig)
  }
  const loop = (now: number) => {
    for (const inst of live) inst.frame(now)
    requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)
  Promise.all(live.map((i) => i.ready)).then(() => readyResolve())
}
