import { afterEach, describe, expect, it, vi } from 'vitest'
import { MUTE_GRACE_MS, cameraLooksAsleep, requestMic, watchCamera } from './camera'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function stubGUM(impl: () => Promise<unknown>) {
  vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia: impl } })
}

describe('requestMic', () => {
  it('returns the stream when allowed', async () => {
    const stream = { id: 'mic' }
    stubGUM(() => Promise.resolve(stream))
    await expect(requestMic()).resolves.toEqual({ stream, status: 'on' })
  })

  it("reports 'denied' when the permission is refused", async () => {
    stubGUM(() => Promise.reject(new DOMException('no', 'NotAllowedError')))
    await expect(requestMic()).resolves.toEqual({ stream: null, status: 'denied' })
  })

  it("reports 'unavailable' for a missing mic or API", async () => {
    stubGUM(() => Promise.reject(new DOMException('none', 'NotFoundError')))
    await expect(requestMic()).resolves.toEqual({ stream: null, status: 'unavailable' })
    vi.stubGlobal('navigator', { ...navigator, mediaDevices: undefined })
    await expect(requestMic()).resolves.toEqual({ stream: null, status: 'unavailable' })
  })
})

class FakeTrack extends EventTarget {
  readyState: 'live' | 'ended' = 'live'
  muted = false
}

function fakeStream(track: FakeTrack) {
  return { getVideoTracks: () => [track] } as unknown as MediaStream
}

describe('watchCamera', () => {
  it("calls the camera asleep as soon as its track ends", () => {
    const t = new FakeTrack()
    const onChange = vi.fn()
    const stop = watchCamera(fakeStream(t), onChange)
    t.readyState = 'ended'
    t.dispatchEvent(new Event('ended'))
    expect(onChange).toHaveBeenCalledWith(true)
    expect(cameraLooksAsleep(fakeStream(t))).toBe(true)
    stop()
  })

  it('waits out a short mute, and wakes up again on unmute', () => {
    vi.useFakeTimers()
    const t = new FakeTrack()
    const onChange = vi.fn()
    watchCamera(fakeStream(t), onChange)
    t.muted = true
    t.dispatchEvent(new Event('mute'))
    vi.advanceTimersByTime(MUTE_GRACE_MS - 100)
    expect(onChange).not.toHaveBeenCalled()
    vi.advanceTimersByTime(200)
    expect(onChange).toHaveBeenLastCalledWith(true)
    t.muted = false
    t.dispatchEvent(new Event('unmute'))
    expect(onChange).toHaveBeenLastCalledWith(false)
  })

  it('ignores a mute that is fixed within the grace period', () => {
    vi.useFakeTimers()
    const t = new FakeTrack()
    const onChange = vi.fn()
    watchCamera(fakeStream(t), onChange)
    t.muted = true
    t.dispatchEvent(new Event('mute'))
    vi.advanceTimersByTime(500)
    t.muted = false
    t.dispatchEvent(new Event('unmute'))
    vi.advanceTimersByTime(MUTE_GRACE_MS)
    expect(onChange).not.toHaveBeenCalled()
    expect(cameraLooksAsleep(fakeStream(t))).toBe(false)
  })
})
