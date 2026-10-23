// Dev aid (C5): screenshot each world with the fake camera on the Me step.
// Usage: node e2e/c5-shots.mjs [outDir] [worldName...]   (needs a dev server on C5_PORT, default 5390)
import { chromium } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const out = process.argv[2] ?? path.join(here, '..', 'test-results', 'c5')
const only = process.argv.slice(3)
const port = process.env.C5_PORT ?? '5390'
const cam = path.join(here, 'fixtures', 'fake-greenscreen.y4m')

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${cam}`, '--enable-gpu', '--ignore-gpu-blocklist'],
})
const ctx = await browser.newContext({ viewport: { width: 1194, height: 834 }, permissions: ['camera', 'microphone'] })
const page = await ctx.newPage()
page.on('pageerror', (e) => console.log('pageerror', e.message))
page.on('console', (m) => m.type() === 'error' && console.log('console.error', m.text()))
await page.goto(`http://localhost:${port}/`)
await page.getByRole('button', { name: /Let's make!/ }).click()
await page.getByRole('heading', { level: 1, name: 'Pick a world' }).waitFor()
const names = await page.locator('.world-tile:not(.world-upload) .world-name').allInnerTexts()
for (const name of names) {
  if (only.length && !only.some((o) => name.toLowerCase().includes(o.toLowerCase()))) continue
  await page.locator('.world-tile', { hasText: name }).click()
  await page.getByRole('button', { name: /Next: Me!/ }).click()
  await page.getByRole('heading', { level: 1, name: 'Me!' }).waitFor()
  await page.locator('.stage-slot .stage-canvas').waitFor({ timeout: 30000 })
  await page.locator('.stage-loading').waitFor({ state: 'detached', timeout: 30000 }).catch(() => {})
  await page.waitForTimeout(1800)
  const slug = name.toLowerCase().replace(/[^a-z]+/g, '-')
  await page.screenshot({ path: path.join(out, `${slug}.png`) })
  if (process.env.C5_PHOTO) {
    // Photo path: add a sticker, drag it onto the front layer, snap, and shoot the Keep result.
    await page.getByRole('button', { name: /Next: Stickers/ }).click()
    await page.locator('.sticker-choice').first().click()
    await page.waitForTimeout(500)
    const box = await page.locator('.stage-slot .stage-canvas').boundingBox()
    if (box) {
      // first sticker lands at (0.25, 0.3) of the stage
      await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.3)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.88, { steps: 8 })
      await page.mouse.up()
    }
    await page.screenshot({ path: path.join(out, `${slug}-stickers.png`) })
    await page.getByRole('button', { name: /Next: Snap!/ }).click()
    await page.getByRole('radio', { name: 'Photo' }).click()
    await page.getByRole('button', { name: 'Take a photo' }).click()
    await page.getByRole('heading', { level: 1, name: 'You did it!' }).waitFor({ timeout: 20000 })
    await page.waitForTimeout(800)
    await page.screenshot({ path: path.join(out, `${slug}-keep.png`) })
    break
  }
  // back to the world grid
  await page.getByRole('button', { name: /back|world/i }).first().click()
  await page.getByRole('heading', { level: 1, name: 'Pick a world' }).waitFor()
}
await browser.close()
