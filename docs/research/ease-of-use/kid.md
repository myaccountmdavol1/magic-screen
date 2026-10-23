## Magic Screen: walkthrough as a 5-year-old pre-reader on a shared iPad

**How I tested.** Playwright Chromium with the fake green-screen camera, at iPad size (1194x834) and phone size (390x844), against localhost:5190. Screenshots and scripts are in `/private/tmp/claude-501/-Users-md-Green-Screen-2/727545c3-c535-41ef-933d-42d65e406914/scratchpad/ease/kid/`: `walk.mjs`, `extra.mjs`, and `ipad-*.png`, `phone-*.png`, `x-*.png`.

**One limit.** The dev server runs in silent mode, so no speech actually played. Everything I say about audio comes from reading `StepShell`, the step files and `voice.ts`.

### Headline numbers
- **Shortest path from Home to a creation in the gallery: 6 taps.** Let's make, then a world tile, Next, Next, Next, shutter. The gallery save happens by itself on Keep.
- **Saving to Photos needs 2 or more extra taps:** Save, then the iOS share sheet, which is all text.
- **Time:** about 23 s on phone and 25 s on iPad, at a scripted pace with one sticker added.
- **Photo timing:** after the shutter tap, "3" shows at 0.09 s, "2" at 1.2 s, "1" at 2.2 s. The flash and busy state run from 3.3 s, and Keep shows at 4.4 s. That's fine.
- **Video timing:** 7.8 s from the start tap to recording actually starting. That is 3 s of countdown plus **about 4.8 s with no feedback at all**. Chromium's fake device may exaggerate this, so check it on a real iPad.
- **Double taps:** a double tap on Next only moves one step, and the shutter can't be tapped during the countdown. Both are good.

### The big one
**Can a pre-reader get from Home to a saved picture alone? Yes, they can reach the gallery.** But the path depends on finding text-labelled Next buttons with no spoken cue. Several accidental taps also silently throw away work.

---

## Friction points and proposed changes

### 1. The logo is a 239x52 "go home" button that throws away work with no warning
- **Evidence:** on every Make step, the top-left "Magic Screen" logo (aria "Magic Screen, go home") is 239x52 px. I tapped it on step 2 and landed straight on Home. Tapping "Let's make!" again then calls `newCreation()`, which wipes the world, stickers and position. The step 1 "Home" back button does the same.
- **Change:** in the Make flow, make the logo do nothing. Or require a 1.5 s hold, like the gear. If kept, any exit while `maxStep > 0` and before Keep should show a picture-only dialog: a big green "keep going" arrow and a small grey house. It should speak: "Do you want to stop? Tap the green arrow to keep going."
- **Helps:** kids alone, and buddies grabbing the iPad.
- **Impact H, effort S.**

### 2. No spoken cue after a choice: kids pick a world, then stall
- **Evidence** (`ipad-02-world.png`, `x-world-scrolled.png`):
  - Tapping a world speaks its name only.
  - "Next: Me!" is a pale, see-through pill floating bottom-right over the News Desk tile. It's disabled until a world is picked, and it doesn't change in any way a kid would notice once it turns on.
  - None of the Next buttons, on any step, speak or animate.
  - A pre-reader can't read "Next: Me!" or "Next: Stickers", so they keep tapping worlds.
- **Change:** pick one.
  - (a) Tapping a world plays a 1 s "zoom into the world" preview, then moves to Me on its own (Back undoes it).
  - (b) Once a world is picked, the Next button turns solid, pulses, and is spoken: "Great! Now tap the big arrow."
  - On every step, swap the Next label for a big right-arrow icon. Keep the text for grown-ups only.
- **Helps:** kids alone.
- **Impact H, effort S** for (b), **M** for (a).

### 3. The Me screen has 8 text-labelled tools, and half are for grown-ups
- **Evidence** (`ipad-03-me.png`, `phone-03-me.png`):
  - The tools are Flip camera, Tap the green, Auto fix, Tighter edge, Looser edge, Bigger, Smaller, Center me.
  - The Tighter and Looser icons (`edgeIn`/`edgeOut`) are almost the same person-with-arrows picture.
  - Four Tighter taps against eight Looser taps looked the same in `x-edge-tight.png` vs `x-edge-loose.png`. The only feedback is a text toast at the end ("That is as loose as it gets!").
  - Tool taps make a "tap" sound but never speak their name.
  - "Tap the green" arms a mode. If the kid then taps Next without tapping the green, nothing tells them it was armed.
  - On phone, Smaller and Center me sit below the fold, behind the sticky nav bar.
  - "Flip camera" swaps to the back camera, so the kid suddenly disappears.
