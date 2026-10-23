import { afterEach, describe, expect, it, vi } from 'vitest'
import { fileNameFor, pickVideoMime, saveToDevice, startRecording } from './recorder'

function stubMediaRecorder(supported: string[]) {
  vi.stubGlobal('MediaRecorder', { isTypeSupported: (m: string) => supported.includes(m) })
}

afterEach(() => vi.unstubAllGlobals())

describe('pickVideoMime', () => {
  it('prefers H.264 mp4 (Safari)', () => {
    stubMediaRecorder(['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm'])
    expect(pickVideoMime()).toBe('video/mp4;codecs=avc1.42E01E,mp4a.40.2')
  })

  it('falls back to plain mp4', () => {
    stubMediaRecorder(['video/mp4'])
    expect(pickVideoMime()).toBe('video/mp4')
  })

  it('uses webm vp9 then vp8 (Chrome / Firefox)', () => {
    stubMediaRecorder(['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'])
    expect(pickVideoMime()).toBe('video/webm;codecs=vp9,opus')
    stubMediaRecorder(['video/webm;codecs=vp8,opus', 'video/webm'])
    expect(pickVideoMime()).toBe('video/webm;codecs=vp8,opus')
  })

  it("returns '' when nothing is supported or MediaRecorder is missing", () => {
    stubMediaRecorder([])
    expect(pickVideoMime()).toBe('')
    vi.stubGlobal('MediaRecorder', undefined)
    expect(pickVideoMime()).toBe('')
  })
})

describe('fileNameFor', () => {
  it('adds or fixes the extension from the mime', () => {
    expect(fileNameFor('magic-screen', 'video/mp4')).toBe('magic-screen.mp4')
    expect(fileNameFor('clip.webm', 'video/mp4;codecs=avc1')).toBe('clip.mp4')
    expect(fileNameFor('photo', 'image/png')).toBe('photo.png')
    expect(fileNameFor('thing', 'application/x-unknown')).toBe('thing')
  })
})

describe('saveToDevice', () => {
  it('shares when files can be shared', async () => {
    const share = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { ...navigator, canShare: () => true, share })
    await expect(saveToDevice(new Blob(['x'], { type: 'image/png' }), 'pic')).resolves.toBe('shared')
    const files = (share.mock.calls[0] as unknown as [ShareData])[0].files!
    expect(files[0].name).toBe('pic.png')
  })

  it("reports 'cancelled' when the share sheet is dismissed", async () => {
    const share = vi.fn(() => Promise.reject(new DOMException('no', 'AbortError')))
    vi.stubGlobal('navigator', { ...navigator, canShare: () => true, share })
    await expect(saveToDevice(new Blob(['x'], { type: 'video/mp4' }), 'clip')).resolves.toBe('cancelled')
  })

  it('falls back to a download link', async () => {
    vi.stubGlobal('navigator', { ...navigator, canShare: undefined })
    // jsdom has no object URLs; patch them for this test only.
    const orig = { create: URL.createObjectURL, revoke: URL.revokeObjectURL }
    URL.createObjectURL = vi.fn(() => 'blob:fake')
    URL.revokeObjectURL = vi.fn()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    try {
      await expect(saveToDevice(new Blob(['x'], { type: 'video/webm' }), 'clip')).resolves.toBe('downloaded')
      expect(click).toHaveBeenCalled()
    } finally {
      click.mockRestore()
      URL.createObjectURL = orig.create
      URL.revokeObjectURL = orig.revoke
    }
  })
})

describe('requestPersistentStorage', () => {
  it('asks persist() once per session and never throws', async () => {
    const { requestPersistentStorage, resetPersistRequestForTests } = await import('./recorder')
    resetPersistRequestForTests()
    const persist = vi.fn(() => Promise.resolve(true))
    vi.stubGlobal('navigator', { ...navigator, storage: { persisted: () => Promise.resolve(false), persist } })
    await expect(requestPersistentStorage()).resolves.toBe(true)
    await expect(requestPersistentStorage()).resolves.toBe(false)
    expect(persist).toHaveBeenCalledTimes(1)
  })

  it('skips the prompt when storage is already persistent, and survives a missing API', async () => {
    const { requestPersistentStorage, resetPersistRequestForTests } = await import('./recorder')
    resetPersistRequestForTests()
    const persist = vi.fn(() => Promise.resolve(true))
    vi.stubGlobal('navigator', { ...navigator, storage: { persisted: () => Promise.resolve(true), persist } })
    await expect(requestPersistentStorage()).resolves.toBe(true)
    expect(persist).not.toHaveBeenCalled()
    resetPersistRequestForTests()
    vi.stubGlobal('navigator', { ...navigator, storage: { persist: () => Promise.reject(new Error('nope')) } })
    await expect(requestPersistentStorage()).resolves.toBe(false)
  })
})

describe('startRecording', () => {
  /** A MediaRecorder that hands back `chunks` when stopped. */
  function stubRecorder(chunks: Blob[]) {
    class FakeRecorder extends EventTarget {
      static isTypeSupported = () => false
      state: RecordingState = 'inactive'
      mimeType = 'video/webm'
      ondataavailable: ((e: { data: Blob }) => void) | null = null
      onstop: (() => void) | null = null
      onerror: (() => void) | null = null
      start() {
        this.state = 'recording'
        this.dispatchEvent(new Event('start'))
      }
      stop() {
        this.state = 'inactive'
        for (const data of chunks) this.ondataavailable?.({ data })
        this.onstop?.()
      }
    }
    vi.stubGlobal('MediaRecorder', FakeRecorder)
    vi.stubGlobal(
      'MediaStream',
      class {
        constructor(public tracks: unknown[] = []) {}
      },
    )
  }
  const canvas = () => ({ captureStream: () => ({ getVideoTracks: () => [], getTracks: () => [] }) }) as unknown as HTMLCanvasElement

  it('rejects an empty recording instead of returning a 0-byte movie', async () => {
    stubRecorder([])
    const h = startRecording({ canvas: canvas(), audio: null })
    await h.started
    await expect(h.stop()).rejects.toThrow(/empty/)
  })

  it('returns the recorded data', async () => {
    stubRecorder([new Blob([new Uint8Array(10)])])
    const h = startRecording({ canvas: canvas(), audio: null })
    await h.started
    const res = await h.stop()
    expect(res.composite.size).toBe(10)
    expect(res.mime).toBe('video/webm')
  })
})
