I checked both agents' work and found nothing that needed fixing, so no files were changed. Both reports hold up. Two things are still untested: motion and speed on a real iPad, and the light-wrap blur cost (item 3 below).

**What I checked**

1. **Files and existing code:** every file both reports name is there. Neither agent changed an existing file. Seven existing files (`useStage.ts`, `Compositor.ts`, `store.ts` and others) were edited about 15–25 minutes before the new files were created. None of them mention the new worlds, so those edits are the other workflow's. `vite.config.ts`, `package.json` and `src/types.ts` haven't been touched since about 15:08. There is no `.gitignore` file in `web/`.
2. **Licenses and content:** all four sources check out.
   - Ocean: Commons page confirms CC0, by Blervis.
   - Waterfall: Commons page confirms CC0, by Cbaile19.
   - Fish: Commons page confirms public domain (PD-self), by Albarubescens.
   - Earth: the NASA images API confirms "Earth Views from the International Space Station", NASA HQ, video, with no copyright notice. NASA work is public domain.
   - I looked at the four posters plus frames at 0.2 s and 6 s from each clip. There are no people, faces, brands, logos or text. Contact sheet: `/private/tmp/claude-501/-Users-md-Green-Screen-2/727545c3-c535-41ef-933d-42d65e406914/scratchpad/moving/check/frames/all.jpg`
3. **Encoding:** all four clips are H.264 Main at level 3.1, yuv420p, 1280x720, 30 fps.
   - Lengths are 10, 10, 10 and 8 s, with no audio track.
   - `moov` comes before `mdat`, so faststart is right.
   - Posters are 640x360 baseline JPEGs.
   - One small exception to "no metadata": each file keeps the encoder tag `Lavf61.7.100`. It's harmless.
4. **Types and tests:**
   - `npx tsc --noEmit` passes, using TS 7.0.2 with the project's strict flags. It covered `animatedWorlds.ts`, its test and `e2e/fixtures/animated-preview.ts`. The temporary config is `/private/tmp/claude-501/-Users-md-Green-Screen-2/727545c3-c535-41ef-933d-42d65e406914/scratchpad/moving/check/tsconfig.json`.
   - `npx vitest run src/assets/animatedWorlds.test.ts` passes 7 of 7.
5. **Look and speed:**
   - The posters and the volcano, weather-lightning, space and snow frames match the still-world style, and the lower middle is left open. The volcano dino does fill much of the right side.
   - The code builds the images once per instance, and a frame is only image draws. It never embeds outside content, so the canvas can't be blocked from upload to WebGL.
   - Speed: WebKit (iPad stand-in) is at most 0.37 ms per frame. Its timer only counts in 1 ms steps, so that is a rough figure.
   - Chromium's outliers (75–350 ms) come from software drawing and garbage collection in headless Chromium, not from this code.

**Things for the integrator to watch**
- **Light-wrap blur:** a canvas background marks the light-wrap blur dirty on every frame. A video background probably does the same, but test it on an iPad.
- **Spoken names:** `speak(choice.name)` will say "Under the Sea (moving)" and "Outer Space (moving)". Renaming them is optional.
- **Refreshing data URLs:** the poster for an animated world is a data URL, which is fine because the background choice isn't saved between sessions.
- **Tile highlight:** the upload tile fix in item 5 is required, not optional.

## Integration checklist

**1. `src/types.ts`**
```ts
export type BackgroundKind = 'builtin' | 'image' | 'video' | 'color' | 'animated'
export interface BackgroundChoice {
  // ...existing fields
  /** animated only: id in ANIMATED_WORLDS (src = poster data URL) */
  animatedId?: string
  /** video worlds: still frame for tiles / before first frame */
  poster?: string
}
```
After this, grep for `switch` statements or `kind ===` checks that assume every kind is covered.

**2. New file `src/assets/footage.ts`.** Copy it word for word from the footage report: `FOOTAGE_WORLDS`, `footageChoice` with id `footage:<id>` and kind `'video'`, and `warmFootage`.

**3. `src/lib/useStage.ts`, `loadBackgroundSource`**
```ts
import { getAnimatedWorld } from '../assets/animatedWorlds'
// return type: Promise<{ source: BackgroundSource; dispose: () => void; tick?: (now: number) => void; pause?: (p: boolean) => void }>
case 'animated': {
  const w = getAnimatedWorld(bg.animatedId ?? bg.id)
  if (!w) return none
  const inst = w.create(1280, 720)
  await inst.ready
  return {
    source: inst.canvas,
    dispose: () => inst.destroy(),
    tick: (now: number) => inst.frame(now),
    pause: (p: boolean) => (p ? inst.stop() : inst.start()),
  }
}
```
- In the `case 'video'` branch, optionally add `v.poster = bg.poster ?? ''`.
- In the render loop, call `tick?.(now)` right before `compositor.render()`, next to `beforeRender`.
- Call `setBackground(inst.canvas)` once, not on every frame.
- Call `pause(true)` when the tab is hidden or the stage stops, and `pause(false)` when it resumes.

