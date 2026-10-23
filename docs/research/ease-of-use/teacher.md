# Magic Screen: friction for a busy K teacher running a 20-kid center on 2–4 shared iPads

## How I tested

- **Tool and settings:** Playwright Chromium with the fake green-screen camera, at iPad size (1194x834) and phone size (390x844), against the local dev server at http://localhost:5190.
- **Script:** `/private/tmp/claude-501/-Users-md-Green-Screen-2/727545c3-c535-41ef-933d-42d65e406914/scratchpad/ease/teacher/walk.cjs`, plus `denied.cjs` in the same folder for the camera-blocked case.
- **Screenshots:** `/private/tmp/claude-501/-Users-md-Green-Screen-2/727545c3-c535-41ef-933d-42d65e406914/scratchpad/ease/teacher/shots/`
- **Limit:** Chromium can't reproduce real iPad Safari prompts. Anything about Safari permission or storage behaviour comes from reading the code, not from watching it happen.

### Counts

| Task | Taps | Time (scripted, so faster than a child) |
|---|---|---|
| One kid, photo, Home → Keep, no sticker | 6 | 11–16 s (first run 20 s, camera ready in about 3 s) |
| Same, with one sticker | 7 | about 20 s |
| Save one creation to Photos on iPad (Save → share sheet → Save Image) | +2 | — |
| Teacher exports 20 creations from the gallery (tile → Save → Save Image → Back, each) | about 80 | about 8–10 min |
| Teacher clears the device | 7–8 (hold gear 2 s → 2-digit answer → ✓ → scroll past 4 cards → Delete all → Delete all) | about 15 s |
| Kid deletes a classmate's creation | 3, no grown-up check | — |

The kid flow is already fast. The teacher's time goes into getting work off the iPad and knowing whose work is whose.

---

## Friction points and proposed changes

### 1. You can't tell whose creation is whose
**Evidence:** after 6 kids, Home (`ipad-05-home-6-creations.png`) shows six tiles with only a photo icon. There is no name, no time and no class. The only tile label is the screen-reader text "Picture from Oct 22". In a real class each tile is a different child, but a teacher matching 20 thumbnails to 20 kids for Seesaw has nothing to go on. Saved file names are just a timestamp: `magic-screen-2026-10-22-18-29-10.png`.

**Change: a "Who's making?" class roster (optional, set by the teacher).**
- **Setup:** in Teacher settings, a "My class" card. The teacher types first names, or pastes a list, and picks a color or animal for each child. Kids who can't read find themselves by the animal.
- **Start of each turn:** if a roster exists, "Let's make!" opens a big face/animal grid first, so the child taps themselves (+1 tap). The name is spoken ("Hi, Maya!").
- **Gallery:** each tile gets a name chip, and Home gets filter chips by child.
- **File names:** `Maya-space-2026-10-22.png`, so files sort by child in Photos, Drive or Seesaw.
- **Who it helps:** the teacher (sorting, Seesaw posting, parent conferences) and kids (they find "mine").
- **Impact / effort:** H / M. It needs a `kid` field on `Creation`, a roster in settings and one new screen.

### 2. A kid can permanently delete anyone's creation
**Evidence:** Home → tile → View (`ipad-06-view.png`) shows a big pink **Delete** button next to Save. The confirm says "Delete this? It will be gone for good" (`ipad-07-delete-confirm.png`). After tapping it the gallery dropped from 6 to 5 tiles, with no grown-up check and no undo. This contradicts the DoInk research note: "Show Delete only in a teacher mode."

**Change:**
- Remove Delete from the kid View screen.
- Add a **Recently deleted** bin in teacher settings that keeps items for 7 days, so a teacher can recover from "a kid deleted something".
- If kids should be able to redo their own work, let them delete only the creation they just made, from Keep ("Try again" already covers this).
- **Who it helps:** the teacher and the kid whose work disappeared.
- **Impact / effort:** H / S.

### 3. Getting 20 creations off the iPad takes about 80 taps, one at a time
**Evidence:** the only export is Save on Keep or View, one file at a time, through the share sheet or a download. Teacher settings has nothing for export, only "Delete all creations". DoInk teachers use Seesaw through the share sheet (pick the student, then a green check), and that is still one file at a time here.

**Change: a teacher-only "Send / Save many" mode.**
- **Where:** Teacher settings → Creations → **Select** button. It opens a gallery grid with checkboxes, plus "Select today" and "Select Maya's" (with the roster).
- **What it sends:** **Share selected** passes all the files to one `navigator.share({files:[...]})`. iOS can then "Save N Images", AirDrop to the teacher's Mac, or post to Seesaw or Google Drive.
- **Fallback:** if multi-file share fails, offer **Download as .zip**, named by child and date.
- **After sending:** a "Delete after sharing" checkbox, so export and clear become one step at the end of the day.
- **Who it helps:** the teacher (end-of-day workflow), and parents get the work.
- **Impact / effort:** H / M.

