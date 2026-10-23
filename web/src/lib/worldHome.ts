// Per-world home spot for the child (ease-of-use C5). Some worlds want the child
// somewhere other than dead centre: behind the News Desk, beside the Weather Map.
// Picking a world moves the child there only if they have not placed themselves.
import { getBackground } from '../assets/backgrounds'
import type { BackgroundChoice, MeTransform } from '../types'

export const CENTER_ME: MeTransform = { x: 0.5, y: 0.5, scale: 1 }

/** Where the child stands by default in this world. */
export function homeMeFor(bg: BackgroundChoice | null | undefined): MeTransform {
  const id = bg?.kind === 'builtin' ? (bg.builtinId ?? bg.id) : undefined
  const home = id ? getBackground(id)?.home : undefined
  return home ? { ...home } : { ...CENTER_ME }
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-3

export function sameMe(a: MeTransform, b: MeTransform): boolean {
  return near(a.x, b.x) && near(a.y, b.y) && near(a.scale, b.scale)
}

/**
 * The child's transform after switching worlds: the new world's home spot when the child
 * is still where the old world put them (untouched), otherwise exactly where they were.
 */
export function meAfterWorldChange(
  me: MeTransform,
  prev: BackgroundChoice | null | undefined,
  next: BackgroundChoice | null | undefined,
): MeTransform {
  const untouched = sameMe(me, homeMeFor(prev)) || sameMe(me, CENTER_ME)
  return untouched ? homeMeFor(next) : me
}
