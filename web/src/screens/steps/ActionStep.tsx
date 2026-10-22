// Step 4: Photo or Video, then one giant hero button with a spoken 3-2-1.
import { useEffect, useRef, useState } from 'react'
import { useApp } from '../../state/store'
import type { OutputKind } from '../../types'
import { StepShell } from '../../components/StepShell'
import { StageSlot } from '../../components/Stage'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/Toast'
import { useStage } from '../../lib/useStage'
import { capturePhoto, makeThumb, startRecording, type RecordingHandle } from '../../lib/recorder'
import { getMic } from '../../lib/camera'
import { playSound } from '../../lib/sound'
import { speak } from '../../lib/voice'

type Phase = 'idle' | 'countdown' | 'recording' | 'busy'

const RING_R = 86
const RING_C = 2 * Math.PI * RING_R

function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms))

export default function ActionStep() {
  const outputKind = useApp((s) => s.outputKind)
  const setOutputKind = useApp((s) => s.setOutputKind)
  const settings = useApp((s) => s.settings)
  const setCapture = useApp((s) => s.setCapture)
  const goStep = useApp((s) => s.goStep)
  const stage = useStage()

  const [phase, setPhase] = useState<Phase>('idle')
  const [count, setCount] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [flash, setFlash] = useState(0)

  // Refs so async flows can see the latest values and bail out after unmount.
  const alive = useRef(true)
  const recRef = useRef<RecordingHandle | null>(null)
  const micRef = useRef<MediaStream | null>(null)
  const timerRef = useRef(0)
  const stageRef = useRef(stage)
  stageRef.current = stage

  useEffect(() => {
    alive.current = true
    return () => {
      // Leaving mid-recording (stepper/back): stop and throw the clip away.
      alive.current = false
      window.clearInterval(timerRef.current)
      recRef.current?.stop().catch(() => {})
      recRef.current = null
      micRef.current?.getTracks().forEach((t) => t.stop())
      micRef.current = null
    }
  }, [])

  const isVideo = outputKind === 'video'

  const choose = (k: OutputKind) => {
    if (phase !== 'idle') return
    playSound('tap')
    setOutputKind(k)
    speak(k === 'photo' ? 'Photo' : 'Video')
  }

  const countdown = async () => {
    for (let n = settings.countdownSec; n > 0; n--) {
      if (!alive.current) return false
      setCount(n)
      playSound('countdown')
      speak(String(n))
      await wait(1000)
    }
    setCount(0)
    return alive.current
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

  const stopVideo = async () => {
    const handle = recRef.current
    if (!handle) return
    recRef.current = null
    window.clearInterval(timerRef.current)
    setPhase('busy')
    playSound('stop')
    const canvas = stageRef.current.canvasRef.current
    // Grab the thumbnail from the live canvas now, before anything changes.
    const thumbPromise = canvas ? makeThumb(canvas) : Promise.resolve('')
    try {
      const res = await handle.stop()
      micRef.current?.getTracks().forEach((t) => t.stop())
      micRef.current = null
      const thumbDataUrl = await thumbPromise
      if (!alive.current) return
      setCapture({
        kind: 'video',
        composite: res.composite,
        mime: res.mime,
        durationSec: res.durationSec,
        thumbDataUrl,
      })
      goStep('keep')
    } catch {
      if (alive.current) {
        toast("Oops, the video didn't save. Try again!")
        setPhase('idle')
      }
    }
  }

  const startVideo = async () => {
    const canvas = stageRef.current.canvasRef.current
    if (!canvas) throw new Error('no stage')
    // Mic is optional: a silent video beats no video.
    const mic = await getMic()
    if (!alive.current) {
      // Unmounted while the permission prompt was up: the cleanup already ran, so
      // release the mic here or the iPad's recording indicator stays on.
      mic?.getTracks().forEach((t) => t.stop())
      return
    }
    micRef.current = mic
    const handle = startRecording({ canvas, audio: micRef.current })
    recRef.current = handle
    playSound('start')
    setElapsed(0)
    setPhase('recording')
    timerRef.current = window.setInterval(() => {
      const t = handle.elapsed()
      setElapsed(t)
      if (t >= settings.maxVideoSec) void stopVideo()
    }, 200)
  }

  const onHero = async () => {
    if (phase === 'recording') {
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
      if (!(await countdown())) return
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
  const progress = Math.min(1, elapsed / Math.max(1, settings.maxVideoSec))
  const heroLabel = recording ? 'Stop' : isVideo ? 'Start filming' : 'Take a photo'

  return (
    <StepShell
      title={isVideo ? 'Film it!' : 'Snap it!'}
      subtitle={recording ? 'Tap the big button to stop.' : 'Pick photo or video. Then tap the big button!'}
      speak="Photo or video? Then tap the big button!"
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
              <svg className="hero-progress" viewBox="0 0 192 192" aria-hidden="true">
                <circle className="track" cx="96" cy="96" r={RING_R} />
                <circle
                  className="fill"
                  cx="96"
                  cy="96"
                  r={RING_R}
                  strokeDasharray={RING_C}
                  strokeDashoffset={RING_C * (1 - progress)}
                />
              </svg>
            )}
            {recording && <span className="hero-ring" aria-hidden="true" />}
            <button
              type="button"
              className={`hero-btn${recording ? ' recording' : ''}`}
              aria-label={heroLabel}
              disabled={phase === 'countdown' || phase === 'busy'}
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

          {isVideo && (
            <div className={`timer${recording ? ' recording' : ''}`} aria-live="off">
              {formatTime(elapsed)} <span className="timer-max">/ {formatTime(settings.maxVideoSec)}</span>
            </div>
          )}
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
        {flash > 0 && <span key={flash} className="shutter-flash" aria-hidden="true" />}
        {recording && (
          <span className="rec-badge">
            <span className="rec-dot" /> {formatTime(elapsed)}
          </span>
        )}
      </StageSlot>
    </StepShell>
  )
}
