import { describe, expect, it } from 'vitest'
import { judgeWorldFile, MAX_VIDEO_BYTES, niceWorldName, savedWorldChoice } from './worlds'

describe('judgeWorldFile', () => {
  it('accepts pictures and videos, rejects other files', () => {
    expect(judgeWorldFile({ type: 'image/png', size: 1000 })).toEqual({ ok: true, media: 'image' })
    expect(judgeWorldFile({ type: 'video/mp4', size: 1000, durationSec: 30 })).toEqual({ ok: true, media: 'video' })
    expect(judgeWorldFile({ type: 'application/pdf', size: 10 }).ok).toBe(false)
  })

  it('turns away videos over 100 MB or 2 minutes with a grown-up message', () => {
    const big = judgeWorldFile({ type: 'video/mp4', size: MAX_VIDEO_BYTES + 1 })
    expect(big).toMatchObject({ ok: false })
    expect(!big.ok && big.message).toMatch(/^Grown-ups: .*100 MB/)
    const long = judgeWorldFile({ type: 'video/quicktime', size: 1000, durationSec: 121 })
    expect(!long.ok && long.message).toMatch(/2 minutes/)
    // Unknown length (not probed yet / Infinity for some streams) is allowed through.
    expect(judgeWorldFile({ type: 'video/mp4', size: 1000, durationSec: Infinity }).ok).toBe(true)
  })
})

describe('niceWorldName', () => {
  it('cleans file names and falls back for camera names', () => {
    expect(niceWorldName('volcano_trip.jpg', 'Class world')).toBe('Volcano trip')
    expect(niceWorldName('IMG_1234.HEIC', 'Class world')).toBe('Class world')
    expect(niceWorldName('PXL_20240101_123456.mp4', 'Class video')).toBe('Class video')
    expect(niceWorldName('2024-05-01 10.22.33.png', 'Class world')).toBe('Class world')
    expect(niceWorldName('a'.repeat(40) + '.png', 'X').length).toBeLessThanOrEqual(28)
  })
})

describe('savedWorldChoice', () => {
  it('maps a saved world to a picture/video background', () => {
    const c = savedWorldChoice(
      { id: 'cw_1', scope: 'class', media: 'video', mime: 'video/mp4', createdAt: 1, name: 'Rain', thumbDataUrl: 'data:t' },
      'blob:x',
    )
    expect(c).toEqual({ id: 'saved:cw_1', kind: 'video', name: 'Rain', src: 'blob:x', poster: 'data:t' })
  })
})
