// The make flow: Talkline 5-step stepper + the current step. Owns the single live
// Stage so the camera keeps running while the child moves between Me, Stickers and
// Snap; unmounting Make (leaving the screen) or reaching Keep stops the camera.
import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { STEPS, useApp } from '../state/store'
import type { StepId } from '../types'
import { Stepper, type StepperStep } from '../components/Stepper'
import Stage from '../components/Stage'
import { EMPTY_STAGE_API, StageContext, type StageApi } from '../lib/useStage'
import WorldStep from './steps/WorldStep'
import MeStep from './steps/MeStep'
import StickersStep from './steps/StickersStep'
import ActionStep from './steps/ActionStep'
import KeepStep from './steps/KeepStep'
import './steps/steps.css'

const STEP_DEFS: StepperStep[] = [
  { id: 'world', label: 'World', icon: 'image' },
  { id: 'me', label: 'Me', icon: 'smile' },
  { id: 'stickers', label: 'Stickers', icon: 'star' },
  { id: 'action', label: 'Snap', icon: 'camera' },
  { id: 'keep', label: 'Keep', icon: 'save' },
]

const LIVE_STEPS: StepId[] = ['me', 'stickers', 'action']

function StepView({ step }: { step: StepId }) {
  switch (step) {
    case 'world':
      return <WorldStep />
    case 'me':
      return <MeStep />
    case 'stickers':
      return <StickersStep />
    case 'action':
      return <ActionStep />
    case 'keep':
      return <KeepStep />
  }
}

export default function Make() {
  const step = useApp((s) => s.step)
  const maxStep = useApp((s) => s.maxStep)
  const goStep = useApp((s) => s.goStep)

  const [api, setApi] = useState<StageApi>(EMPTY_STAGE_API)
  // Detached host for the one Stage instance; StageSlot moves it between steps.
  const [host] = useState(() => {
    const el = document.createElement('div')
    el.className = 'stage-host'
    return el
  })
  const ctx = useMemo(() => ({ ...api, host }), [api, host])
  const live = LIVE_STEPS.includes(step)

  return (
    <div className="make">
      <Stepper
        steps={STEP_DEFS}
        current={STEPS.indexOf(step)}
        max={maxStep}
        onGo={(i) => goStep(STEPS[i])}
      />
      <StageContext.Provider value={ctx}>
        <div key={step} className="make-step">
          <StepView step={step} />
        </div>
        {live && createPortal(<Stage onApi={setApi} />, host)}
      </StageContext.Provider>
    </div>
  )
}
