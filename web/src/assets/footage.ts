// "Real places": looping real-footage worlds (public domain / CC0, see public/worlds/LICENSES.md).
// The clips are not precached; the service worker keeps each one after its first play.
import type { BackgroundChoice } from '../types'

export interface FootageWorld {
  id: string
  name: string
  src: string
  poster: string
  thumbColor: string
}

const base = import.meta.env.BASE_URL // '/' by default
const w = (id: string, name: string, thumbColor: string): FootageWorld => ({
  id,
  name,
  thumbColor,
  src: `${base}worlds/${id}.mp4`,
  poster: `${base}worlds/${id}.jpg`,
})

export const FOOTAGE_WORLDS: FootageWorld[] = [
  w('ocean', 'Ocean Waves', '#2563eb'),
  w('earth', 'Planet Earth', '#0b1026'),
  w('waterfall', 'Waterfall', '#64748b'),
  w('fish', 'Swimming Fish', '#0ea5e9'),
]

export const FOOTAGE_PREFIX = 'footage:'

export const footageChoice = (f: FootageWorld): BackgroundChoice => ({
  id: `${FOOTAGE_PREFIX}${f.id}`,
  kind: 'video',
  name: f.name,
  src: f.src,
  poster: f.poster,
})

const warmed = new Set<string>()
/**
 * Fetch the whole clip once (no Range header) so the service worker's CacheFirst rule
 * stores a full 200 response; after that it answers Safari's byte-range requests offline.
 */
export function warmFootage(f: FootageWorld) {
  if (warmed.has(f.id) || typeof fetch !== 'function') return
  warmed.add(f.id)
  fetch(f.src).catch(() => warmed.delete(f.id))
}
