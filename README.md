# Magic Screen

A green screen studio for kindergarteners. It runs in the browser, works best on iPad Safari, and also works on phones and desktops. A child picks a world (outer space, under the sea, dinosaur land...), stands in front of a green screen, adds stickers, then takes a photo or films a short video. Everything they make stays on the device.

It's free: no accounts, no paywall, no server.

## Features

- **Five big steps:** World → Me → Stickers → Snap → Keep, with a picture stepper and spoken prompts for children who can't read yet.
- **Worlds, in rows on the World step:**
  - **Class worlds** (only when a grown-up has added some): pictures or videos added in Teacher settings → Class worlds. They show first, so the lesson's world is the first thing kids see.
  - **Pictures:** 12 built-in illustrated worlds.
  - **Moving worlds:** 6 cartoon worlds animated live on a canvas (Sea Friends, Rocket Trip, Snow Day, Rainy Day, Volcano, Balloon Ride). There are no video files, and recordings include the motion.
  - **Real places:** 4 looping public-domain/CC0 video clips (Ocean Waves, Planet Earth, Waterfall, Swimming Fish) in `web/public/worlds/`. They aren't precached. The service worker caches each clip after its first play, so it works offline from then on.
  - **My worlds:** a child's own picture or video, saved on the device (the newest 12 are kept). Videos over 100 MB or 2 minutes are turned away with a grown-up hint. Only a grown-up can remove them, in Teacher settings → Kids' worlds.
- **Live keying** at camera frame rate. "Auto fix" picks the screen colour, and "Tap the green" (the Magic finger) lets you point at the screen to choose it.
- **Move and resize yourself:** drag to move, Bigger / Smaller buttons, and Center me.
- **34 stickers** in four packs (Fun, Faces, Animals, Weather). Drag, resize, rotate and delete them.
- **Photo or video** (up to 1 minute, with sound if a mic is available), plus confetti, a gallery on the device, and Save to Photos/Files.
- **AI cutout mode** for rooms with no green screen. A person-segmentation model cuts the child out.
- **Teacher settings** behind a press-and-hold parent gate: the green screen (cut-out mode, Magic Helper, sliders), camera, recording length and countdown, voice and sounds, and deleting creations.
- **Installable PWA** that works offline after the first load.

## How the real-time keyer works

All keying runs on the device, in two tiers. Details are in `docs/research/realtime/recommendation.md` and `SPEC.md`.

**Tier 1: the colour keyer.** This runs on every device in WebGL2, with a Canvas2D fallback.
- Each camera pixel's distance from the screen colour is looked up in a precomputed Lab-colour lookup table. A dark guard protects hair and pupils.
- Temporal smoothing reduces flicker without leaving ghosts on moving kids.
- An edge-aware guided filter and a small choke give clean, sharp edges.
- Alpha-aware despill removes green fringing, and a light wrap blends the child into the world.
- Adaptive auto-key watches the screen and only ever tightens the thresholds. It shows a hint if the screen is lit unevenly or a shirt matches the screen colour.

**Tier 2: the Magic Helper.** This is Google MediaPipe's selfie segmenter running locally in WebAssembly, on the GPU where available.
- It produces a coarse person mask. The mask removes things that clearly aren't the child (garbage matte), and can optionally fill back a green shirt (core matte).
- `src/lib/deviceTier.ts` picks how often it runs, based on how fast the device is.
- Teachers can set it to Auto, On or Off.

## Quick start

```bash
cd web
npm install      # also copies the MediaPipe runtime + model into public/mediapipe/
npm run dev      # http://localhost:5173 (also served on your LAN)
```

Other scripts: `npm test` (Vitest), `npm run typecheck`, `npm run build` (output in `web/dist/`), `npm run preview`.

`npm install` downloads `selfie_segmenter.tflite` and `selfie_segmenter_landscape.tflite` (about 250 KB each) from Google's model storage once, at install time. Set `MAGIC_SKIP_MODEL_DOWNLOAD=1` to skip it. Without the model, AI cutout and the Magic Helper turn off, and the colour keyer still works.

## Using it on an iPad

Safari only allows camera access on **HTTPS** pages (or `localhost`), so you need to serve the app over HTTPS. You can do this in either of two ways:

- **Deploy it for free:** build with `npm run build` and publish `web/dist/` to Netlify, Vercel, GitHub Pages or Cloudflare Pages. It's a fully static site.
- **Serve it on your own network:** create a trusted local certificate with [mkcert](https://github.com/FiloSottile/mkcert) and install the mkcert root CA on the iPad. Then serve over HTTPS, either by pointing Vite's `server.https` / `preview.https` option (`{ key, cert }`) at the mkcert files, or by putting any static HTTPS server with that cert in front of `dist/`.

Then on the iPad:
1. Open the site in Safari and tap **Share → Add to Home Screen**. It opens full-screen like an app and works offline.
2. When asked, allow **Camera** (and Microphone for videos with sound). If you said no by mistake, go to Settings → Safari → Camera, or Settings → Magic Screen.
3. For the best results, light the green screen evenly and avoid green clothes. The Magic Helper can rescue a green shirt.

## Privacy

- Nothing leaves the device. Camera frames, photos and videos are processed and stored locally, in the browser's IndexedDB.
- There are no accounts, no analytics, no ads and no third-party requests at runtime. Fonts, the ML model and the WebAssembly runtime are all bundled with the app.
- Teachers can delete all creations from the teacher settings. Clearing the browser's site data deletes them too.

## Project layout

- `web/`: the app (Vite + React + TypeScript + zustand).
  - `src/lib/keyer/`: the compositor, shaders and keying maths.
  - `src/lib/segmenter.ts`: the Magic Helper.
  - `src/screens/`, `src/components/`: the UI.
  - `src/assets/`: the SVG worlds and stickers.
- `web/e2e/fixtures/make_fake_camera.py`: regenerates `fake-greenscreen.y4m`, a synthetic green-screen clip for Chromium's fake camera (`--use-file-for-fake-video-capture`).
- `SPEC.md`: module contracts. `docs/research/`: background research.

## Credits

- Inspired by [DoInk Green Screen](https://www.doink.com/). This project is not affiliated with or endorsed by DoInk.
- Visual design follows Talkline.
- Uses [Google MediaPipe](https://github.com/google-ai-edge/mediapipe) (Apache License 2.0) for the Magic Helper and AI cutout. Its license ships with the app (`web/THIRD_PARTY_LICENSES.md`, `public/mediapipe/LICENSE.md`) and is shown under Teacher → About → Open-source licenses.
- Real places footage: public domain (NASA, Wikimedia Commons) and CC0 (Wikimedia Commons). Sources, authors and licenses are in `web/public/worlds/LICENSES.md`, linked from Teacher → About.
- Fonts: Baloo 2 and Quicksand (SIL Open Font License), self-hosted through Fontsource.

The project license has not been chosen by the owner yet.
