import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { speak as say } from '../lib/voice'
import { playSound } from '../lib/sound'
import { Button, type ButtonVariant } from './Button'
import { IconButton } from './IconButton'
import { Icon } from './Icon'
import { HoldRing, useHold } from './HoldRing'
import { toast } from './Toast'
import './StepShell.css'

/** Spoken when a step's choice is made and the big arrow lights up. */
export const READY_SPEAK = 'Great! Now tap the big arrow.'
const BLOCKED_SPEAK = 'Pick one first!'
/** Added to an idle re-prompt when the arrow is already lit but the prompt doesn't mention it. */
const IDLE_NEXT_SPEAK = 'Ready? Tap the big arrow!'
/** Quiet this long on a step → say the prompt again and wiggle what to tap. */
export const IDLE_MS = 8000
const NUDGE_MS = 900
const BACK_HOLD_MS = 1500
/**
 * A kid's double tap on Next/Back: the first tap swaps in the next step, whose arrow sits
 * in the same spot, so the second tap used to skip a whole step. Nav taps this soon after
 * the previous nav tap are ignored.
 */
const NAV_DEBOUNCE_MS = 350
let lastNavAt = -Infinity
/**
 * @param at the tap's own time (`event.timeStamp`, same clock as performance.now()). Mounting
 *   the next step (camera + WebGL setup on Me) can block the main thread for longer than the
 *   debounce, so the second tap's handler may run late; its event time is still 150 ms on.
 */
function navTapAllowed(at: number = performance.now()): boolean {
  const now = Number.isFinite(at) && at > 0 ? at : performance.now()
  if (now - lastNavAt < NAV_DEBOUNCE_MS && now >= lastNavAt) return false
  lastNavAt = now
  return true
}

export interface StepShellProps {
  title: string
  subtitle?: string
  /** Spoken on mount, when the speaker button is tapped, and again after ~8 s idle. */
  speak?: string
  children: ReactNode
  back?: {
    label: string
    onClick: () => void
    /** Leaving the flow (step 1 "Home"): needs a 1.5 s hold with a filling ring. */
    hold?: boolean
  }
  next?: {
    label: string
    onClick: () => void
    /** Still tappable: a tap boops, wiggles the choice area ([data-nudge]) and says `blockedSpeak`. */
    disabled?: boolean
    /** Non-primary variants (e.g. Keep's "Make another") stay a labelled pill, not the arrow. */
    variant?: ButtonVariant
    /** Said when the choice is made and the arrow turns solid. Default: READY_SPEAK. */
    readySpeak?: string
    /** Said when the greyed arrow is tapped, e.g. "Pick a world first!". */
    blockedSpeak?: string
  }
  /** Tools column. In 'stage' layout it sits right of the stage on wide screens, under it otherwise. */
  aside?: ReactNode
  layout?: 'single' | 'stage'
}

type Nudge = 'choice' | 'next' | 'body' | null

/** Step-1 "Home": a kid's tap only shows a hint; a grown-up's 1.5 s hold leaves. */
function HoldBackButton({ label, onDone }: { label: string; onDone: () => void }) {
  const { progress, handlers } = useHold({
    ms: BACK_HOLD_MS,
    onDone: () => {
      playSound('pop')
      onDone()
    },
    onShortTap: () => toast('Hold to go home'),
  })
  return (
    <button
      type="button"
      className={`btn btn-secondary btn-lg hold-back${progress > 0 ? ' holding' : ''}`}
      aria-label={`${label}. Press and hold.`}
      {...handlers}
    >
      <span className="hold-back-icon">
        <HoldRing progress={progress} />
        <Icon name="home" size={26} />
      </span>
      <span className="btn-label">{label}</span>
    </button>
  )
}

