// Step 2: see yourself in the world. Camera + live key.
// Kids get three big tools (Bigger, Smaller, Center me). The fixing tools (Tap the green,
// Auto fix, Tighter/Looser edge, Flip camera) live in a "Grown-up fix" drawer behind a
// 3 s hold on a small gear in the stage corner, away from the kid tools; the drawer closes
// itself after FIX_IDLE_MS without a grown-up touching it. A hold alone (no multiplication question) is enough here: the drawer only
// adjusts the live picture for this session, nothing is deleted and no teacher setting
// except the edge nudge (which Teacher settings shows and can reset) changes.
import { useEffect, useRef, useState } from 'react'
import { useApp } from '../../state/store'
import { homeMeFor } from '../../lib/worldHome'
import { StepShell } from '../../components/StepShell'
import { StageSlot } from '../../components/Stage'
import { Icon, type IconName } from '../../components/Icon'
import { HoldButton } from '../../components/HoldButton'
import { toast } from '../../components/Toast'
import { useStage, clamp } from '../../lib/useStage'
import { playSound } from '../../lib/sound'
import { speak } from '../../lib/voice'

/** The Grown-up fix gear needs a long hold: a kid's resting finger rarely lasts 3 s. */
const FIX_HOLD_MS = 3000
/** The open drawer closes itself after this long without a touch inside it. */
const FIX_IDLE_MS = 20_000

function Tool({
  icon,
  label,
  onClick,
  active,
  tone = 'blue',
  disabled,
  speakLabel,
  big,
}: {
  icon: IconName
  label: string
  onClick: () => void
  active?: boolean
  tone?: 'blue' | 'orange' | 'mint' | 'sun'
  disabled?: boolean
  /** kid tools say their name out loud so pre-readers learn them */
  speakLabel?: boolean
  big?: boolean
}) {
  return (
    <button
      type="button"
      className={`tool-btn tone-${tone}${active ? ' active' : ''}${big ? ' tool-big' : ''}`}
      aria-pressed={active}
      disabled={disabled}
      onClick={() => {
        playSound('tap')
        if (speakLabel) speak(label)
        onClick()
      }}
    >
      <span className="tool-icon" aria-hidden="true">
        <Icon name={icon} size={big ? 40 : 30} />
      </span>
      <span className="tool-label">{label}</span>
    </button>
  )
}