**4. `Compositor.ts`.** No change is needed for uploads: a canvas is already re-uploaded every frame. If iPad shows slowdown, rebuild the background blur only every 4th–8th frame for `HTMLCanvasElement` backgrounds. The dirty flag is set around line 1997.

**5. `src/screens/steps/WorldStep.tsx`**
```ts
import { ANIMATED_WORLDS } from '../../assets/animatedWorlds'
import { withSvgSize } from '../../assets/svg'   // add to the existing svg import
import { FOOTAGE_WORLDS, footageChoice, warmFootage } from '../../assets/footage'

// REQUIRED (line 63): footage is kind 'video' but is not an upload
const uploaded = background && (background.kind === 'image' || background.kind === 'video') && !background.id.startsWith('footage:') ? background : null

const moving = useMemo(() => ANIMATED_WORLDS.map((w) => ({ ...w, url: svgToDataUrl(withSvgSize(w.posterSvg, 480, 270)) })), [])
```
Add the following after the existing `world-grid`. Then add the "Real places" row exactly as the footage report gives it.
```tsx
<h2 className="world-row-title">Moving worlds</h2>
<div className="world-grid" role="radiogroup" aria-label="Moving worlds">
  {moving.map((w) => {
    const selected = background?.id === `animated:${w.id}`
    return (
      <button key={w.id} type="button" role="radio" aria-checked={selected}
        className={`world-tile${selected ? ' selected' : ''}`} style={{ background: w.thumbColor }}
        onClick={() => pick({ id: `animated:${w.id}`, kind: 'animated', name: w.name, src: w.url, animatedId: w.id })}>
        <span className="world-thumb"><img src={w.url} alt="" draggable={false} /></span>
        <span className="world-name">{w.name}</span>
        {selected && <span className="world-check" aria-hidden="true"><Icon name="check" size={26} /></span>}
      </button>
    )
  })}
</div>
```
The blob-URL cleanup subscriber at line 16 is safe: footage `src` values aren't `blob:` URLs, so they won't be revoked.

**6. `steps.css`**
```css
.world-row-title{font:700 1.4rem 'Baloo 2',sans-serif;margin:18px 4px 8px}
.world-thumb video{width:100%;height:100%;object-fit:cover;display:block}
```

**7. `vite.config.ts`, workbox block**
```ts
globIgnores: ['**/mediapipe/wasm/vision_wasm_nosimd_internal.*', '**/mediapipe/wasm/vision_wasm_module_internal.*', '**/worlds/**'],
runtimeCaching: [
  /* existing mediapipe rule */,
  {
    urlPattern: /\/worlds\/[^/]+\.(?:mp4|jpg)$/,
    handler: 'CacheFirst',
    options: {
      cacheName: 'worlds-footage',
      rangeRequests: true,
      cacheableResponse: { statuses: [200] },
      expiration: { maxEntries: 12, purgeOnQuotaError: true },
    },
  },
],
```
`globPatterns` doesn't match mp4 or jpg today, so the ignore line is a safeguard.

**8. No change needed:** `package.json`, `.gitignore`, `playwright.config.ts` and recording.
- The vitest settings already include `src/**/*.test.ts`.
- The `e2e/fixtures/*` files don't match Playwright's test pattern.
- Footage adds about 9.3 MB to `public/`, fetched only when a child picks a real-place world.
- Any WebKit e2e test must tap before it expects a video to play.

**Files checked:**
- `/Users/md/Green Screen 2/web/src/assets/animatedWorlds.ts`
- `/Users/md/Green Screen 2/web/src/assets/animatedWorlds.test.ts`
- `/Users/md/Green Screen 2/web/e2e/fixtures/animated-preview.html`
- `/Users/md/Green Screen 2/web/e2e/fixtures/animated-preview.ts`
- `/Users/md/Green Screen 2/web/e2e/fixtures/footage-preview.html`
- In `/Users/md/Green Screen 2/web/public/worlds/`: the four clips (`ocean`, `earth`, `waterfall`, `fish`), each as `.mp4` with a `.jpg` poster, plus `LICENSES.md`