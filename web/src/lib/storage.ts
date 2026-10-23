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
    })
      .then((d) => {
        // App start: empty the "Recently deleted" bin of anything older than 7 days.
        if (!purgedThisLoad) {
          purgedThisLoad = true
          void purgeExpired(d).catch(() => {})
        }
        return d
      })
      .catch((err) => {
        dbPromise = null
        throw friendly(err)
      })
  }
  return dbPromise
}

/** How long a deleted creation can still be restored from Teacher → Recently deleted. */
export const TRASH_DAYS = 7
const TRASH_MS = TRASH_DAYS * 24 * 60 * 60 * 1000
let purgedThisLoad = false

/** True once a soft-deleted creation has been in the bin longer than TRASH_DAYS. */
export function isExpired(c: Pick<Creation, 'deletedAt'>, now = Date.now()): boolean {
  return c.deletedAt != null && now - c.deletedAt > TRASH_MS
}

/** Days left before a binned creation is gone for good (at least 1 while it is still listed). */
export function daysLeft(c: Pick<Creation, 'deletedAt'>, now = Date.now()): number {
  if (c.deletedAt == null) return TRASH_DAYS
  return Math.max(1, Math.ceil((c.deletedAt + TRASH_MS - now) / (24 * 60 * 60 * 1000)))
}

/** Split a gallery into live creations and the bin (each newest first by its own clock). */
export function splitTrash(all: Creation[]): { live: Creation[]; trash: Creation[] } {
  const live = all.filter((c) => c.deletedAt == null).sort((a, b) => b.createdAt - a.createdAt)
  const trash = all.filter((c) => c.deletedAt != null).sort((a, b) => b.deletedAt! - a.deletedAt!)
  return { live, trash }
}

async function purgeExpired(d: IDBPDatabase<MagicDB>, now = Date.now()): Promise<number> {
  const all = await d.getAll('creations')
  const expired = all.filter((c) => isExpired(c, now))
  if (!expired.length) return 0
  const tx = d.transaction(['creations', 'media'], 'readwrite')
  await Promise.all([
    ...expired.flatMap((c) => [tx.objectStore('creations').delete(c.id), tx.objectStore('media').delete(c.id)]),
    tx.done,
  ])
  return expired.length
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

let pendingSaves = 0
/** A gallery save is still being written (main.tsx must not reload for an app update now). */
export function hasPendingSaves(): boolean {
  return pendingSaves > 0
}

/** Store metadata + media atomically, so the gallery never shows a creation with no blob. */
export function saveCreation(c: Creation, blob: Blob): Promise<void> {
  pendingSaves++
  return guard(async () => {
    const d = await db()
    const tx = d.transaction(['creations', 'media'], 'readwrite')
    const reqs: Promise<unknown>[] = []
    try {
      // Media first: if it fails (even synchronously), no metadata row is left behind.
      reqs.push(tx.objectStore('media').put(blob, c.id))
      reqs.push(tx.objectStore('creations').put(c))
      await Promise.all([...reqs, tx.done])
    } catch (err) {
      // A put that throws (e.g. QuotaExceededError) does not abort the transaction by
      // itself, so the other row would commit: a gallery tile with no picture.
      for (const p of reqs) p.catch(() => {})
      tx.done.catch(() => {})
      try {
        tx.abort()
      } catch {
        /* already finished */
      }
      throw err
    }
  }).finally(() => {
    pendingSaves--
  })
}

/** Newest first. Leaves out anything in the Recently deleted bin. */
export function listCreations(): Promise<Creation[]> {
  return guard(async () => splitTrash(await (await db()).getAll('creations')).live)
}

/** The Recently deleted bin (Teacher only), most recently deleted first. Expired items are left out. */
export function listDeletedCreations(): Promise<Creation[]> {
  return guard(async () => {
    const now = Date.now()
    return splitTrash(await (await db()).getAll('creations')).trash.filter((c) => !isExpired(c, now))
  })
}

/** A live creation; binned ones read as missing so a stale View link can't show them. */
export function getCreation(id: string): Promise<Creation | undefined> {
  return guard(async () => {
    const c = await (await db()).get('creations', id)
    return c && c.deletedAt == null ? c : undefined
  })
}

export function getCreationBlob(id: string): Promise<Blob | undefined> {
  return guard(async () => (await db()).get('media', id))
}

/** Move a creation to the Recently deleted bin (restorable for TRASH_DAYS). */
export function deleteCreation(id: string, now = Date.now()): Promise<void> {
  return setDeletedAt(id, now)
}

/** Take a creation back out of the bin. */
export function restoreCreation(id: string): Promise<void> {
  return setDeletedAt(id, undefined)
}

function setDeletedAt(id: string, deletedAt: number | undefined): Promise<void> {
  return guard(async () => {
    const d = await db()
    const tx = d.transaction('creations', 'readwrite')
    const c = await tx.store.get(id)
    if (c) {
      const next: Creation = { ...c }
      if (deletedAt == null) delete next.deletedAt
      else next.deletedAt = deletedAt
      await tx.store.put(next)
    }
    await tx.done
  })
}

/** Remove a creation and its media right now (Teacher → Recently deleted → Delete now). */
export function deleteCreationForever(id: string): Promise<void> {
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
