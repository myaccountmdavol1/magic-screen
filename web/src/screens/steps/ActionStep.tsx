// Step 4: Photo or Video, then one giant hero button with a spoken 3-2-1.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useApp } from '../../state/store'
import type { OutputKind } from '../../types'
import { StepShell } from '../../components/StepShell'
import { StageSlot } from '../../components/Stage'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/Toast'
import { useStage } from '../../lib/useStage'
import { capturePhoto, makeThumb, startRecording, type RecordingHandle } from '../../lib/recorder'
import { requestMic, type MicResult } from '../../lib/camera'
import { playSound } from '../../lib/sound'
import { speak } from '../../lib/voice'

/**
 * idle → countdown (3-2-1) → starting (overlay stays up until the recorder really runs)
 * → recording → busy (saving) → Keep.
 */
type Phase = 'idle' | 'countdown' | 'starting' | 'recording' | 'busy'
/** off = teacher turned "Record sound" off (never ask); asking = permission prompt up. */
type MicState = 'off' | 'asking' | 'on' | 'denied'

const RING_R = 86
const RING_C = 2 * Math.PI * RING_R
/** Stop taps in the first 2 s are ignored, so a double-tap can't save a 1-second clip. */
export const STOP_GUARD_SEC = 2
/** The ring turns orange for the last few seconds. */
const LOW_TIME_SEC = 3

const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms))

function stopStream(s: MediaStream | null) {
  s?.getTracks().forEach((t) => t.stop())
}

