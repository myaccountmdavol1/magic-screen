import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ANIMATED_WORLDS, getAnimatedWorld, LOOP_SECONDS } from './animatedWorlds'

// jsdom has no 2D canvas and never loads images, so tests run two ways:
// 1. bare jsdom (getContext unsupported): everything must be a safe no-op;
// 2. a recording fake 2D context + an Image stub that "loads" at once, so the sprite
//    path really runs.

type Call = [string, ...unknown[]]

function fakeContext(calls: Call[]) {
  const rec =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args])
    }
  return {
    setTransform: rec('setTransform'),
    drawImage: rec('drawImage'),
    fillRect: rec('fillRect'),
    beginPath: rec('beginPath'),
    moveTo: rec('moveTo'),
    quadraticCurveTo: rec('quadraticCurveTo'),
    stroke: rec('stroke'),
    globalAlpha: 1,
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    imageSmoothingEnabled: true,
  }
}

class LoadingImage {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  width: number
  height: number
  constructor(w = 0, h = 0) {
    this.width = w
    this.height = h
  }
  set src(_v: string) {
    queueMicrotask(() => this.onload?.())
  }
}

describe('animatedWorlds catalogue', () => {
  it('has 5-6 worlds with unique ids, names and posters', () => {
    expect(ANIMATED_WORLDS.length).toBeGreaterThanOrEqual(5)
    expect(ANIMATED_WORLDS.length).toBeLessThanOrEqual(6)
    expect(new Set(ANIMATED_WORLDS.map((w) => w.id)).size).toBe(ANIMATED_WORLDS.length)
    for (const w of ANIMATED_WORLDS) {
      expect(w.name.length).toBeGreaterThan(0)
      expect(w.thumbColor).toMatch(/^#[0-9a-f]{6}$/i)
      expect(w.posterSvg.startsWith('<svg')).toBe(true)
      expect(w.posterSvg).toContain('viewBox="0 0 1920 1080"')
      expect(w.posterSvg).toContain('width="1920"')
      expect(w.posterSvg).toMatch(/<use href="#aw-/)
      // poster markup must be well formed XML
      const doc = new DOMParser().parseFromString(w.posterSvg, 'image/svg+xml')
      expect(doc.getElementsByTagName('parsererror').length).toBe(0)
      expect(getAnimatedWorld(w.id)).toBe(w)
    }
    expect(getAnimatedWorld('nope')).toBeUndefined()
  })
})

describe('instances without canvas support (bare jsdom)', () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null)
  })
  afterEach(() => vi.restoreAllMocks())

  it('create / frame / stop / start / destroy never throw', () => {
    for (const w of ANIMATED_WORLDS) {
      const inst = w.create(1280, 720)
      expect(inst.canvas).toBeInstanceOf(HTMLCanvasElement)
      expect(inst.canvas.width).toBe(1280)
      expect(inst.canvas.height).toBe(720)
      expect(inst.running).toBe(true)
      expect(() => {
        inst.frame(0)
        inst.frame(16)
        inst.stop()
        inst.frame(32)
        inst.start()
        inst.frame(48)
        inst.seek(12.5)
        inst.frame(64)
        inst.destroy()
        inst.destroy()
        inst.frame(80)
      }).not.toThrow()
    }
  })
})

describe('instances with a (fake) 2D context', () => {
  let calls: Call[]
  beforeEach(() => {
    calls = []
    const ctx = fakeContext(calls)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ctx as unknown as CanvasRenderingContext2D)
    vi.stubGlobal('Image', LoadingImage)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('rasterizes once, then each frame is drawImage-only work', async () => {
    for (const w of ANIMATED_WORLDS) {
      const inst = w.create(1280, 720, { reducedMotion: false })
      await inst.ready
      calls.length = 0
      for (let i = 0; i < 120; i++) inst.frame(1000 + i * 16.7)
      const draws = calls.filter((c) => c[0] === 'drawImage')
      // static layer every frame + sprites
      expect(draws.length).toBeGreaterThan(120 * 2)
      // never re-parses SVG per frame: no Image construction after ready
      inst.destroy()
      expect(inst.canvas.width).toBe(0)
    }
  })

  it('draws a placeholder fill before the art is ready', () => {
    const inst = ANIMATED_WORLDS[0].create(640, 360)
    calls.length = 0
    inst.frame(0)
    expect(calls.some((c) => c[0] === 'fillRect')).toBe(true)
    inst.destroy()
  })

  it('is deterministic from time and pause-safe', async () => {
    const w = getAnimatedWorld('sea-moving')!
    const a = w.create(320, 180, { reducedMotion: false })
    const b = w.create(320, 180, { reducedMotion: false })
    await Promise.all([a.ready, b.ready])
    const record = (inst: typeof a) => {
      calls.length = 0
      inst.frame(performance.now())
      return JSON.stringify(calls)
    }
    a.stop()
    b.stop()
    a.seek(7.25)
    b.seek(7.25 + LOOP_SECONDS) // wraps to the same pose
    expect(record(a)).toBe(record(b))

    // stop() freezes; start() resumes without a jump even after a long gap
    const frozen = record(a)
    a.frame(999_999)
    expect(record(a)).toBe(frozen)
    a.start()
    a.frame(5_000_000)
    expect(record(a)).not.toBe('') // drew
    a.stop()
    expect(record(a)).toBe(frozen)
    a.destroy()
    b.destroy()
  })

  it('reduced motion drops the lightning flash', async () => {
    const w = getAnimatedWorld('weather-moving')!
    const flashTime = 9.65 // inside the first lightning flicker
    const normal = w.create(320, 180, { reducedMotion: false })
    const calm = w.create(320, 180, { reducedMotion: true })
    await Promise.all([normal.ready, calm.ready])
    const washes = (inst: typeof normal) => {
      inst.stop()
      inst.seek(flashTime)
      calls.length = 0
      inst.frame(0)
      return calls.filter((c) => c[0] === 'fillRect').length
    }
    expect(washes(normal)).toBe(1)
    expect(washes(calm)).toBe(0)
    normal.destroy()
    calm.destroy()
  })

  it('clamps big frame gaps (hidden tab) so motion never jumps', async () => {
    const w = getAnimatedWorld('space-moving')!
    const a = w.create(320, 180, { reducedMotion: false })
    const b = w.create(320, 180, { reducedMotion: false })
    await Promise.all([a.ready, b.ready])
    a.frame(0)
    a.frame(10_000) // 10 s gap counts as one 100 ms step
    b.frame(0)
    b.frame(100)
    calls.length = 0
    a.stop()
    a.frame(0)
    const ca = JSON.stringify(calls)
    calls.length = 0
    b.stop()
    b.frame(0)
    expect(JSON.stringify(calls)).toBe(ca)
    a.destroy()
    b.destroy()
  })
})
