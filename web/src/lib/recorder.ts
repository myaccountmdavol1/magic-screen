// Recording, photo capture, thumbnails and "save to my iPad".
//
// IMPORTANT (Safari): canvas.captureStream() only emits a frame when the canvas is
// actually redrawn. The Stage render loop must keep calling compositor.render() every
// animation frame while recording, even if nothing moved, or the video will freeze/stall.
// The Compositor's canvas uses preserveDrawingBuffer:true, which is what lets
// capturePhoto() read a WebGL canvas outside of the frame callback.

export interface RecordingResult {
  composite: Blob
  mime: string
  durationSec: number
}

export interface RecordingHandle {
  stop(): Promise<RecordingResult>
  /** Seconds since recording started. */
  elapsed(): number
}

export interface StartRecordingOptions {
  canvas: HTMLCanvasElement
  audio: MediaStream | null
}

const VIDEO_MIMES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
]

function isSupported(mime: string): boolean {
  try {
    return typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime)
  } catch {
    return false
  }
}

/** First supported container: mp4/H.264 on Safari (plays in Photos), webm elsewhere. '' = browser default. */
export function pickVideoMime(): string {
  return VIDEO_MIMES.find(isSupported) ?? ''
}

/** Strip codec parameters: 'video/mp4;codecs=...' -> 'video/mp4'. */
function baseMime(mime: string, fallback: string): string {
  const base = mime.split(';')[0].trim()
  return base || fallback
}

interface Track {
  recorder: MediaRecorder
  chunks: Blob[]
  done: Promise<void>
}

function makeTrack(stream: MediaStream, mime: string): Track {
  const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream)
  const chunks: Blob[] = []
  recorder.ondataavailable = (e: BlobEvent) => {
    if (e.data && e.data.size > 0) chunks.push(e.data)
  }
  const done = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve()
    // An encoder error also ends the recording; resolve with whatever we have.
    recorder.onerror = () => resolve()
  })
  return { recorder, chunks, done }
}

function finishTrack(t: Track): Promise<void> {
  if (t.recorder.state !== 'inactive') {
    try {
      t.recorder.stop()
    } catch {
      return Promise.resolve()
    }
    return t.done
  }
  return Promise.resolve()
}

export function startRecording({ canvas, audio }: StartRecordingOptions): RecordingHandle {
  const mime = pickVideoMime()
  const canvasStream = canvas.captureStream(30)
  const composite = new MediaStream([...canvasStream.getVideoTracks(), ...(audio?.getAudioTracks() ?? [])])
  const main = makeTrack(composite, mime)

  const startedAt = performance.now()
  // 1s timeslices so a crash/kill mid-recording still leaves usable chunks.
  main.recorder.start(1000)

  let stopping: Promise<RecordingResult> | null = null
  let stoppedAt: number | null = null

  return {
    elapsed() {
      return ((stoppedAt ?? performance.now()) - startedAt) / 1000
    },
    stop() {
      if (stopping) return stopping
      stoppedAt = performance.now()
      stopping = finishTrack(main).then(() => {
        // The canvas capture track is ours; camera/mic tracks belong to the caller.
        for (const t of canvasStream.getTracks()) t.stop()
        const outMime = baseMime(main.recorder.mimeType || mime, 'video/webm')
        return {
          composite: new Blob(main.chunks, { type: outMime }),
          mime: outMime,
          durationSec: (stoppedAt! - startedAt) / 1000,
        }
      })
      return stopping
    },
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not capture the picture.'))), type, quality)
  })
}

/** PNG of the composite canvas exactly as the child sees it. */
export function capturePhoto(canvas: HTMLCanvasElement): Promise<Blob> {
  return canvasToBlob(canvas, 'image/png')
}

const THUMB_W = 320

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

