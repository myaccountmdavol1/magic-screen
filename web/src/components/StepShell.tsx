import { useEffect, type ReactNode } from 'react'
import { speak as say } from '../lib/voice'
import { Button, type ButtonVariant } from './Button'
import { IconButton } from './IconButton'

export interface StepShellProps {
  title: string
  subtitle?: string
  /** Spoken on mount and whenever the speaker button is tapped (most kids can't read yet). */
  speak?: string
  children: ReactNode
  back?: { label: string; onClick: () => void }
  next?: { label: string; onClick: () => void; disabled?: boolean; variant?: ButtonVariant }
  /** Tools column. In 'stage' layout it sits right of the stage on wide screens, under it otherwise. */
  aside?: ReactNode
  layout?: 'single' | 'stage'
}

/** Shared step frame: heading + speaker, body, and the Back / Next nav row. */
export function StepShell({
  title,
  subtitle,
  speak,
  children,
  back,
  next,
  aside,
  layout = 'single',
}: StepShellProps) {
  useEffect(() => {
    if (speak) say(speak)
  }, [speak])

  return (
    <div className={`step-shell layout-${layout}`}>
      <header className="step-header">
        <div className="step-title-row">
          <h1>{title}</h1>
          {speak && (
            <IconButton icon="speaker" label="Say it again" tone="blue" className="speak-btn" onClick={() => say(speak)} />
          )}
        </div>
        {subtitle && <p>{subtitle}</p>}
      </header>

      <div className="step-body">
        {layout === 'stage' ? (
          <div className="stage-layout">
            <div className="stage-main">{children}</div>
            {aside && <aside className="stage-aside">{aside}</aside>}
          </div>
        ) : (
          <>
            {children}
            {aside && <div className="single-aside">{aside}</div>}
          </>
        )}
      </div>

      {(back || next) && (
        <div className={`nav-row${back ? '' : ' end'}`}>
          {back && (
            <Button variant="secondary" size="lg" icon="back" onClick={back.onClick}>
              {back.label}
            </Button>
          )}
          {next && (
            <Button
              variant={next.variant ?? 'primary'}
              size="lg"
              iconRight="next"
              className="nav-next"
              disabled={next.disabled}
              onClick={next.onClick}
            >
              {next.label}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