- **Change:**
  - Kid view gets only three tools: Bigger, Smaller and Center me, with big icons. Each one speaks its name when tapped.
  - Move Tap the green, Auto fix, Tighter/Looser and Flip into a "grown-up fix" drawer. Open it with the same 2 s hold as the gear, or put the defaults in Teacher settings.
  - If Tighter/Looser stay visible to kids, rename and redraw them as **"Fuzzy" and "Sharp"**: a soft blurry blob vs a crisp outline. Each tap should briefly flash a glowing outline around the cutout so the change can be seen.
  - Add a "pinch to make me bigger" hand animation on the stage at first visit.
- **Helps:** kids (fewer choices), teachers (fixing stays possible).
- **Impact H, effort S** to hide/gate, **M** to redraw.

### 4. Video: stopping is unclear, early taps make 1-second clips, and there's a dead gap before recording
- **Evidence** (`ipad-09-video-idle.png`, `ipad-09b-recording.png`, `x-short-video-keep.png`):
  - The countdown ends, then about 4.8 s pass with no number, no ring and the button disabled (awaiting `getMic()`) before recording starts. On a real iPad, the first video also brings up the text-only "Allow microphone?" system prompt right here.
  - Once recording starts, nothing is spoken; there is only the start sound.
  - Stopping means tapping a white square, and "Tap the big button to stop." is text only.
  - The limit is 60 s, shown as "0:02 / 1:00", which a pre-reader can't read. The ring takes a full minute to fill.
  - A kid who taps again 0.3 s after recording starts (because "nothing happened") stops it. That 1.02 s clip was celebrated and saved.
- **Change:**
  - Ask for the mic when the kid taps the Video card, or have a grown-up allow it once from Teacher settings. Keep the "3-2-1" overlay up until recording really starts, then flash a big red "REC" pulse.
  - Speak "We're filming! Tap the square to stop." at the start, and "3, 2, 1, done!" before auto-stop.
  - Ignore stop taps in the first 2 s.
  - Set a 15 s kid default (teacher can change it). Show the time left as a draining ring or "film strip" of 3 to 5 chunks, not digits.
  - Swap the white square for a red "hand/stop" icon that also pulses.
- **Helps:** kids alone.
- **Impact H, effort S/M.**

### 5. The Keep screen offers 4 choices, and "Save" opens a text-only share sheet
- **Evidence** (`ipad-06-keep.png`, `phone-06-keep.png`):
  - The choices are Save (blue, XL), Home (text link), Try again (bottom-left, back-arrow) and Make another (green).
  - The creation is already in My creations, but nothing says so. The voice says "Wow! You made it!" with no next step.
  - Save calls `saveToDevice`, which brings up the iOS share sheet (AirDrop, Messages, Mail…). A pre-reader can send it somewhere, or get stuck.
  - On phone, confetti covers the title and the picture.
- **Change:**
  - On Keep, animate the thumbnail flying into a "My creations" star icon, and speak "It's in your gallery!"
  - Reduce the kid choices to two big picture buttons: **"Again"** (camera, goes to Snap) and **"New"** (sparkle, goes to World). Add a small house.
  - Move "Save to Photos" to the gallery View screen, or behind a grown-up hold. Teacher settings could also turn on "save to Photos without asking" where the platform allows it.
  - After 4 s, speak "Want to make another? Tap the sparkle!"
- **Helps:** kids, and teachers who don't want accidental AirDrops.
- **Impact H, effort S/M.**

### 6. Gallery: a buddy can delete anyone's work in 3 colourful taps
- **Evidence** (`x-view.png`, `x-delete-confirm.png`): tapping a tile on Home opens View, then the red "Delete" button. The confirm dialog shows text-only "Delete this?" with a bright pink "Delete" as the louder button and a pale "Keep it". A kid will tap the bright one. On a shared iPad, creations have no owner marker.
- **Change:**
  - By default, show no delete for kids. Delete becomes a 2 s hold (same ring as the gear), or teacher-only in settings.
  - If a confirm stays, make "Keep it" the big coloured default and speak "Do you want to throw it away?"
  - Optionally, put a small "who made it" animal badge (picked once per session from 6 animals) on tiles, so buddies can find their own.
- **Helps:** shared classrooms, teachers.
- **Impact H, effort S.**

