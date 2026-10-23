# Magic Screen in real classroom conditions: friction points and lesson ideas

**How I tested.** I drove the local dev server (localhost:5190) with Playwright Chromium. I used five fake-camera clips: the default green screen, plus four I generated with the repo's own generator: `classroom` (a plain wall, no green screen), `green-shirt`, `uneven-light`, and the wall clip on a phone. I tested at iPad 1194x834 and phone 390x844, and also ran a video probe. Screenshots are in `/private/tmp/claude-501/-Users-md-Green-Screen-2/727545c3-c535-41ef-933d-42d65e406914/scratchpad/ease/classroom/shots/`.

**Limits of the test.** The clips are synthetic and the browser was headless Chromium. The AI cutout and Magic Helper results are therefore only a rough guide; check them on a real iPad. The dev build is silent, so I checked spoken prompts in the source, not by ear.

**Baseline counts:**
- **Photo, one kid, green screen:** 9 taps, about 16 s of real interaction (Let's make, World, Next, Next, pick pack, 2 stickers, Next, shutter).
- **Photo, plain wall:** the same 9 taps, but slower to settle. The app took 4.4 s after Me opened to switch to the AI cutout.
- **Video:** 3.6 s from tapping the shutter to recording. The microphone is requested only *after* the countdown ends (first getUserMedia with audio fired at 16.0 s, after the tap at 12.7 s).
- **Each extra kid in the same lesson:** another 9 taps. "Make another" resets the world and stickers.

---

## A. Classroom conditions

### A1. With no green screen, kids hear "stand in front of the green," then a different instruction
- **Evidence (Me, wall clip):**
  - At 1.5 s the raw classroom shows with no cutout. The subtitle says "Stand in front of the green." The tools include Tap the green and Auto fix (`wall-ipad/03-me-1.5s.png`).
  - At 4.4 s a toast says "No green screen? No problem. Magic cutout is on!" The tool grid drops from 8 to 6 buttons, so the layout jumps under the kid's finger.
  - StepShell speaks again whenever its `speak` prop changes. So a kid hears "Stand in front of the green. Wave hello!" and then, about 3 s later, "Wave hello! Drag to move you."
  - The cause: `autoMode` starts as `'chroma'` every time the Stage mounts, and it takes two 700 ms misses to switch.
- **Change:**
  1. Remember the last mode the app detected on this device (localStorage) and start in that mode.
  2. Until the first decision, show a neutral cover ("Finding you…" with sparkles) and a neutral prompt ("Wave hello!").
  3. Hide the green-only tools until a decision is made, instead of removing them afterwards.
- **Who it helps:** classrooms with no green screen, likely most first-time users. **Impact:** H. **Effort:** S.

### A2. With the AI cutout, the body fades out and the news desk shows through it
- **Evidence:** In the wall clip, the AI cutout kept the head but turned the body into a ghost. On News Desk, the desk and the "KIDS NEWS" sign show through the torso in the saved photo (`wall-ipad/07-keep.png`), and on the phone (`wall-phone/04-me-4.5s.png`). The fixture is synthetic, but soft torsos and edges are typical of a 256px selfie model.
- **Change:** add a **front layer** to some backgrounds: a desk, podium, car door, bush, or boat rim drawn *over* the Me layer. The backgrounds are already SVG, so each one would get a `front` SVG and the Compositor would draw it after Me. This hides the weakest part of the cutout (lower body and legs), and it looks like real TV.
- Then auto-place the kid behind the front layer. Each background would get a default `MeTransform`, for example news: scale 0.8, y 0.55.
- **Who it helps:** wall-only classrooms, and the news, weather and book report lessons. **Impact:** H. **Effort:** M.

### A3. Green clothes: the shirt disappears and no one says why
- **Evidence (Me, green-shirt clip):** the torso was fully keyed out, leaving a floating head and arms (`greenshirt-ipad/04-me-4.5s.png`). None of the `shirtOn` / `shirtOff` messages appeared within 4.5 s. The Magic Helper may not have started in headless Chromium, so recheck this on an iPad.
- **Change:**
  - When the shirt signal fires and the helper is off, show a kid-facing visual: a shirt icon with a sparkle and the line "Your shirt is magic! It's invisible!" Offer two buttons:
    - **Keep it** (fun: the invisibility cloak)
    - **Fix it** (forces the helper on, or switches to the AI cutout for this session)
  - The "invisibility cloak" lesson is already in the tips, so the moment becomes a feature, not a bug.
- **Who it helps:** kids and teachers. **Impact:** M. **Effort:** S.

### A4. Uneven light: the cutout looked good, but the warning is phrased for grown-ups
- **Evidence:** the uneven-light clip keyed cleanly (`uneven-ipad/04-me-4.5s.png`). The only guidance is a text toast, "Grown-ups: the green screen looks patchy…", which pre-readers can't read and which disappears.
- **Change:** show a small persistent "lamp" chip on the stage corner, visible only on the Me step. Tapping it opens a single picture card: lamp arrows pointing at the screen, plus "step away from the screen." It would show the patchy areas as a heat overlay on the live preview. The `uneven` signal and the border sampler already exist.
- **Who it helps:** the teacher setting up. **Impact:** M. **Effort:** M.

### A5. A kid tapping Flip camera silently changes the teacher's camera setting
- **Evidence:** after tapping Flip camera on Me, `localStorage.magicscreen.settings.facing` became `"environment"` and stayed that way. The next kid, and the next day's class, start on the back camera.
- **Change:** make Flip a per-session state. Only Teacher settings should write the default. Also show a small "Front" or "Back" chip on the Flip button, so the teacher can see which camera is live.
- **Who it helps:** teachers on shared iPads. **Impact:** M. **Effort:** S.

### A6. The longest countdown is too short to reach the spot
- **Evidence:** the countdown options are None, 3 and 5 s. The app's own tips say "Step a few big steps in front of the screen" and "Use the back camera on a tripod." A 5-year-old tapping a front-camera iPad on a tripod and then walking 2 to 3 m needs about 8 to 10 s.
- **Change:**
  - Add **10 s** to the Countdown setting.
  - Add a **Grown-up films** option for when the back camera is selected: the countdown is skipped, because the teacher is at the iPad.
  - During the countdown, make the number full-stage and flash the whole screen edge, so it can be seen from across the room even when the voice can't be heard.
- **Who it helps:** a kid filming alone, or a tripod setup. **Impact:** H. **Effort:** S.

### A7. The microphone permission prompt appears after the countdown
- **Evidence (video probe):** the shutter was tapped at 12.7 s, the countdown ran, and `getUserMedia({audio})` fired at 16.0 s (`ActionStep.startVideo`). On iPad Safari, the first video of a session pops the mic prompt just as the kid is posing. If nobody taps Allow, the video is silent with no warning (`getMic` returns null without telling anyone).
- **Change:**
  1. Ask for the mic when the kid taps the **Video** card, not after the countdown.
  2. If the mic is denied, show a muted-mic icon on the recording badge, and on Keep show "No sound this time, ask a grown-up."
  3. In Teacher settings, add a "Record sound" toggle (On / Off). Off avoids the prompt entirely, for a noisy room or when there will be a voice-over.
- **Who it helps:** teachers. **Impact:** H. **Effort:** S.

### A8. In a noisy room the speech can't be heard, and a teacher filming can't see the screen
- **Evidence:** all guidance is SpeechSynthesis plus a short toast. The countdown is spoken, and the "3-2-1" number sits only on the stage. When the teacher holds the iPad with the back camera, the kid sees the back of the iPad and gets no cue at all.
- **Change:**
  - **Big-cue mode:** while recording, a thick pulsing red border around the whole viewport. During the countdown, a full-screen number. Both are visible from the side or at a distance.
  - On iPads with a flash, an optional **torch blink** for 3-2-1 when using the back camera (`MediaStreamTrack.applyConstraints({advanced:[{torch:true}]})`, where supported) gives a cue on the kid's side. Treat this as a nice-to-have.
  - Add a voice-volume note to the tips: speech follows the iPad volume and the Mute switch.
- **Who it helps:** a teacher filming a kid, noisy rooms. **Impact:** M. **Effort:** S (border, number) to M (torch).

### A9. Mirroring flips anything a kid holds up in the saved file
- **Evidence:** in `Compositor.ts`, `u_mirror` and `ctx.scale(-1,1)` are applied in the main render. Photos and videos are captured from that canvas, so with the front camera and mirror on (the default), the saved output is mirrored. In a book report, the book cover, name tags and shirt text come out backwards.
- **Change:** keep the live preview mirrored but save un-mirrored: render the capture or record pass with mirror off. Alternatively, add a teacher toggle, "Saved photos look like: Mirror / Real". Default to **Real** whenever the lesson template involves holding something up (book report, show and tell).
- **Who it helps:** book report and "all about me" lessons. **Impact:** H. **Effort:** S to M (recording needs a second canvas or a per-frame toggle).

### A10. Multiple kids in frame have no setup guidance
- **Evidence:** the copy says the AI cutout "works best with one child." The default Me scale fills the frame height, so a group needs repeated taps on Smaller. Nothing addresses 2 to 3 kids (common for a weather report with a forecaster plus a "camera crew" in shot). I did not test this; there is no multi-person fixture.
- **Change:** add a "How many?" picker for the template, either on the template card or as a Me-step chip with 1 or 2 to 3 kid icons. It sets the Me scale (1.0 or 0.75) and position, and in segment mode it turns off whatever limits the cutout to a single person (if anything does). Also add a multi-person fixture to the test suite.
- **Who it helps:** group lessons. **Impact:** M. **Effort:** S (scale preset) to M (testing).

### A11. Offline and older iPads
- **Evidence (config):**
  - The PWA precaches js, css, svg, png, woff2, the SIMD wasm and the tflite model, so it works offline once installed.
  - The nosimd wasm (about 13 MB, for iOS before 16.4) is cached only *on first use*. The first offline launch on an old iPad therefore has no AI cutout. Combined with A1, a wall-only class on old iPads gets an unkeyed camera with "stand in front of the green."
  - Nothing tells the teacher whether the app is ready for offline use.
- **Change:**
  1. In Teacher settings, add a "Ready for offline" status row (service worker installed, model cached) with a **Download everything** button that fetches the fallback wasm.
  2. Add a device-tier line, "This iPad: AI cutout runs smoothly / slowly / not available," based on the existing `deviceTier` benchmark. Use it to recommend 540p.
  3. If the AI cutout is unavailable and no green screen is detected, say so plainly: "This iPad needs a green screen."
- **Who it helps:** classrooms with poor Wi-Fi or older iPads. **Impact:** M. **Effort:** S to M.

---

## B. Lesson use: one-tap templates

### B1. Every kid in a lesson repeats all 9 taps; add Lesson mode
- **Evidence:** "Make another" calls `newCreation()`, which clears the background, stickers and Me transform and returns to World. A 20-kid weather lesson means 20 × 9 taps, plus 20 chances to pick Rainbow Land instead of Weather Map.
- **Change:** in Teacher settings, add **Today's lesson** with a template picker. When a lesson is set:
  - Home shows the lesson card ("Weather report") instead of the generic Let's make card.
  - Tapping it jumps straight to Me with the world, front layer, default position, sticker pack and suggested output (video, 30 s) preloaded.
  - Keep's primary button becomes **Next kid**: same setup, back to Me.
  - The flow drops to about 3 taps per kid (Next kid, Next, shutter, with the stickers step pre-filled or skippable).
- Leaving the lesson takes the same grown-up hold as the gear.
- **Who it helps:** teachers. **Impact:** H (the biggest time saver). **Effort:** M.

### B2. Template set, mapped to the DoInk reference-sheet lessons
Each template bundles a world, an optional front layer, a Me position, a sticker pack, a spoken prompt, and an output type.

| Template | World / front layer | Sticker pack (new items in italics) | Spoken prompt | Notes |
|---|---|---|---|---|
| Weather report | Weather Map **blank variant** (the current map has fixed 75°/68° icons that clash with kids' stickers, see `green-ipad/05-stickers.png`). Kid placed at the left third, scale 0.85 | Weather + *Thermometer hot/cold, Wind, Rainbow, Wind-blown leaf, Number tags 0–100°* | "Tell us the weather! Point to the map." | The current Center me puts the kid over the map (`green-ipad/04-me-4.5s.png`); this needs a left-side default |
| News / "Kids News" | News Desk + **desk front layer** | *Microphone, Paper, Breaking-news burst* | "Say: Hello, I'm…" | Name lower-third (C1). The ticker text "Sunny day at school…" is baked into the background and is covered by the kid's head; let the teacher's lesson title replace it |
| Book report | New "Library / reading nook" world; kid at the right, room on the left for the cover | *Book, Star rating 1–5, Thumbs up, Speech bubble* | "Hold up your book! Tell us your favorite part." | Must save un-mirrored (A9). Teacher uploads the cover photo as a **sticker** (new: "My picture" in the stickers tray) |
| Field trip | Teacher upload of a real trip photo (zoo, farm), or Farm / City | *Camera, Bus, Ticket, Map pin* | "Where did we go? What did you see?" | Upload exists, but only in World and only for that one creation; Lesson mode should keep it for all kids |
| Animal habitat | Jungle, Under the Sea, Snowy Mountains, *Desert (new)*, *Pond (new)* | Animals split by habitat: *penguin, polar bear, camel, frog, shark, monkey, owl* | "Which animal lives here?" | The current Animals pack is pets (cat, dog, bunny, bear, unicorn, dino, butterfly, fish), so it doesn't fit habitat lessons |
| All about me | *Name banner* world (bunting with a big empty plate), or Rainbow Land | *Birthday cake, Number 1–9 (age), Family hearts, Favorite food/color dots* | "Tell us all about you!" | Name stamp (C1) is the core of this lesson |
| Storytelling | Castle, Moon, Space, Dino | *Dragon, Crown (exists), Treasure, Rocket, Wand (exists)* | "Once upon a time…" | Benefits most from multi-scene (C4) |

- **Who it helps:** teachers, plus kids (stickers that fit the topic). **Impact:** H. **Effort:** M (templates are data: background id, front layer, transform, pack, prompt). Each new SVG asset is S.

---

## C. Text, lower-thirds, voice-over, multi-scene: which are worth it

### C1. Name / title lower-third: **worth it, teacher-typed only**
- **Why:** gallery tiles have no name or date (`video-ipad/05-home-gallery.png`). On a shared iPad, a teacher with 20 nearly identical weather clips can't tell whose is whose, and the files are named `magic-screen-<timestamp>`.
- **How:**
  - **Class list:** a textarea in Teacher settings with one first name per line.
  - **Pick who's next:** in Lesson mode, Me shows a row of big name chips, each with a color-dot avatar so pre-readers can find their own. Tapping one sets the name.
  - **On the video:** the name renders as a TV-style lower-third bar (lesson title on top, name below, for example "WEATHER • Maya"). It is drawn in the Compositor's sticker pass, so it is baked into the export.
  - **File and gallery:** the name goes into the filename (`Maya-weather-2026-10-22.mp4`) and onto the gallery tile, and the gallery can filter by name.
- **Kids never type anything.**
- **Who it helps:** teachers, plus the Seesaw workflow (the right file reaches the right kid). **Impact:** H. **Effort:** M.

### C2. Free text tool for kids: **skip**
DoInk's text editor (font, size, color grid, alignment) is a known source of complexity, and kindergartners can't type. C1's teacher-typed title and name covers the real need (such as the "D is for Dog" alphabet book) with no new kid UI.

### C3. Voice-over: **worth it as a narrow "Talk over your picture" option, not a mixer**
- **Why:** a photo with narration is the easiest "report" format for shy kids, and the mic stays close to the iPad, which suits a noisy room. Live in-front-of-camera audio is the hardest to get clean in class.
- **How:** on Keep, for a **photo only**, add a third big button, **Add my voice** (mic icon):
  - It records up to 30 s with the same countdown and stop button.
  - It exports an mp4 of the still image plus the audio (canvas captureStream of the static frame plus the mic track, using the existing recorder).
  - No trimming, no mixing, no re-recording over video.
- **Impact:** M. **Effort:** M.

### C4. Multi-scene stories: **worth it only as a fixed 3-panel "Beginning / Middle / End"**, not a timeline
- **Why:** storytelling and field-trip retells naturally run in sequence. DoInk's layer and timeline model is exactly what K teachers struggle with.
- **How:** a "Story (3 parts)" template:
  - The stepper loops World, Me, Snap three times. The step header shows 3 big dots labeled 1, 2, 3 with picture icons (sun rising, mountain, moon).
  - Keep stitches the three clips (video), or three photos with optional voice-overs, into one file with a 0.5 s star wipe between parts.
  - Clips are concatenated by re-drawing them through the recorder canvas.
- **Rules:** keep it to exactly three parts, offered only as a template, and never as an editor.
- **Impact:** M. **Effort:** L (stitching on Safari is the cost). Do this after A, B1 and C1.

### C5. "News" lower-third without a name: **free with C1**
The news template renders the lower-third with "KIDS NEWS • LIVE" by default, and with the name when one is set. It shares C1's renderer.

---

## Priority order (impact first, then effort)
1. **A1** Fix the first ~4 s on Me when there's no green screen: neutral cover, remembered mode, one prompt. (H/S)
2. **A7** Ask for the mic on tapping Video, not after the countdown; warn when a video is silent. (H/S)
3. **A6** 10 s countdown, a "Grown-up films" mode, and a full-screen countdown. (H/S)
4. **A9** Save un-mirrored when kids hold things up. (H/S–M)
5. **B1 + B2** Lesson mode with templates and a **Next kid** button: from 9 taps to about 3 per kid. (H/M)
6. **C1** Class list name chips, lower-third, named files and gallery. (H/M)
7. **A2** Front layers (news desk, podium), which also hide AI-cutout weak spots. (H/M)
8. **A5** Flip camera stops overwriting the teacher's setting. (M/S)
9. **A3**, **A4**, **A8**, **A10**, **A11** (all M)
10. **C3** Voice-over on a photo (M/M), then **C4** 3-part story (M/L)

Scripts and logs are in `/private/tmp/claude-501/-Users-md-Green-Screen-2/727545c3-c535-41ef-933d-42d65e406914/scratchpad/ease/classroom/`, under `shots/<scenario>-<viewport>/` (each has a `log.txt` with taps, timings and toasts). The generated camera clips are in the `cams/` folder there.