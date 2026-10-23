import { useEffect, useRef, useState } from 'react'
import { playSound } from '../lib/sound'
import { Icon } from './Icon'
import { IconButton } from './IconButton'

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok'] as const

interface Question {
  a: number
  b: number
}

/** 3..9 times 3..9: easy for a grown-up, out of reach for a kindergartner. */
export function newQuestion(prev?: Question): Question {
  for (;;) {
    const q = { a: 3 + Math.floor(Math.random() * 7), b: 3 + Math.floor(Math.random() * 7) }
    if (!prev || q.a !== prev.a || q.b !== prev.b) return q
  }
}

/**
 * Grown-up check that keeps kids out of teacher settings. There is no code to
 * remember, change or forget: each time it asks a fresh multiplication question.
 */
export function ParentGate({ open, onSuccess, onClose }: { open: boolean; onSuccess: () => void; onClose: () => void }) {
  const [q, setQ] = useState<Question>(() => newQuestion())
  const [entry, setEntry] = useState('')
  const [wrong, setWrong] = useState(false)
  const firstKeyRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    setQ((prev) => newQuestion(prev))
    setEntry('')
    setWrong(false)
    firstKeyRef.current?.focus()
  }, [open])

  const press = (k: (typeof KEYS)[number]) => {
    playSound('tap')
    setWrong(false)
    if (k === 'del') return setEntry(entry.slice(0, -1))
    if (k === 'ok') {
      if (!entry) return
      if (Number(entry) === q.a * q.b) {
        playSound('success')
        onSuccess()
      } else {
        // A wrong answer gets a brand new question, so guessing doesn't pay off.
        setWrong(true)
        setEntry('')
        setQ((prev) => newQuestion(prev))
      }
      return
    }
    if (entry.length >= 2) return
    setEntry(entry + k)
  }

  // Hardware keyboard support (desktop / iPad keyboard). A ref keeps the listener stable.
  const pressRef = useRef(press)
  pressRef.current = press
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return closeRef.current()
      let k: (typeof KEYS)[number] | null = null
      if (/^[0-9]$/.test(e.key)) k = e.key as (typeof KEYS)[number]
      else if (e.key === 'Backspace') k = 'del'
      else if (e.key === 'Enter') k = 'ok'
      if (!k) return
      // The keypad's first key has focus: without this, Enter would also "click" it and
      // type a stray digit into the (fresh) answer right after checking.
      e.preventDefault()
      pressRef.current(k)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return null

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal gate" role="dialog" aria-modal="true" aria-labelledby="gate-title">
        <IconButton icon="close" label="Close" className="modal-close" onClick={onClose} />
        <div className="gate-icon" aria-hidden="true">
          <Icon name="lock" size={36} />
        </div>
        <h2 id="gate-title">Grown-ups only</h2>
        <p className="muted">Ask a grown-up to answer this.</p>
        <p className="gate-question" id="gate-question">
          {q.a} × {q.b} = ?
        </p>
        <div className={`gate-answer${wrong ? ' shake' : ''}`} role="status" aria-labelledby="gate-question">
          {entry || <span className="gate-answer-placeholder">?</span>}
        </div>
        <p className="gate-error" role="alert">
          {wrong ? 'Not quite. Try this one!' : '\u00a0'}
        </p>
        <div className="keypad">
          {KEYS.map((k, i) => (
            <button
              key={k}
              ref={i === 0 ? firstKeyRef : undefined}
              type="button"
              className={`key${k === 'del' ? ' key-fn' : k === 'ok' ? ' key-ok' : ''}`}
              aria-label={k === 'ok' ? 'Check answer' : k === 'del' ? 'Delete' : k}
              onClick={() => press(k)}
            >
              {k === 'ok' ? <Icon name="check" size={30} /> : k === 'del' ? <Icon name="back" size={28} /> : k}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * Simple big-button yes/no dialog (shares the gate's modal styling).
 * Used for destructive actions like deleting a creation.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel = 'Keep it',
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  message?: string
  confirmLabel: string
  cancelLabel?: string
  onConfirm: () => void
  onCancel: () => void
}) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const cancelCb = useRef(onCancel)
  cancelCb.current = onCancel

  useEffect(() => {
    if (!open) return
    // Focus the safe choice first.
    cancelRef.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && cancelCb.current()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return null
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal confirm" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
        <div className="gate-icon danger" aria-hidden="true">
          <Icon name="trash" size={36} />
        </div>
        <h2 id="confirm-title">{title}</h2>
        {message && <p className="muted">{message}</p>}
        <div className="confirm-actions">
          <button
            ref={cancelRef}
            type="button"
            className="btn btn-secondary btn-lg"
            onClick={() => {
              playSound('tap')
              onCancel()
            }}
          >
            <Icon name="close" size={26} />
            <span className="btn-label">{cancelLabel}</span>
          </button>
          <button
            type="button"
            className="btn btn-danger btn-lg"
            onClick={() => {
              playSound('tap')
              onConfirm()
            }}
          >
            <Icon name="trash" size={26} />
            <span className="btn-label">{confirmLabel}</span>
          </button>
        </div>
      </div>
    </div>
  )
}
