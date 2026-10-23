// Capture safety (ease-of-use plan A2, A6, A8): the mic is asked on the Video tap, no
// dead gap or 1-second clips, leaving the app saves the movie, a camera drop gets a
// big "Wake it up" button, and a failed gallery save never pretends it worked.
import type { Page } from '@playwright/test'
import { expect, meToSnap, openHome, pickWorld, snapPhoto, stepHeading, test } from './helpers'

/** Count getUserMedia calls that ask for audio (window.__micAsks), optionally denying them. */
async function spyMic(page: Page, opts: { deny?: boolean } = {}) {
  await page.addInitScript((deny) => {
    const w = window as unknown as { __micAsks: number }
    w.__micAsks = 0
    const md = navigator.mediaDevices
    const orig = md.getUserMedia.bind(md)
    md.getUserMedia = (c?: MediaStreamConstraints) => {
      if (c?.audio) {
        w.__micAsks++
        if (deny) return Promise.reject(new DOMException('Permission denied', 'NotAllowedError'))
      }
      return orig(c)
    }
  }, !!opts.deny)
}
const micAsks = (page: Page) => page.evaluate(() => (window as unknown as { __micAsks: number }).__micAsks)

/** Record spoken prompts instead of speaking them (window.__spoken). */
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

/** Pretend the iPad went to the home screen (or came back). */
async function setHidden(page: Page, hidden: boolean) {
  await page.evaluate((h) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h })
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') })
    document.dispatchEvent(new Event('visibilitychange'))
  }, hidden)
}

async function toSnap(page: Page) {
  await openHome(page)
  await pickWorld(page)
  await meToSnap(page)
}

test('video: mic asked on the Video tap, REC pulse, 2s stop guard, draining ring with no digits', async ({ page, shot }) => {
  await spyMic(page)
  await recordSpeech(page)
  await toSnap(page)

  expect(await micAsks(page)).toBe(0)
  await page.getByRole('radio', { name: 'Video' }).click()
  // Asked right away, before any countdown.
  await expect.poll(() => micAsks(page)).toBe(1)
  // No "0:00 / 0:15" style digits anywhere.
  await expect(page.locator('.timer')).toHaveCount(0)
  await expect(page.getByRole('img', { name: 'Up to 15 seconds' })).toBeVisible()

  await page.getByRole('button', { name: 'Start filming' }).click()
  await expect(page.locator('.countdown-num')).toBeVisible()
  await expect(page.locator('.rec-pulse')).toBeVisible({ timeout: 10_000 })
  // An excited re-tap right away is ignored: still filming.
  await page.getByRole('button', { name: 'Stop' }).click()
  await page.waitForTimeout(300)
  await expect(page.locator('.rec-badge')).toHaveText(/REC/)
  await expect(stepHeading(page, 'Film it!')).toBeVisible()
  await shot('rec-pulse')
  expect(await micAsks(page)).toBe(1)
  await expect.poll(() => spoken(page)).toContain("We're filming! Tap the square to stop.")

  await page.waitForTimeout(2200)
  await expect(page.getByRole('img', { name: /seconds left/ })).toBeVisible()
  await shot('recording-ring')
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(stepHeading(page, 'You did it!')).toBeVisible({ timeout: 20_000 })

  // Keep: the idle re-prompt never talks over the playing movie.
  const movie = page.locator('.keep-result video')
  await expect.poll(() => movie.evaluate((v: HTMLVideoElement) => !v.paused)).toBe(true)
  const heard = (await spoken(page)).length
  await page.waitForTimeout(9500)
  expect((await spoken(page)).slice(heard)).toEqual([])
})

test('teacher "Record sound" off: Video never asks for the mic', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('magicscreen.settings', JSON.stringify({ ...JSON.parse(localStorage.getItem('magicscreen.settings') ?? '{}'), recordSound: false }))
  })
  await spyMic(page)
  await toSnap(page)
  await page.getByRole('radio', { name: 'Video' }).click()
  await page.getByRole('button', { name: 'Start filming' }).click()
  await expect(page.locator('.rec-badge')).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(2300)
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(stepHeading(page, 'You did it!')).toBeVisible({ timeout: 20_000 })
  expect(await micAsks(page)).toBe(0)
})

