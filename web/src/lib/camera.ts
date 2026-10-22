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

/** Microphone for video recordings. Returns null (silent video) rather than blocking recording. */
export async function getMic(): Promise<MediaStream | null> {
  if (!hasMediaDevices()) return null
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
  } catch {
    return null
  }
}
