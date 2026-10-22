// Step 2: see yourself in the world. Camera + live key; big tools to fix the look.
import { useEffect } from 'react'
import { DEFAULT_ME, useApp } from '../../state/store'
import { StepShell } from '../../components/StepShell'
import { StageSlot } from '../../components/Stage'
import { Icon, type IconName } from '../../components/Icon'
import { toast } from '../../components/Toast'
import { useStage, clamp } from '../../lib/useStage'
import { playSound } from '../../lib/sound'
import { speak } from '../../lib/voice'

function Tool({
  icon,
  label,
  onClick,
  active,
  tone = 'blue',
  disabled,
}: {
  icon: IconName
  label: string
  onClick: () => void
  active?: boolean
  tone?: 'blue' | 'orange' | 'mint' | 'sun'
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      className={`tool-btn tone-${tone}${active ? ' active' : ''}`}
      aria-pressed={active}
      disabled={disabled}
      onClick={() => {
        playSound('tap')
        onClick()
      }}
    >
      <span className="tool-icon" aria-hidden="true">
        <Icon name={icon} size={30} />
      </span>
      <span className="tool-label">{label}</span>
    </button>
  )
}

export default function MeStep() {
  const settings = useApp((s) => s.settings)
  const updateSettings = useApp((s) => s.updateSettings)
  const setMe = useApp((s) => s.setMe)
  const nextStep = useApp((s) => s.nextStep)
  const goStep = useApp((s) => s.goStep)
  const stage = useStage()
  // The live mode: in Auto the stage decides from what the camera sees.
  const segment = stage.mode === 'segment'

  useEffect(() => {
    if (!segment) toast('Stand in front of the green!')
  }, [segment])

  // Outline: -1 looser .. +1 tighter, in small steps a kid can feel.
  const nudgeOutline = (delta: number) => {
    const cur = useApp.getState().settings.outline ?? 0
    const next = clamp(Math.round((cur + delta) * 4) / 4, -1, 1)
    if (next === cur) {
      toast(delta > 0 ? 'That is as snug as it gets!' : 'That is as loose as it gets!')
      return
    }
    updateSettings({ outline: next })
  }

  const zoom = (factor: number) => {
    const me = useApp.getState().me
    setMe({ scale: clamp(me.scale * factor, 0.4, 2) })
  }

  return (
    <StepShell
      title="Me!"
      subtitle={segment ? 'Wave hello! Drag to move you.' : 'Stand in front of the green.'}
      speak={segment ? 'Wave hello! Drag to move you.' : 'Stand in front of the green. Wave hello!'}
      layout="stage"
      back={{ label: 'Back', onClick: () => goStep('world') }}
      next={{ label: 'Next: Stickers', onClick: nextStep }}
      aside={
        <div className="tool-grid">
          <Tool
            icon="flip"
            label="Flip camera"
            onClick={() => updateSettings({ facing: settings.facing === 'user' ? 'environment' : 'user' })}
          />
          {!segment && (
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
          {!segment && (
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
          <Tool icon="plus" label="Bigger" onClick={() => zoom(1.15)} />
          <Tool icon="minus" label="Smaller" onClick={() => zoom(1 / 1.15)} />
          <Tool icon="reset" label="Center me" tone="orange" onClick={() => setMe(DEFAULT_ME)} />
        </div>
      }
    >
      <StageSlot>
        {segment && (
          <span className="stage-badge">
            <Icon name="sparkle" size={18} /> AI cutout on
          </span>
        )}
      </StageSlot>
    </StepShell>
  )
}