function once(el: EventTarget, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ok = () => {
      el.removeEventListener('error', bad)
      resolve()
    }
    const bad = () => {
      el.removeEventListener(event, ok)
      reject(new Error(`media error waiting for ${event}`))
    }
    el.addEventListener(event, ok, { once: true })
    el.addEventListener('error', bad, { once: true })
  })
}

async function videoFrame(blob: Blob): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(blob)
  const v = document.createElement('video')
  v.muted = true
  v.playsInline = true
  v.setAttribute('playsinline', '')
  v.preload = 'auto'
  try {
    const loaded = once(v, 'loadeddata')
    v.src = url
    v.load()
    // iOS Safari won't fetch a detached video's data until playback is requested;
    // a muted play() is always allowed. Paused again before seeking.
    v.play().catch(() => undefined)
    await withTimeout(loaded, 8000, 'thumbnail load')
    v.pause()
    // MediaRecorder webm often reports duration=Infinity; 0.1s is still a safe seek target.
    const target = Number.isFinite(v.duration) && v.duration > 0 ? Math.min(0.1, v.duration / 2) : 0.1
    const seeked = once(v, 'seeked')
    v.currentTime = target
    await withTimeout(seeked, 4000, 'thumbnail seek').catch(() => undefined)
    const c = document.createElement('canvas')
    c.width = v.videoWidth || 1280
    c.height = v.videoHeight || 720
    c.getContext('2d')?.drawImage(v, 0, 0, c.width, c.height)
    return c
  } finally {
    v.removeAttribute('src')
    v.load()
    URL.revokeObjectURL(url)
  }
}

async function imageFrame(blob: Blob): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.decoding = 'async'
    const loaded = once(img, 'load')
    img.src = url
    await withTimeout(loaded, 8000, 'thumbnail image')
    const c = document.createElement('canvas')
    c.width = img.naturalWidth || 1280
    c.height = img.naturalHeight || 720
    c.getContext('2d')?.drawImage(img, 0, 0)
    return c
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** 320px-wide JPEG data URL for the gallery. */
export async function makeThumb(source: Blob | HTMLCanvasElement): Promise<string> {
  const frame =
    source instanceof Blob ? (source.type.startsWith('video/') ? await videoFrame(source) : await imageFrame(source)) : source
  const sw = frame.width || 16
  const sh = frame.height || 9
  const out = document.createElement('canvas')
  out.width = THUMB_W
  out.height = Math.max(1, Math.round((THUMB_W * sh) / sw))
  const ctx = out.getContext('2d')
  if (!ctx) throw new Error('Could not make a thumbnail.')
  // JPEG has no alpha: paint white under any transparent pixels.
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, out.width, out.height)
  ctx.drawImage(frame, 0, 0, out.width, out.height)
  return out.toDataURL('image/jpeg', 0.8)
}

const EXT_BY_MIME: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

/** Ensure the file name carries the right extension so Photos/Files recognise it. */
export function fileNameFor(filename: string, mime: string): string {
  const ext = EXT_BY_MIME[baseMime(mime, '')]
  if (!ext) return filename
  const stem = filename.replace(/\.[a-z0-9]{2,5}$/i, '')
  return `${stem}.${ext}`
}

/**
 * Share sheet first (on iPad this is the only way into Photos), then a download link.
 */
export async function saveToDevice(blob: Blob, filename: string): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const type = baseMime(blob.type, 'application/octet-stream')
  const name = fileNameFor(filename, type)

  if (typeof navigator !== 'undefined' && typeof navigator.canShare === 'function' && typeof File !== 'undefined') {
    const file = new File([blob], name, { type })
    let canShare = false
    try {
      canShare = navigator.canShare({ files: [file] })
    } catch {
      canShare = false
    }
    if (canShare) {
      try {
        await navigator.share({ files: [file], title: 'Magic Screen' })
        return 'shared'
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') return 'cancelled'
        // NotAllowedError (lost user activation) etc.: fall through to download.
      }
    }
  }

  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoking immediately can cancel the download in Safari; give it time.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return 'downloaded'
}
