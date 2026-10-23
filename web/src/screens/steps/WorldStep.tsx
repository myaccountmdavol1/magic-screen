// Step 1: pick a world. Rows, top to bottom: the teacher's Class worlds (only when there
// are some, so today's lesson world is the first thing kids see), Pictures (12 still
// worlds), Moving worlds (canvas-animated), Real places (footage) and My worlds (the
// child's saved uploads, plus the upload tile).
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { useApp } from '../../state/store'
import type { BackgroundChoice, SavedWorld } from '../../types'
import { READY_SPEAK, StepShell } from '../../components/StepShell'
import { useRequestExit } from '../../components/StopDialog'
import { Icon, type IconName } from '../../components/Icon'
import { toast } from '../../components/Toast'
import { BUILTIN_BACKGROUNDS } from '../../assets/backgrounds'
import { ANIMATED_WORLDS } from '../../assets/animatedWorlds'
import { FOOTAGE_WORLDS, footageChoice, warmFootage } from '../../assets/footage'
import { getBackgroundUrl, svgToDataUrl, withSvgSize } from '../../assets/svg'
import { getUpload, listWorlds, saveWorld } from '../../lib/storage'
import { prepareWorldFile, savedWorldChoice } from '../../lib/worlds'
import { playSound } from '../../lib/sound'
import { speak } from '../../lib/voice'
import { meAfterWorldChange } from '../../lib/worldHome'

// An uploaded or saved world lives behind a blob: URL. Once it stops being the chosen
// world (another pick, a new upload, or "Make another" resetting the flow) nothing shows
// it any more, so free it instead of leaking one per pick.
useApp.subscribe((s, prev) => {
  const old = prev.background
  if (s.background === old || !old || (old.kind !== 'image' && old.kind !== 'video')) return
  if (old.src.startsWith('blob:')) URL.revokeObjectURL(old.src)
})

const notify = (message: string) => toast(message, { grownup: message.startsWith('Grown-ups') })

/** Saved worlds for the World step (re-read after every upload). */
function useSavedWorlds() {
  const [classWorlds, setClassWorlds] = useState<SavedWorld[]>([])
  const [myWorlds, setMyWorlds] = useState<SavedWorld[]>([])
  const refresh = useCallback(async () => {
    try {
      const [c, m] = await Promise.all([listWorlds('class'), listWorlds('mine')])
      setClassWorlds(c)
      setMyWorlds(m)
    } catch {
      /* no IndexedDB (private mode): just the built-in worlds */
    }
  }, [])
  useEffect(() => {
    void refresh()
  }, [refresh])
  return { classWorlds, myWorlds, refresh }
}

function WorldRow({ id, icon, title, tone, children }: { id: string; icon: IconName; title: string; tone: string; children: ReactNode }) {
  return (
    <section className="world-row" aria-labelledby={`world-row-${id}`} data-row={id}>
      <h2 className="world-row-title" id={`world-row-${id}`}>
        <span className={`world-row-icon tone-${tone}`} aria-hidden="true">
          <Icon name={icon} size={22} />
        </span>
        {title}
      </h2>
      <div className="world-grid" role="radiogroup" aria-labelledby={`world-row-${id}`}>
        {children}
      </div>
    </section>
  )
}

function Tile({
  name,
  selected,
  color,
  badge,
  onClick,
  children,
}: {
  name: string
  selected: boolean
  color?: string
  badge?: 'moving' | 'video'
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={name}
      className={`world-tile${selected ? ' selected' : ''}`}
      style={color ? { background: color } : undefined}
      onClick={onClick}
    >
      <span className="world-thumb">{children}</span>
      <span className="world-name">{name}</span>
      {badge && (
        <span className={`world-badge world-badge-${badge}`} aria-hidden="true">
          <Icon name="play" size={14} />
          {badge === 'moving' && <span>Moving</span>}
        </span>
      )}
      {selected && (
        <span className="world-check" aria-hidden="true">
          <Icon name="check" size={26} />
        </span>
      )}
    </button>
  )
}

function SavedThumb({ w }: { w: SavedWorld }) {
  if (w.thumbDataUrl) return <img src={w.thumbDataUrl} alt="" draggable={false} />
  return (
    <span className="world-upload-icon">
      <Icon name={w.media === 'video' ? 'video' : 'image'} size={40} />
    </span>
  )
}

