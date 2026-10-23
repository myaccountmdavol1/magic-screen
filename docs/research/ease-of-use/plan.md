# Magic Screen: one ranked list to make it easier

**Ground rule used for ranking:** kids should never get more choices. Any added complexity goes to the grown-up gate or a teacher setting. Where reviewers raised the same point, the item notes who flagged it ([kid], [teacher], [classroom], [a11y]).

---

## (A) Quick wins: high impact, small effort

**A1. Stop accidental exits from throwing away work**
- **Change:**
  - In the Make flow, the 239x52 logo does nothing.
  - "Home" on step 1 needs a 1.5 s hold, using the same ring as the gear.
  - Any exit before Keep shows a picture-only dialog: a big green arrow to keep going and a small grey house. It speaks "Do you want to stop? Tap the green arrow to keep going."
  - Add bottom padding or a solid band so the floating nav never sits over world tiles.
- **Helps:** kids working alone, and buddies grabbing the iPad.
- **Impact/effort:** H / S.
- **Evidence:** [kid 1, 9]. One logo tap on step 2 goes straight Home, and "Let's make!" then calls `newCreation()`, which wipes the world, stickers and position. On iPad, the Home pill covers The Moon tile and "Next: Me!" covers News Desk.

**A2. Never lose a session to a reload, leaving the app, or a camera drop**
- **Change:**
  - Pass `registerSW` an `onNeedReload` that only reloads on Home or when the app is hidden, never during Make or recording.
  - If the page is hidden while recording, call `stopVideo()` and go to Keep with "We saved your movie!"
  - When the camera track ends or mutes, show a "Camera fell asleep" cover with a big "Wake it up" button. Retry once automatically when the app becomes visible.
- **Helps:** everyone.
- **Impact/effort:** H / S.
- **Evidence:** [a11y A1–A3]. With `autoUpdate` and no `onNeedReload`, the library runs `window.location.reload()` mid-session. That update is 14.9 MB. `ActionStep` has no `visibilitychange` handling, and `Stage` has no track-ended listener, so the picture just freezes.

**A3. Take Delete away from kids and add a teacher "Recently deleted" bin**
- **Change:**
  - Remove Delete from the kid View screen. It moves to Teacher settings.
  - Deleted items stay in a "Recently deleted" bin for 7 days.
  - Add a Home button and a title ("My photo · Oct 22") to View.
- **Helps:** shared classrooms, and the kid whose work vanished.
- **Impact/effort:** H / S.
- **Evidence:** [kid 6, teacher 2, a11y F9]. A buddy deletes a classmate's work in 3 taps. The confirm dialog makes the pink "Delete" the loud button. DoInk research says "Delete only in teacher mode."

**A4. Make "what next" obvious without reading**
- **Change:**
  - Every Next becomes a big right-arrow icon. The text stays for grown-ups.
  - Once a choice is made, the arrow turns solid, pulses, and speaks "Great! Now tap the big arrow."
  - A greyed Next stays tappable: it plays a boop, wiggles the grid and says "Pick a world first!"
  - After 8 s idle, repeat the step prompt and wiggle the target.
  - Clear toasts when the screen changes, and grow the speaker button to 64 px.
- **Helps:** pre-readers working alone.
- **Impact/effort:** H / S.
- **Evidence:** [kid 2, 10; a11y C2]. Next is a pale pill with no speech or animation. Kids keep tapping worlds. There is no idle re-prompt anywhere. The gear toast stays on screen into World.

**A5. Me step: kids see 3 tools, the fixing tools go behind the grown-up hold**
- **Change:**
  - The kid view shows only Bigger, Smaller and Center me, with big icons, each speaking its name.
  - Tap the green, Auto fix, Tighter/Looser and Flip move to a "grown-up fix" drawer opened with a 2 s hold.
  - Flip becomes per-session and no longer writes `settings.facing`.
- **Helps:** kids (fewer choices), and teachers (fixing still possible, and the setting stays put).
- **Impact/effort:** H / S.
- **Evidence:** [kid 3, classroom A5]. There are 8 text-labelled tools. The Tighter and Looser icons are nearly identical, and 4 vs 8 taps looked the same. On phone, 2 tools sit below the fold. Flip changed `localStorage` for the next kid and the next day.

