# Magic Screen — build spec

A kindergarten-friendly green screen studio, modeled on **DoInk Green Screen** and styled after **Talkline** (apphive.us/talkline).
It runs as a PWA on iPad (Safari), phones and desktop browsers from one codebase.
**Magic Screen is 100% on-device:** free, no logins, no paywall, no server. Nothing a child makes ever leaves the device.
Real-time keying is two-tier, both running in the browser (details in `docs/research/realtime/recommendation.md`):

1. **Tier 1, live chroma keyer (always on, every device):** WebGL2, with a Canvas2D + CPU fallback. Used for the live preview and every export.
2. **Tier 2, "Magic Helper" (automatic on capable devices):** the MediaPipe selfie segmenter runs alongside Tier 1 as a garbage/core matte. It never decides the edges.

Research notes are in `docs/research/` (doink.md, talkline.md, critique.md, `realtime/`). CorridorKey was evaluated and dropped; its notes are archived in `docs/research/archive/corridorkey.md`. Talkline's raw source for visual reference: `docs/research/talkline-source/`.

## Kid flow (Talkline-style 5-step stepper)

`Home (gallery)` → **1 World** → **2 Me** → **3 Stickers** → **4 Snap/Film** → **5 Keep**

| Step | What happens |
|---|---|
| 1 World | Picture grid of 12 built-in illustrated backgrounds, plus "My picture/video" upload. Images last the whole recording, which avoids DoInk's 5-second image trap. Videos loop. |
| 2 Me | The camera starts and the live key is applied automatically. The key color is sampled from the frame border. Big flip-camera button. A "Magic finger: tap the green" option re-picks the key color. Drag to move me, pinch or +/- to resize. |
| 3 Stickers | Picture-only sticker tray. Tap to add. Drag to move, pinch or corner handle to resize and rotate, corner ✕ to delete. |
| 4 Snap/Film | A Photo / Video toggle, shown as two big picture cards. Then a 160px hero button, a spoken 3-2-1 countdown, a giant stop button, and the hard limit from settings. |
| 5 Keep | Playback, confetti, **Save** (Web Share with files, falling back to a download), saved to the gallery automatically, **Make another**. |

**Home:** big "Let's make!" card plus a grid of saved creations. Holding the gear for 2 seconds opens the grown-up check: a fresh multiplication question (3–9 × 3–9) each time, so there is no code to remember, change or forget.

**Teacher settings:**
- key color, similarity, smoothness and spill sliders, with a live preview
- green screen vs AI cutout (MediaPipe segmentation)
- resolution, max video seconds, countdown
- voice and sounds toggles, mirror
- Magic Helper: Auto / On / Off (teacher-only; kids never see it)
- delete creations
- "How to set up your green screen" tips, based on the DoInk reference sheets: even lighting, no green clothes, keep the subject away from the screen

## Visual rules

These come from Talkline; see `web/src/styles/tokens.css` and `docs/research/talkline.md`.

- Use the token CSS variables only.
  - Body text is `--grape-700`, never black.
  - Blue = go forward, mint = done/play, orange = camera/record, pink = recording/delete, sun = logo/warmth.
  - Green (`--screen-green`) marks the "Me" layer.
- Chunky 3D pill buttons: a hard bottom shadow with no blur, and `:active` presses down 2px. Use `999px` radius.
- Frosted-glass main panel `rgba(255,255,255,.58)`, radius 2rem. Three blurred background blobs (sun, sky, pink).
- Fonts: Baloo 2 (800/900) for display, Quicksand (500–700) for body. Self-hosted via @fontsource and imported in main.tsx.
- Step transitions use the `pop-in` keyframe (280ms, `--ease-pop`). Respect reduced motion.
- Kid targets are at least 64px; primary actions 80–160px. Every screen has at most one primary action.
- Text is 1–3 word headings plus one short friendly line, and each step's prompt is spoken. A 🔊 button repeats it.
- Icons are inline SVG on a 24-grid with a round 2.4 stroke and `currentColor`. Stickers and backgrounds are hand-built flat SVG with thick same-hue outlines. No emoji fonts in core UI; emoji may be used inside SVG text for stickers if rendered as images.
- Layout:
  - **Phones (<640px):** sticky bottom nav bar with safe-area padding.
  - **≥640px:** nav inside the panel.
  - **iPad landscape (≥1024px wide):** in the Me, Stickers and Action steps, the stage on the left (about 65%) and tools on the right.
  - The stage is always 16:9 with `outline: 4px solid #fff`, radius 1.5rem.

## Module map and contracts

Shared types live in `web/src/types.ts` and state in `web/src/state/store.ts` (zustand `useApp`). **Do not change these without updating all users.**