export default function WorldStep() {
  const background = useApp((s) => s.background)
  const setBackground = useApp((s) => s.setBackground)
  const nextStep = useApp((s) => s.nextStep)
  const requestExit = useRequestExit()
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const { classWorlds, myWorlds, refresh } = useSavedWorlds()

  // SVG → data URL is a bit of work for 12 big SVGs; the helper caches it.
  const thumbs = useMemo(
    () => BUILTIN_BACKGROUNDS.map((bg) => ({ ...bg, url: getBackgroundUrl(bg.id) ?? svgToDataUrl(bg.svg) })),
    [],
  )
  // Moving-world posters are built on first use; tile-sized is plenty.
  const moving = useMemo(
    () => ANIMATED_WORLDS.map((w) => ({ ...w, url: svgToDataUrl(withSvgSize(w.posterSvg, 480, 270)) })),
    [],
  )

  const pick = (choice: BackgroundChoice) => {
    // First pick: StepShell says "<name>! Great! Now tap the big arrow." as the arrow lights up.
    const first = !useApp.getState().background
    // C5: an untouched child moves to the new world's home spot (behind the desk, beside the map).
    const st = useApp.getState()
    st.setMe(meAfterWorldChange(st.me, st.background, choice))
    setBackground(choice)
    playSound('pop')
    if (!first) speak(choice.name)
  }

  const pickSaved = async (w: SavedWorld) => {
    try {
      const blob = await getUpload(w.id)
      if (!blob) {
        toast("That world didn't load. Try another!")
        void refresh()
        return
      }
      pick(savedWorldChoice(w, URL.createObjectURL(blob)))
    } catch {
      toast("That world didn't load. Try another!")
    }
  }

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // let the same file be picked again later
    if (!file || busy) return
    setBusy(true)
    try {
      const prep = await prepareWorldFile(file)
      if (!prep.ok) {
        notify(prep.message)
        return
      }
      const name = prep.media === 'video' ? 'My video' : 'My picture'
      try {
        // Saved on this device so it is still there tomorrow ("My worlds", newest first).
        const saved = await saveWorld(file, { scope: 'mine', name, thumbDataUrl: prep.thumb })
        pick(savedWorldChoice(saved, URL.createObjectURL(file)))
        await refresh()
      } catch (err) {
        // Storage full or unavailable: still use it for this creation.
        notify(err instanceof Error && err.message.startsWith('The iPad is full') ? `Grown-ups: ${err.message}` : 'Grown-ups: this picture could not be saved for next time.')
        pick({ id: `upload_${Date.now().toString(36)}`, kind: prep.media, name, src: URL.createObjectURL(file) })
      }
    } finally {
      setBusy(false)
    }
  }

  // Only an unsaved, in-memory upload (storage failed) lights up the upload tile.
  const unsaved = background && background.id.startsWith('upload_') ? background : null

  return (
    <StepShell
      title="Pick a world"
      subtitle="Where do you want to go?"
      speak="Pick a world. Where do you want to go?"
      back={{ label: 'Home', onClick: requestExit, hold: true }}
      next={{
        label: 'Next: Me!',
        onClick: nextStep,
        disabled: !background,
        readySpeak: background ? `${background.name}! ${READY_SPEAK}` : READY_SPEAK,
        blockedSpeak: 'Pick a world first!',
      }}
    >
      <div className="world-rows" data-nudge>
        {classWorlds.length > 0 && (
          <WorldRow id="class" icon="star" title="Class worlds" tone="sun">
            {classWorlds.map((w) => (
              <Tile
                key={w.id}
                name={w.name}
                selected={background?.id === `saved:${w.id}`}
                color="#f59e0b"
                badge={w.media === 'video' ? 'video' : undefined}
                onClick={() => void pickSaved(w)}
              >
                <SavedThumb w={w} />
              </Tile>
            ))}
          </WorldRow>
        )}

        <WorldRow id="pictures" icon="image" title="Pictures" tone="blue">
          {thumbs.map((bg) => (
            <Tile
              key={bg.id}
              name={bg.name}
              selected={background?.kind === 'builtin' && background.builtinId === bg.id}
              color={bg.thumbColor}
              onClick={() =>
                pick({ id: `builtin:${bg.id}`, kind: 'builtin', name: bg.name, src: bg.url, builtinId: bg.id })
              }
            >
              <img src={bg.url} alt="" draggable={false} />
            </Tile>
          ))}
        </WorldRow>

        <WorldRow id="moving" icon="sparkle" title="Moving worlds" tone="pink">
          {moving.map((w) => (
            <Tile
              key={w.id}
              name={w.name}
              selected={background?.kind === 'animated' && background.animatedId === w.id}
              color={w.thumbColor}
              badge="moving"
              onClick={() => pick({ id: `animated:${w.id}`, kind: 'animated', name: w.name, src: w.url, animatedId: w.id })}
            >
              <img src={w.url} alt="" draggable={false} />
            </Tile>
          ))}
        </WorldRow>

        <WorldRow id="real" icon="video" title="Real places" tone="mint">
          {FOOTAGE_WORLDS.map((f) => {
            const selected = background?.id === footageChoice(f).id
            return (
              <Tile
                key={f.id}
                name={f.name}
                selected={selected}
                color={f.thumbColor}
                onClick={() => {
                  pick(footageChoice(f))
                  warmFootage(f)
                }}
              >
                {selected ? (
                  <video src={f.src} poster={f.poster} muted loop autoPlay playsInline />
                ) : (
                  <img src={f.poster} alt="" draggable={false} />
                )}
              </Tile>
            )
          })}
        </WorldRow>

        <WorldRow id="mine" icon="smile" title="My worlds" tone="orange">
          <button
            type="button"
            role="radio"
            aria-checked={!!unsaved}
            aria-label="Add mine: pick a picture or video"
            aria-busy={busy}
            className={`world-tile world-upload${unsaved ? ' selected' : ''}`}
            onClick={() => fileRef.current?.click()}
          >
            <span className="world-thumb">
              {unsaved?.kind === 'image' && <img src={unsaved.src} alt="" draggable={false} />}
              {unsaved?.kind === 'video' && <video src={unsaved.src} muted loop autoPlay playsInline />}
              {!unsaved && (
                <span className="world-upload-icon">
                  {busy ? <span className="world-spinner" /> : <Icon name="upload" size={40} />}
                </span>
              )}
            </span>
            <span className="world-name">Add mine</span>
            {unsaved && (
              <span className="world-check" aria-hidden="true">
                <Icon name="check" size={26} />
              </span>
            )}
          </button>
          {myWorlds.map((w) => (
            <Tile
              key={w.id}
              name={w.name}
              selected={background?.id === `saved:${w.id}`}
              color="#fb923c"
              badge={w.media === 'video' ? 'video' : undefined}
              onClick={() => void pickSaved(w)}
            >
              <SavedThumb w={w} />
            </Tile>
          ))}
          <input ref={fileRef} type="file" accept="image/*,video/*" hidden onChange={(e) => void onFile(e)} />
        </WorldRow>
      </div>
    </StepShell>
  )
}