**A6. Video: no dead gap, no 1-second clips, no surprise mic prompt**
- **Change:**
  - Ask for the mic when the kid taps the Video card. Add a teacher "Record sound" toggle; Off avoids the prompt entirely.
  - Keep the 3-2-1 overlay up until recording really starts, then flash "REC".
  - Speak "We're filming! Tap the square to stop."
  - Ignore stop taps in the first 2 s.
  - Kid default is 15 s, with time left shown as a draining ring rather than "0:02 / 1:00".
  - If the mic was denied, show a muted icon and "No sound this time."
- **Helps:** kids alone, and teachers.
- **Impact/effort:** H / S–M.
- **Evidence:** [kid 4, classroom A7]. `getUserMedia({audio})` fires after the countdown. There were 4.8 s with no feedback. A 0.3 s re-tap saved a 1.02 s clip. `getMic` returns null silently.

**A7. With no green screen, start calm: one prompt, no layout jump**
- **Change:**
  - Remember the last mode the device detected and start in it.
  - Until the first decision, show a "Finding you…" cover and say only "Wave hello!"
  - Hide the green-only tools until the decision, instead of removing them afterwards.
- **Helps:** classrooms without a green screen, likely most first-time users.
- **Impact/effort:** H / S.
- **Evidence:** [classroom A1]. The app says "Stand in front of the green," then about 3 s later gives a different prompt. The tool grid drops from 8 to 6 under the kid's finger. The switch takes 4.4 s, because `autoMode` always starts as `'chroma'`.

**A8. Storage safety: don't let creations quietly disappear**
- **Change:**
  - Call `navigator.storage.persist()` on the first save.
  - If the gallery save fails, skip the confetti. Show a card that stays until dismissed: "Not saved in My creations. Tap Save to put it in Photos now", with Save pulsing.
  - Let the real "iPad is full" message through.
- **Helps:** teachers, and kids whose work would otherwise be lost.
- **Impact/effort:** H / S.
- **Evidence:** [teacher 4, a11y A4]. `persist()` is never called, and Safari can evict the gallery after 7 days in a tab. `KeepStep.tsx:73` overrides the friendly quota message with "Couldn't keep it in the gallery" while confetti still plays.

---

## (B) Worth doing next

**B1. Simplify Keep to two picture buttons**
- **Change:**
  - The thumbnail flies into a "My creations" star and the voice says "It's in your gallery!" Show a "✓ In My creations" chip.
  - Kid buttons: "Again" (camera, goes to Snap) and "New" (sparkle, goes to World), plus a small house.
  - "Save to Photos" (renamed) moves to the gallery View screen or behind a hold. The share sheet stays away from kids.
  - After 4 s, speak "Want to make another? Tap the sparkle!"
- **Helps:** kids, and teachers who don't want accidental AirDrops.
- **Impact/effort:** H / S–M.
- **Evidence:** [kid 5, a11y F1/F8]. Keep has 4 choices. "Save" suggests the work would otherwise be lost, and it opens the text-only iOS share sheet. On phone, confetti covers the picture.

**B2. A blocked camera gets real grown-up help**
- **Change:**
  - Add a "Grown-up help" link on the trouble card, with picture steps for the matching case: Safari tab (aA → Website Settings), installed app (Settings → Safari → Camera), or another app using the camera.
  - Grey out Me tools while there's no camera.
  - "Keep going" leads to "No camera — add stickers!"
- **Helps:** teachers fixing it mid-center.
- **Impact/effort:** H / S.
- **Evidence:** [teacher 6, a11y A7]. Once iOS Safari is denied, "Try again" does nothing. The tools stay enabled on an empty stage.

**B3. Reorganize Teacher settings around what teachers actually do**
- **Change:**
  - **Top:** Creations, with count, storage meter ("38 · 410 MB · ~2 GB free") and Delete all.
  - **Then:** "Test camera" with a live preview and a "Fix it for me" button that runs auto-key on the real room.
  - **Plain toggles:** which camera (with pictures), Longest video, Countdown, Voice, Sounds.
  - **Collapsed "Advanced":** Similarity, Smoothness, Spill, Outline, Magic Helper and quality.
  - **Status rows:** "Ready without wifi" and "This iPad: AI cutout runs smoothly / slowly / not available".
  - A note to Add to Home Screen when not running standalone.
  - A "Reset all settings" button.
- **Helps:** non-technical teachers.
- **Impact/effort:** H / S–M.
- **Evidence:** [teacher 8, a11y A8, classroom A11]. The page is about 3200 px tall and opens with keyer jargon. The preview is a cartoon. The default is Front even though the tips say back camera on a tripod.

