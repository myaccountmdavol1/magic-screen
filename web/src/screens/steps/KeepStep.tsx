// Step 5: celebrate, auto-save to the gallery (on this device only), and save to the
// device's Photos / Files.
import { useEffect, useMemo, useState } from 'react'
import { useApp } from '../../state/store'
import type { CaptureResult, OutputKind } from '../../types'
import { StepShell } from '../../components/StepShell'
import { Button } from '../../components/Button'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/Toast'
import { fireConfetti } from '../../components/Confetti'
import { requestPersistentStorage, saveToDevice } from '../../lib/recorder'
import { saveCreation, newCreationId } from '../../lib/storage'
import { playSound } from '../../lib/sound'
import { speak } from '../../lib/voice'

interface Shown {
  kind: OutputKind
  blob: Blob
  mime: string
  durationSec?: number
}

/**
 * Gallery saves per capture. Module-level (not a ref) because the child can leave Keep
 * via the stepper and come back with the same capture, which mounts a fresh KeepStep;
 * a per-instance ref would save a duplicate into the gallery.
 */
const saves = new WeakMap<Blob, Promise<void>>()
/** Captures already celebrated (or already told "not saved"): StrictMode-safe, once each. */
const announced = new WeakSet<Blob>()
/** Captures the child already put into Photos / Files with Save. */
const savedToDevice = new WeakSet<Blob>()

async function persist(shown: Shown, thumbDataUrl: string) {
  await saveCreation(
    {
      id: newCreationId(),
      createdAt: Date.now(),
      kind: shown.kind,
      mime: shown.mime,
      durationSec: shown.durationSec,
      thumbDataUrl,
    },
    shown.blob,
  )
}

/** Only messages written for people (e.g. "The iPad is full!") get through; never raw errors. */
const FRIENDLY_SAVE_ERROR = /iPad is full|cannot save pictures/i

/** Run `fn` now, or when the page is next visible (speech and confetti are lost while hidden). */
function whenVisible(fn: () => void): () => void {
  if (!document.hidden) {
    fn()
    return () => {}
  }
  const onVis = () => {
    if (document.hidden) return
    document.removeEventListener('visibilitychange', onVis)
    fn()
  }
  document.addEventListener('visibilitychange', onVis)
  return () => document.removeEventListener('visibilitychange', onVis)
}

type GalleryState = { status: 'saving' } | { status: 'saved' } | { status: 'failed'; reason: string | null }

export default function KeepStep() {
  const capture = useApp((s) => s.capture)
  const goStep = useApp((s) => s.goStep)
  const goScreen = useApp((s) => s.goScreen)
  const newCreation = useApp((s) => s.newCreation)

  const shown = useMemo(() => fromCapture(capture), [capture])
  const [saving, setSaving] = useState(false)
  const [gallery, setGallery] = useState<GalleryState>({ status: 'saving' })
  const [inPhotos, setInPhotos] = useState(false)

  // Create the blob URL inside the effect (not useMemo): StrictMode's simulated unmount
  // would otherwise revoke a memoized URL that the remount then keeps using.
  const [url, setUrl] = useState('')
  useEffect(() => {
    if (!shown) {
      setUrl('')
      return
    }
    const u = URL.createObjectURL(shown.blob)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [shown])

  const savedOnLeave = !!capture?.savedOnLeave

  // Auto-save once per capture; celebrate only once it is really in My creations.
  useEffect(() => {
    if (!capture) return
    const blob = capture.composite
    setInPhotos(savedToDevice.has(blob))
    let job = saves.get(blob)
    if (!job) {
      // First save on this device: ask the browser not to evict the gallery.
      void requestPersistentStorage()
      job = persist(fromCapture(capture)!, capture.thumbDataUrl)
      saves.set(blob, job)
    }
    let cancelled = false
    let stopWaiting = () => {}
    setGallery({ status: 'saving' })
    job.then(
      () => {
        if (cancelled) return
        setGallery({ status: 'saved' })
        if (announced.has(blob)) return
        announced.add(blob)
        stopWaiting = whenVisible(() => {
          fireConfetti()
          playSound('success')
          // Came back to the app after it saved the movie: say so out loud now.
          if (capture.savedOnLeave) speak('We saved your movie!')
        })
      },
      (err: unknown) => {
        if (cancelled) return
        // No confetti: the child must not think it is kept when it isn't.
        const msg = err instanceof Error ? err.message : ''
        setGallery({ status: 'failed', reason: FRIENDLY_SAVE_ERROR.test(msg) ? msg : null })
        announced.add(blob)
      },
    )
    return () => {
      cancelled = true
      stopWaiting()
    }
  }, [capture])

  const onSave = async () => {
    if (!shown || saving) return
    setSaving(true)
    try {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      const res = await saveToDevice(shown.blob, `magic-screen-${stamp}`)
      if (res !== 'cancelled') {
        savedToDevice.add(shown.blob)
        setInPhotos(true)
        playSound('success')
        toast('Saved!')
        speak('Saved!')
      }
    } catch {
      toast("Couldn't save. Ask a grown-up.")
    } finally {
      setSaving(false)
    }
  }

  if (!capture || !shown) {
    return (
      <StepShell
        title="Nothing yet"
        subtitle="Let's make something first!"
        speak="Let's make something first!"
        next={{ label: 'Snap!', onClick: () => goStep('action') }}
      >
        <div className="keep-empty">
          <Icon name="camera" size={64} />
        </div>
      </StepShell>
    )
  }

  const unsaved = gallery.status === 'failed' && !inPhotos
  const spoken = unsaved
    ? 'Not saved yet. Tap Save to put it in Photos.'
    : savedOnLeave
      ? 'We saved your movie!'
      : 'Wow! You made it!'

  return (
    <StepShell
      title={savedOnLeave ? 'We saved your movie!' : 'You did it!'}
      subtitle={shown.kind === 'video' ? 'Watch your movie!' : 'Look at your picture!'}
      speak={spoken}
      back={{ label: 'Try again', onClick: () => goStep('action') }}
      next={{ label: 'Make another', onClick: newCreation, variant: 'success' }}
    >
      <div className={`keep${unsaved ? ' is-unsaved' : ''}`}>
        <div className="keep-result">
          {!url ? null : shown.kind === 'photo' ? (
            <img src={url} alt="Your picture" />
          ) : (
            <video key={url} src={url} autoPlay loop playsInline controls />
          )}
        </div>

        {unsaved && (
          <div className="keep-unsaved" role="alert">
            <span className="keep-unsaved-icon" aria-hidden="true">
              <Icon name="save" size={30} />
            </span>
            <span className="keep-unsaved-text">
              <strong>Not saved in My creations.</strong>
              <span>Tap Save to put it in Photos now.</span>
              {gallery.reason && <span className="keep-unsaved-reason">{gallery.reason}</span>}
            </span>
          </div>
        )}

        <div className="keep-actions">
          <Button
            variant="primary"
            size="xl"
            icon="save"
            className={unsaved ? 'keep-save-pulse' : undefined}
            onClick={onSave}
            disabled={saving}
          >
            Save
          </Button>
          <Button variant="ghost" size="lg" icon="home" onClick={() => goScreen('home')}>
            Home
          </Button>
        </div>
      </div>
    </StepShell>
  )
}

function fromCapture(c: CaptureResult | null): Shown | null {
  if (!c) return null
  return { kind: c.kind, blob: c.composite, mime: c.mime, durationSec: c.durationSec }
}

