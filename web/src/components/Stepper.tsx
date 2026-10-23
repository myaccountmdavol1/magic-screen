import { Fragment } from 'react'
import { Icon, type IconName } from './Icon'

export interface StepperStep {
  id: string
  label: string
  icon: IconName
}

/**
 * Talkline numbered step circles, shown as a progress indicator only. Done steps
 * turn mint with a check. Kids can't tap it (a stray tap used to jump steps);
 * going back is the Back button's job.
 */
export function Stepper({ steps, current, max }: { steps: StepperStep[]; current: number; max: number }) {
  return (
    <nav className="stepper stepper-progress" aria-label={`Step ${current + 1} of ${steps.length}`}>
      <ol>
        {steps.map((s, i) => {
          const active = i === current
          // A step is "done" once the child has moved past it (even if they went back).
          const done = !active && (i < current || i < max)
          const reached = i <= max
          return (
            <Fragment key={s.id}>
              {i > 0 && <li className={`step-line${i <= max ? ' done' : ''}`} aria-hidden="true" />}
              <li
                className="step-item"
                aria-current={active ? 'step' : undefined}
                aria-label={`Step ${i + 1}: ${s.label}${done ? ', done' : ''}`}
              >
                <span className={`step-btn${active ? ' active' : ''}${done ? ' done' : ''}${reached ? '' : ' locked'}`}>
                  <span className="step-circle" aria-hidden="true">
                    {done ? <Icon name="check" size={22} /> : <Icon name={s.icon} size={22} />}
                    <span className="step-num">{i + 1}</span>
                  </span>
                  <span className="step-label" aria-hidden="true">
                    {s.label}
                  </span>
                </span>
              </li>
            </Fragment>
          )
        })}
      </ol>
    </nav>
  )
}