### `web/src/lib/keyer/` (Compositor)
```ts
// Compositor.ts
export class Compositor {
  constructor(canvas: HTMLCanvasElement, opts?: { width?: number; height?: number }) // WebGL2, preserveDrawingBuffer:true; falls back to Canvas2D+CPU key if no WebGL2
  readonly width: number; readonly height: number
  resize(width: number, height: number): void
  setBackground(src: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement | ImageBitmap | string /*css color*/ | null): void
  setForeground(src: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement | null, opts?: { mirror?: boolean }): void
  setKey(k: KeySettings): void
  setMask(src: HTMLCanvasElement | ImageBitmap | null): void // used when mode === 'segment' (R channel = person)
  setMe(t: MeTransform): void
  setStickers(list: { image: HTMLImageElement | ImageBitmap; x: number; y: number; scale: number; rotation: number }[]): void
  render(): void // draw one frame: bg (cover-fit) → keyed fg (contain-fit, transformed) → stickers
  sampleBorderColor(): RGB | null // auto key: robust median of fg border pixels that look "screen-like" (high saturation)
  sampleColorAt(nx: number, ny: number): RGB | null // magic finger: normalized stage coords → fg pixel (accounts for me transform and mirror)
  renderMatte(): Promise<Blob> // PNG of current fg alpha at fg native res (white = me), unmirrored — debugging / export
  destroy(): void
}
// autoKey.ts — pure functions, unit tested (vitest)
export function rgbToYCbCr(c: RGB): [number, number, number]
export function pickKeyColor(samples: RGB[]): RGB | null // reject low-saturation samples; median of green/blue-ish cluster
export function keyAlpha(px: RGB, key: RGB, similarity: number, smoothness: number): number // CPU mirror of the shader, used by tests + 2D fallback
export function despill(px: RGB, key: RGB, strength: number): RGB
// shaders.ts — GLSL sources
```
Modes `packed` (top half RGB, bottom half alpha), `alpha` (source alpha) and `none` must also work.

#### Tier 1: on-device chroma keyer
Target pipeline (see `docs/research/realtime/recommendation.md` for constants and GLSL):
1. **Lab-LUT key.** A shadow-tolerant, one-directional CIELAB distance to the key colour ("keyD") is baked on the CPU into a 3D LUT texture (48³, or 64³ if fast enough) once per key colour, with a dark-pixel guard so hair and pupils are never removed. The shader does one LUT fetch and a smoothstep from `lo` to `hi`; sliders map to `lo = 4 + 16·similarity`, `hi = lo + 6 + 12·smoothness` and never need a re-bake. The same JS function drives `autoKey.ts`, its tests and the LUT.
2. **Temporal smoothing.** The matte pass blends with the previous frame (EMA ≈ 0.5) only where luma barely changed, which removes flicker without ghosting. History resets on camera switch, resize, visibility change and context restore.
3. **Guided filter** (half res, radius 4, eps 6e-4, guide = camera luma) for image-aligned edges, falling back to a 3x3 tent when float colour buffers are missing. Then a choke (`pow(a, 1.3)`) and a noise snap.
4. **Alpha-aware despill.** The limit is the max of the other two channels inside the subject (keeps yellows yellow) and their average at semi-transparent edges; removed spill luma is added back as neutral grey. Disabled where the Magic Helper's core fill rescued a screen-coloured shirt.
5. **Light wrap.** A small blend of a blurred background at inner edges.
6. **Adaptive auto-key.** The key colour is picked from the frame border (linear-RGB average → Lab), thresholds come from the samples' keyD spread, and every ~2 s an async low-res readback of clearly-background pixels nudges the key (EMA in Lab, re-bake only when ΔE00 > 2) to follow iPad auto white balance. Poor screens trigger a friendly "add light" hint rather than a looser key. "Magic finger" re-picks the colour from a tap.

#### Tier 2: Magic Helper (MediaPipe selfie segmenter)
- The 256x256 float16 selfie segmenter (Apache-2.0, ~250 KB, self-hosted in `public/mediapipe/`) produces a confidence mask, uploaded as an R8 texture into the Compositor's context.
- **Garbage matte:** the mask is dilated (~5% of frame width) with slow decay, and kills anything that is clearly not a child (walls, a teacher, the edge of the screen).
- **Core matte:** the mask is eroded with slow growth, and fills areas that are clearly a child (e.g. a green shirt). Edges always come from the chroma key. Its weight fades in over 300 ms after warm-up.
- In `segment` mode (no green screen) the mask is the matte itself, refined by the same guided filter.
- **Device-tier cadence (`deviceTier.ts`):** no WebGL2 → Canvas2D CPU key, no ML. Otherwise lazy-load the segmenter after the camera starts, warm up, time 20 frames, and run it every frame (≤ 25 ms), every 2nd (≤ 50 ms), every 3rd (≤ 90 ms) or not at all. CPU delegate only if ≤ 50 ms. Thermal backoff steps the cadence down when frame times stay high for 3 s and retries after 30 s. Pause on `visibilitychange`.

