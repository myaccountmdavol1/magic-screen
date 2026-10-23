// Camera + microphone access. Kept tiny and framework-free so Stage.tsx can own lifecycle.
import type { Settings } from '../types'

export type CameraErrorKind = 'denied' | 'missing' | 'insecure' | 'other'

/** Thrown by startCamera so the UI can show a kid/teacher-friendly explanation per kind. */
export class CameraError extends Error {
  readonly kind: CameraErrorKind
  constructor(kind: CameraErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'CameraError'
    this.kind = kind
  }
}

export interface CameraHandle {
  video: HTMLVideoElement
  stream: MediaStream
  stop(): void
}

export interface StartCameraOptions {
  facing: Settings['facing']
  resolution: Settings['resolution']
}

const RESOLUTIONS: Record<Settings['resolution'], { width: number; height: number }> = {
  '540p': { width: 960, height: 540 },
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
}

function hasMediaDevices(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
}

function toCameraError(err: unknown): CameraError {
  if (err instanceof CameraError) return err
  const name = (err as { name?: string } | null)?.name
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return new CameraError('denied', 'Camera permission was not given.', { cause: err })
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return new CameraError('missing', 'No camera was found.', { cause: err })
    default:
      return new CameraError('other', 'The camera could not start.', { cause: err })
  }
}

function stopStream(stream: MediaStream) {
  for (const t of stream.getTracks()) t.stop()
}

/**
 * Start the camera. Constraints are "ideal" so iPads/phones that cannot do the exact
 * size or facing still give us *a* camera instead of failing.
 */
export async function startCamera({ facing, resolution }: StartCameraOptions): Promise<CameraHandle> {
  if (!hasMediaDevices()) {
    // getUserMedia only exists on https:// or localhost.
    throw new CameraError('insecure', 'The camera needs a secure (https) connection.')
  }
  const size = RESOLUTIONS[resolution] ?? RESOLUTIONS['720p']

  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: facing },
        width: { ideal: size.width },
        height: { ideal: size.height },
        frameRate: { ideal: 30 },
      },
    })
  } catch (err) {
    throw toCameraError(err)
  }

  const video = document.createElement('video')
  // playsInline + muted are required for iOS Safari to autoplay without fullscreen.
  video.playsInline = true
  video.muted = true
  video.autoplay = true
  video.setAttribute('playsinline', '')
  video.setAttribute('muted', '')
  video.setAttribute('autoplay', '')
  video.srcObject = stream
  // iOS Safari can stall or stop updating frames for a <video> that is not in the
  // document, so park it as an invisible 1px element (not display:none, which iOS
  // also treats as "don't decode").
  video.setAttribute('aria-hidden', 'true')
  video.style.cssText =
    'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-1'
  document.body.appendChild(video)

  try {
    // Start play() first: iOS may not load a stream's metadata until playback is requested.
    const playing = video.play()
    playing.catch(() => {}) // awaited below; avoid an unhandled rejection if metadata fails first
    if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
      await new Promise<void>((resolve, reject) => {
        const onMeta = () => {
          cleanup()
          resolve()
        }
        const onErr = () => {
          cleanup()
          reject(new Error('video element error'))
        }
        const cleanup = () => {
          video.removeEventListener('loadedmetadata', onMeta)
          video.removeEventListener('error', onErr)
        }
        video.addEventListener('loadedmetadata', onMeta)
        video.addEventListener('error', onErr)
      })
    }
    await playing
  } catch (err) {
    stopStream(stream)
    video.srcObject = null
    video.remove()
    throw toCameraError(err)
  }

  let stopped = false
  return {
    video,
    stream,
    stop() {
      if (stopped) return
      stopped = true
      stopStream(stream)
      video.pause()
      video.srcObject = null
      video.remove()
    },
  }
}

export type MicStatus = 'on' | 'denied' | 'unavailable'

export interface MicResult {
  stream: MediaStream | null
  /** 'denied' = the grown-up (or the browser) said no; 'unavailable' = no mic / no API. */
  status: MicStatus
}

/**
 * Microphone for video recordings. Never throws: a silent video beats no video, but
 * the caller learns *why* there is no sound so it can tell the child.
 */
export async function requestMic(): Promise<MicResult> {
  if (!hasMediaDevices()) return { stream: null, status: 'unavailable' }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    return { stream, status: 'on' }
  } catch (err) {
    const name = (err as { name?: string } | null)?.name
    const denied = name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError'
    return { stream: null, status: denied ? 'denied' : 'unavailable' }
  }
}

/** Microphone for video recordings. Returns null (silent video) rather than blocking recording. */
export async function getMic(): Promise<MediaStream | null> {
  return (await requestMic()).stream
}

/** How long a visible page tolerates a muted camera before calling it asleep. */
export const MUTE_GRACE_MS = 1500

/**
 * Watch a live camera stream for the OS taking it away: the track ends (unplugged,
 * revoked, another app grabbed it) or stays muted while the page is visible (iPad
 * Split View / Control Center). Backgrounding mutes the track too; that is ignored
 * while hidden and re-checked when the page comes back.
 * `onChange(true)` = the camera fell asleep, `onChange(false)` = it woke up on its own.
 * Our own `handle.stop()` never fires 'ended' (per spec), so it does not trigger this.
 * Returns an unsubscribe function.
 */
export function watchCamera(stream: MediaStream, onChange: (asleep: boolean) => void): () => void {
  const tracks = stream.getVideoTracks()
  if (tracks.length === 0) return () => {}
  let muteTimer = 0
  let asleep = false
  const set = (v: boolean) => {
    if (v === asleep) return
    asleep = v
    onChange(v)
  }
  const isHidden = () => typeof document !== 'undefined' && document.hidden
  const check = () => {
    window.clearTimeout(muteTimer)
    if (tracks.some((t) => t.readyState === 'ended')) return set(true)
    if (tracks.some((t) => t.muted)) {
      if (isHidden()) return
      muteTimer = window.setTimeout(() => {
        if (!isHidden() && tracks.some((t) => t.muted || t.readyState === 'ended')) set(true)
      }, MUTE_GRACE_MS)
      return
    }
    set(false)
  }
  for (const t of tracks) {
    t.addEventListener('ended', check)
    t.addEventListener('mute', check)
    t.addEventListener('unmute', check)
  }
  return () => {
    window.clearTimeout(muteTimer)
    for (const t of tracks) {
      t.removeEventListener('ended', check)
      t.removeEventListener('mute', check)
      t.removeEventListener('unmute', check)
    }
  }
}

/** True when the stream's camera track is gone or still muted (used on returning to the app). */
export function cameraLooksAsleep(stream: MediaStream): boolean {
  const tracks = stream.getVideoTracks()
  return tracks.length === 0 || tracks.some((t) => t.readyState === 'ended' || t.muted)
}
