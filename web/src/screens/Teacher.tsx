import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { DEFAULT_SETTINGS, useApp } from '../state/store'
import { Compositor } from '../lib/keyer/Compositor'
import {
  daysLeft,
  deleteAllCreations,
  deleteCreation,
  deleteCreationForever,
  listCreations,
  listDeletedCreations,
  restoreCreation,
  TRASH_DAYS,
} from '../lib/storage'
import { playSound } from '../lib/sound'
import type { Creation, RGB, Settings } from '../types'
import { Panel } from '../components/Panel'
import { Button } from '../components/Button'
import { Icon, type IconName } from '../components/Icon'
import { ConfirmDialog } from '../components/ParentGate'
import { toast } from '../components/Toast'

const MEDIAPIPE_URL = 'https://ai.google.dev/edge/mediapipe'

/* ---------- small helpers ---------- */

function rgbToHex([r, g, b]: RGB) {
  const h = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`
}

function hexToRgb(hex: string): RGB {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) return DEFAULT_SETTINGS.key.color
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255]
}

/**
 * Procedural test shot: an unevenly lit green screen with a "kid" (skin head,
 * blue shirt, a bit of green spill on the edges). Uneven light makes the
 * similarity slider visibly matter, like a real classroom wall.
 */
function makeSampleForeground(w: number, h: number) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  const g = ctx.createRadialGradient(w * 0.35, h * 0.3, 10, w * 0.5, h * 0.5, w * 0.75)
  g.addColorStop(0, '#4fd36a')
  g.addColorStop(0.6, '#2fb24c')
  g.addColorStop(1, '#1f8a3a')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  // a soft shadow on the screen behind the kid
  ctx.fillStyle = 'rgba(10, 60, 20, 0.28)'
  ctx.beginPath()
  ctx.ellipse(w * 0.56, h * 0.78, w * 0.17, h * 0.3, 0, 0, Math.PI * 2)
  ctx.fill()
  // shirt
  ctx.fillStyle = '#2f8fef'
  ctx.beginPath()
  ctx.ellipse(w * 0.5, h * 1.02, w * 0.2, h * 0.36, 0, 0, Math.PI * 2)
  ctx.fill()
  // head
  ctx.fillStyle = '#f2c29b'
  ctx.beginPath()
  ctx.arc(w * 0.5, h * 0.42, h * 0.2, 0, Math.PI * 2)
  ctx.fill()
  // hair
  ctx.fillStyle = '#5b3a1e'
  ctx.beginPath()
  ctx.arc(w * 0.5, h * 0.37, h * 0.2, Math.PI * 1.02, Math.PI * 1.98)
  ctx.fill()
  // green spill rim
  ctx.strokeStyle = 'rgba(80, 200, 100, 0.55)'
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.arc(w * 0.5, h * 0.42, h * 0.2, 0, Math.PI * 2)
  ctx.stroke()
  // face
  ctx.fillStyle = '#1b3a6b'
  ctx.beginPath()
  ctx.arc(w * 0.46, h * 0.42, h * 0.018, 0, Math.PI * 2)
  ctx.arc(w * 0.54, h * 0.42, h * 0.018, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = '#1b3a6b'
  ctx.lineWidth = 3
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.arc(w * 0.5, h * 0.47, h * 0.05, 0.15 * Math.PI, 0.85 * Math.PI)
  ctx.stroke()
  return c
}

/** Bright "space" backdrop so leftover green is obvious in the preview. */
function makeSampleBackground(w: number, h: number) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  const g = ctx.createLinearGradient(0, 0, 0, h)
  g.addColorStop(0, '#1b4f9c')
  g.addColorStop(1, '#7c3aed')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = '#fff3cf'
  for (let i = 0; i < 40; i++) {
    const x = (i * 97) % w
    const y = (i * 53) % h
    ctx.beginPath()
    ctx.arc(x, y, (i % 3) + 1, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.fillStyle = '#ffc83d'
  ctx.beginPath()
  ctx.arc(w * 0.85, h * 0.22, h * 0.12, 0, Math.PI * 2)
  ctx.fill()
  return c
}

/* ---------- form controls ---------- */

function Card({ icon, title, children, tone = 'blue' }: { icon: IconName; title: string; children: ReactNode; tone?: string }) {
  return (
    <section className="t-card">
      <h2 className="t-card-title">
        <span className={`t-card-icon tone-${tone}`} aria-hidden="true">
          <Icon name={icon} size={24} />
        </span>
        {title}
      </h2>
      {children}
    </section>
  )
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="t-row t-toggle">
      <span className="t-row-text">
        <span className="t-label">{label}</span>
        {hint && <span className="t-hint">{hint}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        className="switch"
        checked={checked}
        onChange={(e) => {
          playSound('tap')
          onChange(e.target.checked)
        }}
      />
    </label>
  )
}

function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
}) {
  const id = useId()
  return (
    <div className="t-row t-seg-row">
      <span className="t-label" id={id}>
        {label}
      </span>
      <div className="segmented" role="radiogroup" aria-labelledby={id}>
        {options.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            className={value === o.value ? 'on' : ''}
            onClick={() => {
              playSound('tap')
              onChange(o.value)
            }}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function Slider({
  label,
  hint,
  value,
  min = 0,
  max = 1,
  step = 0.01,
  onChange,
  disabled,
  valueText,
}: {
  label: string
  hint?: string
  value: number
  min?: number
  max?: number
  step?: number
  onChange: (v: number) => void
  disabled?: boolean
  /** shown instead of the 0–100% position (e.g. "Normal" for a centred slider) */
  valueText?: string
}) {
  const id = useId()
  const pct = Math.round(((value - min) / (max - min)) * 100)
  return (
    <div className={`t-slider${disabled ? ' disabled' : ''}`}>
      <div className="t-slider-head">
        <label className="t-label" htmlFor={id}>
          {label}
        </label>
        <span className="t-value">{valueText ?? `${pct}%`}</span>
      </div>
      {hint && <span className="t-hint">{hint}</span>}
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        style={{ ['--fill' as string]: `${pct}%` }}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
    </div>
  )
}

/* ---------- sections ---------- */

/** Third-party license texts (MediaPipe Apache-2.0), loaded only when opened. */
function Licenses() {
  const [text, setText] = useState<string | null>(null)
  return (
    <details
      className="t-licenses"
      onToggle={(e) => {
        if (!e.currentTarget.open || text !== null) return
        import('../../THIRD_PARTY_LICENSES.md?raw')
          .then((m: { default: string }) => setText(m.default))
          .catch(() => setText('The license text could not be loaded.'))
      }}
    >
      <summary>Open-source licenses</summary>
      <pre className="t-license-text">{text ?? 'Loading…'}</pre>
    </details>
  )
}

function KeyPreview({ settings, check = false }: { settings: Settings; check?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const compRef = useRef<Compositor | null>(null)
  const [failed, setFailed] = useState(false)
  const pendingDestroy = useRef(0)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    // StrictMode unmounts and remounts right away: keep the same Compositor then, and
    // only destroy it (releasing its WebGL context) once the preview is really gone.
    window.clearTimeout(pendingDestroy.current)
    if (!compRef.current) {
      try {
        const W = 480
        const H = 270
        const comp = new Compositor(canvas, { width: W, height: H })
        comp.setBackground(makeSampleBackground(W, H))
        comp.setForeground(makeSampleForeground(W, H))
        compRef.current = comp
      } catch {
        setFailed(true)
      }
    }
    // The preview only draws when a slider moves, so redraw once the GPU context
    // comes back (the Compositor's own restore listener was registered first).
    const onRestored = () => requestAnimationFrame(() => compRef.current?.render())
    canvas.addEventListener('webglcontextrestored', onRestored)
    return () => {
      canvas.removeEventListener('webglcontextrestored', onRestored)
      pendingDestroy.current = window.setTimeout(() => {
        compRef.current?.destroy({ releaseContext: true })
        compRef.current = null
      }, 0)
    }
  }, [])

  const { color, similarity, smoothness, spill } = settings.key
  useEffect(() => {
    const comp = compRef.current
    if (!comp) return
    comp.setKey({ mode: 'chroma', color, similarity, smoothness, spill })
    // "Check the edges": cutout over a grey checker + magenta band (keyer P2 item 11).
    comp.setCheckerboard(check)
    comp.render()
  }, [color, similarity, smoothness, spill, check])

  return (
    <div className="key-preview">
      <canvas ref={canvasRef} className="key-preview-canvas" aria-label="Preview of the green screen settings on a sample picture" />
      {failed && <p className="t-hint">Preview is not available on this device.</p>}
      <span className="key-preview-tag">Preview</span>
    </div>
  )
}

/** The outline slider runs -1 (looser) .. +1 (tighter); 0 is the normal edge. */
function outlineText(v: number): string {
  if (Math.abs(v) < 0.01) return 'Normal'
  return `${v > 0 ? 'Tighter' : 'Looser'} ${Math.round(Math.abs(v) * 100)}%`
}

function GreenScreenCard() {
  const settings = useApp((s) => s.settings)
  const update = useApp((s) => s.updateSettings)
  const setKey = (patch: Partial<Settings['key']>) => update({ key: { ...settings.key, ...patch } })
  // Green screen settings apply in Auto too (whenever a screen is found).
  const chroma = settings.greenScreenMode !== 'segment'
  const [checkEdges, setCheckEdges] = useState(false)

  return (
    <Card icon="sparkle" title="Green screen" tone="green">
      <Segmented
        label="How should we cut out the kids?"
        value={settings.greenScreenMode}
        options={[
          { value: 'auto', label: 'Auto (recommended)' },
          { value: 'chroma', label: 'Green screen' },
          { value: 'segment', label: 'No green screen' },
        ]}
        onChange={(greenScreenMode) => update({ greenScreenMode })}
      />
      {settings.greenScreenMode === 'auto' && (
        <p className="t-hint t-hint-row">
          Uses the green screen when the camera sees one, and the AI cutout when it doesn't.
        </p>
      )}
      <Slider
        label="Outline"
        hint="Slide right for a tighter edge (trims more), left for a looser one. Grown-up fix on the Me step nudges it too."
        value={settings.outline ?? 0}
        valueText={outlineText(settings.outline ?? 0)}
        min={-1}
        max={1}
        step={0.05}
        onChange={(outline) => update({ outline })}
      />
      {chroma && (
        <>
          <Segmented
            label="Magic Helper (AI person finder)"
            value={settings.magicHelper ?? 'auto'}
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'on', label: 'On' },
              { value: 'off', label: 'Off' },
            ]}
            onChange={(magicHelper) => update({ magicHelper })}
          />
          <p className="t-hint t-hint-row">
            Keeps kids in the picture (even in green shirts) and hides things that aren't kids. It runs only on this
            device; Auto uses it when the device is fast enough.
          </p>
        </>
      )}
      {!chroma && (
        <p className="t-note">
          AI cutout finds the person without any green screen. It is softer around the edges and works best with one
          child in a plain room. The settings below only apply to green screen mode.
        </p>
      )}

      <div className={`key-grid${chroma ? '' : ' dimmed'}`}>
        <KeyPreview settings={settings} check={checkEdges} />
        <div className="key-controls">
          <div className="t-row">
            <span className="t-row-text">
              <span className="t-label">Screen color</span>
              <span className="t-hint">Picked automatically from the camera. Change it if your screen is blue.</span>
            </span>
            <span className="swatch-group">
              <label className="swatch" style={{ background: rgbToHex(settings.key.color) }}>
                <span className="sr-only">Pick the screen color</span>
                <input
                  type="color"
                  value={rgbToHex(settings.key.color)}
                  disabled={!chroma}
                  onChange={(e) => setKey({ color: hexToRgb(e.target.value) })}
                />
              </label>
              <Button
                variant="secondary"
                icon="reset"
                disabled={!chroma}
                onClick={() => update({ key: { ...DEFAULT_SETTINGS.key } })}
              >
                Reset
              </Button>
            </span>
          </div>
          <Slider
            label="Similarity"
            hint="Higher removes more of the green. Too high eats into the kids."
            value={settings.key.similarity}
            disabled={!chroma}
            onChange={(similarity) => setKey({ similarity })}
          />
          <Slider
            label="Smoothness"
            hint="Softens the edges around hair and hands."
            value={settings.key.smoothness}
            max={0.4}
            disabled={!chroma}
            onChange={(smoothness) => setKey({ smoothness })}
          />
          <Slider
            label="Spill removal"
            hint="Takes the green glow off skin and clothes."
            value={settings.key.spill}
            disabled={!chroma}
            onChange={(spill) => setKey({ spill })}
          />
          <Toggle
            label="Check the edges"
            hint="Shows the cutout over a grey checkerboard with a pink stripe, so holes and green edges stand out."
            checked={checkEdges}
            onChange={setCheckEdges}
          />
        </div>
      </div>
    </Card>
  )
}

function creationLabel(c: Creation) {
  const what = c.kind === 'video' ? 'Video' : 'Photo'
  try {
    return `${what} · ${new Date(c.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
  } catch {
    return what
  }
}

/**
 * Delete lives here, not on the kid View screen. Deleting moves a creation to
 * "Recently deleted" for 7 days (purged on app start after that) so a slip can be undone.
 */
function CreationsCard() {
  const [live, setLive] = useState<Creation[] | null>(null)
  const [trash, setTrash] = useState<Creation[]>([])
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)

  const refresh = () =>
    Promise.all([listCreations(), listDeletedCreations()])
      .then(([l, t]) => {
        setLive(l)
        setTrash(t)
      })
      .catch(() => {
        setLive((prev) => prev ?? [])
      })

  useEffect(() => {
    void refresh()
  }, [])

  const run = async (fn: () => Promise<void>, ok: string, fail: string) => {
    setBusy(true)
    try {
      await fn()
      toast(ok)
    } catch {
      toast(fail)
    } finally {
      await refresh()
      setBusy(false)
    }
  }

  const deleteAll = async () => {
    setConfirm(false)
    playSound('pop')
    await run(deleteAllCreations, 'All creations deleted', 'Some creations could not be deleted')
  }

  const count = live?.length ?? null

  return (
    <Card icon="image" title="Creations" tone="pink">
      <p className="t-note">
        {count === null ? 'Counting…' : count === 1 ? '1 creation saved on this device.' : `${count} creations saved on this device.`}
      </p>
      {!!live?.length && (
        <ul className="t-creations" aria-label="Saved creations">
          {live.map((c) => (
            <li key={c.id} className="t-creation">
              <img src={c.thumbDataUrl} alt="" className="t-creation-thumb" draggable={false} />
              <span className="t-creation-label">{creationLabel(c)}</span>
              <Button
                variant="secondary"
                icon="trash"
                disabled={busy}
                aria-label={`Delete ${creationLabel(c)}`}
                onClick={() => {
                  playSound('pop')
                  void run(() => deleteCreation(c.id), 'Moved to Recently deleted', 'Could not delete it')
                }}
              >
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}

      {/* An empty bin gets no heading of its own: right above "Delete all" it read as part of it. */}
      {trash.length === 0 ? (
        !!live?.length && (
          <p className="t-hint t-hint-row">
            Deleted creations wait in Recently deleted for {TRASH_DAYS} days, so you can bring them back. They still use
            space until then.
          </p>
        )
      ) : (
        <>
        <h3 className="t-subtitle">Recently deleted</h3>
        <ul className="t-creations" aria-label="Recently deleted">
          {trash.map((c) => (
            <li key={c.id} className="t-creation t-creation-deleted">
              <img src={c.thumbDataUrl} alt="" className="t-creation-thumb" draggable={false} />
              <span className="t-creation-label">
                {creationLabel(c)}
                <span className="t-hint">{daysLeft(c) === 1 ? '1 day left' : `${daysLeft(c)} days left`}</span>
              </span>
              <span className="t-creation-actions">
                <Button
                  variant="success"
                  icon="refresh"
                  disabled={busy}
                  aria-label={`Restore ${creationLabel(c)}`}
                  onClick={() => void run(() => restoreCreation(c.id), 'Restored!', 'Could not restore it')}
                >
                  Restore
                </Button>
                <Button
                  variant="ghost"
                  icon="close"
                  disabled={busy}
                  aria-label={`Delete ${creationLabel(c)} now`}
                  onClick={() => void run(() => deleteCreationForever(c.id), 'Deleted for good', 'Could not delete it')}
                >
                  Delete now
                </Button>
              </span>
            </li>
          ))}
        </ul>
        </>
      )}

      <Button variant="danger" icon="trash" disabled={(!count && !trash.length) || busy} onClick={() => setConfirm(true)}>
        Delete all creations
      </Button>
      <ConfirmDialog
        open={confirm}
        title="Delete everything?"
        message="All photos and videos on this device, including Recently deleted, will be gone for good."
        confirmLabel="Delete all"
        onConfirm={deleteAll}
        onCancel={() => setConfirm(false)}
      />
    </Card>
  )
}

const TIPS: { icon: IconName; title: string; text: string }[] = [
  { icon: 'sparkle', title: 'Light it evenly', text: 'Light the green screen and the child evenly. Dark patches and shadows are the #1 cause of holes and flicker.' },
  { icon: 'smile', title: 'No green clothes', text: 'Anything the same color as the screen disappears. (Fun lesson: a green scarf is an invisibility cloak!)' },
  { icon: 'move', title: 'Step away from the screen', text: 'Have kids stand a few big steps in front of the screen. This stops shadows on it and the green glow on their edges.' },
  { icon: 'photo', title: 'Fill the frame with green', text: 'Make the screen bigger than the camera view, so no wall or floor shows at the edges.' },
  { icon: 'camera', title: 'Use the back camera on a tripod', text: 'The back camera is sharper. A tripod or stand keeps the picture steady so the key stays clean.' },
  { icon: 'image', title: 'Matte, smooth backdrop', text: 'Use a bright, non-shiny green: a plastic tablecloth, fabric or painted board. Smooth out wrinkles.' },
  { icon: 'finger', title: 'Magic finger', text: 'If the cutout looks patchy, press and hold the small gear in the corner of the picture on the Me step for 3 seconds to open Grown-up fix, tap "Tap the green", then touch the green behind the child.' },
  { icon: 'refresh', title: 'Experiment', text: 'Try different distances between camera, child and screen, and adjust Similarity above until edges look clean.' },
]

/* ---------- screen ---------- */

export default function Teacher() {
  const settings = useApp((s) => s.settings)
  const update = useApp((s) => s.updateSettings)
  const goScreen = useApp((s) => s.goScreen)

  return (
    <Panel className="teacher">
      <header className="step-header">
        <h1>Teacher settings</h1>
        <p>Changes save right away.</p>
      </header>

      <div className="t-cards">
        <GreenScreenCard />

        <Card icon="camera" title="Camera" tone="orange">
          <Segmented
            label="Picture quality"
            value={settings.resolution}
            options={[
              { value: '540p', label: '540p' },
              { value: '720p', label: '720p' },
              { value: '1080p', label: '1080p' },
            ]}
            onChange={(resolution) => update({ resolution })}
          />
          <p className="t-hint t-hint-row">720p is best for most iPads. 1080p makes bigger files and can be slower.</p>
          <Segmented
            label="Which camera"
            value={settings.facing}
            options={[
              { value: 'user', label: 'Front (selfie)' },
              { value: 'environment', label: 'Back' },
            ]}
            onChange={(facing) => {
              update({ facing })
              // A grown-up Flip on the Me step only lasts the session; the new default wins right away.
              useApp.getState().setSessionFacing(null)
            }}
          />
          <Toggle
            label="Mirror the front camera"
            hint="Feels like a mirror, so moving left goes left."
            checked={settings.mirror}
            onChange={(mirror) => update({ mirror })}
          />
        </Card>

        <Card icon="video" title="Recording" tone="pink">
          <Segmented
            label="Longest video"
            value={settings.maxVideoSec}
            options={[
              { value: 15, label: '15s' },
              { value: 30, label: '30s' },
              { value: 60, label: '1 min' },
              { value: 120, label: '2 min' },
            ]}
            onChange={(maxVideoSec) => update({ maxVideoSec })}
          />
          <Segmented
            label="Countdown"
            value={settings.countdownSec}
            options={[
              { value: 0, label: 'None' },
              { value: 3, label: '3' },
              { value: 5, label: '5' },
            ]}
            onChange={(countdownSec) => update({ countdownSec })}
          />
          <Toggle
            label="Record sound"
            hint="Videos include the microphone. Off: videos are silent and the iPad never asks for the mic."
            checked={settings.recordSound ?? true}
            onChange={(recordSound) => update({ recordSound })}
          />
        </Card>

        <Card icon="speaker" title="Voice & sounds" tone="mint">
          <Toggle
            label="Spoken help"
            hint="Reads each step out loud for kids who can't read yet."
            checked={settings.voice}
            onChange={(voice) => update({ voice })}
          />
          <Toggle label="Sound effects" hint="Taps, pops and the countdown beep." checked={settings.sounds} onChange={(sounds) => update({ sounds })} />
        </Card>

        <CreationsCard />

        <Card icon="star" title="Green screen tips" tone="sun">
          <ul className="tips">
            {TIPS.map((t) => (
              <li key={t.title} className="tip">
                <span className="tip-icon" aria-hidden="true">
                  <Icon name={t.icon} size={22} />
                </span>
                <span>
                  <strong>{t.title}.</strong> {t.text}
                </span>
              </li>
            ))}
          </ul>
        </Card>

        <Card icon="smile" title="About" tone="blue">
          <p className="t-note">
            Magic Screen is a free green screen studio for young kids, inspired by DoInk Green Screen. Photos and videos are
            saved only on this device, with no accounts and no tracking.
          </p>
          <p className="t-note">
            All the green screen work happens right here on the device. Nothing is ever uploaded.
          </p>
          <p className="t-note t-credit">
            The Magic Helper person cutout uses{' '}
            <a href={MEDIAPIPE_URL} target="_blank" rel="noreferrer noopener">
              Google MediaPipe
            </a>{' '}
            (Apache License 2.0).
          </p>
          <Licenses />
        </Card>
      </div>

      <div className="nav-row">
        <Button variant="secondary" size="lg" icon="back" onClick={() => goScreen('home')}>
          Back home
        </Button>
      </div>
    </Panel>
  )
}
