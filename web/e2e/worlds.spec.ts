// Moving worlds, Real places, saved "My worlds" and teacher "Class worlds".
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { expect, meToSnap, openHome, openTeacher, snapPhoto, stepHeading, test } from './helpers'

const here = path.dirname(fileURLToPath(import.meta.url))
const PICTURE = fs.readFileSync(path.join(here, '..', 'public', 'worlds', 'waterfall.jpg'))

async function startWorldStep(page: Page) {
  await page.getByRole('button', { name: /Let's make!/ }).click()
  await expect(stepHeading(page, 'Pick a world')).toBeVisible()
}

async function pickByName(page: Page, name: string) {
  const tile = page.getByRole('radio', { name, exact: true })
  await tile.scrollIntoViewIfNeeded()
  await tile.click()
  await expect(tile).toHaveAttribute('aria-checked', 'true')
}

/** Fraction of pixels that changed between two reads of the stage's left quarter (no child there). */
async function backgroundMotion(page: Page): Promise<number> {
  const f = await page.locator('.stage-slot .stage-canvas').evaluate(async (c: HTMLCanvasElement) => {
    const w = Math.floor(c.width / 4)
    const h = c.height
    const t = document.createElement('canvas')
    t.width = w
    t.height = h
    const ctx = t.getContext('2d', { willReadFrequently: true })!
    const read = () => {
      ctx.drawImage(c, 0, 0, w, h, 0, 0, w, h)
      return ctx.getImageData(0, 0, w, h).data
    }
    const a = read()
    await new Promise((r) => setTimeout(r, 700))
    const b = read()
    let changed = 0
    for (let i = 0; i < a.length; i += 4) {
      if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 24) changed++
    }
    return changed / (a.length / 4)
  })
  if (process.env.E2E_DEBUG) console.log('motion', f)
  return f
}

test('moving world: pick an animated world, the background moves, and a photo reaches Keep', async ({ page, shot }) => {
  await openHome(page)
  await startWorldStep(page)
  const badge = page.getByRole('radio', { name: 'Sea Friends', exact: true }).locator('.world-badge')
  await expect(badge).toHaveText('Moving')
  await pickByName(page, 'Sea Friends')
  await page.getByRole('button', { name: /Next: Me!/ }).click()
  await expect(stepHeading(page, 'Me!')).toBeVisible()
  await expect(page.locator('.stage-loading')).toHaveCount(0, { timeout: 30_000 })
  await page.waitForTimeout(1000)
  await expect.poll(() => backgroundMotion(page), { timeout: 10_000 }).toBeGreaterThan(0.002)
  await shot('me-moving')
  await meToSnap(page)
  await snapPhoto(page, shot)
})

test('real place: pick a footage world, it plays on the stage, and a photo reaches Keep', async ({ page, shot }) => {
  await openHome(page)
  await startWorldStep(page)
  await pickByName(page, 'Ocean Waves')
  // The picked tile previews the clip; others show a poster.
  await expect(page.getByRole('radio', { name: 'Ocean Waves', exact: true }).locator('video')).toHaveCount(1)
  await expect(page.getByRole('radio', { name: 'Planet Earth', exact: true }).locator('img')).toHaveAttribute('src', /\/worlds\/earth\.jpg$/)
  await page.getByRole('button', { name: /Next: Me!/ }).click()
  await expect(stepHeading(page, 'Me!')).toBeVisible()
  await expect(page.locator('.stage-loading')).toHaveCount(0, { timeout: 30_000 })
  await page.waitForTimeout(1000)
  await expect.poll(() => backgroundMotion(page), { timeout: 10_000 }).toBeGreaterThan(0.002)
  await meToSnap(page)
  await snapPhoto(page, shot)
})

test('my worlds: an uploaded picture is saved and is still there after a reload', async ({ page }) => {
  await openHome(page)
  await startWorldStep(page)
  const mine = page.locator('.world-row[data-row="mine"]')
  await expect(mine.locator('.world-tile')).toHaveCount(1) // just the upload tile
  await mine.locator('input[type="file"]').setInputFiles({ name: 'IMG_0042.jpg', mimeType: 'image/jpeg', buffer: PICTURE })
  const saved = mine.getByRole('radio', { name: 'My picture', exact: true })
  await expect(saved).toHaveAttribute('aria-checked', 'true')
  await expect(saved.locator('img')).toHaveAttribute('src', /^data:image\/jpeg/)
  await expect(page.getByRole('button', { name: /Next: Me!/ })).toBeEnabled()

  await page.reload()
  await startWorldStep(page)
  const again = page.locator('.world-row[data-row="mine"]').getByRole('radio', { name: 'My picture', exact: true })
  await expect(again).toHaveCount(1)
  await again.click()
  await expect(again).toHaveAttribute('aria-checked', 'true')
  // No delete on the kid screen: removing it is grown-up only.
  await expect(page.locator('.world-row').getByRole('button', { name: /delete/i })).toHaveCount(0)
})

test('class worlds: a grown-up adds one, it comes first on the World step, then deletes it', async ({ page, shot }) => {
  await openHome(page)
  await openTeacher(page)
  const card = page.locator('.t-card', { has: page.getByRole('heading', { name: 'Class worlds' }) })
  await card.getByTestId('class-world-input').setInputFiles({ name: 'rainforest_trip.jpg', mimeType: 'image/jpeg', buffer: PICTURE })
  await expect(card.getByRole('textbox')).toHaveValue('Rainforest trip')
  await shot('teacher-class-world')
  await page.getByRole('button', { name: 'Back home' }).click()

  await startWorldStep(page)
  const firstRow = page.locator('.world-row').first()
  await expect(firstRow).toHaveAttribute('data-row', 'class')
  await expect(firstRow.getByRole('heading', { name: 'Class worlds' })).toBeVisible()
  const first = page.locator('.world-tile:not(.world-upload)').first()
  await expect(first).toHaveAccessibleName('Rainforest trip')
  await first.click()
  await expect(first).toHaveAttribute('aria-checked', 'true')
  await shot('world-class-first')

  // Back home (nothing made yet) → teacher → delete.
  await page.getByRole('radio', { name: 'Outer Space', exact: true }).click()
  await page.goto('/')
  await openTeacher(page)
  await card.getByRole('button', { name: 'Delete Rainforest trip' }).click()
  await expect(card.getByRole('textbox')).toHaveCount(0)
  await page.getByRole('button', { name: 'Back home' }).click()
  await startWorldStep(page)
  await expect(page.locator('.world-row[data-row="class"]')).toHaveCount(0)
  await expect(page.locator('.world-row').first()).toHaveAttribute('data-row', 'pictures')
})
