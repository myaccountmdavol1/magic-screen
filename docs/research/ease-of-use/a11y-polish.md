## Accessibility, robustness and polish review: Magic Screen

**How I tested:** Playwright Chromium with the fake green-screen camera, on iPad landscape (1194x834), iPad portrait (834x1194), phone (390x844) and phone landscape (844x390). I also ran it with reduced motion on, and read the source for the paths a browser can't easily fake. Each item says whether I **saw** it on screen or am inferring it from **code**.

**Tap counts (iPad):**
- **Shortest photo:** 6 taps (Let's make → world → Next: Me! → Next: Stickers → Next: Snap! → shutter) plus the 3 s countdown. With one sticker it is 7 taps, about 24 s in the scripted run.
- **Video:** the same, plus Video and Stop, so 8 to 9 taps.
- **Teacher settings:** 2 s hold on the gear, then 3 to 4 keypad taps.

Screenshots: /private/tmp/claude-501/-Users-md-Green-Screen-2/727545c3-c535-41ef-933d-42d65e406914/scratchpad/ease/a11y/

---

### A. Robustness: lost work and dead ends

**A1. A background app update can reload the page in the middle of a session or recording.** *(code, confirmed in the library)*
- **Evidence:** `main.tsx` calls `registerSW({ immediate: true })` with `registerType: 'autoUpdate'` and no `onNeedReload`. In `vite-plugin-pwa/dist/client/build/register.js`, auto mode then runs `window.location.reload()` as soon as the new version activates.
- **What happens:** the update is about 14.9 MB (22 files) and downloads quietly on school wifi. When it finishes, the page reloads. A child partway through a video loses the clip, and nothing in the make flow is saved, so they land back on Home.
- **Fix:** pass `onNeedReload` and keep a `pendingReload` flag. Reload only when the child is on Home, or the next time the app is hidden. Never reload during the `make` screen or while recording.
- **Helps:** every child and teacher. **Impact:** H. **Effort:** S.

**A2. Leaving the app while recording isn't handled.** *(code; headless browsers can't truly suspend a page)*
- **Evidence:** `ActionStep.tsx` has no `visibilitychange` or `pagehide` handling. The timer uses `performance.now()`, so time spent away still counts toward the limit. In my simulated hide, the recording kept going (`still recording after bg? 1`).
- **What happens on an iPad:** Home button, Control Center or a notification can end the camera track or stall MediaRecorder. The clip then has a frozen gap, or gets cut off when the limit is reached.
- **Fix:** when the page is hidden during recording, call `stopVideo()` straight away, so the clip saved so far goes to Keep as normal. When the app comes back, show the Keep screen with "We saved your movie!"
- **Helps:** kids, teachers. **Impact:** H. **Effort:** S.

**A3. If the camera stops after it has started, the picture just freezes with no way back.** *(code)*
- **Evidence:** `Stage.tsx` has no listener for the camera track ending or muting. The "Camera is shy / Try again" cover only appears when `startCamera` fails at the start.
- **What happens:** iPadOS stops the camera when the app goes to the background, when Split View or FaceTime takes it, or when Control Center opens. The child sees a frozen frame and keeps waving.
- **Fix:** when the video track ends, show the same cover with the title "Camera fell asleep" and a big "Wake it up" button that calls `retryCamera()`. Also retry automatically once when the app becomes visible again.
- **Impact:** H. **Effort:** S.

**A4. A full iPad shows a vague message, and the celebration happens anyway.** *(code)*
- **Evidence:** `storage.ts` writes a clear message ("The iPad is full! Ask your teacher to delete some old creations."), but `KeepStep` ignores it and shows a generic toast: "Couldn't keep it in the gallery" for 2.6 s. Confetti and "Wow! You made it!" still play.
- **Other gaps:** nothing calls `navigator.storage.persist()`, so Safari can clear the gallery after 7 days of non-use when the app isn't added to the Home Screen. Nothing calls `navigator.storage.estimate()`. The Teacher screen only says "0 creations saved on this device".
- **Fix:**
  - When saving to the gallery fails, show a card that stays on screen until dismissed: "Not saved in My creations. Tap Save to put it in Photos now", with the Save button pulsing.
  - Call `persist()` after the first creation.
  - Teacher → Creations: add "Using 212 MB · about 40 more videos fit" and a "Delete videos older than 30 days" button.
- **Helps:** teachers. **Impact:** H. **Effort:** S–M.