test('mic denied: muted badge says "No sound this time" and filming still works', async ({ page, shot }) => {
  await spyMic(page, { deny: true })
  await toSnap(page)
  await page.getByRole('radio', { name: 'Video' }).click()
  await expect(page.locator('.mic-off-badge')).toHaveText(/No sound this time/)
  await shot('mic-denied')
  await page.getByRole('button', { name: 'Start filming' }).click()
  await expect(page.locator('.rec-badge')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.mic-off-badge')).toBeVisible()
})

test('leaving the app mid-recording saves the movie and lands on Keep', async ({ page, shot }) => {
  await toSnap(page)
  await page.getByRole('radio', { name: 'Video' }).click()
  await page.getByRole('button', { name: 'Start filming' }).click()
  await expect(page.locator('.rec-badge')).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(1500)
  await setHidden(page, true)
  await expect(stepHeading(page, 'We saved your movie!')).toBeVisible({ timeout: 20_000 })
  await setHidden(page, false)
  const video = page.locator('.keep-result video')
  await expect(video).toBeVisible()
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2)
  await shot('saved-on-leave')
  // It really is in the gallery.
  await page.locator('.keep-actions').getByRole('button', { name: 'Home' }).click()
  await expect(page.locator('.gallery-grid .creation-tile:not(.skeleton)')).toHaveCount(1)
})

test('camera drop: "Camera fell asleep" cover, and "Wake it up" brings it back', async ({ page, shot }) => {
  await openHome(page)
  await pickWorld(page)
  await expect(stepHeading(page, 'Me!')).toBeVisible()
  await expect(page.locator('.stage-loading')).toHaveCount(0, { timeout: 30_000 })
  // The OS takes the camera away: the track ends.
  await page.evaluate(() => {
    const v = [...document.querySelectorAll('video')].find((el) => el.srcObject instanceof MediaStream)
    const track = (v!.srcObject as MediaStream).getVideoTracks()[0]
    track.stop()
    track.dispatchEvent(new Event('ended'))
  })
  const cover = page.locator('.stage-asleep')
  await expect(cover).toBeVisible()
  await expect(cover.getByRole('heading', { name: 'Camera fell asleep' })).toBeVisible()
  await shot('camera-asleep')
  await cover.getByRole('button', { name: 'Wake it up' }).click()
  await expect(cover).toHaveCount(0)
  await expect(page.locator('.stage-loading')).toHaveCount(0, { timeout: 30_000 })
  const live = await page.evaluate(() => {
    const v = [...document.querySelectorAll('video')].find((el) => el.srcObject instanceof MediaStream)
    return (v?.srcObject as MediaStream | undefined)?.getVideoTracks()[0]?.readyState
  })
  expect(live).toBe('live')
})

test('first save asks for persistent storage', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __persistCalls: number }
    w.__persistCalls = 0
    if (!navigator.storage) return
    navigator.storage.persisted = () => Promise.resolve(false)
    navigator.storage.persist = () => {
      w.__persistCalls++
      return Promise.resolve(true)
    }
  })
  await toSnap(page)
  await snapPhoto(page)
  await expect.poll(() => page.evaluate(() => (window as unknown as { __persistCalls: number }).__persistCalls)).toBe(1)
})

test('gallery save fails (iPad full): no confetti, sticky card, Save pulses', async ({ page, shot }) => {
  await page.addInitScript(() => {
    // Every gallery write hits the quota (thrown before any request exists, so the
    // transaction stays empty, like a real quota abort that rolls back).
    const orig = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'creations') throw new DOMException('Quota exceeded', 'QuotaExceededError')
      return orig.apply(this, args)
    }
  })
  await toSnap(page)
  await snapPhoto(page)

  const card = page.locator('.keep-unsaved')
  await expect(card).toBeVisible()
  await expect(card).toContainText('Not saved in My creations.')
  await expect(card).toContainText('Tap Save to put it in Photos now.')
  await expect(card).toContainText('The iPad is full!')
  await expect(page.locator('.keep-actions').getByRole('button', { name: 'Save' })).toHaveClass(/keep-save-pulse/)
  // Confetti never fired: its canvas is never sized for a burst.
  const confettiSized = await page.locator('.confetti-canvas').evaluate((c: HTMLCanvasElement) => c.width !== 300)
  expect(confettiSized).toBe(false)
  await page.waitForTimeout(2000)
  await expect(card).toBeVisible()
  await shot('not-saved')
})
