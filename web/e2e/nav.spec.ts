// Make-flow navigation for pre-readers (ease-of-use plan A1 + A4): no accidental exits,
// a big Next arrow that explains itself, idle re-prompts, kid-proof stepper.
import type { Locator, Page } from '@playwright/test'
import { expect, openHome, stepHeading, test } from './helpers'

/** Record every spoken prompt instead of speaking it (window.__spoken). */
async function recordSpeech(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __spoken: string[] }
    w.__spoken = []
    // Spoken prompts start off (a teacher turns them on); switch them on for this test.
    try {
      const k = 'magicscreen.settings'
      localStorage.setItem(k, JSON.stringify({ ...JSON.parse(localStorage.getItem(k) ?? '{}'), voice: true }))
      // Mark the one-time "audio off" reset as done, or it would switch voice back off.
      localStorage.setItem('magicscreen.audioOffReset', '1')
    } catch {
      /* ignore */
    }
    const s = window.speechSynthesis
    if (!s) return
    s.speak = (u: SpeechSynthesisUtterance) => {
      w.__spoken.push(u.text)
    }
    s.cancel = () => {}
  })
}
const spoken = (page: Page) => page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken.slice())
const clearSpoken = (page: Page) =>
  page.evaluate(() => {
    ;(window as unknown as { __spoken: string[] }).__spoken.length = 0
  })

async function hold(page: Page, target: Locator, ms: number) {
  const box = (await target.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(ms)
  await page.mouse.up()
}

test('world step: logo is inert, stepper is progress only, the greyed arrow explains, a pick lights it up', async ({
  page,
  shot,
}) => {
  await recordSpeech(page)
  await openHome(page)
  await page.getByRole('button', { name: /Let's make!/ }).click()
  await expect(stepHeading(page, 'Pick a world')).toBeVisible()

  // A1: the logo no longer goes home mid-flow; the stepper can't be tapped.
  await expect(page.locator('.topbar .logo-button')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /go home/i })).toHaveCount(0)
  await expect(page.locator('.stepper button')).toHaveCount(0)
  await expect(page.locator('.stepper [aria-current="step"]')).toHaveAttribute('aria-label', /Step 1: World/)

  // A4: speaker is a full kid target.
  const speaker = page.getByRole('button', { name: 'Say it again' })
  // Poll: the step pops in with a scale animation, so the first measurement can be short.
  await expect
    .poll(async () => {
      const sb = (await speaker.boundingBox())!
      return Math.min(sb.width, sb.height)
    })
    .toBeGreaterThanOrEqual(63.5)

  // Greyed arrow is still tappable: boop, wiggle the grid, say what's missing.
  const next = page.getByRole('button', { name: 'Next: Me!' })
  await expect(next).toHaveAttribute('aria-disabled', 'true')
  await expect(next).toHaveClass(/waiting/)
  const nb = (await next.locator('.nav-arrow-circle').boundingBox())!
  expect(nb.width).toBeGreaterThanOrEqual(64)
  await clearSpoken(page)
  // force: Playwright treats aria-disabled as "not enabled" and would wait; a kid's tap lands.
  await next.click({ force: true })
  await expect(page.locator('.step-shell')).toHaveClass(/nudge-choice/)
  await expect(stepHeading(page, 'Pick a world')).toBeVisible()
  expect(await spoken(page)).toContain('Pick a world first!')
  await shot('world-blocked')

  // The nav band is solid, so it never sits see-through over the tiles.
  const bandAlpha = await page.locator('.make-step .nav-row').evaluate((el) => {
    const m = getComputedStyle(el).backgroundColor.match(/rgba?\(([^)]+)\)/)
    const parts = m ? m[1].split(',').map(Number) : []
    return parts.length === 4 ? parts[3] : parts.length === 3 ? 1 : 0
  })
  expect(bandAlpha).toBeGreaterThanOrEqual(0.9)

  // Pick a world: the arrow turns solid, pulses and says what to do.
  await clearSpoken(page)
  const tile = page.locator('.world-tile:not(.world-upload)').first()
  const name = (await tile.locator('.world-name').innerText()).trim()
  await tile.click()
  await expect(next).toHaveClass(/ready/)
  await expect(next).toHaveClass(/pulse/)
  await expect(next).not.toHaveAttribute('aria-disabled', 'true')
  await expect.poll(() => spoken(page)).toContain(`${name}! Great! Now tap the big arrow.`)
  await shot('world-ready')

  await next.click()
  await expect(stepHeading(page, 'Me!')).toBeVisible()
  await expect(page.locator('.stepper [aria-current="step"]')).toHaveAttribute('aria-label', /Step 2: Me/)
})