### 7. Stickers: text-only tabs, a small delete X with no undo, and no audio
- **Evidence** (`ipad-04b-sticker-added.png`, `phone-04b-sticker-added.png`):
  - The pack tabs Fun, Faces, Animals and Weather are text pills, 48 px tall.
  - A selected sticker shows a pink X (44x44) at its top-left and a resize handle (44x44). A kid dragging the sticker can easily hit the X, and there is no undo.
  - "Clear all" has no confirm, and on iPad it sits off-screen (y=878).
  - The sticker grid scrolls inside the tray with no hint, and the third row is cut off.
- **Change:**
  - Give each tab an icon (star, smiley, paw, cloud) and keep speaking the name.
  - Grow the X and the handle to at least 56 px and move the X 12 px further out. Better still, delete by dragging the sticker to a trash can shown during the drag.
  - Removing a sticker shows an "undo" puff that taps back in for 4 s.
  - Make "Clear all" a 1 s hold.
- **Helps:** kids.
- **Impact M, effort S/M.**

### 8. The "My picture" tile is 13th, below the fold, and opens the iOS photo picker
- **Evidence:** on iPad, My picture sits at y=882 (off-screen). On phone it's at y=1161, about 1.5 screens down. Tapping it opens the system Photos/Files picker, which is text-heavy and full of the teacher's photos.
- **Change:** a teacher setting to hide "My picture" for kids. Or have teachers upload class worlds in Teacher settings so they show as normal picture tiles.
- **Helps:** teachers, kids alone.
- **Impact M, effort S/M.**

### 9. The floating nav bar sits on top of world tiles
- **Evidence** (`ipad-02-world.png`): at first load on iPad, the sticky "Home" pill covers the bottom-left of The Moon tile, and "Next: Me!" covers News Desk. A kid reaching for The Moon taps Home and leaves the flow (with finding 1, that loses the pick).
- **Change:** give the nav row a solid band with padding on the World grid, or add bottom padding equal to the nav height so tiles never sit under it. Combined with finding 1, Home should need a hold.
- **Helps:** kids.
- **Impact M, effort S.**

### 10. The first tap is silent, and the voice never re-prompts an idle kid
- **Evidence:**
  - Home only says "Let's make some magic!" after `audioUnlocked`, so the first visit is silent until something is tapped.
  - `StepShell` speaks once on mount. The speaker button is 48x48, smaller than everything else.
  - There is no idle re-prompt anywhere. A kid who stalls on Me (finding 3) or World (finding 2) hears nothing more.
  - The "Grown-ups: press and hold the gear" toast stayed on screen after moving to World.
- **Change:**
  - Show a full-screen "Tap to start" splash (a big bouncing camera) that unlocks audio and leads straight into the greeting.
  - After 8 s with no meaningful tap, repeat the step prompt plus where to go next ("Tap the big arrow!"). Wiggle the target button.
  - Grow the speaker button to 64 px.
  - Clear toasts when the screen changes.
- **Helps:** kids alone.
- **Impact M, effort S.**

### 11. Stepper circles are small, tappable, and jump around
- **Evidence:** on phone the step circles are 50x74 with labels you have to read. From Keep, tapping "World" jumps back with the old capture still around; "Keep" stays reachable and shows the earlier photo.
- **Change:** for kids, make the stepper a non-interactive progress bar (a moving star along a path). Navigation would happen only through the big Back/Next.
- **Helps:** kids.
- **Impact L/M, effort S.**

### 12. The Photo/Video choice adds a decision before the fun part
- **Evidence** (`ipad-05-snap.png`): the speech asks "Photo or video?", but Photo is already selected. Video is a dashed outline that looks disabled.
- **Change:** default to Photo and drop the question from the prompt ("Tap the big camera!"). Let the teacher set the default to Video for news-desk days. Give Video a solid style rather than a dashed one.
- **Helps:** kids.
- **Impact L, effort S.**

---

## What already works for this lens
- The Home "Let's make!" card is big and obvious.
- World tiles are pictures and speak their names.
- The shutter is huge (160 px on iPad, 116 px on phone) and can't be tapped twice during the countdown.
- A double tap on Next moves only one step.
- The gallery saves itself on Keep, so nothing is lost after the shutter.
- Make another resets cleanly.
- A kid tapping the gear only gets a toast.

## Suggested order
1. **Finding 1** (logo/Home loses work)
2. **Finding 4** (video stop rules and audio)
3. **Finding 2** (the Next cue)
4. **Finding 3** (gate the edge tools)
5. **Finding 5** (simplify Keep, move Save to Photos away from kids)
6. **Finding 6** (gallery delete)

All are small or medium changes, and together they remove the main places a kid alone gets stuck.