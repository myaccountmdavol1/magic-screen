# DoInk Green Screen: Feature Spec for Rebuilding It as a Kindergarten Web App

## Sources
- Official docs: https://www.doink.com/support (the full manual, last updated for v2.x, (c)2015). Also published as a PDF at https://www.doink.com/s/Green-Screen-by-Do-Ink-xyc2.pdf.
- https://www.doink.com/description. Its only content is 5 screenshots (screenshot1-5.png) with no captions, so it gave no text detail.
- https://www.doink.com/referencesheets: 10 one-page teacher PDFs. I read all of them: Video, Photo, Live Camera, Chromakey, Mask Tool, Props, Text Tool, Animating, Canva, Seesaw.
- https://www.doink.com/faqs, which has 11 FAQs, and https://www.doink.com/tutorials, which lists 12 YouTube tutorials by title only. I did not watch the videos.
- Web search: the App Store listing ([apps.apple.com](https://apps.apple.com/app/id730091131)), [AppFollow](https://apps.apple.com/cz/app/green-screen-by-do-ink/id730091131?l=cs), and DoInk blog posts on pathing ([blog](https://blog.doink.com/tagged/DoInk%20pathing%20tool), [animate props](https://blog.doink.com/post/187624699370/how-to-animate-props-in-green-screen-by-doink-one)).
- Local copies of the downloaded pages, PDFs and JPEGs: `/private/tmp/claude-501/-Users-md-Green-Screen-2/727545c3-c535-41ef-933d-42d65e406914/scratchpad/doink/`

Priority key: **P0** = needed for the kindergarten web MVP, **P1** = nice to have soon, **P2** = later or teacher-only, **Skip** = leave out for K.

---

## 1. Core model
- **Composition:** up to **3 layers** are stacked and composited at each moment on the timeline. Top is in front, middle is in the middle, bottom is the background.
- **Each layer is a horizontal track** that holds a **sequence** of sources (clips) laid end to end. Sources play one after another.
- **Source types:** live camera, video from the library, photo from the library, Do Ink artwork or animation, a text element, a prop from the Prop Library, and a new animation drawn in the app (from v2019 on).
- **Per-source settings:** chroma (on/off, key color, sensitivity), crop rectangle, mask bitmap, transform (pan, scale, rotate), audio level (video only), start and end on the timeline, and an optional motion path.
- **Default chroma state:** **ON** for sources on the top and middle layers, **OFF** for the bottom layer. Do Ink artwork defaults to OFF because it already has transparency.
- **Output mode:** a VIDEO / IMAGE toggle in the top toolbar.
- **Project settings:**
  - title and tags
  - resolution: 1080p, 720p (default) or 640x480 (4:3)
  - aspect ratio 16:9 or 4:3, plus an orientation setting (Landscape/Portrait) seen on the Canva sheet
  - camera position: Front/Back, one per project
  - file name
  - "Project locked" toggle seen in the settings popover. Its behavior is undocumented.

## 2. Feature list

### Gallery and project management
1. **Gallery**
   - **Behavior:** a grid of project cards. Each card shows a filmstrip thumbnail, a title and optional tags. Tap a card to open it.
   - **UI:** "+" at top right offers "Create a New Project" or "Import a Project". A gear at top left opens app preferences. Each card has a "..." button (or swipe left) for Delete, Duplicate and Export. There is a search bar labelled "filter with tags".
   - **Priority:** **P0**, simplified. Big picture cards and one giant "New" button. Drop tags and search. Show Delete only in a teacher mode.
2. **Sample project**
   - **Behavior:** always the last card in the gallery. It can be edited but changes are never saved.
   - **Priority:** **P1**. A "demo" project with a dinosaur and space is a good kindergarten onboarding.
3. **App preferences (Gallery gear)**
   - **Behavior:** sets defaults for video resolution, camera position, file format, and default image duration. Image duration defaults to 5 s and the slider goes up to "unlimited" (FAQ #2).
   - **Priority:** **P2**, teacher settings. For K, image duration should default to unlimited or "match the longest clip" so kids never run into it.
4. **Project settings (gear in editor)**
   - **Behavior:** popover with title, tags, resolution, aspect ratio, orientation, camera Front/Back, project locked, file name.
   - **Priority:** **P1**. Only the front/back camera flip is needed as a big icon. Fix the rest (16:9, 720p).
5. **Export/import project file (.doink-gs)**
   - **Behavior:** bundles all assets into one file and goes through Files, Dropbox or Drive. Import accepts only .doink-gs.
   - **Priority:** **P2**. On the web, use IndexedDB persistence, with an optional zip export for teachers.
6. **Asset references**
   - **Behavior:** projects store references to camera-roll media rather than copies. If the media is deleted, the app shows a "missing media" alert.
   - **Priority:** for the web, **copy blobs into IndexedDB** (P0) so this failure never happens.
7. **Undo/redo**
   - **Behavior:** undo and redo arrows at top left of the editor, plus inside the mask and drawing tools.
   - **Priority:** **P0**, as a single big "oops" undo button.

### Editor layout
8. **Four regions**
   - **Behavior:**
     - **Source Selector**: a right-side panel listing CAMERA: Add the Camera; PHOTOS & VIDEOS: Moments/Videos/Photos/Albums; TEXT: Add a New Text Element; ANIMATION & DRAWING: Create a New Animation / Open the Prop Library / Open the Do Ink Folder; CLOUD: Open the Document Picker.
     - **Preview**: large, at the top.
     - **Timeline**: 3 rows, each with a "+" at its right end.
     - **Toolbars**: the top bar has back "<", undo/redo, Export Video / Record Video / Capture Image (the button label changes with state), the VIDEO|IMAGE toggle, gear and "?". The bar above the timeline has the time readout "0 00/60ths seconds", a play triangle, and the chroma (color wheel), crop and mask icons. The bottom bar has a wrench and a speaker, plus Cut, Copy, Paste, Delete, Trim and Split.
   - **UI note:** the layout adapts to device orientation.
   - **Priority:** **P0** structure, re-skinned. Preview takes about 65% of the screen. Show 3 big colored layer lanes with icons (sky/background, me/middle, sticker/top). Use a picture-tile source picker instead of a text list.

### Adding sources
9. **Add to layer at playhead**
   - **Behavior:** tap "+" on a layer, pick a source, and it is inserted at the **current playhead time** (the red cursor line). You set the playhead by scrolling the timeline horizontally.
   - **Priority:** **P0**. For K, always insert at 0 and fill the whole layer. Hide the playhead concept by default.
10. **Import photo/video**
    - **Behavior:** opens the photo library, with a "Location" button to switch to Drive/Dropbox. The picker shows a preview, then "Use" or "Done".
    - **Priority:** **P0**, using `<input type=file accept="image/*,video/*">` plus a **built-in background gallery** (space, ocean, jungle, dinosaurs, underwater, weather map, news desk). A kindergartner cannot browse a camera roll well, so a curated gallery matters most.
11. **Default image duration**
    - **Behavior:** images default to 5 s. A "duration box" pops up the first time and is dismissed by tapping anywhere (Text Tool sheet). This is a known teacher pain point (FAQ #2: the background vanishes after 5 s during live-camera recording).
    - **Priority:** **P0**: avoid the trap. Images should last the full project length by default.
12. **Add the camera**
    - **Behavior:** adds a live camera source at the playhead. **It deletes any later sources on that layer.** Its duration is unlimited until trimmed or until another source follows it. Since v2.0, multiple camera sources are allowed across layers, but they all use the same front or back camera.
    - **Priority:** **P0**. Camera on the middle layer is the main kindergarten flow ("Me!").
13. **Do Ink artwork / Do Ink folder**
    - **Behavior:** imports transparent vector animations from the companion app. Chroma is off by default.
    - **Priority:** **Skip**. Replace with built-in transparent PNG/GIF/Lottie "stickers" (P1).
14. **Prop Library (v2019+)**
    - **Behavior:** a searchable library with tabs ALL PROPS / APPROVED / FEATURED and a search box (for example, type "background"). It contains backgrounds and characters. It can be hidden through iOS Settings.
    - **Priority:** **P0** as "Backgrounds", **P1** as "Stickers". Make it a curated, picture-only grid with no free-text search for K. Category chips should use icons.
15. **Text element (v2019+)**
    - **Behavior:** "Add a New Text Element" opens an editor with a font chooser, size -/+, text color palette (a "T" icon opening a ~10x12 color grid), fill (box) color, and alignment left/center/right/justify. On the canvas, left/right green handles set the text wrap width and top/bottom handles set the margins (visible only when a fill color is set). Tap and hold to move the box. A center green dot is the motion-path handle. Tapping "T" above the timeline re-edits the text.
    - **Priority:** **P1** for teachers (a title card). Kids cannot type, so offer an optional "my name" stamp.
16. **Create a New Animation (v2019+)**
    - **Behavior:** an in-app flipbook editor. Tools: brush, shapes (rect, ellipse, polygon, star?), fill, eraser, color, undo/redo, play, "+" to add frames, with onion skinning. Up to **30 frames**. "Done" places it on the layer.
    - **Priority:** **P2**. A single-frame "draw a sticker" could be P1.

### Selection and timeline editing
17. **Select a source**
    - **Behavior:** tap a clip to select it. The timeline auto-scrolls so the clip is under the red cursor, and the clip gets a red (later yellow) border with square handles at each end (green on the left, pink/red on the right).
    - **Priority:** **P0**. Selection also sets which layer the transform gestures act on.
18. **Source tools panel**
    - **Behavior:** tap the already selected clip a second time to open or close the panel. Holds Delete, Cut, Copy, Paste, Trim, audio level and (in v2019 screenshots) Split, in the bottom bar.
    - **Priority:** **P1**. The double-tap pattern is too subtle for K. Show one big trash-can icon on the selected clip.
19. **Trim at playhead**
    - **Behavior:** removes the part of the selected clip to the right of the cursor. Mainly used to give a camera source a finite length.
    - **Priority:** **P2**.
20. **Split**
    - **Behavior:** a button visible in v2019 screenshots. It presumably cuts the clip at the playhead into two. Not documented.
    - **Priority:** **Skip**.
21. **Move clip**
    - **Behavior:** long-press, then drag along the layer. Neighboring clips on that layer are moved, trimmed or deleted to make room. Clips cannot be dragged across layers; use Cut/Paste for that.
    - **Priority:** **P2**.
22. **Trim handles**
    - **Behavior:** drag the square end handles to trim the start or end, which also changes an image's duration.
    - **Priority:** **P2**.
23. **Clear all**
    - **Behavior:** a toolbar button removes every source.
    - **Priority:** **P1**, with a confirmation.
24. **Timeline duration**
    - **Behavior:** no fixed length. The project ends at the end of the last source. A camera source is unlimited until trimmed, and recording stops at the end of the last source or when the user taps stop. Time is shown as seconds plus "60ths".
    - **Priority:** **P0**: simplify. For K, recording should run until the child taps a big STOP, with a hard cap (for example 60 s), with bounded-length background videos looping or holding their last frame. *How the original handles the end of a background video while the camera is unlimited is not documented. It probably goes blank, which is the FAQ #2 symptom.*

### Keying, crop and mask
25. **Chroma tool**
    - **Behavior:** select the clip, then tap the color-wheel icon to enter full-screen chroma mode with a checkerboard showing transparency. The bottom bar has an **Enabled** switch, a **Chroma Key** color swatch, a **hue-spectrum slider** (a rainbow bar for picking hue), and a **Sensitivity** slider (shown as e.g. "Sensitivity 40%"). Exit with "Done".
    - **Priority:** **P0**, but done automatically by CorridorKey. See the notes in section 3.
26. **Eyedropper**
    - **Behavior:** touch and drag anywhere on the preview in chroma mode, and the key color follows your finger live. It works on the live camera too: point the camera at the screen and touch it.
    - **Priority:** **P1**, offered as an optional "Magic finger: tap the green" for when auto-keying fails.
27. **Any key color**
    - **Behavior:** the screen doesn't have to be green. Any saturated color except white or black works; the reference sheet uses a purple yoga mat.
    - **Priority:** **P1**. CorridorKey is green-tuned. *Whether it supports other colors is uncertain; the CorridorKey 2.0 repo needs checking.*
28. **Zoom inside tools**
    - **Behavior:** pinch to magnify the preview inside the chroma, crop and mask tools. A reset button restores the view.
    - **Priority:** **Skip** for K.
29. **Scrubber inside tools**
    - **Behavior:** for video, a timeline icon swaps the toolbar for a scrubber so you can check the key, crop or mask at any frame. A tool icon swaps back.
    - **Priority:** **P2**.
30. **Crop tool**
    - **Behavior:** a yellow rectangle. Drag a corner to resize, drag inside to move. A "Constrain" switch locks it to the project aspect ratio. Clear resets it. Works on every source type.
    - **Priority:** **P2**. A "make me smaller box" is not needed when transform exists.
31. **Mask tool**
    - **Behavior:** a static mask over the whole clip duration. Five tools:
      - **Magic wand**: flood fill erase from the tapped seed color, with a live Sensitivity slider that still works after the tap.
      - **Eraser**: size and opacity sliders.
      - **Rectangle** and **Ellipse** erase: opacity.
      - **Paint** (un-erase): size and opacity.
      - Plus undo/redo, clear, **invert**, and a "Size NN / Opacity 100% / Invert" toolbar.
    - **Priority:** **P1** as just "Eraser + Paint-back" with big finger brushes ("rub out the messy bits"). Magic wand, shapes and invert are **P2**.
32. **Automatic person detection**
    - **Behavior:** mentioned in the current App Store listing. It is probably segmentation without a green screen. *Version and UI unknown.*
    - **Priority:** **P1**. On the web, MediaPipe Selfie Segmentation would cover the "no green screen" fallback.

### Transform and motion
33. **Transform (always on)**
    - **Behavior:** no mode is needed. With a clip selected, drag in the preview with 1 or 2 fingers to move it, pinch to scale, twist to rotate, all at the same time. **Double-tap resets.**
    - **Priority:** **P0**. Add big + / - and reset buttons for kids who can't pinch, and mouse equivalents for the web (drag, wheel to scale, corner handles).
34. **Motion path / "Pathing" (v2019+)**
    - **Behavior:** tap and drag the green center dot of an element and draw a path with your finger. The element travels along the path over its duration. Works on text, photos, props and animations. The blog says it must be enabled in **advanced settings** ("advanced drawing tools and pathing").
    - **Priority:** **P1**. "Draw a path and the dinosaur walks along it" is a strong K feature if it's one gesture.

### Camera
35. **Front/back camera**
    - **Behavior:** set in project settings and shared across the whole project.
    - **Priority:** **P0**, as a big flip button.
36. **Tap to focus and expose**
    - **Behavior:** with the camera source selected, tap the preview. A yellow square appears and focus, exposure and white balance adjust there. They reset to center if the scene changes.
    - **Priority:** **Skip**. Browser support is limited.
37. **Lock focus/exposure**
    - **Behavior:** long-press. A "locked" label appears; tap to unlock. While recording with chroma on, exposure and white balance lock automatically, but focus does not.
    - **Priority:** **P2**. Where `MediaStreamTrack.applyConstraints` allows, lock exposure and white balance on record automatically.
38. **Older-device fallback**
    - **Behavior:** if the front camera can't do HD, the app records at low resolution and upscales.
    - **Priority:** N/A. On the web, request 1280x720 and accept what the device gives.

### Playback, recording and export
39. **Live preview / Play**
    - **Behavior:** Play rehearses the composition, with the live camera keyed in real time.
    - **Priority:** **P0**. The live keyed preview *is* the product. The original needs real-time keying; see the CorridorKey risk in section 3.
40. **Record (live camera projects)**
    - **Behavior:** if any layer has a camera source, the main button becomes a red **"Record Video"**. A **5-second countdown** ("Recording in: 5...") runs before recording. A black-square stop button sits under the preview. Recording also stops automatically at the end of the last source.
    - **Priority:** **P0**: giant red button with an animated 5-4-3-2-1 (spoken countdown optional) and a giant stop.
41. **Post-record sheet**
    - **Behavior:** "Your video has been recorded!" with Preview your video / Show the export options / Save to the Camera Roll / Dismiss. Preview shows a player, a **live-vs-prerecorded audio mix** control, and save. Success alert: "Success! The video was saved to the Camera Roll" with OK.
    - **Priority:** **P0**: "Watch it! / Keep it! / Try again" with big icons and confetti on save. The audio mix is P2.
42. **Export Video (no camera)**
    - **Behavior:** a blue "Export Video" button renders offline with a progress bar, then shows "Your video is ready!" with Play and Save. Save opens the iOS share sheet (Save Video, Files, AirDrop, Seesaw...).
    - **Priority:** **P0**: canvas `captureStream` + MediaRecorder, then download or the Web Share API.
43. **"Save" vs "Record" confusion**
    - **Behavior:** FAQ #8. The Save button disappears when any layer contains a camera source, and teachers get stuck when they added the camera by accident.
    - **Priority:** **P0** lesson: make the mode explicit ("Camera is ON" chip on the layer).
44. **Image mode (still capture)**
    - **Behavior:** the VIDEO|IMAGE toggle switches the main button to a green **"Capture Image"**. With the camera, a double-circle shutter takes the photo; without it, the button grabs a still at the playhead. Prompt: "Discard this image / Show the export options / Save to the Camera Roll". The output resolution follows the lowest-resolution source.
    - **Priority:** **P0**. A photo is the easiest kindergarten win ("Take my picture in space!"). Consider making Photo the default.
45. **Share targets**
    - **Behavior:** reference sheets cover Seesaw through the share sheet (pick the student, then a green check) and Canva (a Canva design as the bottom-layer background, portrait orientation).
    - **Priority:** **P1**: Web Share API plus download. Seesaw/Google Classroom deep links are P2.

### Audio
46. **Per-clip audio level**
    - **Behavior:** a speaker icon in the source tools shows a 0-100% slider. It is disabled if the clip has no audio. Camera audio records at 100%.
    - **Priority:** **P1**: a single mute/unmute toggle on background videos.
47. **Audio mix after recording**
    - **Behavior:** balances live mic audio against prerecorded tracks.
    - **Priority:** **P2**.
48. **Music / sound effects**
    - **Behavior:** not present in DoInk (no audio-only tracks).
    - **Priority:** new idea, P2.

### Help
49. **"?" help button**
    - **Behavior:** in the editor top bar; it probably opens in-app help. *Contents unknown.*
    - **Priority:** **P1**: an animated mascot that shows the next step.

## 3. Teacher tips (for a help screen or teacher guide)
- **Backdrop:** bright, fully saturated, matte and non-reflective. Cheap options: dollar-store green plastic tablecloths, an IKEA green shower curtain, green file folders, pizza boxes painted green, green tri-fold boards (Michaels), green fabric.
- **Wall paint:** Behr Disney "Gamma Sector Green", Sherwin-Williams Neon Green 2032-10, Valspar Luscious Green 6010-7, Dulux "chroma key green".
- **Light:** light the backdrop and subject evenly and minimize shadows.
- **Clothing:** no clothing or objects in the key color, or they turn invisible. This makes a fun "invisibility cloak" lesson.
- **Stability:** use a tripod or stand.
- **Experiment:** try different subject-to-screen and camera-to-subject distances, and tune color and sensitivity.
- **More than 3 layers:** export the composition, re-import it on the bottom layer, and add 2 more layers. Repeat as needed (FAQ #11).
- **Background sources:** Free Virtual Sets (YouTube) for newscasts; Pixabay, Photos for Class, Discovery Ed, Creative Commons YouTube.
- **Lesson flows on the reference sheets:**
  - *Green Screen Video*: background on layer 1, green clip on layer 2, Export, Save, Save Video, OK, Done.
  - *Green Screen Photo*: the same flow in Image mode with Capture Image.
  - *Live Camera*: background on the bottom layer, Add the Camera on layer 2, set front/back in Settings, red Record, countdown, black stop, Save to Camera Roll, Success, OK.
  - *Prop Photo*: Prop Library background, then a green image from Moments.
  - *Change Key Color*: purple mat, then tap the purple on the canvas.
  - *Mask*: eraser to hide, paint to restore.
  - *Text*: "D is for Dog" alphabet-book example.
  - *Animate*: draw a flipbook stick figure and path it.
  - *Canva* and *Seesaw* integration.
- **Lessons for UX:** the reference sheets are photo-step guides with **numbered steps, red/green arrows and boxes**, written so a teacher can post them for students. The web app should build that guidance in: highlight the next button, number the steps (1 Background, 2 Me, 3 Go!), and add audio cues.

## 4. Kid-specific UX patterns: what DoInk does and what we should do
- **DoInk's patterns:** simple layer metaphor, live keyed preview, a countdown before recording, double-tap reset, one-tap color picking, auto-on chroma for the upper layers.
- **DoInk's pain points for K** (from the FAQs, the sheets, and an App Store rating of about 2.7-3.3/5):
  - the 5 s image duration trap
  - the hidden double-tap source tools panel
  - Save vs Record confusion
  - text-heavy iOS menus (Moments/Albums/Document Picker)
  - small icons
  - "0 00/60ths seconds" time display
  - nested "Discard / Show export options / Save" dialogs
  - project/camera-roll reference fragility
- **Proposed MVP flow for K (3 big steps, picture-only, voice prompts):**
  1. **Pick a world.** A big tile grid of built-in backgrounds, plus "my picture" upload.
  2. **Put me in.** The camera turns on with automatic keying. Add an optional sticker.
  3. **Snap or Film.** A giant camera icon or a giant red record button, a 5-4-3-2-1 countdown, a giant stop.
  4. **Keep it / Try again,** then a confetti animation.
- **Touch and layout:** touch targets of at least 64-88 px, iPad landscape and portrait, a phone fallback, and mouse/keyboard on the web.
- **Teacher mode:** behind a PIN or long-press. It holds delete, settings, resolution, the advanced key/mask tools, timeline trimming and project export.

## 5. CorridorKey 2.0 integration notes
- **I have not verified the repo yet.** The user requires https://github.com/nikopueringer/CorridorKey2.0 for keying. As far as I know, the original CorridorKey is a Python/PyTorch neural keyer that takes a green-screen frame plus a coarse alpha hint and outputs straight color with a clean alpha. It is GPU-heavy and **not real-time in a browser**.
- **Risk: real-time keying.** DoInk's core experience (live keyed preview during recording) needs real time. Recommended hybrid:
  - (a) a real-time WebGL chroma key with an eyedropper and sensitivity (the DoInk-equivalent algorithm) for the live preview and recording;
  - (b) CorridorKey 2.0 as a "Make it perfect" refinement pass on captured photos and recorded clips. It would run either through ONNX/WebGPU in the browser if the model can be exported and is small enough, or on a server endpoint.
- **Must confirm from the repo:**
  - license
  - model size and format (ONNX availability?)
  - input requirements (an alpha hint mask? — the coarse matte could come from the WebGL key or MediaPipe)
  - whether non-green keys are supported
  - per-frame latency
- **Other:** CorridorKey also outputs despilled foreground color. That fixes the "green shadows / green fringe" problem in FAQ #5.

## 6. Uncertainties
- **Description page:** gave no text, only 5 uncaptioned screenshots.
- **Tutorials:** the 12 YouTube videos were not watched. Gesture timings, animations and the help contents are unknown.
- **Docs coverage:** the official docs (v2.0, 2015) do not cover the v2019+ features (Prop Library, Text, Create Animation, Pathing, Split, Project locked, Orientation, person detection). Their behavior here is inferred from reference-sheet screenshots, the App Store listing and the blog.
- **Chroma algorithm:** the exact color-distance math (hue-based? YCbCr?) and edge softness are unknown. The UI suggests a hue slider plus a sensitivity percentage, with no spill suppression or edge feather controls.
- **Duration behavior:** what happens when a video is shorter than an unlimited camera source (blank, freeze, or loop) is not documented.
- **Output and pricing:** the "video file format" preference options (probably MOV vs MP4) are unconfirmed. Price is listed variously at $4.99 and $7.99.

Sources:
- [Green Screen by Do Ink – App Store](https://apps.apple.com/app/id730091131)
- [Green Screen by Do Ink – App Store (CZ)](https://apps.apple.com/cz/app/green-screen-by-do-ink/id730091131?l=cs)
- [Green Screen by Do Ink – AppFollow](https://apps.appfollow.io/ios/green-screen-by-do-ink/730091131?country=au)
- [DoInk pathing tool – blog](https://blog.doink.com/tagged/DoInk%20pathing%20tool)
- [Pathing in DoInk – blog](https://blog.doink.com/tagged/Pathing%20in%20DoInk)
- [How to animate props – blog](https://blog.doink.com/post/187624699370/how-to-animate-props-in-green-screen-by-doink-one)
- https://www.doink.com/support, https://www.doink.com/description, https://www.doink.com/referencesheets, https://www.doink.com/faqs, https://www.doink.com/tutorials