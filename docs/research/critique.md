# Review: research reports for the kindergarten green-screen app

The CorridorKey report holds up on every point I checked. Its main conclusion is right: CorridorKey 2.0 cannot do the live keying, so it can only be an optional server step that cleans up a clip after it is recorded. The two concrete corrections are an overstated single-photo claim and a too-broad "Tier A runs at 60 fps on iPad" claim.

## 1. What I checked myself

**CorridorKey 2.0 repo**

I used the GitHub and Hugging Face APIs and searched the existing clone at `/private/tmp/claude-501/-Users-md-Green-Screen-2/727545c3-c535-41ef-933d-42d65e406914/scratchpad/ck/repo` (HEAD 485f5e9, 2026-10-15).

- **It exists.** `nikopueringer/CorridorKey2.0` is real and active: branch `master`, last push 2026-10-15, 634 stars, not archived. GitHub reports its license as "NOASSERTION" because the license is a custom one.
- **CUDA is required.** `infer.py:121` says `raise RuntimeError("CorridorKey v2 runtime requires a CUDA GPU.")`. `corridorkey/runtime.py` hardcodes `torch.autocast("cuda", dtype=torch.bfloat16)` at lines 337, 386, 515, 531 and 886.
- **GPU minimum.** README line 21 says: "NVIDIA GPU (currently RTX 30-series or newer) with at least 4 GB of VRAM".
- **The hint is optional.** README line 95 says it can run "with no hints, a single first-frame hint, or a full hint" video. The flags `--hint_first_frame`, `--hint_quality` (default 0.95), `--low_vram` and `--model_scale` all exist in `infer.py`.
- **Weights.** The Hugging Face repo `nikopueringer/CorridorKey2.0` holds `corridorkey_v2.safetensors` and `foundation_stats.safetensors`. The C-RADIO, MoGe and RVM helper models are downloaded separately, as the report says.
- **License.** I checked clauses 2a–2d and 3 verbatim, and the report summarizes them correctly:
  - no reselling the code or weights
  - no paid API or paywall in front of the model
  - anything released that includes it must be free
  - commercial software needs a written agreement
  - organizations with more than $20M revenue need a paid seat per user

## 2. Claims that are wrong, overstated or unverified

**CorridorKey report**

- **Single photo as input: overstated.** The report says "single image = 1-frame dir". The `--input` help text only says "Input video file or directory of image frames". Nothing shows that the time-window path works with one frame (T=1). The "Make it Magic" step for photos must be tested, and the server may need to repeat the frame to make a short clip.
- **"Tier A runs at 60 fps on iPad Safari and phones": unverified.**
  - The keying shader itself is cheap.
  - Drawing camera video into WebGL (`texImage2D` from a video element) is slow on older iPads, and kindergartens often have those.
  - Plan for 30 fps at 720p.
- **Recording format: incomplete.** Safari's MediaRecorder gives mp4/H.264 and Chrome gives webm. Saving a video to the iPad's Photos needs `navigator.share({files})`, not a download link.
- **Processing time and parameter count: estimates.** "Minutes, not seconds" and "~1.2B parameters" are educated guesses. The server must be benchmarked.
- **Third-party ports.** I did not check the CorridorKeyWeb, CorridorKey-Runtime or OBS-filter claims. They don't affect the decision, because the plan doesn't use them.

**DoInk report**

- **Pricing.** "$4.99 / $7.99" and "rating 2.7–3.3" are unsourced. They don't matter for the build.
- **"Any key color".** CorridorKey 2.0 has no green/blue selector and is trained for green or blue screens. Purple or other colors will only work in our own live shader, not in CorridorKey.
- **Undocumented behaviors.** "Automatic person detection", "Project locked" and "Split" are guesses. All are cut from the MVP anyway.
- **Live keying in a browser.** The report asks whether the original's real-time keying can be matched in a browser. A plain chroma-key shader is enough, so this is settled.

**Talkline report**

- **No factual problems found.** This report is solid.
- **Fonts.** The report notes that Talkline's named fonts never actually load. Our app should self-host Baloo 2 and Quicksand so it works offline as a PWA, rather than linking Google Fonts.
- **The user offered Talkline's source code.** Ask for it. The CSS and the stepper parts can be reused directly instead of re-extracted from the page.

## 3. Missing information that blocks building

1. **Where the GPU server comes from and who pays for it.** Does the school have an NVIDIA machine, or would this be a cloud GPU? Without one, CorridorKey cannot be used at all, and the app falls back to the live keyer only. This is the biggest open decision.
2. **License and distribution.** Will the app be free? Is it a district (where the $20M revenue rule may apply) or a single school? Is an App Store build wanted? Clause 2d may require a written agreement with Corridor Digital. Clause 4 requires "CorridorKey" credit in the app.
3. **Student privacy (COPPA/FERPA).** Uploading children's video to a server needs a policy:
   - who runs the server
   - how long clips are kept (zero is best)
   - whether the teacher must opt in

   Talkline's promise that "everything stays on your device" breaks the moment the CorridorKey step is used. The app must tell the teacher this clearly.
