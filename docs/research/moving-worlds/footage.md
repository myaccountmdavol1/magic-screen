I added four looping real-footage worlds in `/Users/md/Green Screen 2/web/public/worlds/`. All four play and loop in WebKit and Chromium, and all are public domain or CC0. I didn't modify any existing file, so the app changes are written below as snippets to paste in.

**Clips** (each is 1280x720, H.264 Main 3.1, yuv420p, 30 fps, faststart, with no audio track and no metadata)

| id | Name | MP4 | Poster (640x360) | Length | Source and license |
|---|---|---|---|---|---|
| ocean | Ocean Waves | 2,336,820 B | 33,545 B | 10.00 s | Commons "Santa Rosa Island Waves" by Blervis, Channel Islands NP. CC0 |
| earth | Planet Earth | 2,360,056 B | 19,851 B | 10.00 s | NASA "Earth Views from the International Space Station" (ISS HDEV camera), images.nasa.gov. Public domain |
| waterfall | Waterfall | 2,401,878 B | 19,925 B | 10.00 s | Commons "Rapids and Falls of the Youghiogheny at Ohiopyle" by Cbaile19. CC0 |
| fish | Fish in the Sea | 2,164,368 B | 23,151 B | 8.00 s | Commons "Swimming in the sea, oblade fishes…" by Albarubescens. Public domain (released by the author) |

- **What's in frame:** the parts I used have no people, faces, brands or text. The NASA source's narration, its NASA logo ending and the waterfall's title cards were all left out.
- **Licenses file:** source URLs, authors, licenses, the time range used from each source and the 2026-10-22 retrieval date are in `/Users/md/Green Screen 2/web/public/worlds/LICENSES.md`. It also lists the clips I turned down and why. One example: a set of "public domain" Virgin Islands palm-beach clips came from material tied to Jeffrey Epstein's island, which rules them out for a kids' app.
- **Loop seam:** I measured how much the last frame differs from the first. The difference is the same as between any two neighbouring frames in the clip (ocean 33.6 vs 37.0 dB, earth 38.1 vs 42.8, waterfall 26.1 vs 25.7, fish 19.8 vs 19.8), so the jump back to the start shouldn't be visible.

**Browser check**
I built a test page at `/Users/md/Green Screen 2/web/e2e/fixtures/footage-preview.html` and ran it with Vite on port 5402, which I stopped afterwards. The dev server on 5190 was left running. In both WebKit and Chromium:
- every clip reported 1280x720 at the expected length, with no errors;
- each `<video muted loop playsinline>` played and went round at least twice, and the posters load at 640x360;
- neither browser found any audio;
- Vite answers range requests with 206.

I took screenshots at about 2.5 s, 6 s and 22 s and looked at them, and they were fine.

One catch in WebKit: headless Playwright WebKit refused to autoplay the muted video on page load (NotAllowedError). After one tap, `play()` worked and the videos looped. Real iPad Safari allows muted inline autoplay, picking a world is a tap anyway, and `useStage.ts` already catches a failed `play()`. Any e2e test that runs on WebKit should tap first.

The editing scripts are in `/private/tmp/claude-501/-Users-md-Green-Screen-2/727545c3-c535-41ef-933d-42d65e406914/scratchpad/moving/footage/scripts/` (`make_loop.sh` builds a clip, `verify.mjs` runs the browser check).

**Changes for the integrator**

1. `src/types.ts`: add an optional poster to `BackgroundChoice`.
```ts
  /** video worlds: still frame for tiles / before first frame */
  poster?: string
```

