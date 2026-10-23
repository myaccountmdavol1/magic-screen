I built six animated worlds that are drawn live on a canvas, so there are no video files. The new unit tests pass (7 of 7), and the new files have no type errors. I checked the screenshots by eye and the worlds look charming, but the motion itself has only been checked by stepping the clock, not by eye. Speed was measured in desktop Chromium and WebKit, not on an iPad. I did not modify any existing file.

## The six worlds
| id | name | what moves |
|---|---|---|
| `sea-moving` | Under the Sea (moving) | 5 fish swimming across with a bob and tail wag, seaweed swaying, bubbles rising from a treasure chest and the sides, a jellyfish bobbing, a crab walking on the sand |
| `space-moving` | Outer Space (moving) | stars twinkling, ringed planet drifting and tilting, rocket flying an arc over the child's head with a flickering flame, UFO bobbing with a pulsing beam, astronaut floating, a comet streaking past now and then |
| `snow-moving` | Snow Day | 3 layers of falling snow (the near flakes spin), clouds drifting, smoke puffing from a log-cabin chimney; mountains, pines and snowman stay still |
| `weather-moving` | Rainy Weather Map | sun rays turning, 3 clouds drifting, rain falling from the 2 grey clouds, a lightning bolt with a soft flash every 12 s |
| `volcano-moving` | Volcano | smoke puffs rising, lava glow pulsing, lava blobs popping, pterodactyl flapping across, long-neck dino breathing and swaying, an egg wobbling in its nest |
| `rainbow-moving` | Rainbow Sky | clouds drifting, stars wobbling, sparkles twinkling, hearts floating up, hot-air balloon bobbing, 2 butterflies fluttering |

The lower-middle of every scene is left open for the child. The art copies the still worlds' style (shared helpers copied in), but nothing is imported from `backgrounds.ts`, so the other workflow's edits there can't break these worlds.

## API (`web/src/assets/animatedWorlds.ts`)
- `AnimatedWorld { id, name, thumbColor, posterSvg, create(width, height, options?) }`
- `AnimatedWorldInstance { canvas, start(), stop(), frame(nowMs), destroy() }`
- I added a few things beyond the spec:
  - instance extras: `ready: Promise<void>`, `seek(seconds)`, `running`.
  - `create` takes an optional third argument, `{ reducedMotion?: boolean }`, which overrides the device setting.
  - exports: `ANIMATED_WORLDS`, `getAnimatedWorld(id)`, `LOOP_SECONDS = 60`, `REDUCED_SPEED = 0.4`.
- **Instances start running.** `start()` and `stop()` can be called repeatedly. After `stop()`, `frame()` still redraws the frozen picture.
- **Drawing:** the still scenery is turned into an image once per instance, and each moving piece is turned into its own small image once. A frame is then one full-size image draw plus a few dozen small ones, with no SVG work and no new memory per frame.
- **Before the images are ready** (they load asynchronously), a frame shows a flat fill in `thumbColor`.
- **Looping and pausing:** the loop is 60 s and every motion repeats a whole number of times in it, so it loops cleanly and the same time always gives the same picture. Gaps between frames are capped at 100 ms, so a hidden tab or a stop/start never makes things jump.
- **Reduced motion:** follows the device setting and updates if it changes. Everything moves at 0.4× speed, twinkles are softer, and there is no lightning or lava popping.
- `posterSvg` is a 1920×1080 SVG of the world at a chosen moment, built on first use. It works with the existing `svgToDataUrl` and `withSvgSize`.

## Speed (time per frame)
| browser | 1280×720 | 1920×1080 |
|---|---|---|
| WebKit | 0.12–0.37 ms | 0.23–0.38 ms |
| Chromium (headless, software rendering) | 0.9–3.9 ms (median 0.1–0.2 ms) | 1.7–4.3 ms |

These include forcing the drawing to finish. The Chromium numbers are slower because headless Chromium draws without the graphics chip; WebKit is the closer stand-in for iPad Safari. That should be comfortably under the 2 ms target on an iPad, but it is a desktop measurement, not an iPad one. In both browsers, stop() really froze the picture and start() resumed it without a jump.

