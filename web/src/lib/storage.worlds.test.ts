// @vitest-environment node
// Saved worlds (kid "My worlds" + teacher "Class worlds") and the v1 → v2 migration.
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { openDB } from 'idb'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  _closeForTests,
  capWorlds,
  DB_VERSION,
  deleteWorld,
  getUpload,
  listCreations,
  listWorlds,
  MY_WORLDS_CAP,
  renameWorld,
  saveUpload,
  saveWorld,
} from './storage'
import type { SavedWorld } from '../types'

// Node's Blob survives fake-indexeddb's structured clone; jsdom's does not.
const blob = (type: string, text = 'x') => new globalThis.Blob([text], { type }) as unknown as Blob

beforeEach(async () => {
  await _closeForTests()
  globalThis.indexedDB = new IDBFactory()
})
afterEach(async () => {
  await _closeForTests()
})

const w = (id: string, createdAt: number): SavedWorld => ({
  id,
  scope: 'mine',
  media: 'image',
  mime: 'image/png',
  createdAt,
  name: 'My picture',
  thumbDataUrl: '',
})

describe('capWorlds', () => {
  it('keeps the newest N and drops the rest', () => {
    const { keep, drop } = capWorlds([w('a', 1), w('c', 3), w('b', 2)], 2)
    expect(keep.map((x) => x.id)).toEqual(['c', 'b'])
    expect(drop.map((x) => x.id)).toEqual(['a'])
  })
})

describe('saved worlds', () => {
  it('is database version 2', () => {
    expect(DB_VERSION).toBe(2)
  })

  it('saves kid and class worlds separately, newest first, with their media', async () => {
    const a = await saveWorld(blob('image/png', 'pic'), { scope: 'mine', name: 'My picture', createdAt: 10 })
    const b = await saveWorld(blob('video/mp4', 'vid'), { scope: 'mine', name: 'My video', createdAt: 20 })
    const c = await saveWorld(blob('image/jpeg'), { scope: 'class', name: 'Volcano trip', thumbDataUrl: 'data:x', createdAt: 5 })

    expect((await listWorlds('mine')).map((x) => x.id)).toEqual([b.id, a.id])
    expect(b.media).toBe('video')
    const cls = await listWorlds('class')
    expect(cls).toHaveLength(1)
    expect(cls[0]).toMatchObject({ id: c.id, scope: 'class', name: 'Volcano trip', thumbDataUrl: 'data:x', media: 'image' })
    expect(c.id.startsWith('cw_')).toBe(true)
    const media = await getUpload(a.id)
    expect(media?.type).toBe('image/png')
    expect(media?.size).toBe(3)
  })

  it('caps kid uploads at MY_WORLDS_CAP (oldest goes, media too) but never class worlds', async () => {
    const first = await saveWorld(blob('image/png'), { scope: 'mine', name: 'My picture', createdAt: 0 })
    for (let i = 1; i <= MY_WORLDS_CAP; i++) {
      await saveWorld(blob('image/png'), { scope: 'mine', name: 'My picture', createdAt: i })
    }
    for (let i = 0; i < MY_WORLDS_CAP + 2; i++) {
      await saveWorld(blob('image/png'), { scope: 'class', name: 'Class world', createdAt: i })
    }
    const mine = await listWorlds('mine')
    expect(mine).toHaveLength(MY_WORLDS_CAP)
    expect(mine.some((x) => x.id === first.id)).toBe(false)
    expect(await getUpload(first.id)).toBeUndefined()
    expect(await listWorlds('class')).toHaveLength(MY_WORLDS_CAP + 2)
  })

  it('renames and deletes (metadata and media)', async () => {
    const c = await saveWorld(blob('image/png'), { scope: 'class', name: 'Class world' })
    await renameWorld(c.id, 'Rainforest')
    expect((await listWorlds('class'))[0].name).toBe('Rainforest')
    await deleteWorld(c.id)
    expect(await listWorlds('class')).toEqual([])
    expect(await getUpload(c.id)).toBeUndefined()
  })

  it('saveUpload still works and lands in My worlds', async () => {
    const id = await saveUpload(blob('video/quicktime'))
    const [only] = await listWorlds('mine')
    expect(only).toMatchObject({ id, name: 'My video', media: 'video' })
  })
})

describe('v1 → v2 migration', () => {
  it('keeps creations, media and old uploads (as kid worlds)', async () => {
    const v1 = await openDB('magicscreen', 1, {
      upgrade(d) {
        const s = d.createObjectStore('creations', { keyPath: 'id' })
        s.createIndex('createdAt', 'createdAt')
        d.createObjectStore('media')
        d.createObjectStore('uploads')
      },
    })
    await v1.put('creations', { id: 'c_1', createdAt: 1, kind: 'photo', mime: 'image/png', thumbDataUrl: '' })
    await v1.put('media', blob('image/png'), 'c_1')
    await v1.put('uploads', blob('image/png', 'old'), 'up_old1')
    await v1.put('uploads', blob('video/mp4', 'oldv'), 'up_old2')
    v1.close()

    const mine = await listWorlds('mine')
    expect(mine.map((x) => x.id).sort()).toEqual(['up_old1', 'up_old2'])
    expect(mine.find((x) => x.id === 'up_old2')).toMatchObject({ media: 'video', name: 'My video', scope: 'mine' })
    expect(await listWorlds('class')).toEqual([])
    expect((await getUpload('up_old1'))?.size).toBe(3)
    expect((await listCreations()).map((c) => c.id)).toEqual(['c_1'])

    // New saves sort ahead of migrated ones.
    const fresh = await saveWorld(blob('image/png'), { scope: 'mine', name: 'My picture' })
    expect((await listWorlds('mine'))[0].id).toBe(fresh.id)
  })
})