### 4. Creations can silently disappear in Safari
**Evidence (code):** `lib/storage.ts` never calls `navigator.storage.persist()` and never checks `navigator.storage.estimate()`. In an iPad Safari tab (not installed to the Home Screen), WebKit can evict script-written storage, including IndexedDB, after 7 days without use. Spring break would wipe the gallery.
- If the iPad fills up, Keep only shows "Couldn't keep it in the gallery". The friendlier quota message in `storage.ts` ("The iPad is full! Ask your teacher…") never reaches that toast, because `KeepStep.tsx:73` overrides it.
- Nothing tells the teacher that creations live only in this browser on this iPad.

**Change:**
- Call `navigator.storage.persist()` on first save.
- When the app is not running from the Home Screen (`display-mode: standalone` false), show a teacher-facing note in settings: "Add Magic Screen to the Home Screen so creations aren't cleared after a week."
- Add a storage meter on the Creations card: "38 creations · 410 MB · about 2 GB free", with a yellow warning at 80%.
- When a save fails because storage is full, keep the capture on Keep and say "This iPad is full. Tap Save to put it in Photos now." That way the child's work isn't lost.
- **Who it helps:** the teacher, and kids whose work would otherwise be lost.
- **Impact / effort:** H / S.

### 5. First run has no setup or install guidance
**Evidence:** the first-run Home (`ipad-01-home-firstrun.png`) is identical to every later visit. There is nothing about Add to Home Screen, camera permission, Guided Access or lighting. The PWA manifest exists (`vite.config.ts`, `display: standalone`), but on iPad Safari nothing tells you to install it. The green screen tips are the 6th of 7 cards in Teacher settings, behind the gear hold and the multiplication check.

**Change: a one-time "Set up this iPad" checklist for grown-ups, about 2 minutes.**
- **When:** it opens the first time the gear is unlocked. It can also open from a small "Grown-ups: set up" link on Home that stays until setup is finished.
- **Steps, each with a ✓:**
  1. **Install:** an animated arrow to Safari's Share button → "Add to Home Screen". The step is auto-checked when it runs in standalone mode.
  2. **Camera:** a "Test camera" button that triggers the permission prompt now, with the teacher there rather than a child.
  3. **Point at your screen:** a live camera preview with a traffic-light check of the green screen ("Even light ✓ / Fills the frame ✗ — move closer"). It reuses the existing auto-key and "add light" logic.
  4. **Back or front camera:** a choice with two pictures (tripod vs selfie stand).
  5. **Lock it:** a short how-to for iPad Guided Access (Settings → Accessibility → Guided Access, triple-click). This is the real answer to kids wandering out of the app into Safari tabs or the Photos app.
- **Repeat for the other iPads:** a "Copy settings to other iPads" QR code that encodes the settings JSON (no server). Teachers set up 2–4 iPads, and today each one has to be configured by hand.
- **Who it helps:** the teacher (setup time) and IT or a parent volunteer.
- **Impact / effort:** H / M.

### 6. A blocked camera gives the teacher no way to fix it
**Evidence:**
- **Blocked (code):** `TROUBLE.denied` in `Stage.tsx:560` says "Camera is asleep — Ask a grown-up to let Magic Screen use the camera" with a **Try again** button. On iOS Safari, once a site has been denied, Try again does nothing, because the prompt never comes back.
- **Failed to start (seen):** with no camera available, the card says "Camera is shy — The camera didn't start" (`ipad-14-camera-denied2.png`). The right-hand tools stay enabled even though there's no camera, and "Keep going" lets the child continue with an empty stage.
- **Why it matters on iPad:** a single "Don't Allow" tap by a child blocks the camera for that site.

**Change:**
- Add a "Grown-up help" link on the trouble card. It opens step-by-step pictures for the case that applies:
  - **Safari tab:** aA button → Website Settings → Camera: Allow.
  - **Installed app:** iPad Settings → Safari → Camera → Allow, then reopen.
  - **Another app is using the camera:** close FaceTime or Zoom.
- Detect standalone vs tab and show only the matching steps.
- Grey out Me tools while the camera is unavailable.
- **Who it helps:** the teacher (mid-center recovery without a kid line forming).
- **Impact / effort:** H / S.

