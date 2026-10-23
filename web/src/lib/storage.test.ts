import { describe, expect, it } from 'vitest'
import { daysLeft, isExpired, splitTrash, TRASH_DAYS } from './storage'
import type { Creation } from '../types'

const DAY = 24 * 60 * 60 * 1000
const c = (id: string, createdAt: number, deletedAt?: number): Creation => ({
  id,
  createdAt,
  kind: 'photo',
  mime: 'image/png',
  thumbDataUrl: '',
  ...(deletedAt != null ? { deletedAt } : {}),
})

describe('Recently deleted bin', () => {
  const now = 100 * DAY

  it('only expires binned creations older than 7 days', () => {
    expect(TRASH_DAYS).toBe(7)
    expect(isExpired(c('a', 0), now)).toBe(false)
    expect(isExpired(c('a', 0, now - 6 * DAY), now)).toBe(false)
    expect(isExpired(c('a', 0, now - 7 * DAY + 1), now)).toBe(false)
    expect(isExpired(c('a', 0, now - 7 * DAY - 1), now)).toBe(true)
  })

  it('counts the days left, never below 1 while listed', () => {
    expect(daysLeft(c('a', 0, now), now)).toBe(7)
    expect(daysLeft(c('a', 0, now - 6.5 * DAY), now)).toBe(1)
    expect(daysLeft(c('a', 0, now - 7 * DAY), now)).toBe(1)
  })

  it('splits live creations (newest made first) from the bin (newest deleted first)', () => {
    const { live, trash } = splitTrash([c('old', 1), c('gone1', 2, 50), c('new', 3), c('gone2', 4, 10)])
    expect(live.map((x) => x.id)).toEqual(['new', 'old'])
    expect(trash.map((x) => x.id)).toEqual(['gone1', 'gone2'])
  })
})
