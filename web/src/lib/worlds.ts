// Saved picture/video worlds: checking a picked file, making its tile thumbnail, and
// turning a SavedWorld into a BackgroundChoice. Storage itself lives in storage.ts.
import type { BackgroundChoice, SavedWorld } from '../types'

/** Videos bigger or longer than this are turned away (a whole class's iPad shares the space). */
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024
export const MAX_VIDEO_SEC = 120
export const MAX_IMAGE_BYTES = 30 * 1024 * 1024

export const SAVED_PREFIX = 'saved:'

export type WorldFileVerdict = { ok: true; media: 'image' | 'video' } | { ok: false; message: string }

/** Pure check of a picked file (type, size and, for videos, length). Unit tested. */
export function judgeWorldFile(f: { type: string; size: number; durationSec?: number | null }): WorldFileVerdict {
  const video = f.type.startsWith('video/')
  if (!video && !f.type.startsWith('image/')) return { ok: false, message: 'Pick a picture or a video' }
  if (video) {
    if (f.size > MAX_VIDEO_BYTES) {
      return { ok: false, message: 'Grown-ups: that video is too big. Pick one under 100 MB.' }
    }
    if (f.durationSec != null && Number.isFinite(f.durationSec) && f.durationSec > MAX_VIDEO_SEC) {
      return { ok: false, message: 'Grown-ups: that video is too long. Pick one under 2 minutes.' }
    }
    return { ok: true, media: 'video' }
  }
  if (f.size > MAX_IMAGE_BYTES) {
    return { ok: false, message: 'Grown-ups: that picture is too big. Pick one under 30 MB.' }
  }
  return { ok: true, media: 'image' }
}

/** A friendly name from a file name; camera-style names ("IMG_1234") fall back. Unit tested. */
export function niceWorldName(fileName: string, fallback: string): string {
  const base = fileName
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!base || /^(img|dsc|dscn|pxl|mov|vid|video|image|photo|screenshot|screen shot)?\s*[\d\s.:]*$/i.test(base)) {
    return fallback
  }
  const short = base.length > 28 ? `${base.slice(0, 27).trimEnd()}…` : base
  return short.charAt(0).toUpperCase() + short.slice(1)
}

const THUMB_W = 320

function drawThumb(src: CanvasImageSource, w: number, h: number): string {
  if (!w || !h) return ''
  const c = document.createElement('canvas')
  c.width = THUMB_W
  c.height = Math.round((THUMB_W * 9) / 16)
  const ctx = c.getContext('2d')
  if (!ctx) return ''
  // Cover-fit into a 16:9 tile, like the stage draws worlds.
  const s = Math.max(c.width / w, c.height / h)
  const dw = w * s
  const dh = h * s
  ctx.drawImage(src, (c.width - dw) / 2, (c.height - dh) / 2, dw, dh)
  try {
    return c.toDataURL('image/jpeg', 0.8)
  } catch {
    return ''
  }
}

/** Length + a 16:9 thumbnail of a picked video, without playing it. Never rejects. */
export function probeVideo(blob: Blob, timeoutMs = 8000): Promise<{ durationSec: number | null; thumb: string }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob)
    const v = document.createElement('video')
    v.muted = true
    v.playsInline = true
    v.preload = 'auto'
    let duration: number | null = null
    let done = false
    const finish = (thumb: string) => {
      if (done) return
      done = true
      window.clearTimeout(timer)
      v.removeAttribute('src')
      v.load()
      URL.revokeObjectURL(url)
      resolve({ durationSec: duration, thumb })
    }
    const timer = window.setTimeout(() => finish(''), timeoutMs)
    v.addEventListener('error', () => finish(''), { once: true })
    v.addEventListener(
      'loadedmetadata',
      () => {
        duration = Number.isFinite(v.duration) ? v.duration : null
        // A frame a little way in is more telling than a black first frame.
        const t = duration ? Math.min(0.5, duration / 2) : 0
        try {
          v.currentTime = t
        } catch {
          finish('')
        }
      },
      { once: true },
    )
    v.addEventListener('seeked', () => finish(drawThumb(v, v.videoWidth, v.videoHeight)), { once: true })
    v.src = url
  })
}

/** A 16:9 thumbnail of a picked picture. Never rejects ('' on failure). */
export function probeImage(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => {
      const t = drawThumb(img, img.naturalWidth, img.naturalHeight)
      URL.revokeObjectURL(url)
      resolve(t)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve('')
    }
    img.src = url
  })
}

/** Check a picked file and make its thumbnail in one go. */
export async function prepareWorldFile(
  file: Blob,
): Promise<{ ok: true; media: 'image' | 'video'; thumb: string } | { ok: false; message: string }> {
  const first = judgeWorldFile({ type: file.type, size: file.size })
  if (!first.ok) return first
  if (first.media === 'image') return { ok: true, media: 'image', thumb: await probeImage(file) }
  const { durationSec, thumb } = await probeVideo(file)
  const v = judgeWorldFile({ type: file.type, size: file.size, durationSec })
  if (!v.ok) return v
  return { ok: true, media: 'video', thumb }
}

/** A saved world as the stage's background choice. `src` is a fresh blob: URL (revoked when unpicked). */
export function savedWorldChoice(w: SavedWorld, src: string): BackgroundChoice {
  return { id: `${SAVED_PREFIX}${w.id}`, kind: w.media, name: w.name, src, ...(w.thumbDataUrl ? { poster: w.thumbDataUrl } : {}) }
}