### `web/src/lib/segmenter.ts`
`export async function createSegmenter(): Promise<{ segment(video: HTMLVideoElement, ts: number): HTMLCanvasElement | null; close(): void }>` uses @mediapipe/tasks-vision ImageSegmenter, selfie_segmenter model. Load the wasm and model from `/mediapipe/` in `public/`, copying them there with a postinstall script so the app works offline. It is lazy-loaded: as the matte in `segment` mode, and as the Tier 2 Magic Helper in `chroma` mode on capable devices.

### `web/src/lib/camera.ts`
`startCamera({facing, resolution}): Promise<{ video: HTMLVideoElement; stream: MediaStream; stop(): void }>` uses `playsInline` and `muted`, and handles NotAllowedError/NotFoundError by throwing `CameraError` with a `kind: 'denied'|'missing'|'insecure'|'other'`. Also `getMic(): Promise<MediaStream|null>`.

### `web/src/lib/recorder.ts`
- `pickVideoMime(): string`: mp4 on Safari, webm vp9/vp8 elsewhere.
- `startRecording({ canvas, audio }): RecordingHandle`, where `audio` is `MediaStream | null`. `RecordingHandle = { stop(): Promise<{ composite: Blob; mime: string; durationSec: number }>; elapsed(): number }`. Uses `canvas.captureStream(30)`; the Stage must keep rendering every frame while recording (Safari only emits frames on redraw).
- `capturePhoto(canvas): Promise<Blob>` (PNG of the composite).
- `makeThumb(blob|canvas): Promise<string>`: a 320px JPEG data URL.
- `saveToDevice(blob, filename): Promise<'shared'|'downloaded'|'cancelled'>`: tries `navigator.canShare({files})`, then falls back to an `<a download>`.

### `web/src/lib/storage.ts` (idb)
DB `magicscreen` v1, with stores `creations` (keyPath id) and `media` (key id → Blob). Exports:
- `saveCreation(c: Creation, blob: Blob)`
- `listCreations(): Promise<Creation[]>` (newest first)
- `getCreationBlob(id)`
- `deleteCreation(id)`
- `saveUpload(blob): Promise<string>` / `getUpload(id)` (user backgrounds)

### `web/src/lib/sound.ts` / `voice.ts`
- `sound.ts` exports `playSound('tap'|'pop'|'success'|'countdown'|'shutter'|'start'|'stop'|'magic')`. Sounds are synthesized with WebAudio, so there are no asset files. It respects `settings.sounds`, and `unlock()` must be called on the first gesture.
- `voice.ts` exports `speak(text)` (SpeechSynthesis, picks a friendly en voice, rate 0.95, pitch 1.1, cancels previous speech) and respects `settings.voice`.

### `web/src/assets/backgrounds.ts` / `stickers.ts`
- `BUILTIN_BACKGROUNDS: { id; name; svg: string /*1920x1080 viewBox*/; thumbColor }[]`: Outer Space, Under the Sea, Jungle, Dinosaur Land, Big City, Weather Map, Castle, Farm, The Moon, Rainbow Land, Snowy Mountains, News Desk.
- `STICKERS: { id; name; svg: string /*100x100*/; pack: 'fun'|'faces'|'animals'|'weather' }[]`, about 32 stickers.
- Helpers `svgToDataUrl(svg)` and `loadImage(url): Promise<HTMLImageElement>`.

### UI (`web/src/components`, `web/src/screens`)
- **Components:** `Button`, `IconButton`, `Icon`, `Stepper`, `Panel`, `Blobs`, `Logo`, `StepShell` (title + subtitle + 🔊 + body + nav row), `ParentGate`, `Confetti`, `Toast`.
- **Stage:** `Stage.tsx` owns the canvas and Compositor and runs the rAF loop. It is mounted once for the Me, Stickers and Action steps so the camera never restarts. It overlays DOM sticker handles and me-drag gestures, and exposes a `stageApi` ref (compositor, camera video, stream) for the Action step.
- **Screens:** `screens/Home.tsx`, `screens/Make.tsx` (the stepper and steps), `screens/steps/{World,Me,Stickers,Action,Keep}Step.tsx`, `screens/Teacher.tsx`, `screens/View.tsx`.

## Privacy
Everything runs in the browser. There is no server, no account and no analytics. Creations and uploaded backgrounds live only in the device's IndexedDB; "Save" hands a file to the system share sheet or a download. Home footer: "Everything you make stays on this device."

## Licensing and credits
- CorridorKey has been removed, so the Corridor Key Licence constraints (credit line, share-alike, no bundled weights) no longer apply.
- **MediaPipe** (`@mediapipe/tasks-vision` and the selfie segmenter model) is Apache-2.0. Keep its license and attribution: Teacher → About shows "The Magic Helper person cutout uses Google MediaPipe (Apache License 2.0)", and the Apache-2.0 license text/NOTICE must ship with the app (e.g. alongside `public/mediapipe/`).
- RVM (GPL-3.0) and other non-permissive models must not be added.
- Project license: CC BY-NC-SA 4.0 is the current field value, left as-is; the license is to be chosen by the owner.
