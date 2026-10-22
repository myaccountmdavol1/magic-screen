// Live keyer quality on the default fake camera (e2e/fixtures/fake-greenscreen.y4m).
// The test builds its own Compositor on the camera (modules come straight from the
// Vite dev server) so it can read the real matte every frame, then asserts:
//   - border: the screen around the child is keyed out
//   - figure: clearly-not-green pixels stay fully opaque
//   - flicker: the still screen region doesn't sparkle from frame to frame
// Thresholds have headroom over measured values (QA, Chromium/Metal: border leak 0,
// figure ≈ 1.0, flicker 0), so a real regression trips them but GPU noise doesn't.
import { expect } from '@playwright/test'
import { test } from './helpers'

interface KeyerMetrics {
  camera: string
  frames: number
  borderMean: number
  borderOver5: number
  figureMean: number
  figureN: number
  flicker: number
  flickerMax: number
}

test('keyer quality: border keyed out, figure opaque, no flicker', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'metrics need one stable viewport')
  await page.goto('/')
  const m: KeyerMetrics = await page.evaluate(async () => {
    // Variables keep TypeScript from resolving dev-server URLs at build time.
    const compPath = '/src/lib/keyer/Compositor.ts'
    const labPath = '/src/lib/keyer/labKey.ts'
    const storePath = '/src/state/store.ts'
    const { Compositor } = await import(/* @vite-ignore */ compPath)
    const { keyDistRgb, keyLabParams } = await import(/* @vite-ignore */ labPath)
    const { DEFAULT_SETTINGS } = await import(/* @vite-ignore */ storePath)

    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.srcObject = stream
    await video.play()
    while (!video.videoWidth) await new Promise((r) => setTimeout(r, 30))

    const canvas = document.createElement('canvas')
    const comp = new Compositor(canvas, { width: 1280, height: 720 })
    const key = { ...DEFAULT_SETTINGS.key, mode: 'chroma' }
    comp.setKey(key)
    comp.setBackground('#7b2cbf')
    comp.setForeground(video, { mirror: false })
    const raf = () => new Promise<number>((r) => requestAnimationFrame(r))
    for (let t0 = performance.now(); performance.now() - t0 < 800; await raf()) comp.render()
    // Same as the app: auto key from the frame border after the camera settles.
    const picked = comp.sampleBorderColor()
    if (picked) comp.setKey({ ...key, color: picked })
    for (let t0 = performance.now(); performance.now() - t0 < 500; await raf()) comp.render()

    const MW = 640
    const MH = 360
    const N = MW * MH
    // The matte exactly as the stage uses it (guided filter, choke, temporal EMA).
    const matte = (): Uint8Array => {
      const px: Uint8ClampedArray = comp.matteGl(comp.glState, MW, MH)
      const a = new Uint8Array(N)
      for (let i = 0; i < N; i++) a[i] = px[i * 4]
      return a
    }
    // Screen-only region of this fixture: the top 15% (the head never reaches it)
    // and the left 6% (the swaying child stays right of it).
    const border = new Uint8Array(N)
    for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) if (y < MH * 0.15 || x < MW * 0.06) border[y * MW + x] = 1
    let borderN = 0
    for (let i = 0; i < N; i++) borderN += border[i]

    // Flicker: consecutive live camera frames, mean |Δalpha| over the border.
    let flicker = 0
    let flickerMax = 0
    let pairs = 0
    let prev: Uint8Array | null = null
    const FRAMES = 40
    await new Promise<void>((resolve) => {
      let n = 0
      const onFrame = () => {
        comp.render()
        const a = matte()
        if (prev) {
          let d = 0
          for (let i = 0; i < N; i++) if (border[i]) d += Math.abs(a[i] - prev[i])
          const v = d / borderN / 255
          flicker += v
          flickerMax = Math.max(flickerMax, v)
          pairs++
        }
        prev = a
        if (++n >= FRAMES) resolve()
        else video.requestVideoFrameCallback(onFrame)
      }
      video.requestVideoFrameCallback(onFrame)
    })

    // Still frame: the matte and the camera picture now show the same frame.
    video.pause()
    for (let i = 0; i < 12; i++) {
      await raf()
      comp.render()
    }
    const a = matte()
    const cam = document.createElement('canvas')
    cam.width = MW
    cam.height = MH
    const cctx = cam.getContext('2d', { willReadFrequently: true })!
    cctx.drawImage(video, 0, 0, MW, MH)
    const rgb = cctx.getImageData(0, 0, MW, MH).data
    // "Clearly the child": far from the key colour, eroded 3 px so edges don't count.
    const k = keyLabParams(comp.getStats().keyColor)
    const far = new Uint8Array(N)
    for (let i = 0; i < N; i++) {
      far[i] = keyDistRgb([rgb[i * 4] / 255, rgb[i * 4 + 1] / 255, rgb[i * 4 + 2] / 255], k) > 35 ? 1 : 0
    }
    let figureSum = 0
    let figureN = 0
    for (let y = 3; y < MH - 3; y++)
      for (let x = 3; x < MW - 3; x++) {
        let core = 1
        for (let dy = -3; dy <= 3 && core; dy++) for (let dx = -3; dx <= 3; dx++) if (!far[(y + dy) * MW + x + dx]) { core = 0; break }
        if (core) {
          figureSum += a[y * MW + x] / 255
          figureN++
        }
      }
    let borderSum = 0
    let over5 = 0
    for (let i = 0; i < N; i++)
      if (border[i]) {
        borderSum += a[i] / 255
        if (a[i] > 13) over5++
      }
    stream.getTracks().forEach((t) => t.stop())
    comp.destroy()
    return {
      camera: `${video.videoWidth}x${video.videoHeight}`,
      frames: pairs,
      borderMean: borderSum / borderN,
      borderOver5: over5 / borderN,
      figureMean: figureN ? figureSum / figureN : 0,
      figureN,
      flicker: pairs ? flicker / pairs : 1,
      flickerMax,
    }
  })
  testInfo.annotations.push({ type: 'keyer-metrics', description: JSON.stringify(m) })

  expect(m.frames, 'enough live frame pairs for a flicker reading').toBeGreaterThanOrEqual(20)
  expect(m.figureN, 'the child was found in the picture').toBeGreaterThan(640 * 360 * 0.03)
  expect(m.borderMean, 'screen border keyed out (mean alpha)').toBeLessThan(0.01)
  expect(m.borderOver5, 'screen border pixels above 5% alpha').toBeLessThan(0.01)
  expect(m.figureMean, 'child stays opaque').toBeGreaterThan(0.98)
  expect(m.flicker, 'mean frame-to-frame alpha change on the still screen').toBeLessThan(0.004)
  expect(m.flickerMax, 'worst frame-to-frame alpha change on the still screen').toBeLessThan(0.02)
})
