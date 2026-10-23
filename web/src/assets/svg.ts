// SVG -> image helpers shared by the World/Stickers steps and the Compositor.
//
// Why fixed raster sizes: Safari rasterizes an SVG <img> at its intrinsic size, and
// drawImage() then scales that bitmap. Without explicit width/height a viewBox-only SVG
// can come out at 150x150 or 300x150 and look blurry once drawn onto the 1920x1080 stage.

import { BUILTIN_BACKGROUNDS } from './backgrounds'
import { STICKERS } from './stickers'

export const BACKGROUND_SIZE = { width: 1920, height: 1080 } as const
/** Stickers can be scaled up to roughly 40% of stage height; 512px keeps them crisp. */
export const STICKER_RASTER_SIZE = 512

/**
 * utf8 data URL for an SVG string. encodeURIComponent escapes everything that could break
 * a URL (#, %, quotes, non-ASCII), which plain "replace a few chars" encoders miss.
 */
export function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.replace(/\s+/g, ' ').trim())}`
}

/** Force explicit width/height on the root <svg> so the browser rasterizes at that size. */
export function withSvgSize(svg: string, width: number, height: number): string {
  const open = svg.match(/<svg\b[^>]*>/)
  if (!open) return svg
  const tag = open[0].replace(/\s(width|height)="[^"]*"/g, '').replace(/^<svg/, `<svg width="${width}" height="${height}"`)
  return svg.replace(open[0], tag)
}

/** Load an image and wait until it is decoded, so the first canvas draw never stalls. */
export function loadImage(url: string, width?: number, height?: number): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    if (width) img.width = width
    if (height) img.height = height
    img.decoding = 'async'
    if (!url.startsWith('data:') && !url.startsWith('blob:')) img.crossOrigin = 'anonymous'
    img.onload = () => {
      // decode() can reject for SVG on some Safari versions even though the image loaded;
      // the image is still usable, so fall back to resolving it.
      const done = () => resolve(img)
      if (typeof img.decode === 'function') img.decode().then(done, done)
      else done()
    }
    img.onerror = () => reject(new Error(`Could not load image: ${url.slice(0, 80)}`))
    img.src = url
  })
}

// ---- cached builtin assets -------------------------------------------------

const urlCache = new Map<string, string>()
const imgCache = new Map<string, Promise<HTMLImageElement>>()

/** Data URL for a built-in background (1920x1080), e.g. for BackgroundChoice.src or a tile <img>. */
export function getBackgroundUrl(id: string): string | undefined {
  const key = `bg:${id}`
  const hit = urlCache.get(key)
  if (hit) return hit
  const def = BUILTIN_BACKGROUNDS.find((b) => b.id === id)
  if (!def) return undefined
  const url = svgToDataUrl(withSvgSize(def.svg, BACKGROUND_SIZE.width, BACKGROUND_SIZE.height))
  urlCache.set(key, url)
  return url
}

/** Data URL for a sticker, rasterized at STICKER_RASTER_SIZE (fine for tray <img> too). */
export function getStickerUrl(id: string): string | undefined {
  const key = `st:${id}`
  const hit = urlCache.get(key)
  if (hit) return hit
  const def = STICKERS.find((s) => s.id === id)
  if (!def) return undefined
  const url = svgToDataUrl(withSvgSize(def.svg, STICKER_RASTER_SIZE, STICKER_RASTER_SIZE))
  urlCache.set(key, url)
  return url
}

function cachedImage(key: string, url: string | undefined, w: number, h: number): Promise<HTMLImageElement> {
  if (!url) return Promise.reject(new Error(`Unknown asset: ${key}`))
  let p = imgCache.get(key)
  if (!p) {
    p = loadImage(url, w, h)
    // Do not cache failures, so a later retry can succeed.
    p.catch(() => imgCache.delete(key))
    imgCache.set(key, p)
  }
  return p
}

/** Decoded 1920x1080 image of a built-in background, cached per id. */
export function getBackgroundImage(id: string): Promise<HTMLImageElement> {
  return cachedImage(`bg:${id}`, getBackgroundUrl(id), BACKGROUND_SIZE.width, BACKGROUND_SIZE.height)
}

/** Decoded 512x512 image of a sticker, cached per id. */
export function getStickerImage(id: string): Promise<HTMLImageElement> {
  return cachedImage(`st:${id}`, getStickerUrl(id), STICKER_RASTER_SIZE, STICKER_RASTER_SIZE)
}

/** Warm the cache (e.g. on the World step) so switching worlds/stickers is instant. */
export function preloadBuiltinAssets(): Promise<void> {
  return Promise.allSettled([
    ...BUILTIN_BACKGROUNDS.map((b) => getBackgroundImage(b.id)),
    ...BUILTIN_BACKGROUNDS.filter((b) => b.front).map((b) => getFrontImage(b.id)),
    ...STICKERS.map((s) => getStickerImage(s.id)),
  ]).then(() => undefined)
}

// ---- world front layers (ease-of-use C5) -----------------------------------

/** Data URL for a world's front layer (desk, fence...), or undefined if it has none. */
export function getFrontUrl(id: string): string | undefined {
  const key = `fr:${id}`
  const hit = urlCache.get(key)
  if (hit) return hit
  const def = BUILTIN_BACKGROUNDS.find((b) => b.id === id)
  if (!def?.front) return undefined
  const url = svgToDataUrl(withSvgSize(def.front, BACKGROUND_SIZE.width, BACKGROUND_SIZE.height))
  urlCache.set(key, url)
  return url
}

/** Decoded 1920x1080 front layer of a built-in world, cached per id (rejects if none). */
export function getFrontImage(id: string): Promise<HTMLImageElement> {
  return cachedImage(`fr:${id}`, getFrontUrl(id), BACKGROUND_SIZE.width, BACKGROUND_SIZE.height)
}
