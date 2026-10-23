import { useEffect, useState } from 'react'
import { useApp } from '../state/store'
import { listCreations } from '../lib/storage'
import { playSound } from '../lib/sound'
import { speak } from '../lib/voice'
import type { Creation } from '../types'
import { Panel } from '../components/Panel'
import { Icon } from '../components/Icon'
import { ParentGate } from '../components/ParentGate'
import { toast } from '../components/Toast'
import { HoldRing, useHold } from '../components/HoldRing'

const HOLD_MS = 2000

/**
 * Gear that must be held for 2 seconds. Kids tap; grown-ups hold. The ring
 * fills while holding so the teacher knows it's working.
 */
function HoldGear({ onUnlock }: { onUnlock: () => void }) {
  const { progress, handlers } = useHold({
    ms: HOLD_MS,
    onDone: () => {
      playSound('pop')
      onUnlock()
    },
    onShortTap: () => toast('Grown-ups: press and hold the gear', { grownup: true }),
  })

  return (
    <button
      type="button"
      className="hold-gear"
      aria-label="Teacher settings. Press and hold for 2 seconds."
      {...handlers}
    >
      <HoldRing progress={progress} />
      <Icon name="gear" size={26} />
    </button>
  )
}

function CameraArt() {
  // Big friendly orange camera with a sparkle: "this is where you start".
  return (
    <svg className="make-art" viewBox="0 0 120 96" aria-hidden="true">
      <rect x="8" y="22" width="104" height="66" rx="18" fill="#fb923c" stroke="#ea580c" strokeWidth="5" />
      <path d="M38 22l8-12h28l8 12" fill="#fdba74" stroke="#ea580c" strokeWidth="5" strokeLinejoin="round" />
      <circle cx="60" cy="55" r="22" fill="#fff" stroke="#ea580c" strokeWidth="5" />
      <circle cx="60" cy="55" r="12" fill="#22c55e" stroke="#15803d" strokeWidth="4" />
      <circle cx="55" cy="50" r="3.5" fill="#fff" />
      <circle cx="94" cy="38" r="5" fill="#fff3cf" />
      <path d="M104 4l3 7.5 7.5 3-7.5 3-3 7.5-3-7.5-7.5-3 7.5-3z" fill="#ffc83d" stroke="#d98c00" strokeWidth="2.5" strokeLinejoin="round" />
    </svg>
  )
}

function formatWhen(ts: number) {
  try {
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  } catch {
    return ''
  }
}

function formatDuration(sec?: number) {
  if (sec == null || !isFinite(sec)) return ''
  const s = Math.max(0, Math.round(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export default function Home() {
  const newCreation = useApp((s) => s.newCreation)
  const viewCreation = useApp((s) => s.viewCreation)
  const goScreen = useApp((s) => s.goScreen)
  const audioUnlocked = useApp((s) => s.audioUnlocked)
  const [creations, setCreations] = useState<Creation[] | null>(null)
  const [gateOpen, setGateOpen] = useState(false)

  useEffect(() => {
    let alive = true
    listCreations()
      .then((list) => alive && setCreations(list))
      .catch(() => alive && setCreations([]))
    return () => {
      alive = false
    }
  }, [])

  // Only greet once speech can actually play (after the first tap on iOS).
  useEffect(() => {
    if (audioUnlocked) speak("Let's make some magic!")
  }, [audioUnlocked])

  return (
    <Panel className="home">
      <div className="home-corner">
        <HoldGear onUnlock={() => setGateOpen(true)} />
      </div>

      <button
        type="button"
        className="make-card"
        onClick={() => {
          playSound('pop')
          newCreation()
        }}
      >
        <span className="make-art-tile">
          <CameraArt />
        </span>
        <span className="make-text">
          <span className="make-title">Let's make!</span>
          <span className="make-sub">Be anywhere in the world</span>
        </span>
      </button>

      <section className="gallery" aria-labelledby="gallery-title">
        <h2 id="gallery-title" className="section-title">
          <Icon name="star" size={26} /> My creations
        </h2>

        {creations === null ? (
          <div className="gallery-grid" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="creation-tile skeleton" />
            ))}
          </div>
        ) : creations.length === 0 ? (
          <div className="gallery-empty">
            <Icon name="smile" size={44} />
            <p>Nothing here yet.</p>
            <p className="muted">Tap "Let's make!" to make your first one.</p>
          </div>
        ) : (
          <ul className="gallery-grid">
            {creations.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className="creation-tile"
                  aria-label={`${c.kind === 'video' ? 'Video' : 'Picture'} from ${formatWhen(c.createdAt)}`}
                  onClick={() => {
                    playSound('tap')
                    viewCreation(c.id)
                  }}
                >
                  {c.thumbDataUrl ? (
                    <img src={c.thumbDataUrl} alt="" draggable={false} />
                  ) : (
                    <span className="creation-noimg">
                      <Icon name="image" size={36} />
                    </span>
                  )}
                  <span className={`creation-badge ${c.kind}`} aria-hidden="true">
                    <Icon name={c.kind === 'video' ? 'play' : 'photo'} size={18} />
                    {c.kind === 'video' && c.durationSec != null && <span>{formatDuration(c.durationSec)}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className="home-footer">
        <p>
          <Icon name="lock" size={18} /> Everything you make stays on this device.
        </p>
      </footer>

      <ParentGate
        open={gateOpen}
        onClose={() => setGateOpen(false)}
        onSuccess={() => {
          setGateOpen(false)
          goScreen('teacher')
        }}
      />
    </Panel>
  )
}