**A5. Long videos can get very large.** *(code)*
- **Evidence:** `startRecording` sets no `videoBitsPerSecond`. A 2-minute clip at 720p or 1080p is held entirely in memory, then copied to IndexedDB, and copied again for sharing.
- **Fix:**
  - Cap the bitrate at about 2.5 Mbps for 720p and 4 Mbps for 1080p.
  - Show a soft hint at 75% of the limit: the ring turns orange and the voice says "10 more seconds!"
  - In Teacher settings, label "2 min" as "(big files)".
- **Impact:** M. **Effort:** S.

**A6. Phones turned sideways put the picture below the fold.** *(saw: `phone-me-landscape.png`)*
- **What I saw:** at 844x390, the logo and step bar take about 60% of the height. Back and Next sit on either side of the stage's top edge, and the tools are completely off-screen. Children tend to hold phones sideways for video.
- **Fix:** add a `(max-height: 500px)` layout:
  - Hide the logo bar and show the step bar as five small dots.
  - Stage on the left at full height, tools in a scrolling column on the right.
  - Back and Next as round floating buttons over the stage corners.
- **Helps:** families on phones. **Impact:** H. **Effort:** M.
- **iPad:** rotating between landscape and portrait mid-flow worked fine (`ipad-portrait-stickers.png`). The stage reflows and the camera keeps running.

**A7. Camera permission denied: the advice doesn't tell anyone how to fix it.** *(code; headless browsers can't really deny permission, my run only reached the "Camera is shy" cover)*
- **Evidence:** the denied copy is "Camera is asleep / Ask a grown-up to let Magic Screen use the camera." Once permission is denied, iOS Safari never asks again, so "Try again" will keep failing silently.
- **After "Keep going"** (`r-denied-continue.png`): the subtitle still says "Stand in front of the green." Tap the green and Auto fix are greyed out with no reason given.
- **Fix:**
  - Under the kid copy, add a collapsible grown-up line with the steps: "iPad: Settings › Apps › Safari › Camera › Allow (or aA › Website Settings)". The Home Screen app version needs its own wording.
  - After "Keep going", change the subtitle to "No camera — add stickers to your world!" and skip straight to Stickers.
- **Impact:** M. **Effort:** S.

**A8. No sign of when the app works offline.** *(code)*
- **Evidence:** `onOfflineReady` isn't used. After the first visit, a teacher can't tell whether the 14.9 MB has finished downloading before taking the iPad somewhere without wifi.
- **Fix:**
  - Teacher → About: "✓ Ready to use without wifi" or "Downloading… 62%" (count cached entries against the precache list).
  - One toast on first completion: "Magic Screen is ready to use offline."
- **Impact:** M. **Effort:** S.

---

### B. Motor access: dragging and pinching

**B1. Moving yourself requires dragging.** *(saw: `ipad-04-me.png`)*
- **Evidence:** the tools offer Bigger, Smaller and Center me, but there is no left, right, up or down. In green-screen mode the subtitle doesn't even mention dragging; only the AI mode says "Drag to move you."
- **Fix:** add a 4-arrow "Move me" pad. Make it one tool tile that opens four 64 px arrows, with each tap moving 5% and holding it repeating. Alternatively, "tap where you want to be": the next tap on the stage moves you there, much like the "Tap the green" mode.
- **Helps:** kids with motor difficulties, Switch Control users. **Impact:** H. **Effort:** S.

**B2. Stickers can only be moved, resized or turned by dragging, and the handles are small.** *(saw: `ipad-05-stickers.png`; code)*
- **Evidence:** the `.sticker-tool` handles are 2.75rem (44 px), below the project's own `--touch-min: 4rem` (64 px). Resizing and turning use one corner handle you have to drag in an arc. New stickers fan out from the top-left, which is often on top of the background art (the planet in Outer Space).
- **Fix:**
  - While a sticker is selected, show a row of tap buttons in the tray: Bigger, Smaller, Turn, and four arrows.
  - Enlarge the handles to 64 px, including the hit area.
  - Add "tap the stage to put it there": tap a tile, then tap a spot.
- **Impact:** H. **Effort:** M.

**B3. "Clear all" has no undo.** *(saw: `ipad-portrait-stickers.png`)*
- **Evidence:** a child who taps it by accident loses all their stickers.
- **Fix:** after clearing, show a 5 s "Undo" pill on the stage. Also put an undo arrow on the single-sticker × button.
- **Impact:** M. **Effort:** S.

