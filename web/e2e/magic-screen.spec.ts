// Magic Screen end-to-end flows in Chromium with a fake green-screen camera.
import {
  expect,
  holdButton,
  keepToHome,
  makePhoto,
  meToSnap,
  openHome,
  openTeacher,
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

test('teacher gate: hold the gear, a wrong answer is rejected, the right answer opens Teacher', async ({ page, shot }) => {
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

  const question = gate.locator('.gate-question')
  const answerFor = async () => {
    const m = (await question.innerText()).match(/(\d+)\s*×\s*(\d+)/)
    expect(m).not.toBeNull()
    return Number(m![1]) * Number(m![2])
  }
  const typeAnswer = async (n: number) => {
    for (const d of String(n)) await gate.getByRole('button', { name: d, exact: true }).click()
    await gate.getByRole('button', { name: 'Check answer' }).click()
  }

  // Wrong answer: friendly message, a brand new question, gate stays shut.
  const first = await question.innerText()
  await typeAnswer((await answerFor()) + 1)
  await expect(gate.getByRole('alert')).toHaveText('Not quite. Try this one!')
  await expect(question).not.toHaveText(first)
  await expect(gate).toBeVisible()
  await shot('gate-wrong')

  await typeAnswer(await answerFor())
  await expect(page.getByRole('heading', { level: 1, name: 'Teacher settings' })).toBeVisible()
  await expect(gate).toHaveCount(0)
  await shot('teacher')
})

test('view a creation (no kid Delete), delete it in Teacher, then restore it from Recently deleted', async ({ page, shot }) => {
  await makePhoto(page)
  await keepToHome(page, 1)

  await page.locator('.gallery-grid .creation-tile').first().click()
  const picture = page.getByRole('img', { name: 'Your picture' })
  await expect(picture).toBeVisible()
  await expect
    .poll(() => picture.evaluate((el: HTMLImageElement) => (el.complete ? el.naturalWidth : 0)))
    .toBeGreaterThan(100)
  await expect(page.getByRole('heading', { level: 1, name: /^My photo · / })).toBeVisible()
  // Kids can save but not delete.
  await expect(page.getByRole('button', { name: 'Save' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Delete/ })).toHaveCount(0)
  await shot('view')
  await page.locator('.nav-row').getByRole('button', { name: 'Home' }).click()
  await expect(page.locator('.gallery-grid .creation-tile:not(.skeleton)')).toHaveCount(1)

  // A grown-up deletes it in Teacher → Creations: it moves to Recently deleted.
  await openTeacher(page)
  const saved = page.getByRole('list', { name: 'Saved creations' })
  await expect(saved.getByRole('listitem')).toHaveCount(1)
  await saved.getByRole('button', { name: /^Delete Photo · / }).click()
  const bin = page.getByRole('list', { name: 'Recently deleted' })
  await expect(bin.getByRole('listitem')).toHaveCount(1)
  await expect(bin).toContainText('7 days left')
  await expect(saved).toHaveCount(0)
  await bin.scrollIntoViewIfNeeded()
  await shot('teacher-recently-deleted')

  // Gone from the kids' gallery, even after a reload.
  await page.getByRole('button', { name: 'Back home' }).click()
  await expect(page.getByText('Nothing here yet.')).toBeVisible()
  await expect(page.locator('.gallery-grid .creation-tile')).toHaveCount(0)
  await page.reload()
  await expect(page.getByText('Nothing here yet.')).toBeVisible()

  // Restore brings it back.
  await openTeacher(page)
  await page.getByRole('list', { name: 'Recently deleted' }).getByRole('button', { name: /^Restore Photo · / }).click()
  await expect(page.getByRole('list', { name: 'Saved creations' }).getByRole('listitem')).toHaveCount(1)
  await expect(page.getByRole('list', { name: 'Recently deleted' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Back home' }).click()
  await expect(page.locator('.gallery-grid .creation-tile:not(.skeleton)')).toHaveCount(1)
  await shot('home-after-restore')
})

test('Me step: kids see 3 tools; a 3s hold on the stage gear opens Grown-up fix; Flip lasts the session only', async ({ page, shot }) => {
  await openHome(page)
  await pickWorld(page)
  await expect(stepHeading(page, 'Me!')).toBeVisible()
  await waitForLiveStage(page)

  const aside = page.locator('.me-tools')
  for (const name of ['Bigger', 'Smaller', 'Center me']) await expect(aside.getByRole('button', { name })).toBeVisible()
  for (const name of ['Tap the green', 'Auto fix', 'Tighter edge', 'Looser edge', 'Flip camera']) {
    await expect(page.getByRole('button', { name })).toHaveCount(0)
  }
  await page.getByRole('button', { name: 'Bigger' }).click()
  await shot('me-kid-tools')

  // The gear sits in the stage corner, not among the kid tools.
  const hold = /Grown-up fix\. Press and hold/
  await expect(aside.getByRole('button', { name: hold })).toHaveCount(0)
  await expect(page.locator('.stage-slot').getByRole('button', { name: hold })).toBeVisible()
  // A quick tap does nothing, and neither does a kid's 2s resting finger; a 3s hold opens it.
  await page.getByRole('button', { name: hold }).click()
  await page.waitForTimeout(400)
  await expect(page.getByRole('region', { name: 'Grown-up fix' })).toHaveCount(0)
  await holdButton(page, hold, 2200)
  await expect(page.getByRole('region', { name: 'Grown-up fix' })).toHaveCount(0)
  await holdButton(page, hold, 3400)
  const drawer = page.getByRole('region', { name: 'Grown-up fix' })
  await expect(drawer).toBeVisible()
  // The fake camera shows a green screen, so the green tools appear once the mode is decided.
  for (const name of ['Tap the green', 'Auto fix', 'Tighter edge', 'Looser edge', 'Flip camera']) {
    await expect(drawer.getByRole('button', { name })).toBeVisible()
  }
  await shot('me-grown-up-fix')

  const savedFacing = () =>
    page.evaluate(() => {
      const raw = localStorage.getItem('magicscreen.settings')
      return raw ? (JSON.parse(raw) as { facing?: string }).facing ?? 'user' : 'user'
    })
  const before = await savedFacing()
  await drawer.getByRole('button', { name: 'Flip camera' }).click()
  await waitForLiveStage(page)
  expect(await savedFacing()).toBe(before)

  await drawer.getByRole('button', { name: 'Done' }).click()
  await expect(drawer).toHaveCount(0)
  await expect(page.getByRole('button', { name: hold })).toBeVisible()
})