**B4. Stickers that are hard to break**
- **Change:**
  - Pack tabs get icons (star, smiley, paw, cloud).
  - The X and the resize handle grow to 64 px, and the X moves further out.
  - Removing one sticker or tapping "Clear all" shows a 4–5 s "Undo" puff.
  - Tap a tile, then tap the stage to place the sticker.
- **Helps:** kids, including those with motor difficulties.
- **Impact/effort:** M–H / S–M.
- **Evidence:** [kid 7, a11y B2/B3]. The handles are 44 px, below the project's own 64 px `--touch-min`. There is no undo. On iPad, "Clear all" sits off-screen.

**B5. Move yourself without dragging**
- **Change:** "tap where you want to be": the next tap on the stage moves you there. This adds no new button, and a 4-arrow pad is the fallback. Both modes' subtitles say "Drag to move."
- **Helps:** motor access, and kids who never discover dragging.
- **Impact/effort:** H / S.
- **Evidence:** [a11y B1, F7]. There's no non-drag way to move, and green-screen mode never mentions dragging.

**B6. Countdown you can see from across the room**
- **Change:**
  - Add a 10 s countdown option.
  - The countdown number goes full-screen, and a thick pulsing red border shows while recording.
  - A "Grown-up films" option skips the countdown when the back camera is used.
  - A teacher "Calm mode" removes the flash and confetti and softens the sounds.
- **Helps:** a kid on a tripod alone, noisy rooms, sensory-sensitive kids.
- **Impact/effort:** H / S.
- **Evidence:** [classroom A6/A8, a11y C3]. The longest countdown is 5 s, and the cues are speech or on the stage only.

**B7. Save un-mirrored**
- **Change:** keep the live preview mirrored but save the real orientation, or add a teacher toggle "Saved photos look like: Mirror / Real".
- **Helps:** book report and show-and-tell lessons.
- **Impact/effort:** H / S–M (video needs a second render pass).
- **Evidence:** [classroom A9]. The mirror is baked in through `u_mirror` / `ctx.scale(-1,1)`, so book covers and name tags save backwards.

**B8. One voice, one caption, readable text**
- **Change:**
  - Use the same string for speech and subtitle.
  - Make subtitles solid ink at 18 px or more, and use solid colours instead of opacity for step and Photo/Video labels.
  - "Grown-ups:" messages become a dismissible card; kid toasts stay under 6 words.
  - Use Photo/Video naming everywhere, and "✨ Magic on" instead of "AI cutout on".
  - Focus the step's h1 when the screen changes.
  - Make the stepper a progress bar kids can't tap.
  - Drop "Photo or video?" from the spoken prompt, since Photo is already selected.
- **Helps:** pre-readers, low vision, deaf and hard-of-hearing kids, VoiceOver users.
- **Impact/effort:** M / S.
- **Evidence:** [a11y C1, D1, E1, E3, F2–F7; kid 11, 12]. Contrast is about 1.5–2.6:1 in places. A 25-word grown-up warning lasts 2.6 s. Snap has 5 names for one action.

---

## (C) Bigger features to consider

**C1. Lesson mode with templates and a "Next kid" button**
- **Change:**
  - The teacher picks today's lesson (Weather, News, Book report, Habitat, All about me, Field trip, Storytelling).
  - Home shows a single lesson card that goes straight to Me with the world, position, sticker pack and output preloaded.
  - Keep's main button becomes "Next kid". Leaving the lesson takes a grown-up hold.
- **Trade-off:** this is the biggest time saver, going from about 9 taps to about 3 per kid. Kids get fewer choices, which fits the goal. The cost is template data, new SVGs (a blank weather map, habitat animals) and a new settings surface.
- **Impact/effort:** H / M.
- **Evidence:** [classroom B1/B2]. Today, 20 kids means 20 × 9 taps, plus 20 chances to pick the wrong world.

**C2. "Who's making?" class roster**
- **Change:**
  - The teacher types first names, and each gets an animal or colour.
  - Kids tap their animal (+1 tap) and hear their name.
  - The name goes on the gallery tile, into the filename (`Maya-weather-2026-10-22.mp4`), onto a gallery filter and onto an optional TV lower-third.
- **Trade-off:** one extra kid tap per turn, which could be skipped in Lesson mode by having the teacher pick. The names stay on the device. Kids never type.
- **Impact/effort:** H / M.
- **Evidence:** [teacher 1, classroom C1, kid 6]. Tiles have no name or date, and files are named by timestamp. This is worse than DoInk.

