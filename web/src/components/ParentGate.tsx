import { useEffect, useRef, useState } from 'react'
import { useApp } from '../state/store'
import { playSound } from '../lib/sound'
import { Icon } from './Icon'
import { IconButton } from './IconButton'

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'del'] as const

/** 4-digit PIN keypad that keeps kids out of teacher settings. */
export function ParentGate({ open, onSuccess, onClose }: { open: boolean; onSuccess: () => void; onClose: () => void }) {
  const pin = useApp((s) => s.settings.teacherPin)
  const [entry, setEntry] = useState('')
  const [wrong, setWrong] = useState(false)
  const firstKeyRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    setEntry('')
    setWrong(false)
    firstKeyRef.current?.focus()
  }, [open])

  const press = (k: (typeof KEYS)[number]) => {
    playSound('tap')
    setWrong(false)
    if (k === 'clear') return setEntry('')
    if (k === 'del') return setEntry(entry.slice(0, -1))
    if (entry.length >= 4) return
    const nextEntry = entry + k
    setEntry(nextEntry)
    if (nextEntry.length === 4) {
      // Defer the verdict a beat so the 4th dot is visibly filled first.
      window.setTimeout(() => {
        if (nextEntry === pin) {
          playSound('success')
          onSuccess()
        } else {
          setWrong(true)
          setEntry('')
        }
      }, 160)
    }
  }

  // Hardware keyboard support (desktop / iPad keyboard). A ref keeps the listener stable.
  const pressRef = useRef(press)
  pressRef.current = press
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current()
      else if (/^[0-9]$/.test(e.key)) pressRef.current(e.key as (typeof KEYS)[number])
      else if (e.key === 'Backspace') pressRef.current('del')
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
        <p className="muted">Ask your teacher to type the secret code.</p>
        <div className={`pin-dots${wrong ? ' shake' : ''}`} aria-label={`${entry.length} of 4 digits entered`}>
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className={`pin-dot${i < entry.length ? ' filled' : ''}`} />
          ))}
        </div>
        <p className="gate-error" role="alert">
          {wrong ? 'Oops! That code is not right.' : ' '}
        </p>
        <div className="keypad">
          {KEYS.map((k, i) => (
            <button
              key={k}
              ref={i === 0 ? firstKeyRef : undefined}
              type="button"
              className={`key${k === 'clear' || k === 'del' ? ' key-fn' : ''}`}
              aria-label={k === 'clear' ? 'Clear' : k === 'del' ? 'Delete' : k}
              onClick={() => press(k)}
            >
              {k === 'clear' ? <Icon name="reset" size={28} /> : k === 'del' ? <Icon name="back" size={28} /> : k}
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