export default function MeStep() {
  const settings = useApp((s) => s.settings)
  const updateSettings = useApp((s) => s.updateSettings)
  const sessionFacing = useApp((s) => s.sessionFacing)
  const setSessionFacing = useApp((s) => s.setSessionFacing)
  const setMe = useApp((s) => s.setMe)
  const nextStep = useApp((s) => s.nextStep)
  const goStep = useApp((s) => s.goStep)
  const stage = useStage()
  const [fixOpen, setFixOpen] = useState(false)
  const drawerRef = useRef<HTMLElement>(null)
  // The live mode: in Auto the stage decides from what the camera sees.
  const segment = stage.mode === 'segment'
  // Auto has settled on green screen vs AI cutout (the stage shows "Finding you…" until then).
  const modeDecided = stage.modeDecided
  // Calm start (A7): if the step opened before Auto decided, say only "Wave hello!" for this
  // visit, so the child doesn't hear a second, different prompt a moment later.
  const [calmStart] = useState(() => !stage.modeDecided)
  // Green-screen-only fixes make no sense before Auto knows there is a green screen.
  const greenTools = !segment && modeDecided
  // No camera (asleep, blocked or still waking): the kid tools have nothing to move.
  const noCamera = !stage.ready

  useEffect(() => {
    if (modeDecided && !segment) toast('Stand in front of the green!')
  }, [segment, modeDecided])

  // Leaving the step (or closing the drawer) puts the magic finger away.
  const armRef = useRef(stage.armMagicFinger)
  armRef.current = stage.armMagicFinger
  useEffect(() => () => armRef.current(false), [])

  useEffect(() => {
    if (fixOpen) drawerRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
  }, [fixOpen])

  const closeFix = () => {
    if (stage.magicArmed) stage.armMagicFinger(false)
    setFixOpen(false)
  }
  const closeFixRef = useRef(closeFix)
  closeFixRef.current = closeFix

  // A grown-up who walks away doesn't leave the fixing tools out for the kids.
  // Any touch inside the drawer (or arming the magic finger) restarts the clock.
  const [fixTouch, setFixTouch] = useState(0)
  useEffect(() => {
    if (!fixOpen) return
    const t = window.setTimeout(() => closeFixRef.current(), FIX_IDLE_MS)
    return () => window.clearTimeout(t)
  }, [fixOpen, fixTouch, stage.magicArmed])

  // Outline: -1 looser .. +1 tighter, in small steps.
  const nudgeOutline = (delta: number) => {
    const cur = useApp.getState().settings.outline ?? 0
    const next = clamp(Math.round((cur + delta) * 4) / 4, -1, 1)
    if (next === cur) {
      toast(delta > 0 ? 'As snug as it gets!' : 'As loose as it gets!')
      return
    }
    updateSettings({ outline: next })
  }

  const zoom = (factor: number) => {
    const me = useApp.getState().me
    setMe({ scale: clamp(me.scale * factor, 0.4, 2) })
  }

  // Per-session flip: never writes settings.facing (the teacher's default stays put).
  const facing = sessionFacing ?? settings.facing
  const flip = () => setSessionFacing(facing === 'user' ? 'environment' : 'user')

  return (
    <StepShell
      title="Me!"
      subtitle={!modeDecided ? 'Wave hello!' : segment ? 'Wave hello! Drag to move you.' : 'Stand in front of the green.'}
      speak={calmStart ? 'Wave hello!' : segment ? 'Wave hello! Drag to move you.' : 'Stand in front of the green. Wave hello!'}
      layout="stage"
      back={{ label: 'Back', onClick: () => goStep('world') }}
      next={{ label: 'Next: Stickers', onClick: nextStep }}
      aside={
        <div className={`me-tools${fixOpen ? ' fix-open' : ''}`}>
          <div className="tool-grid tool-grid-kid">
            <Tool icon="plus" label="Bigger" big speakLabel disabled={noCamera} onClick={() => zoom(1.15)} />
            <Tool icon="minus" label="Smaller" big speakLabel disabled={noCamera} onClick={() => zoom(1 / 1.15)} />
            <Tool
              icon="reset"
              label="Center me"
              tone="orange"
              big
              speakLabel
              disabled={noCamera}
              onClick={() => setMe(homeMeFor(useApp.getState().background))}
            />
          </div>

          {fixOpen && (
            <section
              ref={drawerRef}
              className="fix-drawer"
              aria-label="Grown-up fix"
              onPointerDownCapture={() => setFixTouch((n) => n + 1)}
            >
              <div className="fix-drawer-head">
                <h2 className="fix-drawer-title">
                  <Icon name="gear" size={20} /> Grown-up fix
                </h2>
                <button type="button" className="fix-drawer-done" onClick={closeFix}>
                  <Icon name="check" size={20} />
                  <span>Done</span>
                </button>
              </div>
              <div className="tool-grid tool-grid-fix">
                {greenTools && (
                  <Tool
                    icon="finger"
                    label="Tap the green"
                    tone="sun"
                    active={stage.magicArmed}
                    disabled={!stage.ready}
                    onClick={() => {
                      const on = !stage.magicArmed
                      stage.armMagicFinger(on)
                      if (on) speak('Tap the green!')
                    }}
                  />
                )}
                {greenTools && (
                  <Tool
                    icon="sparkle"
                    label="Auto fix"
                    tone="mint"
                    disabled={!stage.ready}
                    onClick={() => {
                      if (stage.autoKey()) {
                        playSound('magic')
                        toast('All fixed!')
                      } else {
                        toast('Stand in front of the green!')
                      }
                    }}
                  />
                )}
                <Tool icon="edgeIn" label="Tighter edge" tone="mint" onClick={() => nudgeOutline(0.25)} />
                <Tool icon="edgeOut" label="Looser edge" tone="mint" onClick={() => nudgeOutline(-0.25)} />
                <Tool icon="flip" label="Flip camera" onClick={flip} />
              </div>
            </section>
          )}
        </div>
      }
    >
      <StageSlot>
        {!fixOpen && (
          <HoldButton
            icon="gear"
            className="stage-fix-gear"
            holdMs={FIX_HOLD_MS}
            label="Grown-up fix. Press and hold for 3 seconds."
            hint="Grown-ups: press and hold to fix the picture"
            onUnlock={() => setFixOpen(true)}
          />
        )}
        {segment && (
          <span className="stage-badge">
            <Icon name="sparkle" size={18} /> Magic on
          </span>
        )}
      </StageSlot>
    </StepShell>
  )
}
