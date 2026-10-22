import { Fragment } from 'react'
import { playSound } from '../lib/sound'
import { Icon, type IconName } from './Icon'

export interface StepperStep {
  id: string
  label: string
  icon: IconName
}

/**
 * Talkline numbered step circles. Done steps turn mint with a check; steps the
 * child hasn't reached yet are disabled so the flow stays linear.
 */
export function Stepper({
  steps,
  current,
  max,
  onGo,
}: {
  steps: StepperStep[]
  current: number
  max: number
  onGo: (i: number) => void
}) {
  return (
    <nav className="stepper" aria-label="Steps">
      <ol>
        {steps.map((s, i) => {
          const active = i === current
          // A step is "done" once the child has moved past it (even if they tapped back).
          const done = !active && (i < current || i < max)
          const reachable = i <= max
          return (
            <Fragment key={s.id}>
              {i > 0 && <li className={`step-line${i <= max ? ' done' : ''}`} aria-hidden="true" />}
              <li className="step-item">
                <button
                  type="button"
                  className={`step-btn${active ? ' active' : ''}${done ? ' done' : ''}`}
                  disabled={!reachable}
                  aria-current={active ? 'step' : undefined}
                  aria-label={`Step ${i + 1}: ${s.label}${done ? ', done' : ''}`}
                  onClick={() => {
                    if (active) return
                    playSound('tap')
                    onGo(i)
                  }}
                >
                  <span className="step-circle">
                    {done ? <Icon name="check" size={22} /> : <Icon name={s.icon} size={22} />}
                    <span className="step-num" aria-hidden="true">
                      {i + 1}
                    </span>
                  </span>
                  <span className="step-label">{s.label}</span>
                </button>
              </li>
            </Fragment>
          )
        })}
      </ol>
    </nav>
  )
}