4. **Assets.** Nobody has sourced the curated backgrounds and stickers with clear licenses. Voice prompts need recorded audio, or the browser's built-in speech (`SpeechSynthesis`), which varies in quality.
5. **Target hardware.** Which oldest iPad and iOS version must it support? This decides the camera resolution and frame rate.
6. **Teacher mode, offline use and accounts.** Is a PIN enough? Must it work offline? Do saved projects need to sync between devices, or only stay on each device?

## 4. Recommended architecture

**Tech stack**

- **App:** Vite + React + TypeScript, built as a PWA (installable, works offline via a service worker). Wrapping it with Capacitor for the App Store is optional and later.
- **Styling:** Talkline's design tokens copied as-is, as CSS variables. Fonts are self-hosted.
- **Storage:** IndexedDB (through `idb`). Projects and media files are copied in, never referenced, so they can't go missing.

**Live keying, on the device**

- Camera from `getUserMedia` at 1280×720, front camera by default, with a flip button.
- A WebGL2 shader does the keying:
  - YCbCr color distance to a key color, with soft edges (smoothstep)
  - removal of green spill
  - a light blur on the matte
- The key color is picked automatically by sampling the border of the frame. A kid can override it with one "tap the green" touch. Only a teacher sees sensitivity sliders.
- Layers are composited on one canvas: background, then "me", then stickers.
- Fallback when there is no green screen: MediaPipe Selfie Segmentation (tasks-vision), loaded only when needed.
- Recording: `canvas.captureStream(30)` plus the microphone track into MediaRecorder, with mp4 picked on Safari and webm elsewhere.
- Photos: `canvas.toBlob`.
- Saving: Web Share with files, falling back to a download.

**CorridorKey 2.0, optional server step ("Make it Magic")**

- **Service:** FastAPI plus one GPU worker in Docker. The CUDA 12.8 base image needs PyTorch 2.9.1, ffmpeg and the weights downloaded at build time (roughly 5 GB).
- **Model loading:** `load_model(paths, "cuda")` runs once at startup.
- **Endpoints:**
  - `POST /jobs` accepts a clip of at most 10 s and 720p. The app sends the original camera footage, not the keyed composite; the app must record it separately. Optionally it also sends the live keyer's matte of the first frame, used as `initial_hint_path` with `hint_quality=0.75`.
  - The worker calls `run_inference(..., outputs={"alpha","fg"})`.
  - `GET /jobs/{id}` reports progress.
  - The result is alpha and foreground mp4s. The app composites them over the chosen background in WebGL and exports the final video.
- **Queue:** one job at a time.
- **Privacy:** files are deleted right after the result is fetched.
- **Licensing in practice:** no login and no paywall in front of the model, plus a "Powered by CorridorKey (Corridor Digital)" credit in the app.
- **When the server is missing:** the app checks `/health` and hides the button if the server isn't reachable. The app works fully without it.

**Recording detail the live keyer forces**

To have raw footage to send to the server, the app must record two streams at once:

- the keyed composite, for the kid to watch right away
- the raw camera, for CorridorKey

## 5. MVP feature list

**Kid flow:** a Talkline-style stepper, Background → Me → Stickers → Snap/Film → Keep.

1. **Pick a World.** A picture grid of about 12 built-in backgrounds, plus a "my picture" upload. Images last the whole recording, so the 5-second trap can't happen. Background videos loop.
2. **Me.** The camera turns on with live keying and auto key color. Big flip-camera button. Optional "tap the green" magic finger.
3. **Stickers.** A picture-only grid. Drag to move, pinch to resize, with big +/−/reset buttons and a corner ✕ to delete.
4. **Snap or Film.** Photo is the default. Recording has:
   - a 160px record button
   - a spoken 5-4-3-2-1 countdown
   - a giant stop button
   - a 60 s hard limit
5. **Watch / Keep / Try again.** Confetti, then save through the share sheet or download. Shows "Make it Magic" when the server is available.

**For teachers and the whole app**

6. **Teacher mode behind a PIN:**
   - delete projects
   - camera resolution
   - sensitivity and spill sliders
   - eraser-style mask
   - CorridorKey server URL and on/off switch
   - backdrop tips page
7. **Gallery.** Saved projects shown as big cards, stored in IndexedDB.
8. **Spoken prompts on every step,** plus tap and success sounds. Big touch targets (64px or more), reduced-motion support, and layouts that work in iPad portrait and landscape, on phones (sticky bottom nav), and on desktop with a mouse.

**Deferred to P1/P2:** the 3-lane timeline, trimming and splitting, motion paths, drawing animations, text, mixing live and recorded audio, and project export.