## Files
**New in the project:**
- `/Users/md/Green Screen 2/web/src/assets/animatedWorlds.ts`
- `/Users/md/Green Screen 2/web/src/assets/animatedWorlds.test.ts` — covers create/destroy, a fake drawing context, behaviour without canvas support, same time gives the same picture, pause safety, the 100 ms gap cap, and reduced motion removing the flash.
- `/Users/md/Green Screen 2/web/e2e/fixtures/animated-preview.html` and `/Users/md/Green Screen 2/web/e2e/fixtures/animated-preview.ts` — test-only preview page: grid, `?posters=1`, `?world=<id>&rm=1`. It isn't picked up by Playwright or `tsc`.

**In the scratchpad:**
- The capture script runs Vite on port 5401 and also benchmarks: `/private/tmp/claude-501/-Users-md-Green-Screen-2/727545c3-c535-41ef-933d-42d65e406914/scratchpad/moving/animated/capture.mjs`
- Results: `/private/tmp/claude-501/-Users-md-Green-Screen-2/727545c3-c535-41ef-933d-42d65e406914/scratchpad/moving/animated/bench.json`
- Screenshots are in `/private/tmp/claude-501/-Users-md-Green-Screen-2/727545c3-c535-41ef-933d-42d65e406914/scratchpad/moving/animated/shots/`. There is one per world at t = 3 s and t = 11 s, a reduced-motion version of each, and a few extras:
  - Lightning frame: `/private/tmp/claude-501/-Users-md-Green-Screen-2/727545c3-c535-41ef-933d-42d65e406914/scratchpad/moving/animated/shots/weather-moving-t9.65.png`
  - All six posters: `/private/tmp/claude-501/-Users-md-Green-Screen-2/727545c3-c535-41ef-933d-42d65e406914/scratchpad/moving/animated/shots/posters.png`
  - Example world shot: `/private/tmp/claude-501/-Users-md-Green-Screen-2/727545c3-c535-41ef-933d-42d65e406914/scratchpad/moving/animated/shots/sea-moving-t3.png`

## Changes the integrator needs to make
1. **`src/types.ts`:** change `BackgroundKind` to `'builtin' | 'image' | 'video' | 'color' | 'animated'`. Add `animatedId?: string` to `BackgroundChoice`. For this kind, `src` is the poster data URL.
2. **`src/lib/useStage.ts`, `loadBackgroundSource`:** add a case:
   ```ts
   case 'animated': {
     const inst = getAnimatedWorld(bg.animatedId ?? bg.id)!.create(1280, 720)
     await inst.ready
     return { source: inst.canvas, dispose: () => inst.destroy(), tick: (now: number) => inst.frame(now) }
   }
   ```
   - Add an optional `tick?: (now: number) => void` to the return type.
   - The Stage's animation loop calls `tick(now)` right before `compositor.render()`, next to `beforeRender`.
   - Call `inst.stop()` when the stage is hidden or paused, and `inst.start()` when it comes back.
3. **`Compositor.ts`:** no change is needed for uploads. It already re-uploads a canvas background every frame (`TrackedSource.needsUpload()` returns true for canvases).
   - Call `setBackground(inst.canvas)` once, not every frame.
   - One cost to know about: a fresh upload marks the background blur dirty (around line 1997), so the light-wrap blur is rebuilt every frame for animated worlds. If that's too slow on iPad, rebuild it only every 4th–8th frame for canvas backgrounds.
4. **`WorldStep.tsx`:** add a "Moving worlds" row.
   - Tiles: `svgToDataUrl(withSvgSize(w.posterSvg, 480, 270))`.
   - On pick: `{ id: 'animated:' + w.id, kind: 'animated', name: w.name, src: posterUrl, animatedId: w.id }`.
   - Optionally a small "moving" badge on the tiles.
5. **Recording:** nothing to do. The canvas is part of the composite, so recordings include the motion.
6. **PWA, `package.json`, `vite.config.ts`, `.gitignore`:** nothing to change. The art is code, nothing is fetched, and the vitest settings already include `src/**/*.test.ts`.