2. New file `src/assets/footage.ts`:
```ts
// Real-place video worlds (public-domain / CC0 footage, see public/worlds/LICENSES.md).
import type { BackgroundChoice } from '../types'

export interface FootageWorld { id: string; name: string; src: string; poster: string; thumbColor: string }

const base = import.meta.env.BASE_URL // '/' by default
const w = (id: string, name: string, thumbColor: string): FootageWorld => ({
  id, name, thumbColor, src: `${base}worlds/${id}.mp4`, poster: `${base}worlds/${id}.jpg`,
})

export const FOOTAGE_WORLDS: FootageWorld[] = [
  w('ocean', 'Ocean Waves', '#2563eb'),
  w('earth', 'Planet Earth', '#0b1026'),
  w('waterfall', 'Waterfall', '#64748b'),
  w('fish', 'Fish in the Sea', '#0ea5e9'),
]

export const footageChoice = (f: FootageWorld): BackgroundChoice => ({
  id: `footage:${f.id}`, kind: 'video', name: f.name, src: f.src, poster: f.poster,
})

/** Fetch the whole file once (no Range header) so the service worker's CacheFirst rule stores a 200 for offline use. */
export function warmFootage(f: FootageWorld) {
  fetch(f.src).catch(() => {})
}
```
`loadBackgroundSource` in `useStage.ts` already handles `kind: 'video'` with a same-origin `src`, so the stage needs no change. Adding `v.poster = bg.poster ?? ''` there is optional.

3. `WorldStep.tsx`, the "Real places" row.
   - Imports: `import { FOOTAGE_WORLDS, footageChoice, warmFootage } from '../../assets/footage'`
   - **Must fix:** the existing upload tile treats any `kind: 'video'` as an upload, so it would wrongly light up when a footage world is picked. Change it to:
```ts
const uploaded = background && (background.kind === 'image' || background.kind === 'video') && !background.id.startsWith('footage:') ? background : null
```
   - Then add this after the current `world-grid` div:
```tsx
<h2 className="world-row-title">Real places</h2>
<div className="world-grid" role="radiogroup" aria-label="Real places">
  {FOOTAGE_WORLDS.map((f) => {
    const selected = background?.id === `footage:${f.id}`
    return (
      <button
        key={f.id}
        type="button"
        role="radio"
        aria-checked={selected}
        className={`world-tile${selected ? ' selected' : ''}`}
        style={{ background: f.thumbColor }}
        onClick={() => { pick(footageChoice(f)); warmFootage(f) }}
      >
        <span className="world-thumb">
          {selected
            ? <video src={f.src} poster={f.poster} muted loop autoPlay playsInline />
            : <img src={f.poster} alt="" draggable={false} />}
        </span>
        <span className="world-name">{f.name}</span>
        {selected && (
          <span className="world-check" aria-hidden="true"><Icon name="check" size={26} /></span>
        )}
      </button>
    )
  })}
</div>
```
   - Suggested CSS for `steps.css`: `.world-row-title{font:700 1.4rem 'Baloo 2',sans-serif;margin:18px 4px 8px}` and `.world-thumb video{width:100%;height:100%;object-fit:cover;display:block}`.

4. `vite.config.ts` workbox block.
   - Keep the clips out of precache by adding to `globIgnores`:
```ts
globIgnores: ['**/mediapipe/wasm/vision_wasm_nosimd_internal.*', '**/mediapipe/wasm/vision_wasm_module_internal.*', '**/worlds/**'],
```
   - Add a second `runtimeCaching` rule. `rangeRequests: true` makes workbox-build add the `RangeRequestsPlugin`; generateSW mode can't take imported plugins directly.
```ts
{
  urlPattern: /\/worlds\/[^/]+\.(?:mp4|jpg)$/,
  handler: 'CacheFirst',
  options: {
    cacheName: 'worlds-footage',
    rangeRequests: true,
    cacheableResponse: { statuses: [200] }, // never store a 206 partial
    expiration: { maxEntries: 12, purgeOnQuotaError: true },
  },
},
```
   - Safari only ever asks for video in byte ranges, which come back as partial (206) responses that this rule won't cache. That's why the tile calls `warmFootage()`: one full fetch puts the whole file in the cache, and after that the plugin answers Safari's range requests from it.

5. Nothing else needs changing: `package.json`, `.gitignore` and `playwright.config.ts` stay as they are. The `.html` fixture isn't picked up as a test, and the `.md` and `.mp4` files aren't matched by the precache glob. The new files add about 9.3 MB to `public/`, and that is fetched only when a child picks a real-place world.

Files are in `/Users/md/Green Screen 2/web/public/worlds/`:
- ocean.mp4
- ocean.jpg
- earth.mp4
- earth.jpg
- waterfall.mp4
- waterfall.jpg
- fish.mp4
- fish.jpg
- LICENSES.md