/** Shared step frame: heading + speaker, body, and the Back / big-arrow Next nav row. */
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
  const shellRef = useRef<HTMLDivElement>(null)
  const h1Ref = useRef<HTMLHeadingElement>(null)
  const [pulse, setPulse] = useState(false)
  const [nudge, setNudge] = useState<Nudge>(null)
  const nudgeTimer = useRef(0)
  const nudgeRaf = useRef(0)

  useEffect(() => {
    if (speak) say(speak)
  }, [speak])

  // New step: move focus to its heading for VoiceOver (unless something already took focus).
  useEffect(() => {
    const a = document.activeElement
    if (!a || a === document.body) h1Ref.current?.focus({ preventScroll: true })
  }, [])

  const doNudge = useCallback((kind: Exclude<Nudge, null>) => {
    // No [data-nudge] marked in this step: wiggle the whole body instead.
    const target = kind === 'choice' && !shellRef.current?.querySelector('[data-nudge]') ? 'body' : kind
    window.clearTimeout(nudgeTimer.current)
    cancelAnimationFrame(nudgeRaf.current)
    setNudge(null) // restart the animation if it's already running
    nudgeRaf.current = requestAnimationFrame(() => {
      setNudge(target)
      nudgeTimer.current = window.setTimeout(() => setNudge(null), NUDGE_MS)
    })
  }, [])

  useEffect(
    () => () => {
      window.clearTimeout(nudgeTimer.current)
      cancelAnimationFrame(nudgeRaf.current)
    },
    [],
  )

  const isArrow = !!next && (next.variant == null || next.variant === 'primary')
  const nextReady = !!next && !next.disabled

  // The choice was just made: light the arrow up, pulse it, and say what to do.
  const live = useRef({ speak, next, nextReady, pulse, isArrow })
  live.current = { speak, next, nextReady, pulse, isArrow }
  const wasReady = useRef(nextReady)
  useEffect(() => {
    if (nextReady && !wasReady.current) {
      setPulse(true)
      say(live.current.next?.readySpeak ?? READY_SPEAK)
    } else if (!nextReady) {
      setPulse(false)
    }
    wasReady.current = nextReady
  }, [nextReady])

  // Idle re-prompt: after ~8 s with no touch, say the prompt again and wiggle the target.
  // Once per quiet spell (the next touch re-arms it), and only while the nav row shows —
  // ActionStep hides it during the countdown/recording, where talking would be wrong.
  const navShown = !!(back || next)
  useEffect(() => {
    if (!navShown || !speak) return
    let timer = 0
    const fire = () => {
      // A dialog (stop / grown-up gate) or a hidden app: wait for the next quiet spell.
      if (document.hidden || document.querySelector('.modal-backdrop')) return arm()
      // Never talk over a playing video (Keep's movie): wait until it is paused.
      const playing = [...(shellRef.current?.querySelectorAll('video') ?? [])].some((v) => !v.paused && !v.ended)
      if (playing) return arm()
      const { speak: prompt, next: n, nextReady: ready, pulse: chosen, isArrow: arrow } = live.current
      if (n && ready && chosen) say(n.readySpeak ?? READY_SPEAK)
      // Arrow ready from the start (Me, Stickers): the prompt alone never says where to go next.
      else if (prompt) say(n && ready && arrow ? `${prompt} ${IDLE_NEXT_SPEAK}` : prompt)
      if (n) doNudge(ready ? 'next' : 'choice')
    }
    const arm = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(fire, IDLE_MS)
    }
    arm()
    window.addEventListener('pointerdown', arm, true)
    window.addEventListener('keydown', arm, true)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('pointerdown', arm, true)
      window.removeEventListener('keydown', arm, true)
    }
  }, [navShown, speak, doNudge])

  const onNext = (e: { timeStamp: number }) => {
    if (!next) return
    if (next.disabled) {
      // Greyed but still tappable: tell the child what's missing instead of doing nothing.
      playSound('stop')
      say(next.blockedSpeak ?? BLOCKED_SPEAK)
      doNudge('choice')
      return
    }
    if (!navTapAllowed(e.timeStamp)) return
    playSound('tap')
    next.onClick()
  }

  const shellCls = ['step-shell', `layout-${layout}`, nudge ? `nudge-${nudge}` : ''].filter(Boolean).join(' ')

  return (
    <div ref={shellRef} className={shellCls}>
      <header className="step-header">
        <div className="step-title-row">
          <h1 ref={h1Ref} tabIndex={-1}>
            {title}
          </h1>
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

      {navShown && (
        <div className={`nav-row${back ? '' : ' end'}`}>
          {back &&
            (back.hold ? (
              <HoldBackButton label={back.label} onDone={back.onClick} />
            ) : (
              <Button variant="secondary" size="lg" icon="back" onClick={(e) => navTapAllowed(e.timeStamp) && back.onClick()}>
                {back.label}
              </Button>
            ))}
          {next &&
            (isArrow ? (
              <button
                type="button"
                className={[
                  'nav-arrow',
                  next.disabled ? 'waiting' : 'ready',
                  pulse && nextReady ? 'pulse' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                aria-label={next.label}
                aria-disabled={next.disabled ? true : undefined}
                onClick={onNext}
              >
                {/* Small caption for grown-ups; kids just follow the arrow. */}
                <span className="nav-arrow-caption" aria-hidden="true">
                  {next.label}
                </span>
                <span className="nav-arrow-circle" aria-hidden="true">
                  <Icon name="next" size={44} />
                </span>
              </button>
            ) : (
              <Button
                variant={next.variant}
                size="lg"
                iconRight="next"
                className="nav-next"
                disabled={next.disabled}
                onClick={(e) => navTapAllowed(e.timeStamp) && next.onClick()}
              >
                {next.label}
              </Button>
            ))}
        </div>
      )}
    </div>
  )
}
