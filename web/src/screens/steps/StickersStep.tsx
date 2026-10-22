// Step 3: decorate with picture stickers. Tap a tile to add; move/resize on the stage.
import { useMemo, useState } from 'react'
import { useApp } from '../../state/store'
import { StepShell } from '../../components/StepShell'
import { StageSlot } from '../../components/Stage'
import { Button } from '../../components/Button'
import { STICKERS, STICKER_PACKS, type StickerPack } from '../../assets/stickers'
import { getStickerUrl, svgToDataUrl } from '../../assets/svg'
import { playSound } from '../../lib/sound'
import { speak } from '../../lib/voice'

export default function StickersStep() {
  const stickers = useApp((s) => s.stickers)
  const addSticker = useApp((s) => s.addSticker)
  const clearStickers = useApp((s) => s.clearStickers)
  const nextStep = useApp((s) => s.nextStep)
  const goStep = useApp((s) => s.goStep)
  const [pack, setPack] = useState<StickerPack>(STICKER_PACKS[0]?.id ?? 'fun')

  const tiles = useMemo(() => STICKERS.map((s) => ({ ...s, url: getStickerUrl(s.id) ?? svgToDataUrl(s.svg) })), [])
  const shown = tiles.filter((s) => s.pack === pack)

  return (
    <StepShell
      title="Stickers"
      subtitle="Tap a sticker. Drag it where you like!"
      speak="Stickers! Tap one, then drag it where you like."
      layout="stage"
      back={{ label: 'Back', onClick: () => goStep('me') }}
      next={{ label: 'Next: Snap!', onClick: nextStep }}
      aside={
        <div className="sticker-tray">
          <div className="sticker-tabs" role="tablist" aria-label="Sticker packs">
            {STICKER_PACKS.map((p) => (
              <button
                key={p.id}
                type="button"
                role="tab"
                aria-selected={pack === p.id}
                className={`pill${pack === p.id ? ' active' : ''}`}
                onClick={() => {
                  playSound('tap')
                  setPack(p.id)
                  speak(p.name)
                }}
              >
                {p.name}
              </button>
            ))}
          </div>
          <div className="sticker-grid" role="tabpanel">
            {shown.map((s) => (
              <button
                key={s.id}
                type="button"
                className="sticker-choice"
                aria-label={s.name}
                onClick={() => {
                  playSound('pop')
                  addSticker(s.id)
                }}
              >
                <img src={s.url} alt="" draggable={false} />
              </button>
            ))}
          </div>
          {stickers.length > 0 && (
            <Button
              variant="ghost"
              size="md"
              icon="trash"
              className="sticker-clear"
              onClick={() => {
                clearStickers()
                speak('All gone!')
              }}
            >
              Clear all
            </Button>
          )}
        </div>
      }
    >
      <StageSlot />
    </StepShell>
  )
}