### 7. "Make another" puts the whole class's work back on the shared screen
**Evidence:** Make another goes to the World step (`ipad-04-make-another-lands.png`), which is fine for speed. But Home, where each next child starts, shows every classmate's creation. Kids open, save or delete each other's work (see #2), and in a busy center the next child often starts by browsing the gallery instead of making.

**Change: a "Center mode" toggle in settings.**
- **Home:** "Let's make!" only, plus the current child's creations from this turn.
- **Full gallery:** moves behind the gear.
- **After Keep:** auto-return to Home after 60 s of no touch, so an abandoned turn resets for the next child.
- **Who it helps:** the teacher (rotation flow) and kids (less distraction).
- **Impact / effort:** M–H / S.

### 8. Teacher settings is hard for a non-technical teacher
**Evidence:** the full page (`ipad-12-teacher-full.png`) is about 3200 px tall at iPad width.
- **Jargon up front:** the first card is all keyer terms: Outline 50%, Magic Helper Auto/On/Off, Screen color swatch, Similarity 40%, Smoothness 20%, Spill removal 60%.
- **Preview is fake:** it is a drawn cartoon, not the teacher's camera or room, so moving the sliders shows nothing about their own setup.
- **Buried essentials:** the things a teacher actually comes here for (Creations / Delete all, tips, Back camera) sit below that.
- **Defaults vs tips:** the tips say "Use the back camera on a tripod", but the default is Front (selfie).
- **Unclear labels:** "540p / 720p / 1080p" and "Magic Helper (AI person finder)" mean little to most teachers.

**Change: reorder and simplify.**
1. **Top: "Creations"** with the count, storage, Share selected, Delete all and Recently deleted.
2. **"Set up / Test camera"**, which opens a live camera preview and a big **Fix it for me** button that runs auto-key on the real room (reusing Auto fix).
3. **Plain toggles:** Which camera (with pictures), Longest video, Countdown, Voice, Sounds.
4. **Collapsed "Advanced (for tech helpers)"** holding Outline, Similarity, Smoothness, Spill, Magic Helper and quality. Rename quality to "Smaller files / Sharper".
5. **Tips as a picture checklist** at the end.

Also add a "Reset all settings" button: there's a Reset for the key color only, not for everything.
- **Who it helps:** every teacher who isn't the school's tech person.
- **Impact / effort:** H / S–M (mostly layout, plus a live preview using the existing Stage).

### 9. The grown-up gate is solid, but the stepper and "My picture" let kids wander
**Evidence:**
- **Gate:** tapping the gear shows only a toast, and the hold-plus-multiplication gate (`ipad-10-gate.png`, "9 × 9 = ?") works well. No change needed.
- **"My picture" tile (code):** it opens the iPad photo picker. Kids can browse the teacher's camera roll, other kids' saved photos and anything else on a shared iPad.
- **Uploaded worlds (code):** they are kept in memory only (WorldStep.tsx comment), so a teacher can't preload a class world. For example, a "Our field trip" photo or a Seesaw topic would have to be re-picked by every child.

**Change:**
- Add a "Kids can use their own picture: On/Off" toggle (default Off in Center mode).
- Add **Class worlds**: in settings the teacher uploads 1–6 images that are stored in IndexedDB and appear as extra tiles on World for every child.
- **Who it helps:** the teacher (privacy and lesson themes, e.g. "habitats week"). DoInk teachers do this with Canva backgrounds (see the Canva reference sheet).
- **Impact / effort:** M / M.

### 10. Clearing the device between classes means deleting everything
**Evidence:** "Delete all creations" is the only bulk control (`Teacher.tsx` CreationsCard). An AM and PM class sharing iPads must export everything first or lose it. There's no "delete older than today", and no confirmation of what's about to go beyond "All photos and videos on this device will be gone for good."

**Change:**
- Offer delete options: "Delete today's / older than a week / by child / everything".
- Show a thumbnail strip in the confirm dialog.
- Combine it with #3 as **Share then clear** in one flow.
- **Who it helps:** the teacher (AM/PM classes).
- **Impact / effort:** M / S.

### 11. Printing and parent hand-off
**Evidence:** there's no print path. Photo is the easiest kindergarten win, and teachers print these for bulletin boards and portfolios.

**Change:**
- Add a teacher-only **Print sheet** in the multi-select view: 1, 2 or 4 per page with the child's name under each (`window.print()` on a print-styled page).
- Add an optional "Add name to picture" stamp that burns the roster name into a photo's corner. This fills the role DoInk's text tool plays ("D is for Dog" alphabet book).
- **Who it helps:** the teacher and parents.
- **Impact / effort:** M / S–M.

---

## How Magic Screen compares with DoInk teachers' complaints

| DoInk pain point | Magic Screen today |
|---|---|
| Background image disappears after 5 s | Solved: worlds last the whole recording |
| Save vs Record confusion | Solved: separate Photo/Video cards, auto-saved to the gallery |
| Text-heavy menus, small icons | Solved: picture tiles and spoken prompts |
| Creation breaks when its camera-roll media is deleted | Solved: blobs are copied into IndexedDB. But Safari storage eviction and a full iPad are new risks (#4) |
| Seesaw posting means one share at a time | Not solved: still one at a time (#3) |
| Green screen setup and lighting | Partly: good tips, but hidden, and the preview is a cartoon rather than the room (#5, #8) |
| Delete should be teacher-only | Not solved: kids can delete (#2) |
| No way to tell students' projects apart (DoInk has titles and tags) | Worse than DoInk: no titles at all (#1) |

## Suggested order

1. **Quick wins (effort S):** #2 (remove kid Delete, add Recently deleted), #4 (persist storage, storage meter, keep the capture when full), #6 (camera recovery help), #8 (reorder settings, add Advanced).
2. **Next:** #1 (class roster) and #3 (Share selected / zip). Together they cut most of the teacher's after-class time.
3. **Then:** #5 (setup checklist and settings QR), #7 (Center mode), #9 (Class worlds).