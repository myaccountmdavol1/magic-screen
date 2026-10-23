import { describe, expect, it } from 'vitest'
import { BUILTIN_BACKGROUNDS } from '../assets/backgrounds'
import type { BackgroundChoice } from '../types'
import { CENTER_ME, homeMeFor, meAfterWorldChange } from './worldHome'
import { DEFAULT_ME } from '../state/store'

const world = (id: string): BackgroundChoice => ({ id: `builtin:${id}`, kind: 'builtin', name: id, src: '', builtinId: id })

describe('world home spots (C5)', () => {
  it('CENTER_ME matches the store default', () => {
    expect(CENTER_ME).toEqual(DEFAULT_ME)
  })

  it('worlds without a home spot centre the child; uploads too', () => {
    expect(homeMeFor(world('space'))).toEqual(CENTER_ME)
    expect(homeMeFor({ id: 'u', kind: 'image', name: 'My picture', src: 'blob:x' })).toEqual(CENTER_ME)
    expect(homeMeFor(null)).toEqual(CENTER_ME)
  })

  it('news and weather have their own spots', () => {
    expect(homeMeFor(world('news'))).not.toEqual(CENTER_ME)
    expect(homeMeFor(world('weather'))).not.toEqual(CENTER_ME)
  })

  it('an untouched child follows the world; a placed child stays put', () => {
    const news = homeMeFor(world('news'))
    expect(meAfterWorldChange(CENTER_ME, null, world('news'))).toEqual(news)
    expect(meAfterWorldChange(news, world('news'), world('weather'))).toEqual(homeMeFor(world('weather')))
    expect(meAfterWorldChange(news, world('news'), world('space'))).toEqual(CENTER_ME)
    const placed = { x: 0.3, y: 0.6, scale: 1.2 }
    expect(meAfterWorldChange(placed, world('news'), world('weather'))).toBe(placed)
  })

  it('home spots and front layers are sane', () => {
    for (const b of BUILTIN_BACKGROUNDS) {
      if (b.home) {
        expect(b.home.scale).toBeGreaterThanOrEqual(0.4)
        expect(b.home.scale).toBeLessThanOrEqual(2)
        expect(b.home.x).toBeGreaterThanOrEqual(0)
        expect(b.home.x).toBeLessThanOrEqual(1)
        // A 16:9 camera frame at this spot stays inside the stage, so an off-centre
        // child is never pushed out of the picture.
        expect(b.home.x - b.home.scale / 2).toBeGreaterThanOrEqual(-1e-9)
        expect(b.home.x + b.home.scale / 2).toBeLessThanOrEqual(1 + 1e-9)
      }
      if (b.front) {
        expect(b.front).toMatch(/viewBox="0 0 1920 1080"/)
        // A front layer must not paint a full-stage backdrop (it would hide the child).
        expect(b.front).not.toMatch(/<rect width="1920" height="1080"/)
        expect(b.front.length).toBeLessThan(12_000)
      }
    }
  })
})
