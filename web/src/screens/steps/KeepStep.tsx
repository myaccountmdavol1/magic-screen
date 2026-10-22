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
import { saveToDevice } from '../../lib/recorder'
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
 * Captures already celebrated + saved. Module-level (not a ref) because the child can
 * leave Keep via the stepper and come back with the same capture, which mounts a
 * fresh KeepStep; a per-instance ref would save a duplicate into the gallery.
 */
const celebrated = new WeakSet<Blob>()

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

export default function KeepStep() {
  const capture = useApp((s) => s.capture)
  const goStep = useApp((s) => s.goStep)
  const goScreen = useApp((s) => s.goScreen)
  const newCreation = useApp((s) => s.newCreation)

  const shown = useMemo(() => fromCapture(capture), [capture])
  const [saving, setSaving] = useState(false)

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

  // Celebrate + auto-save once per capture (also covers StrictMode's double effect).
  useEffect(() => {
    if (!capture || celebrated.has(capture.composite)) return
    celebrated.add(capture.composite)
    fireConfetti()
    playSound('success')
    speak('Wow! You made it!')
    persist(fromCapture(capture)!, capture.thumbDataUrl).catch(() => toast("Couldn't keep it in the gallery"))
  }, [capture])

  const onSave = async () => {
    if (!shown || saving) return
    setSaving(true)
    try {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      const res = await saveToDevice(shown.blob, `magic-screen-${stamp}`)
      if (res !== 'cancelled') {
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

  return (
    <StepShell
      title="You did it!"
      subtitle={shown.kind === 'video' ? 'Watch your movie!' : 'Look at your picture!'}
      speak="Wow! You made it!"
      back={{ label: 'Try again', onClick: () => goStep('action') }}
      next={{ label: 'Make another', onClick: newCreation, variant: 'success' }}
    >
      <div className="keep">
        <div className="keep-result">
          {!url ? null : shown.kind === 'photo' ? (
            <img src={url} alt="Your picture" />
          ) : (
            <video key={url} src={url} autoPlay loop playsInline controls />
          )}
        </div>

        <div className="keep-actions">
          <Button variant="primary" size="xl" icon="save" onClick={onSave} disabled={saving}>
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