**C3. Teacher bulk export: "Share then clear"**
- **Change:**
  - A teacher-only multi-select with "Select today" / "Select Maya's".
  - One `navigator.share({files})` call, with a .zip fallback.
  - A "Delete after sharing" option.
  - Delete by today / older than a week / child.
  - An optional print sheet.
- **Trade-off:** multi-file share behaviour varies across iOS versions, and zipping large videos is memory-heavy. Kids are not affected.
- **Impact/effort:** H / M.
- **Evidence:** [teacher 3, 10, 11]. About 80 taps and 8–10 min for 20 creations today. Seesaw posting is still one at a time.

**C4. Center mode, plus class worlds**
- **Change:**
  - Home shows only the make card and this turn's work; the full gallery goes behind the gear.
  - Auto-return to Home after 60 s idle on Keep.
  - "My picture" is hidden by default.
  - The teacher uploads 1–6 class worlds, stored in IndexedDB, that show as normal tiles.
- **Trade-off:** families lose easy gallery browsing, so this should be a toggle and off for home use.
- **Impact/effort:** M–H / S–M.
- **Evidence:** [teacher 7, 9; kid 8]. The next child starts by browsing classmates' work. "My picture" opens the teacher's camera roll. Uploaded worlds live in memory only.

**C5. Front layers and per-world default position**
- **Change:** a desk, podium or bush drawn over the kid on chosen worlds, with an automatic scale and position for each world.
- **Trade-off:** this hides the weakest part of the AI cutout (the torso and legs) and looks like TV. The cost is new SVG art for each world and tuning per world.
- **Impact/effort:** H / M.
- **Evidence:** [classroom A2]. With the AI cutout, the News Desk shows through a ghostly torso. Center me puts the kid over the weather map.

**C6. One-time grown-up setup checklist**
- **Change:**
  - Install arrow, auto-checked when standalone.
  - Test the camera now, so the permission prompt comes with a teacher present.
  - Live light check (traffic light).
  - Pick front or back camera.
  - How to use Guided Access.
  - A settings QR to copy to the other iPads.
- **Trade-off:** solid value but a new flow. Do B3 first, which covers about half of it.
- **Impact/effort:** H / M.
- **Evidence:** [teacher 5]. The first run is identical to every later visit, and the tips are the 6th card behind the gate.

**Also queued, not ranked here:**
- Spanish or bilingual prompts (H/M). It needs about 120 strings pulled into a strings file. [a11y E2]
- Phone landscape layout (H/M; families, not iPad). [a11y A6]
- "Add my voice" to a photo (M/M). [classroom C3]

---

## (D) Things NOT to do

- **D1. A free text tool for kids.** Kids can't type, and DoInk's text editor is a known pain point. Teacher-typed names and titles (C2) cover the need. [classroom C2]
- **D2. Timelines, layers or a multi-scene editor.** At most, a fixed 3-part "Beginning / Middle / End" template, and only after C1 and C2. Stitching video in Safari is costly. [classroom C4]
- **D3. Keyer controls for kids, even renamed ("Fuzzy / Sharp").** Kids couldn't see the difference. Gate them (A5) instead of redrawing them. [kid 3]
- **D4. Auto-advance from World to Me on tap.** It punishes kids who try several worlds and makes Back a new decision. A pulsing spoken arrow (A4) gets the same result. [kid 2a]
- **D5. New kid-facing pickers or dialogs:**
  - "How many kids?" on Me, a "Keep it / Fix it" shirt dialog, a language flag on Home, owner badges for each session, torch blinks.
  - Make these teacher defaults or template settings. The shirt notice can be a fun visual with no decision. [classroom A3, A10, A8; a11y E2; kid 6]

---

## Recommended next batch

All S or S–M; together they remove the main places a kid gets stuck or loses work.

1. **A1:** accidental exits no longer lose work, and the nav stops covering tiles.
2. **A2:** no reload, background or camera drop loses a session.
3. **A3:** Delete becomes teacher-only, with a Recently deleted bin.
4. **A4:** a big spoken arrow for Next, a tappable disabled Next, and an idle re-prompt.
5. **A5:** 3 kid tools on Me, the fixing tools behind a hold, and Flip stops overwriting the setting.
6. **A6:** video fixes (mic asked early, no dead gap, 2 s stop guard, 15 s ring).
7. **A8 + A7:** `persist()` and keeping the capture when storage is full, plus the calm no-green-screen start.

After that, start C1 (Lesson mode) together with C2 (roster). Between them they save teachers the most time.