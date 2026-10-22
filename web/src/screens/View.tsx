import { useEffect, useState } from 'react'
import { useApp } from '../state/store'
import { deleteCreation, getCreation, getCreationBlob } from '../lib/storage'
import { saveToDevice } from '../lib/recorder'
import { playSound } from '../lib/sound'
import type { Creation } from '../types'
import { Panel } from '../components/Panel'
import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { ConfirmDialog } from '../components/ParentGate'
import { toast } from '../components/Toast'

function extFor(mime: string, kind: Creation['kind']) {
  if (mime.includes('mp4')) return 'mp4'
  if (mime.includes('webm')) return 'webm'
  if (mime.includes('jpeg')) return 'jpg'
  if (mime.includes('png')) return 'png'
  return kind === 'video' ? 'mp4' : 'png'
}

type LoadState =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'ready'; creation: Creation; blob: Blob; url: string }

export default function View() {
  const viewingId = useApp((s) => s.viewingId)
  const goScreen = useApp((s) => s.goScreen)
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!viewingId) {
      setState({ status: 'missing' })
      return
    }
    let alive = true
    let url = ''
    Promise.all([getCreation(viewingId), getCreationBlob(viewingId)])
      .then(([creation, blob]) => {
        if (!alive) return
        if (!creation || !blob) return setState({ status: 'missing' })
        url = URL.createObjectURL(blob)
        setState({ status: 'ready', creation, blob, url })
      })
      .catch(() => alive && setState({ status: 'missing' }))
    return () => {
      alive = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [viewingId])

  const onSave = async () => {
    if (state.status !== 'ready') return
    setSaving(true)
    try {
      const { creation, blob } = state
      const stamp = new Date(creation.createdAt).toISOString().slice(0, 10)
      const result = await saveToDevice(blob, `magic-screen-${stamp}-${creation.id.slice(-4)}.${extFor(creation.mime, creation.kind)}`)
      if (result !== 'cancelled') {
        playSound('success')
        toast(result === 'shared' ? 'Saved!' : 'Downloaded!')
      }
    } catch {
      toast('Oops! Could not save. Try again.')
    } finally {
      setSaving(false)
    }
  }

  const onDelete = async () => {
    if (!viewingId) return
    setConfirmOpen(false)
    try {
      await deleteCreation(viewingId)
      playSound('pop')
      toast('All gone!')
    } catch {
      toast('Oops! Could not delete it.')
    }
    goScreen('home')
  }

  return (
    <Panel className="view">
      <div className="view-stage-wrap">
        {state.status === 'loading' && <div className="view-stage skeleton" aria-busy="true" />}
        {state.status === 'missing' && (
          <div className="view-stage view-missing">
            <Icon name="image" size={48} />
            <p>We can't find this one.</p>
          </div>
        )}
        {state.status === 'ready' &&
          (state.creation.kind === 'video' ? (
            <video className="view-stage" src={state.url} controls playsInline autoPlay aria-label="Your video" />
          ) : (
            <img className="view-stage" src={state.url} alt="Your picture" draggable={false} />
          ))}
      </div>

      <div className="view-actions">
        <Button
          variant="success"
          size="xl"
          icon="save"
          onClick={onSave}
          disabled={state.status !== 'ready' || saving}
          className="view-save"
        >
          Save
        </Button>
        <Button variant="danger" size="lg" icon="trash" onClick={() => setConfirmOpen(true)} disabled={state.status === 'loading'}>
          Delete
        </Button>
      </div>

      <div className="nav-row">
        <Button variant="secondary" size="lg" icon="back" onClick={() => goScreen('home')}>
          Back
        </Button>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Delete this?"
        message="It will be gone for good."
        confirmLabel="Delete"
        onConfirm={onDelete}
        onCancel={() => setConfirmOpen(false)}
      />
    </Panel>
  )
}
