// Magic Screen end-to-end flows in Chromium with a fake green-screen camera.
import {
  expect,
  keepToHome,
  makePhoto,
  meToSnap,
  openHome,
  pickWorld,
  stepHeading,
  test,
  waitForLiveStage,
} from './helpers'

test('photo flow: Home → World → Me → Stickers → Snap → Keep, then it shows on Home', async ({ page, shot }) => {
  await makePhoto(page, shot)
  await keepToHome(page, 1)
  const tile = page.locator('.gallery-grid .creation-tile').first()
  await expect(tile).toHaveAttribute('aria-label', /^Picture from /)
  await expect(tile.locator('img')).toHaveAttribute('src', /^data:image\//)
  await shot('home-gallery')
})

test('video flow: records about 3 seconds and Keep plays it back', async ({ page, shot }) => {
  await openHome(page)
  await pickWorld(page)
  await meToSnap(page)

  await page.getByRole('radio', { name: 'Video' }).click()
  await expect(stepHeading(page, 'Film it!')).toBeVisible()
  await page.getByRole('button', { name: 'Start filming' }).click()
  await expect(page.locator('.rec-badge')).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(3200)
  await shot('recording')
  await page.getByRole('button', { name: 'Stop' }).click()

  await expect(stepHeading(page, 'You did it!')).toBeVisible({ timeout: 20_000 })
  const video = page.locator('.keep-result video')
  await expect(video).toBeVisible()
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2)

  // MediaRecorder WebM files can report duration=Infinity until seeked; a real
  // duration is what lets the scrubber work, so require a finite value > 1s.
  const rawDuration = await video.evaluate((v: HTMLVideoElement) => v.duration)
  console.log('keep video raw duration', rawDuration)
  const duration = await video.evaluate(async (v: HTMLVideoElement) => {
    if (!isFinite(v.duration)) {
      await new Promise<void>((resolve) => {
        const done = () => resolve()
        v.addEventListener('durationchange', done, { once: true })
        v.currentTime = 1e6
        setTimeout(done, 3000)
      })
      v.currentTime = 0
    }
    return v.duration
  })
  expect(duration).toBeGreaterThan(1)
  expect(duration).toBeLessThan(10)

  const size = await video.evaluate((v: HTMLVideoElement) => [v.videoWidth, v.videoHeight])
  expect(size[0]).toBeGreaterThan(100)
  expect(size[1]).toBeGreaterThan(100)

  // Playable: time advances once playing.
  const advanced = await video.evaluate(async (v: HTMLVideoElement) => {
    v.muted = true
    await v.play()
    const t0 = v.currentTime
    await new Promise((r) => setTimeout(r, 700))
    return v.currentTime !== t0
  })
  expect(advanced).toBe(true)
  await shot('keep-video')

  await keepToHome(page, 1)
  await expect(page.locator('.gallery-grid .creation-tile').first()).toHaveAttribute('aria-label', /^Video from /)
  await shot('home-gallery')
})