**B4. No way to cancel the countdown.** *(saw: `ipad-07-countdown.png`)*
- **Evidence:** during the countdown, the shutter, Photo/Video and Back are all disabled. An accidental tap means waiting it out, and a recording then starts.
- **Fix:** turn the hero button into a "✕ Stop" while counting down.
- **Impact:** L. **Effort:** S.

---

### C. Visual: contrast, colour-only cues, motion

**C1. Several labels are low contrast.** *(measured computed styles; ratios are approximate)*

| Element | Colour | Approx. contrast |
|---|---|---|
| Upcoming step labels ("Stickers / Snap / Keep") | done-label colour, then button `opacity:.52` | ≈1.5:1 |
| Finished step labels | `rgba(47,143,239,.72)` | ≈2.3:1 |
| Unselected Photo/Video labels | pale orange / pink | ≈2:1 |
| Step subtitles | `rgba(27,79,156,.72)` at 17 px | ≈4:1 |
| "Tap the green" label | amber on white | ≈2.6:1 |

- **Fix:** use solid ink colours instead of opacity. Make subtitles full `--ink` at 18 px or more. For upcoming steps, use a grey outline with darker grey text (#6b7a90) instead of fading.
- **Helps:** low-vision kids, bright classrooms. **Impact:** M. **Effort:** S.

**C2. Tapping a greyed-out Next does nothing at all.** *(code: `WorldStep` sets `disabled: !background`)*
- **Evidence:** pre-readers can't tell faded from active, and a disabled button gives no response to a tap.
- **Fix:** keep Next tappable and look different. A tap with no world picked plays a gentle "boop", wiggles the world grid and says "Pick a world first!"
- **Impact:** M. **Effort:** S.

**C3. Reduced motion is handled; an in-app calm mode is missing.** *(saw: `r-reduced-keep.png`)*
- **What works:** with reduced motion on, confetti is suppressed and the global CSS cuts animations to 1 ms.
- **The gap:** a sensory-sensitive child on a shared class iPad usually won't have the system setting on. The app has a white full-screen shutter flash, confetti, wiggle and pulse animations, and countdown beeps.
- **Fix:** Teacher → Voice & sounds: a "Calm mode" switch. It applies the same rules as reduced motion, removes the flash, softens sounds, and replaces confetti with a single gold star.
- **Impact:** M. **Effort:** S.

**C4. Colour-only cues are mostly fine.** Finished steps get a check icon, selected Photo/Video use solid vs dashed borders, and the selected world gets a check. No change needed.

---

### D. VoiceOver and keyboard

**D1. Focus is lost on every screen change.** *(saw)*
- **Evidence:** after "Let's make!" and after "Next: Me!", `document.activeElement` is `BODY`, because `key={step}` unmounts the button that was tapped. VoiceOver goes back to the top of the page.
- **Fix:** on each step mount, focus the step's `h1` (with `tabIndex={-1}`).
- **Impact:** M. **Effort:** S.

**D2. VoiceOver users get no description of the stage.** *(saw in the accessibility tree)*
- **Evidence:** `.stage-touch` is `aria-hidden`, and the canvas has no label. Stickers on the stage can't be focused, so a keyboard or switch user can't select a different sticker.
- **Fix:**
  - Give the stage `role="img"` with a live label, e.g. "You are in Outer Space. Stickers: Star, Heart."
  - List the placed stickers as buttons in the tray, under a "On your picture" row. Selecting one there gives the B2 tap controls.
- **Impact:** M. **Effort:** M.

**D3. Built-in speech and VoiceOver talk over each other.** *(code)*
- **Evidence:** the countdown is `aria-live="assertive"` and is also spoken with `speechSynthesis`. Every step prompt is spoken on mount while VoiceOver is reading the new screen.
- **Fix:** add a Teacher toggle "Child uses VoiceOver", which turns off auto-spoken prompts but keeps the speaker button.
- **Impact:** L. **Effort:** S.

---

### E. Hearing, other languages, reading

**E1. Spoken prompts don't match the on-screen text, and some cues are spoken only.** *(code, `speak` vs `subtitle`)*

| Where | On screen | Spoken |
|---|---|---|
| Me | "Stand in front of the green." | adds "Wave hello!" |
| Stickers | "Tap a sticker. Drag it where you like!" | "Stickers! Tap one, then drag it where you like." |
| Snap (while recording) | changes to "Tap the big button to stop." | nothing new |
| Clear all | nothing | "All gone!" |
| Choosing a world | nothing | the world's name |

- **Fix:** use one string for both, and show it as a caption under the title that highlights each word as it is spoken (driven by `SpeechSynthesisUtterance.onboundary`). This helps deaf and hard-of-hearing children, children learning to read, and ESL families.
- **Impact:** M. **Effort:** S–M.

**E2. No Spanish, or any other language.** *(code)*
- **Evidence:** `voice.ts` only picks `en*` voices. `<html lang="en">`. Roughly 120 strings are written directly into the components, so there is no translation layer.
- **Fix:**
  - Move the strings into `strings/en.ts` and `strings/es.ts`, plus `settings.language`.
  - Make `pickVoice` prefer `es-MX` or `es-US` voices (iPads ship with Paulina and Mónica).
  - Language choice in Teacher settings, plus a small flag on Home that families can tap.
  - A "Bilingual" option that speaks in Spanish while showing English text, or the reverse.
- **Helps:** ESL families, dual-language classrooms. **Impact:** H. **Effort:** M.

**E3. Messages for grown-ups disappear too fast.** *(code: `SIGNAL_TEXT` in `useStage.ts`)*
- **Evidence:** "Grown-ups: the green screen looks patchy. More even light or a smoother screen…" is about 25 words in a toast that lasts 2.6 s. The shirt warning is about the same length.
- **Fix:** messages that start "Grown-ups:" go in a small dismissible card on the stage edge with a "Got it" button. Keep toasts under 6 words.
- **Impact:** M. **Effort:** S.

**E4. Text is harder to read than it needs to be.** Subtitles are faded (72% opacity) Quicksand at 17 px.
- **Fix:** full-opacity text, 1.4 line height, and an optional "Easy-read font" setting (Atkinson Hyperlegible, about 30 KB self-hosted).
- **Impact:** L. **Effort:** S.

---

### F. Inconsistent and confusing wording

| # | Where | Problem | Proposal |
|---|---|---|---|
| F1 | Step 5 "Keep" (download icon) + big **Save** button | The creation is already saved to My creations automatically. "Save" suggests it will be lost otherwise, and on iPad it opens the share sheet, which is adult territory. | Show a chip "✓ In My creations" and rename the button "Save to Photos". Give it the same colour as on the View screen (blue on Keep, green on View today). |
| F2 | Snap step | Five names for one action: step "Snap", titles "Snap it!" / "Film it!", buttons "Take a photo" / "Start filming", Keep subtitle "Watch your movie!" | Use **Photo** and **Video** everywhere: "Take a photo", "Start video", "Watch your video!" |
| F3 | Keep → gallery labels | "picture" (Keep, gallery tile labels) vs "Photo" (chooser) | Use "photo" everywhere. |
| F4 | Me step | Kid button "Tap the green", Teacher tip "Magic finger" | Use one name: "Tap the green" in both. |
| F5 | Stage badge "AI cutout on" | "AI" is jargon to a 5-year-old. It doesn't match Teacher's "Magic Helper (AI person finder)" or the mode name "No green screen". | Kid badge: "✨ Magic on". Teacher: use "Magic Helper" consistently and rename the mode "No green screen (Magic Helper)". |
| F6 | Edge tools | "Tighter edge / Looser edge", Teacher "Outline 50%", toast "That is as snug as it gets!" | Kid: "Trim edge / Grow edge"; toast: "That's the most!"; Teacher: "Edge trim". |
| F7 | Me subtitle | Green-screen mode doesn't mention dragging; AI mode says "Drag to move you." (awkward) | Both modes: "Stand in front of the green. Drag to move." plus the B1 arrows. |
| F8 | Keep nav | Back slot "Try again" (goes back to Snap with stickers kept) next to "Make another". "Try again" also appears on camera errors. | "↺ Take it again" vs "+ New one". |
| F9 | View screen (`view.png`) | No title. A kid-reachable pink **Delete** button. No Home button. | Title "My photo · Oct 22". Hide Delete for kids (long-press or teacher only). Add Home. |
| F10 | Camera covers | "Camera is shy" / "Camera is asleep" give no fix | Kid line plus grown-up steps, see A7. |

---

### Priority order
1. **A1** update reload: H/S
2. **A2 + A3** leaving the app / camera dropping: H/S
3. **B1** move-me arrows: H/S
4. **A4** storage full: H/S–M
5. **A6** phone landscape: H/M
6. **B2** sticker tap controls: H/M
7. **E2** Spanish: H/M
8. **F1, F2** wording: M/S
9. **C1, C2** contrast and disabled Next: M/S
10. **E1, E3** captions and grown-up messages: M/S
11. **D1** focus on screen change: M/S