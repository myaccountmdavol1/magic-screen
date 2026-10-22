// Step 1: pick a world (built-in illustrated background or the child's own picture/video).
import { useMemo, useRef, type ChangeEvent } from 'react'
import { useApp } from '../../state/store'
import type { BackgroundChoice } from '../../types'
import { StepShell } from '../../components/StepShell'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/Toast'
import { BUILTIN_BACKGROUNDS } from '../../assets/backgrounds'
import { getBackgroundUrl, svgToDataUrl } from '../../assets/svg'
import { playSound } from '../../lib/sound'
import { speak } from '../../lib/voice'

// An uploaded world lives behind a blob: URL. Once it stops being the chosen world
// (another pick, a new upload, or "Make another" resetting the flow) nothing shows
// it any more, so free it instead of leaking one per upload.
useApp.subscribe((s, prev) => {
  const old = prev.background
  if (s.background === old || !old || (old.kind !== 'image' && old.kind !== 'video')) return
  if (old.src.startsWith('blob:')) URL.revokeObjectURL(old.src)
})

export default function WorldStep() {
  const background = useApp((s) => s.background)
  const setBackground = useApp((s) => s.setBackground)
  const nextStep = useApp((s) => s.nextStep)
  const goScreen = useApp((s) => s.goScreen)
  const fileRef = useRef<HTMLInputElement>(null)

  // SVG → data URL is a bit of work for 12 big SVGs; the helper caches it.
  const thumbs = useMemo(
    () => BUILTIN_BACKGROUNDS.map((bg) => ({ ...bg, url: getBackgroundUrl(bg.id) ?? svgToDataUrl(bg.svg) })),
    [],
  )

  const pick = (choice: BackgroundChoice) => {
    setBackground(choice)
    playSound('pop')
    speak(choice.name)
  }

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // let the same file be picked again later
    if (!file) return
    const isVideo = file.type.startsWith('video/')
    if (!isVideo && !file.type.startsWith('image/')) {
      toast('Pick a picture or a video')
      return
    }
    // Uploads are kept in memory only: nothing ever reads them back from IndexedDB,
    // so persisting each one would silently fill the iPad's storage.
    pick({
      id: `upload_${Date.now().toString(36)}`,
      kind: isVideo ? 'video' : 'image',
      name: 'My picture',
      src: URL.createObjectURL(file),
    })
  }

  const uploaded = background && (background.kind === 'image' || background.kind === 'video') ? background : null

  return (
    <StepShell
      title="Pick a world"
      subtitle="Where do you want to go?"
      speak="Pick a world. Where do you want to go?"
      back={{ label: 'Home', onClick: () => goScreen('home') }}
      next={{ label: 'Next: Me!', onClick: nextStep, disabled: !background }}
    >
      <div className="world-grid" role="radiogroup" aria-label="Worlds">
        {thumbs.map((bg) => {
          const selected = background?.kind === 'builtin' && background.builtinId === bg.id
          return (
            <button
              key={bg.id}
              type="button"
              role="radio"
              aria-checked={selected}
              className={`world-tile${selected ? ' selected' : ''}`}
              style={{ background: bg.thumbColor }}
              onClick={() =>
                pick({ id: `builtin:${bg.id}`, kind: 'builtin', name: bg.name, src: bg.url, builtinId: bg.id })
              }
            >
              <span className="world-thumb">
                <img src={bg.url} alt="" draggable={false} />
              </span>
              <span className="world-name">{bg.name}</span>
              {selected && (
                <span className="world-check" aria-hidden="true">
                  <Icon name="check" size={26} />
                </span>
              )}
            </button>
          )
        })}

        <button
          type="button"
          role="radio"
          aria-checked={!!uploaded}
          className={`world-tile world-upload${uploaded ? ' selected' : ''}`}
          onClick={() => fileRef.current?.click()}
        >
          <span className="world-thumb">
            {uploaded?.kind === 'image' && <img src={uploaded.src} alt="" draggable={false} />}
            {uploaded?.kind === 'video' && <video src={uploaded.src} muted loop autoPlay playsInline />}
            {!uploaded && (
              <span className="world-upload-icon">
                <Icon name="upload" size={40} />
              </span>
            )}
          </span>
          <span className="world-name">My picture</span>
          {uploaded && (
            <span className="world-check" aria-hidden="true">
              <Icon name="check" size={26} />
            </span>
          )}
        </button>
        <input ref={fileRef} type="file" accept="image/*,video/*" hidden onChange={onFile} />
      </div>
    </StepShell>
  )
}