export default function ActionStep() {
  const outputKind = useApp((s) => s.outputKind)
  const setOutputKind = useApp((s) => s.setOutputKind)
  const settings = useApp((s) => s.settings)
  const setCapture = useApp((s) => s.setCapture)
  const goStep = useApp((s) => s.goStep)
  const stage = useStage()
  const recordSound = settings.recordSound ?? true

  const [phase, setPhase] = useState<Phase>('idle')
  const [count, setCount] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [flash, setFlash] = useState(0)
  const [recPulse, setRecPulse] = useState(0)
  const [mic, setMic] = useState<MicState>(recordSound ? 'asking' : 'off')

  // Refs so async flows can see the latest values and bail out after unmount.
  const alive = useRef(true)
  const recRef = useRef<RecordingHandle | null>(null)
  const micRef = useRef<MediaStream | null>(null)
  const micAsk = useRef<Promise<MicResult> | null>(null)
  const timerRef = useRef(0)
  const stageRef = useRef(stage)
  stageRef.current = stage
  const phaseRef = useRef(phase)
  phaseRef.current = phase

  const releaseMic = useCallback(() => {
    stopStream(micRef.current)
    micRef.current = null
    micAsk.current = null
  }, [])

  /**
   * Ask for the mic as soon as Video is picked (not after the countdown), so the
   * permission prompt never lands in the middle of the 3-2-1. Never throws.
   */
  const ensureMic = useCallback(async (): Promise<MediaStream | null> => {
    if (!(useApp.getState().settings.recordSound ?? true)) {
      setMic('off')
      return null
    }
    const live = micRef.current
    if (live) {
      if (live.getAudioTracks().some((t) => t.readyState === 'live')) return live
      // The OS ended the mic (call, Siri, another app): ask again instead of handing a
      // dead track to MediaRecorder (Safari can refuse to start, or record nothing).
      stopStream(live)
      micRef.current = null
      micAsk.current = null
    }
    if (!micAsk.current) {
      setMic('asking')
      const ask = requestMic()
      micAsk.current = ask
      void ask.then((res) => {
        if (micAsk.current !== ask || !alive.current) {
          // Released (or unmounted) while the prompt was up: let the mic go right away,
          // or the iPad's recording indicator stays on.
          stopStream(res.stream)
          return
        }
        micRef.current = res.stream
        setMic(res.status === 'on' ? 'on' : 'denied')
        if (res.status !== 'on') speak('No sound this time.')
      })
    }
    const res = await micAsk.current
    return micRef.current ?? (res.status === 'on' ? res.stream : null)
  }, [])

  useEffect(() => {
    alive.current = true
    return () => {
      // Leaving mid-recording (stepper/back): stop and throw the clip away.
      alive.current = false
      window.clearInterval(timerRef.current)
      recRef.current?.stop().catch(() => {})
      recRef.current = null
      releaseMic()
    }
  }, [releaseMic])

  const isVideo = outputKind === 'video'

  // Coming back to an already-picked Video (e.g. "Try again" from Keep): get the mic ready.
  useEffect(() => {
    if (isVideo) void ensureMic()
    else {
      releaseMic()
      setMic(recordSound ? 'asking' : 'off')
    }
  }, [isVideo, recordSound, ensureMic, releaseMic])

  const choose = (k: OutputKind) => {
    if (phase !== 'idle') return
    playSound('tap')
    setOutputKind(k)
    speak(k === 'photo' ? 'Photo' : 'Video')
  }

  const countdown = async () => {
    for (let n = settings.countdownSec; n > 0; n--) {
      if (!alive.current || document.hidden) return false
      setCount(n)
      playSound('countdown')
      speak(String(n))
      await wait(1000)
    }
    setCount(0)
    return alive.current && !document.hidden
  }

  const snapPhoto = async () => {
    const canvas = stageRef.current.canvasRef.current
    if (!canvas) throw new Error('no stage')
    playSound('shutter')
    setFlash((f) => f + 1)
    const composite = await capturePhoto(canvas)
    const thumbDataUrl = await makeThumb(composite)
    if (!alive.current) return
    setCapture({ kind: 'photo', composite, mime: composite.type || 'image/png', thumbDataUrl })
    goStep('keep')
  }

  const stopVideo = useCallback(
    async ({ savedOnLeave = false }: { savedOnLeave?: boolean } = {}) => {
      const handle = recRef.current
      if (!handle) return
      recRef.current = null
      window.clearInterval(timerRef.current)
      setPhase('busy')
      if (!savedOnLeave) playSound('stop')
      const canvas = stageRef.current.canvasRef.current
      // Grab the thumbnail from the live canvas now, before anything changes.
      const thumbPromise = canvas ? makeThumb(canvas).catch(() => '') : Promise.resolve('')
      try {
        const res = await handle.stop()
        const thumbDataUrl = await thumbPromise
        if (!alive.current) return
        setCapture({
          kind: 'video',
          composite: res.composite,
          mime: res.mime,
          durationSec: res.durationSec,
          thumbDataUrl,
          ...(savedOnLeave ? { savedOnLeave: true } : {}),
        })
        goStep('keep')
      } catch {
        if (alive.current) {
          toast('Oops! Try again.')
          setPhase('idle')
        }
      }
    },
    [setCapture, goStep],
  )

  // A2: the iPad went to the home screen / another app mid-recording. Save what we
  // have (the camera is about to freeze anyway) and land on Keep.
  useEffect(() => {
    const onVis = () => {
      if (!document.hidden) return
      if (recRef.current && phaseRef.current === 'recording') void stopVideo({ savedOnLeave: true })
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [stopVideo])

  const startVideo = async () => {
    const canvas = stageRef.current.canvasRef.current
    if (!canvas) throw new Error('no stage')
    setPhase('starting')
    // Usually already granted/denied on the Video tap; a silent video beats no video.
    const audio = await ensureMic()
    if (!alive.current) return
    const handle = startRecording({ canvas, audio })
    recRef.current = handle
    await handle.started
    if (!alive.current) return
    if (document.hidden) {
      // Left during the hand-off: nothing worth keeping yet.
      recRef.current = null
      await handle.stop().catch(() => undefined)
      setPhase('idle')
      return
    }
    playSound('start')
    setElapsed(0)
    setPhase('recording')
    setRecPulse((n) => n + 1)
    speak("We're filming! Tap the square to stop.")
    timerRef.current = window.setInterval(() => {
      const t = handle.elapsed()
      setElapsed(t)
      if (t >= useApp.getState().settings.maxVideoSec) void stopVideo()
    }, 200)
  }

  const onHero = async () => {
    if (phase === 'recording') {
      // Ignore the excited double-tap right after it starts.
      if ((recRef.current?.elapsed() ?? 0) < STOP_GUARD_SEC) return
      void stopVideo()
      return
    }
    if (phase !== 'idle') return
    if (!stage.canvasRef.current) {
      toast('Wait for the camera…')
      return
    }
    setPhase('countdown')
    try {
      if (!(await countdown())) {
        if (alive.current) {
          setCount(0)
          setPhase('idle')
        }
        return
      }
      if (isVideo) await startVideo()
      else {
        setPhase('busy')
        await snapPhoto()
      }
    } catch {
      if (alive.current) {
        toast('Oops! Try again.')
        setPhase('idle')
      }
    }
  }

  const recording = phase === 'recording'
  const maxSec = Math.max(1, settings.maxVideoSec)
  const used = recording || phase === 'busy' ? Math.min(1, elapsed / maxSec) : 0
  const low = recording && maxSec - elapsed <= LOW_TIME_SEC
  const heroLabel = recording ? 'Stop' : isVideo ? 'Start filming' : 'Take a photo'
  const showWait = phase === 'starting' || (phase === 'countdown' && count === 0 && isVideo)

  return (
    <StepShell
      title={isVideo ? 'Film it!' : 'Snap it!'}
      subtitle={recording ? 'Tap the square to stop.' : 'Tap the big button!'}
      speak="Tap the big button!"
      layout="stage"
      back={phase === 'idle' ? { label: 'Back', onClick: () => goStep('stickers') } : undefined}
      aside={
        <div className="action-tools">
          <div className="action-choices" role="radiogroup" aria-label="Photo or video">
            <button
              type="button"
              role="radio"
              aria-checked={!isVideo}
              className={`choice-card photo${!isVideo ? ' selected' : ''}`}
              disabled={phase !== 'idle'}
              onClick={() => choose('photo')}
            >
              <span className="choice-icon">
                <Icon name="camera" size={34} />
              </span>
              <span className="choice-title">Photo</span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={isVideo}
              className={`choice-card video${isVideo ? ' selected' : ''}`}
              disabled={phase !== 'idle'}
              onClick={() => choose('video')}
            >
              <span className="choice-icon">
                <Icon name="video" size={34} />
              </span>
              <span className="choice-title">Video</span>
            </button>
          </div>

          <div className="hero-shell">
            {isVideo && (
              // Time left: a full ring that drains while filming (no digits for pre-readers).
              <svg
                className={`hero-progress${low ? ' low' : ''}`}
                viewBox="0 0 192 192"
                role="img"
                aria-label={recording ? `${Math.max(0, Math.ceil(maxSec - elapsed))} seconds left` : `Up to ${maxSec} seconds`}
              >
                <circle className="track" cx="96" cy="96" r={RING_R} />
                <circle
                  className="fill"
                  cx="96"
                  cy="96"
                  r={RING_R}
                  strokeDasharray={RING_C}
                  strokeDashoffset={RING_C * used}
                />
              </svg>
            )}
            {recording && <span className="hero-ring" aria-hidden="true" />}
            <button
              type="button"
              className={`hero-btn${recording ? ' recording' : ''}`}
              aria-label={heroLabel}
              disabled={phase === 'countdown' || phase === 'starting' || phase === 'busy'}
              onClick={onHero}
            >
              {recording ? (
                <span className="stop-square" />
              ) : isVideo ? (
                <span className="record-dot" />
              ) : (
                <Icon name="camera" size={64} />
              )}
            </button>
          </div>
        </div>
      }
    >
      <StageSlot>
        {phase === 'countdown' && count > 0 && (
          <div className="countdown" aria-live="assertive">
            <span key={count} className="countdown-num">
              {count}
            </span>
          </div>
        )}
        {showWait && (
          // The recorder is spinning up: keep the countdown tint so there is no dead gap.
          <div className="countdown countdown-wait" aria-hidden="true">
            <span className="countdown-wait-dot" />
          </div>
        )}
        {recPulse > 0 && recording && (
          // Filming started: the stage edge pulses red (the middle stays clear for the child's face).
          <span key={recPulse} className="rec-pulse" aria-hidden="true" />
        )}
        {flash > 0 && <span key={flash} className="shutter-flash" aria-hidden="true" />}
        {recording && (
          <span className="rec-badge" role="status">
            <span className="rec-dot" /> REC
          </span>
        )}
        {isVideo && mic === 'denied' && (phase === 'idle' || recording) && (
          <span className="mic-off-badge" role="status">
            <MicOffIcon /> No sound this time
          </span>
        )}
      </StageSlot>
    </StepShell>
  )
}

/** Microphone with a slash: "this video has no sound". Inline so Icon.tsx stays untouched. */
function MicOffIcon() {
  return (
    <svg
      width={24}
      height={24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 12.2 4.7M19 11v0" />
      <path d="M12 18v3M8.5 21h7" />
      <path d="M4 4l16 16" />
    </svg>
  )
}