test('keyer: the green is removed and the child is kept', async ({ page, shot }) => {
  await openHome(page)
  const bgSrc = await pickWorld(page)
  expect(bgSrc).not.toBe('')
  await expect(stepHeading(page, 'Me!')).toBeVisible()
  await waitForLiveStage(page)
  await page.waitForTimeout(1500)
  await shot('me-keyed')

  const stats = await page.evaluate(async (src) => {
    const stage = document.querySelector<HTMLCanvasElement>('.stage-slot .stage-canvas')
    if (!stage) throw new Error('no stage canvas')
    const W = stage.width
    const H = stage.height
    const read = (draw: (ctx: CanvasRenderingContext2D) => void) => {
      const c = document.createElement('canvas')
      c.width = W
      c.height = H
      const ctx = c.getContext('2d', { willReadFrequently: true })!
      draw(ctx)
      return ctx.getImageData(0, 0, W, H).data
    }
    // The stage canvas (WebGL, preserveDrawingBuffer) copied into a 2D canvas.
    const live = read((ctx) => ctx.drawImage(stage, 0, 0, W, H))

    // The chosen world drawn the way the Compositor draws it: opaque cover-fit.
    const img = new Image()
    img.src = src
    await img.decode()
    const bg = read((ctx) => {
      const s = Math.max(W / img.naturalWidth, H / img.naturalHeight)
      const dw = img.naturalWidth * s
      const dh = img.naturalHeight * s
      ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh)
    })

    // Chroma-green test: green clearly dominates red and blue (like #2bb34a).
    const isChroma = (r: number, g: number, b: number) => g > 90 && g > r * 1.4 && g > b * 1.4
    const region = (x0: number, y0: number, x1: number, y1: number) => {
      let n = 0
      let green = 0
      let diff = 0
      let differing = 0
      // Sample every 4th pixel; plenty for a statistic and keeps this fast.
      for (let y = Math.floor(y0 * H); y < Math.floor(y1 * H); y += 4) {
        for (let x = Math.floor(x0 * W); x < Math.floor(x1 * W); x += 4) {
          const i = (y * W + x) * 4
          const d = (Math.abs(live[i] - bg[i]) + Math.abs(live[i + 1] - bg[i + 1]) + Math.abs(live[i + 2] - bg[i + 2])) / 3
          n++
          diff += d
          if (d > 40) differing++
          if (isChroma(live[i], live[i + 1], live[i + 2])) green++
        }
      }
      return { greenFrac: green / n, meanDiff: diff / n, differingFrac: differing / n }
    }
    // Border = top strip + the upper parts of the left/right edges. The figure in the
    // fixture never reaches these (head at ~40% height, sways within the middle).
    return {
      size: [W, H],
      top: region(0, 0, 1, 0.1),
      left: region(0, 0, 0.06, 0.5),
      right: region(0.94, 0, 1, 0.5),
      center: region(0.1, 0.3, 0.9, 1),
      bgChroma: region(0, 0, 1, 1).greenFrac, // for diagnostics only
    }
  }, bgSrc)

  console.log('keyer stats', JSON.stringify(stats))
  for (const edge of [stats.top, stats.left, stats.right]) {
    // No chroma green left at the borders...
    expect(edge.greenFrac).toBeLessThan(0.02)
    // ...because the world shows through there.
    expect(edge.meanDiff).toBeLessThan(25)
  }
  // The child is composited over the world in the middle/bottom of the stage.
  expect(stats.center.differingFrac).toBeGreaterThan(0.05)
  expect(stats.center.greenFrac).toBeLessThan(0.02)
})

test('teacher gate: hold the gear, wrong PIN is rejected, 1234 opens Teacher', async ({ page, shot }) => {
  await openHome(page)
  const gear = page.getByRole('button', { name: /Teacher settings\. Press and hold/ })

  // A quick tap does not open the gate.
  await gear.click()
  await page.waitForTimeout(400)
  await expect(page.getByRole('dialog', { name: 'Grown-ups only' })).toHaveCount(0)

  // Hold for 2s+.
  const box = (await gear.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(2400)
  await page.mouse.up()
  const gate = page.getByRole('dialog', { name: 'Grown-ups only' })
  await expect(gate).toBeVisible()
  await shot('gate')

  for (const d of ['9', '9', '9', '9']) await gate.getByRole('button', { name: d, exact: true }).click()
  await expect(gate.getByRole('alert')).toHaveText('Oops! That code is not right.')
  await expect(gate.locator('.pin-dot.filled')).toHaveCount(0)
  await expect(gate).toBeVisible()
  await shot('gate-wrong')

  for (const d of ['1', '2', '3', '4']) await gate.getByRole('button', { name: d, exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Teacher settings' })).toBeVisible()
  await expect(gate).toHaveCount(0)
  await shot('teacher')
})

test('view a creation and delete it', async ({ page, shot }) => {
  await makePhoto(page)
  await keepToHome(page, 1)

  await page.locator('.gallery-grid .creation-tile').first().click()
  const picture = page.getByRole('img', { name: 'Your picture' })
  await expect(picture).toBeVisible()
  await expect
    .poll(() => picture.evaluate((el: HTMLImageElement) => (el.complete ? el.naturalWidth : 0)))
    .toBeGreaterThan(100)
  await shot('view')

  // Cancel first: nothing is deleted.
  await page.getByRole('button', { name: 'Delete' }).click()
  const confirm = page.getByRole('alertdialog', { name: 'Delete this?' })
  await expect(confirm).toBeVisible()
  await shot('confirm')
  await confirm.getByRole('button', { name: 'Keep it' }).click()
  await expect(confirm).toHaveCount(0)
  await expect(picture).toBeVisible()

  await page.getByRole('button', { name: 'Delete' }).click()
  await confirm.getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByRole('button', { name: /Let's make!/ })).toBeVisible()
  await expect(page.getByText('Nothing here yet.')).toBeVisible()
  await expect(page.locator('.gallery-grid .creation-tile')).toHaveCount(0)
  await shot('home-after-delete')

  // Still gone after a reload (deleted from IndexedDB, not just the UI).
  await page.reload()
  await expect(page.getByText('Nothing here yet.')).toBeVisible()
})
