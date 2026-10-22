// Shared fixtures + flow helpers for the Magic Screen e2e suite.
import { test as base, expect, type Page, type TestInfo } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

/** Where step screenshots go (inspected by QA; not part of the repo). */
export const SHOT_DIR =
  process.env.E2E_SHOT_DIR ??
  '/private/tmp/claude-501/-Users-md-Green-Screen-2/727545c3-c535-41ef-933d-42d65e406914/scratchpad/qa/chromium'

/** Console noise from the browser itself, not from the app. */
const IGNORED_CONSOLE = [/OpenGL error checking is disabled/i, /GPU stall due to ReadPixels/i]

export interface Shots {
  (name: string): Promise<void>
}

export const test = base.extend<{ consoleErrors: string[]; shot: Shots }>({
  // Auto fixture: every test fails if the app logs a console error or throws.
  consoleErrors: [
    async ({ page }, use) => {
      const errors: string[] = []
      page.on('console', (m) => {
        if (m.type() !== 'error') return
        const text = m.text()
        if (IGNORED_CONSOLE.some((re) => re.test(text))) return
        errors.push(`[console.error] ${text}`)
      })
      page.on('pageerror', (e) => errors.push(`[pageerror] ${e.stack ?? e.message}`))
      // E2E_DEBUG=1: log photo-capture results, unhandled rejections and toasts (flake triage).
      if (process.env.E2E_DEBUG) {
        page.on('console', (m) => { if (m.text().startsWith('DBG')) console.log(m.text()) })
        await page.addInitScript(() => {
          const orig = HTMLCanvasElement.prototype.toBlob
          HTMLCanvasElement.prototype.toBlob = function (cb, type, q) {
            const t0 = performance.now()
            return orig.call(this, (b) => { console.log('DBG toBlob', b ? b.size : 'NULL', Math.round(performance.now() - t0)); cb(b) }, type, q)
          }
          window.addEventListener('unhandledrejection', (e) => console.log('DBG unhandled', String(e.reason)))
          const mo = new MutationObserver(() => {
            for (const t of document.querySelectorAll('.toast')) if (t.textContent) console.log('DBG toast', t.textContent)
          })
          document.addEventListener('DOMContentLoaded', () => mo.observe(document.body, { childList: true, subtree: true }))
        })
      }
      await use(errors)
      expect(errors, 'no console errors or page errors').toEqual([])
    },
    { auto: true },
  ],
  shot: async ({ page }, use, testInfo: TestInfo) => {
    fs.mkdirSync(SHOT_DIR, { recursive: true })
    let n = 0
    const slug = testInfo.title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()
    await use(async (name: string) => {
      n += 1
      const file = `${testInfo.project.name}--${slug}--${String(n).padStart(2, '0')}-${name}.png`
      // Finish entry animations (modal fade-in etc.) so the shot shows the settled UI.
      await page.screenshot({ path: path.join(SHOT_DIR, file), animations: 'disabled' })
    })
  },
})

export { expect }

/** Fresh app load on Home (each test has its own context, so IndexedDB starts empty). */
export async function openHome(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('button', { name: /Let's make!/ })).toBeVisible()
  await expect(page.getByText('Everything you make stays on this device.')).toBeVisible()
}

export function stepHeading(page: Page, name: string | RegExp) {
  return page.getByRole('heading', { level: 1, name })
}

/** Home → World (pick the first built-in world). Returns the world image src. */
export async function pickWorld(page: Page, shot?: Shots): Promise<string> {
  await page.getByRole('button', { name: /Let's make!/ }).click()
  await expect(stepHeading(page, 'Pick a world')).toBeVisible()
  const next = page.getByRole('button', { name: /Next: Me!/ })
  await expect(next).toBeDisabled()
  await shot?.('world')
  const tile = page.locator('.world-tile:not(.world-upload)').first()
  await tile.click()
  await expect(tile).toHaveAttribute('aria-checked', 'true')
  const src = (await tile.locator('img').getAttribute('src')) ?? ''
  await shot?.('world-picked')
  await expect(next).toBeEnabled()
  await next.click()
  return src
}

/** Waits for the live stage: canvas mounted, camera awake, no trouble card. */
export async function waitForLiveStage(page: Page) {
  const canvas = page.locator('.stage-slot .stage-canvas')
  await expect(canvas).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.stage-loading')).toHaveCount(0, { timeout: 30_000 })
  await expect(page.locator('.stage-trouble')).toHaveCount(0)
  // Let the keyer settle on a few real camera frames.
  await page.waitForTimeout(1500)
}

/** Me → Stickers (adds one sticker) → Snap. */
export async function meToSnap(page: Page, shot?: Shots) {
  await expect(stepHeading(page, 'Me!')).toBeVisible()
  await waitForLiveStage(page)
  await shot?.('me')
  await page.getByRole('button', { name: /Next: Stickers/ }).click()
  await expect(stepHeading(page, 'Stickers')).toBeVisible()
  await page.locator('.sticker-choice').first().click()
  await expect(page.getByRole('button', { name: /Clear all/ })).toBeVisible()
  await shot?.('stickers')
  await page.getByRole('button', { name: /Next: Snap!/ }).click()
  await expect(stepHeading(page, /Snap it!|Film it!/)).toBeVisible()
  await waitForLiveStage(page)
  await shot?.('snap')
}

/** Snap a photo (3-2-1 countdown) and land on Keep with a loaded picture. */
export async function snapPhoto(page: Page, shot?: Shots) {
  await page.getByRole('radio', { name: 'Photo' }).click()
  await page.getByRole('button', { name: 'Take a photo' }).click()
  await expect(page.locator('.countdown-num')).toBeVisible()
  await shot?.('countdown')
  await expect(stepHeading(page, 'You did it!')).toBeVisible({ timeout: 20_000 })
  const img = page.locator('.keep-result img')
  await expect(img).toBeVisible()
  await expect
    .poll(() => img.evaluate((el: HTMLImageElement) => (el.complete ? el.naturalWidth : 0)))
    .toBeGreaterThan(100)
  await shot?.('keep-photo')
}

/** Full photo flow from Home to Keep. */
export async function makePhoto(page: Page, shot?: Shots) {
  await openHome(page)
  await shot?.('home')
  await pickWorld(page, shot)
  await meToSnap(page, shot)
  await snapPhoto(page, shot)
}

/** Back to Home from Keep and wait for the gallery to list `count` creations. */
export async function keepToHome(page: Page, count: number) {
  await page.locator('.keep-actions').getByRole('button', { name: 'Home' }).click()
  await expect(page.getByRole('button', { name: /Let's make!/ })).toBeVisible()
  await expect(page.locator('.gallery-grid .creation-tile:not(.skeleton)')).toHaveCount(count)
}