test('step-1 Home needs a hold, and leaving with work shows the picture-only stop dialog', async ({ page, shot }) => {
  await recordSpeech(page)
  await openHome(page)
  await page.getByRole('button', { name: /Let's make!/ }).click()
  const homeBtn = page.getByRole('button', { name: /^Home\. Press and hold/ })

  // A kid's tap does nothing (just a hint).
  await homeBtn.click()
  await page.waitForTimeout(400)
  await expect(stepHeading(page, 'Pick a world')).toBeVisible()

  // Held 1.5 s with nothing made yet: straight home.
  await hold(page, homeBtn, 1900)
  await expect(page.getByRole('button', { name: /Let's make!/ })).toBeVisible()

  // With work (went on to Me and came back): the hold asks first.
  await page.getByRole('button', { name: /Let's make!/ }).click()
  const tile = page.locator('.world-tile:not(.world-upload)').first()
  await tile.click()
  await page.getByRole('button', { name: 'Next: Me!' }).click()
  await expect(stepHeading(page, 'Me!')).toBeVisible()
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(stepHeading(page, 'Pick a world')).toBeVisible()

  await clearSpoken(page)
  await hold(page, homeBtn, 1900)
  const dialog = page.getByRole('alertdialog', { name: 'Do you want to stop?' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button')).toHaveCount(2)
  const keep = dialog.getByRole('button', { name: 'Keep going' })
  const stop = dialog.getByRole('button', { name: 'Stop and go home' })
  expect((await keep.boundingBox())!.width).toBeGreaterThan((await stop.boundingBox())!.width * 1.5)
  expect((await stop.boundingBox())!.width).toBeGreaterThanOrEqual(63.5)
  await expect(keep).toBeFocused()
  expect(await spoken(page)).toContain('Do you want to stop? Tap the green arrow to keep going.')
  await shot('stop-dialog')

  // Keep going: nothing lost.
  await keep.click({ force: true }) // it pulses, so it's never "stable"
  await expect(dialog).toHaveCount(0)
  await expect(tile).toHaveAttribute('aria-checked', 'true')

  // Stop: home.
  await hold(page, homeBtn, 1900)
  await expect(dialog).toBeVisible()
  await stop.click()
  await expect(page.getByRole('button', { name: /Let's make!/ })).toBeVisible()
})

test('toasts clear on screen change; after ~8 s idle the prompt repeats and the grid wiggles', async ({
  page,
  shot,
}) => {
  await recordSpeech(page)
  await openHome(page)

  // The gear's grown-up hint must not follow the child into World.
  await page.getByRole('button', { name: /Teacher settings\. Press and hold/ }).click()
  await expect(page.locator('.toast')).toContainText('Grown-ups')
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: /Let's make!/ }).click()
  await expect(stepHeading(page, 'Pick a world')).toBeVisible()
  await expect(page.locator('.toast')).toHaveCount(0)

  await clearSpoken(page)
  await expect(page.locator('.step-shell')).toHaveClass(/nudge-choice/, { timeout: 12_000 })
  expect(await spoken(page)).toContain('Pick a world. Where do you want to go?')
  await shot('world-idle-nudge')
})

test('a double tap on the Next arrow moves only one step', async ({ page }) => {
  await openHome(page)
  await page.getByRole('button', { name: /Let's make!/ }).click()
  await expect(stepHeading(page, 'Pick a world')).toBeVisible()
  await page.getByRole('radio').first().click()
  const arrow = page.locator('.nav-arrow.ready')
  await expect(arrow).toBeVisible()
  await page.waitForTimeout(400) // pop-in done, arrow settled
  const center = async (loc: Locator) => {
    const b = (await loc.boundingBox())!
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  }
  // Which nav button each click really landed on, and its event time.
  await page.evaluate(() => {
    const w = window as unknown as { __navClicks: { label: string | null; t: number }[] }
    w.__navClicks = []
    window.addEventListener(
      'click',
      (e) => {
        const btn = (e.target as Element).closest('.nav-arrow')
        w.__navClicks.push({ label: btn?.getAttribute('aria-label') ?? null, t: e.timeStamp })
      },
      true,
    )
  })
  // Two taps 150 ms apart by the touch's own clock, like a real touchscreen, whose event
  // times don't depend on how busy the page is. The second tap goes to Me's arrow once it
  // is on screen; under load that can be well over 150 ms of wall time later, but its
  // event time still says 150 ms, so the test is deterministic.
  const cdp = await page.context().newCDPSession(page)
  const t0 = Date.now() / 1000
  const tap = async ({ x, y }: { x: number; y: number }, at: number) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, timestamp: at })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, timestamp: at + 0.05 })
  }
  await tap(await center(arrow), t0)
  const meArrow = page.getByRole('button', { name: 'Next: Stickers' })
  // Wait (without clicking) until Me's arrow has popped in and is the element under its centre.
  await meArrow.click({ trial: true })
  await tap(await center(meArrow), t0 + 0.15)
  await page.waitForTimeout(600)
  await expect(stepHeading(page, 'Me!')).toBeVisible()
  // The second tap really hit Me's arrow, 150 ms after the first: it was ignored.
  const clicks = await page.evaluate(() => (window as unknown as { __navClicks: { label: string | null; t: number }[] }).__navClicks)
  expect(clicks.map((c) => c.label)).toEqual(['Next: Me!', 'Next: Stickers'])
  expect(clicks[1].t - clicks[0].t).toBeGreaterThan(140)
  expect(clicks[1].t - clicks[0].t).toBeLessThan(160)
})
