// On-device gallery (IndexedDB via idb). Nothing here ever leaves the device.
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { Creation } from '../types'

interface MagicDB extends DBSchema {
  creations: { key: string; value: Creation; indexes: { createdAt: number } }
  /** finished creation media, keyed by Creation.id */
  media: { key: string; value: Blob }
  /** user-uploaded backgrounds (My picture/video) */
  uploads: { key: string; value: Blob }
}

const DB_NAME = 'magicscreen'
const DB_VERSION = 1

let dbPromise: Promise<IDBPDatabase<MagicDB>> | null = null

function db(): Promise<IDBPDatabase<MagicDB>> {
  if (!dbPromise) {
    if (typeof indexedDB === 'undefined') {
      return Promise.reject(new Error('This browser cannot save pictures. Try Safari or Chrome.'))
    }
    dbPromise = openDB<MagicDB>(DB_NAME, DB_VERSION, {
      upgrade(d) {
        if (!d.objectStoreNames.contains('creations')) {
          const s = d.createObjectStore('creations', { keyPath: 'id' })
          s.createIndex('createdAt', 'createdAt')
        }
        if (!d.objectStoreNames.contains('media')) d.createObjectStore('media')
        if (!d.objectStoreNames.contains('uploads')) d.createObjectStore('uploads')
      },
      // Another tab upgraded the DB: drop our handle so the next call reopens.
      blocking() {
        void dbPromise?.then((d) => d.close())
        dbPromise = null
      },
      // iOS Safari can drop the IndexedDB connection (backgrounding, storage pressure).
      // Forget the dead handle so the next save reopens instead of failing until reload.
      terminated() {
        dbPromise = null
      },
    }).catch((err) => {
      dbPromise = null
      throw friendly(err)
    })
  }
  return dbPromise
}

function isQuotaError(err: unknown): boolean {
  const e = err as { name?: string; code?: number } | null
  return e?.name === 'QuotaExceededError' || e?.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e?.code === 22
}

function friendly(err: unknown): Error {
  if (isQuotaError(err)) {
    return new Error('The iPad is full! Ask your teacher to delete some old creations.', { cause: err })
  }
  if (err instanceof Error) return err
  return new Error('Could not save. Please try again.', { cause: err })
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw friendly(err)
  }
}

function newId(prefix: string): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
  return `${prefix}_${rand}`
}

/** Store metadata + media atomically, so the gallery never shows a creation with no blob. */
export function saveCreation(c: Creation, blob: Blob): Promise<void> {
  return guard(async () => {
    const d = await db()
    const tx = d.transaction(['creations', 'media'], 'readwrite')
    await Promise.all([tx.objectStore('creations').put(c), tx.objectStore('media').put(blob, c.id), tx.done])
  })
}

/** Newest first. */
export function listCreations(): Promise<Creation[]> {
  return guard(async () => {
    const d = await db()
    const all = await d.getAllFromIndex('creations', 'createdAt')
    return all.reverse()
  })
}

export function getCreation(id: string): Promise<Creation | undefined> {
  return guard(async () => (await db()).get('creations', id))
}

export function getCreationBlob(id: string): Promise<Blob | undefined> {
  return guard(async () => (await db()).get('media', id))
}

export function deleteCreation(id: string): Promise<void> {
  return guard(async () => {
    const d = await db()
    const tx = d.transaction(['creations', 'media'], 'readwrite')
    await Promise.all([tx.objectStore('creations').delete(id), tx.objectStore('media').delete(id), tx.done])
  })
}

/** Teacher settings: "delete all creations". */
export function deleteAllCreations(): Promise<void> {
  return guard(async () => {
    const d = await db()
    const tx = d.transaction(['creations', 'media'], 'readwrite')
    await Promise.all([tx.objectStore('creations').clear(), tx.objectStore('media').clear(), tx.done])
  })
}

/** Save a user background; returns its id. */
export function saveUpload(blob: Blob): Promise<string> {
  return guard(async () => {
    const id = newId('up')
    await (await db()).put('uploads', blob, id)
    return id
  })
}

export function getUpload(id: string): Promise<Blob | undefined> {
  return guard(async () => (await db()).get('uploads', id))
}

export function deleteUpload(id: string): Promise<void> {
  return guard(async () => (await db()).delete('uploads', id))
}

/** Convenience for callers building a Creation. */
export function newCreationId(): string {
  return newId('c')
}
