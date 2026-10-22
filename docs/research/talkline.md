# TalkLine (apphive.us/talkline): design system for a kindergarten app

**Source:** I fetched https://apphive.us/talkline with curl. It is one self-contained HTML file of about 91 KB. All the CSS sits in one inline `<style>` of 16.6 KB, all the JS is one inline `<script>`, and there are no external CSS, JS or font files. I took live screenshots with Chrome DevTools. I saved the extracted source and screenshots in the scratchpad; paths are at the end.

## 1. Color palette (CSS custom properties, quoted verbatim)
```css
:root {
  --grape-50: #eef6ff;  --grape-100: #d9ecff; --grape-200: #b6dbff;
  --grape-400: #5aa9f8; --grape-500: #2f8fef; --grape-600: #1f6fd4; --grape-700: #1b4f9c;
  --sun-100: #fff3cf;   --sun-300: #ffd86b;   --sun-400: #ffc83d;   --sun-500: #ffb703;
  --tang-400: #fb923c;  --tang-500: #f97316;  --tang-600: #ea580c;
  --bubble-400: #f472b6; --bubble-500: #ec4899;
  --mint-400: #34d399;  --mint-500: #10b981;
  --sky: #38bdf8;
  --shadow: 0 18px 50px rgba(27, 79, 156, 0.12);
  color: var(--grape-700);   /* body text = deep blue #1b4f9c, never black */
  background: var(--sun-100);
}
```
The "grape" scale is actually blue. Each color has a job:

| Color | Used for |
|---|---|
| Blue | Main actions and the current step |
| Orange (tang) | Camera and the record button |
| Pink (bubble) | Recording state, errors, delete, drag handles |
| Mint | Finished steps, success, "Play it back", "Make another" |
| Sun (yellow) | Logo and background warmth |

Hard-coded colors that make the "3D" bottom edges:
- `#d98c00` under the logo
- `#0f8d65` under success buttons
- `#be185d` under the record button while recording

Muted text uses transparency, for example `rgba(27,79,156,0.72)`, `0.62` for `.muted`, and `rgba(47,143,239,0.72)` for step labels that are not active.

## 2. Gradients and background
- **Body:** `background: linear-gradient(180deg, var(--sun-100), #ffffff 48%, rgba(56, 189, 248, 0.15));`. This runs from cream at the top, to white, to a light sky blue at the bottom.
- **Three fixed, blurred "blobs" behind everything:** `.blob { width:18rem; height:18rem; border-radius:999px; filter: blur(54px); position:fixed; pointer-events:none }`
  - `.blob-sun`: top-left, `rgba(255,200,61,0.34)`
  - `.blob-sky`: right side at 30% height, `rgba(56,189,248,0.28)`
  - `.blob-pink`: bottom, `rgba(244,114,182,0.22)`
- **Logo tile:** `linear-gradient(180deg, var(--sun-300), var(--sun-500))` plus `box-shadow: 0 3px 0 #d98c00`.
- **Progress bar:** `linear-gradient(90deg, var(--grape-400), var(--grape-600))`.
- **Main panel is frosted glass:** `background: rgba(255,255,255,0.58); border: 1px solid rgba(255,255,255,0.68); border-radius: 2rem; box-shadow: var(--shadow)`.

## 3. Typography
- **Body font:** `font-family: "Quicksand", ui-rounded, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;`
- **Headings and wordmark:** `font-family: "Baloo 2", "Quicksand", ui-rounded, system-ui, sans-serif;`
- **The named fonts never load.** There is no Google Fonts link and no @font-face. On Apple devices the text actually renders in **SF Pro Rounded** through `ui-rounded`, which is what the screenshots show. For our app, load Baloo 2 (800/900) and Quicksand (500–700) from Google Fonts, or keep the `ui-rounded` stack.
- **Weights are heavy throughout:** 900 for buttons, headings, step numbers, the timer and choice titles; 800 for labels and messages.

| Element | Size and settings |
|---|---|
| Wordmark | `1.7rem / 900`, each letter a different color: `Talk` + pink **L**, sun **i**, mint **n**, blue **e** |
| Step h1 | `clamp(1.6rem, 3vw, 2rem)`, line-height 1.1 |
| Record timer | `1.9rem / 900` |
| Choice title | `1.08rem / 900` |
| Large button | `1.03rem` |
| Muted text | `0.9rem` |
| Step label | `0.72rem / 800` |
| Curve label | `0.64rem / 900` |

## 4. Border radii
- `999px` (fully round): every button, pill, icon button, step circle, progress track and handle.
- `2rem`: main panel.
- `1.5rem`: cards (choice, record, tray, result), photo stage, video, camera box.
- `1rem`: logo tile, choice icon tile, sticker tiles, messages, hint toast, step buttons.
- `0.55rem`: the stop square in the record button.

## 5. Shadows
There are two kinds, and both use the brand's deep blue tint `rgba(27,79,156,…)` rather than black:
- **Hard, "chunky 3D" bottom edge with no blur.** This is the main button look.
  - `.button`: `0 4px 0 var(--grape-600)`
  - `.button.secondary`: `0 3px 0 var(--grape-200)`
  - `.success`: `0 4px 0 #0f8d65`
  - Record button: `0 7px 0 var(--tang-600)`
  - Active step circle: `0 3px 0 #1f6fd4`
- **Soft and floating:**
  - Panel: `0 18px 50px rgba(27,79,156,.12)`
  - Stage: `0 15px 35px rgba(27,79,156,.16)` plus `outline: 4px solid #fff`
  - Cards: `0 12px 30px rgba(27,79,156,.1)`
  - Icon buttons: `0 5px 15px rgba(27,79,156,.18)`
  - Sticker tiles: `0 5px 12px rgba(27,79,156,.1)`

## 6. Buttons and touch targets
```css
.button { border:0; border-radius:999px; padding:.75rem 1rem; font-weight:900; color:#fff;
  background:var(--grape-500); box-shadow:0 4px 0 var(--grape-600);
  transition: transform 120ms ease, background 160ms ease, opacity 160ms ease; }
.button:hover { background: var(--grape-400); }
.button:active { transform: translateY(2px); box-shadow: 0 2px 0 var(--grape-600); }  /* press-down */
.button:disabled { opacity:.5; transform:none; }
.button.secondary { color:var(--grape-600); background:#fff; box-shadow:0 3px 0 var(--grape-200); }
.button.ghost { background:transparent; box-shadow:none; }
.button.success { background:var(--mint-500); box-shadow:0 4px 0 #0f8d65; }
.button.large { padding:.85rem 1.15rem; font-size:1.03rem; }
```
Sizes of the main touch targets:

| Element | Size and style |
|---|---|
| Record button (hero) | `10rem × 10rem` (160px) circle in orange, with a `4rem` mic icon. While recording it turns pink and shows a white `3rem` stop square. A pink ring behind it (`rgba(236,72,153,.25)`, 10.5rem) grows and shrinks with how loud the voice is (`transition: width 80ms linear`). |
| Camera snap button | `5rem` white circle with an orange `3.5rem` inner dot and `outline: 4px solid var(--grape-400)` |
| Play overlay | `5rem` white circle over the photo |
| Choice cards | `min-height: 12rem`, `border: 4px dashed var(--grape-200)` (blue) or `rgba(251,146,60,.56)` (orange for the camera card). Each has a `4rem` rounded icon tile in a pale tint. Pressing gives `transform: scale(0.97)`. |
| Icon buttons (zoom) | `2.5rem` circles, `rgba(255,255,255,.92)` |
| Pills (sticker tabs) | `padding:.45rem .8rem`, `--grape-100` background; active is `--grape-500` with white text |
| Sticker grid | `repeat(5,1fr)` on phones, `repeat(6,1fr)` at ≥640px; square tiles with `aspect-ratio:1` on white |
| Drag handles | `1.35rem` pink dots, mid handle `1.55rem` blue, `border: 3px solid #fff`, `0 3px 8px rgba(0,0,0,.24)` |
| Selected-sticker tools | `1.8rem` round buttons on the corners: pink ✕ delete at top-left, blue resize at bottom-right |

## 7. Icons and illustration
- **UI icons** are inline SVGs on a 24×24 grid, line style: `fill:none; stroke:currentColor; stroke-width:2.2–2.6; stroke-linecap:round; stroke-linejoin:round`. They match the text color and look friendly and rounded. Examples: upload arrow into a tray, camera, + and − zoom, reset, mic, play, check, ✕.
- **Logo** is a simple SVG face: a light blue circle `#7cc6f5` with stroke `#2f8fef`, dot eyes and a smile in `#1b3a6b`, sitting on a yellow gradient tile.
- **Stickers** are hand-built SVGs on a 100×100 grid with flat fills and a thick darker outline in the same hue (`stroke-width 3.5–5`, round joins). No emoji fonts are used.
  - Shapes pack: star `#fbbf24`/`#f59e0b`, heart `#fb6f92`/`#e11d6f`, sparkle `#67e8f9`/`#06b6d4`, sunglasses, top hat, crown `#fcd34d`/`#d97706`, speech bubble with a `#7c3aed` stroke, mustache, bow, lightning bolt, rainbow, flower.
  - Faces pack: a yellow `#ffd83d` face with `#e6a700` outline in Happy, Laughing, Cool, Heart eyes, Silly, Star eyes, Surprised, Sad, Wink and Sleepy. Facial features are `#3a2a00`.
  - Placed stickers get `filter: drop-shadow(0 2px 4px rgba(0,0,0,.25))`.

## 8. Animation and motion
- **Step change pops in:** `animation: pop-in 280ms cubic-bezier(0.34, 1.56, 0.64, 1) both;`
  ```css
  @keyframes pop-in { 0%{opacity:0;transform:scale(.86)} 60%{transform:scale(1.03)} 100%{opacity:1;transform:scale(1)} }
  ```
- **Active step** grows to `transform: scale(1.05)` (160ms ease).
- **Buttons** press down 2px and their hard shadow shrinks from 4px to 2px (120ms).
- **Cards** shrink to `scale(.97)` on press.
- **Hint toast** fades out over 500ms (`.hint.hidden { opacity:0 }`). It is a dark blue pill, `rgba(27,79,156,.78)`, with white 900-weight text.
- **The record ring** follows the live microphone level, so kids see that the app is hearing them.
- **Reduced motion is respected:** `@media (prefers-reduced-motion: reduce)` sets all animations and transitions to 1ms.

## 9. Layout and navigation
- **One centered column:** `.app-shell { width:min(100%, 44rem); min-height:100dvh; margin:0 auto; padding:1rem; display:flex; flex-direction:column }`. Content blocks are capped at `width:min(100%, 28rem)`.
- **Order on the page:** logo bar, then a **numbered 5-step stepper** (Photo, Mouth, Voice, Stickers, Save), then one glass panel, then a small footer ("Everything you make stays on your device." with a lock icon).
- **Stepper behavior:**
  - Circles are `2.35rem`, joined by `0.25rem` lines.
  - Each step is pale blue by default, solid blue with a 3D edge when current, and mint with a ✓ when done.
  - Steps not yet reached are disabled (`opacity:.52`). Kids can tap back to any step they have already visited.
- **Each step uses the same shell:** a big h1 (for example "Pick a photo"), a one-line friendly subtitle ("Choose a fun face - a pet, a drawing, or you!"), the body, then a nav row with **Back** (secondary) on the left and **Next: \<what comes next\>** (large, primary) on the right. Next stays disabled until the step is done.
- **Phone layout (<640px):**
  - The nav row is a **sticky bottom bar** (`position:sticky; bottom:0; background:rgba(255,255,255,.88); backdrop-filter:blur(12px); padding-bottom:max(.75rem, env(safe-area-inset-bottom))`).
  - Choice cards stack vertically and the logo is centered.
- **≥640px (tablet and desktop):** the nav row is a normal row inside the panel, the logo moves left, the choice cards sit side by side in 2 columns, and the sticker grid has 6 columns.
- **Touch handling:**
  - `-webkit-tap-highlight-color: transparent`, `overscroll-behavior-y: none`, `touch-action:none` on drag layers, and `-webkit-touch-callout:none`.
  - The page includes `apple-mobile-web-app-capable` meta tags.
  - The camera opens in a full-screen dialog with a blurred deep blue background (`rgba(27,79,156,.92)`, `backdrop-filter: blur(8px)`).

## 10. How it keeps things simple for young children
1. **Linear wizard with one task per screen.** The five steps are numbered and named with single words. There is never more than one main action.
2. **Very large targets.** The record button is 160px, choice cards are at least 192px tall, the snap button is 80px, and the play button is 80px.
3. **Few words, plain wording.** Headings are 2–3 words. Subtitles are one encouraging sentence ("Tap the big button and say something fun!"). Buttons are verbs, and Next always names what comes next ("Next: Stickers").
4. **Color tells you what to do.** Blue moves you forward, green means done or play, pink means recording or delete, orange means camera or mic. Finished steps turn green with a checkmark.
5. **Immediate visual feedback.** Buttons look physically pressed, the voice ring pulses with sound, there is a live timer ("0.0s", then "Got it! 3.2s recorded"), and a success line appears ("Looks great! Tap Next to keep going.").
6. **Safe defaults.** Next is disabled until the step is complete. "Re-record", "Choose a different photo" and "Make another" make it easy to try again. Error messages are friendly and suggest an alternative ("Upload audio instead").
7. **Privacy you can see, for teachers.** All processing happens on the device, there is no account, and the footer says so in one line.
8. **No sound cues, voice prompts or TTS.** The only audio is the child's own recording. A kindergarten version should add spoken instructions and tap and success sounds, because many children this age cannot read yet. TalkLine does not have these.
9. **Pictures over words.** Each choice card pairs a 4rem icon tile with a title. Stickers are picture-only tiles with no captions.

## Applying this to a green-screen app
Reuse the tokens, the frosted-glass panel, the chunky 3D pill buttons, the pop-in step transition and the numbered stepper as-is. A natural flow would be **Background → Me (camera with live keying) → Record → Stickers → Save**. Copy the 160px hero record button. Add spoken prompts and sound effects (point 8), and load Baloo 2 and Quicksand properly.

## Files
- /private/tmp/claude-501/-Users-md-Green-Screen-2/727545c3-c535-41ef-933d-42d65e406914/scratchpad/talkline/desktop-step1.png (1280×900 window; the capture came out 1024×768 @2x)
- /private/tmp/claude-501/-Users-md-Green-Screen-2/727545c3-c535-41ef-933d-42d65e406914/scratchpad/talkline/mobile-step1.png (390×844 @3x)
- /private/tmp/claude-501/-Users-md-Green-Screen-2/727545c3-c535-41ef-933d-42d65e406914/scratchpad/talkline/ipad-step1.png (1024×768 @2x landscape)
- /private/tmp/claude-501/-Users-md-Green-Screen-2/727545c3-c535-41ef-933d-42d65e406914/scratchpad/talkline/raw/page.html (full source)
- /private/tmp/claude-501/-Users-md-Green-Screen-2/727545c3-c535-41ef-933d-42d65e406914/scratchpad/talkline/raw/style.css (all the extracted CSS)
- /private/tmp/claude-501/-Users-md-Green-Screen-2/727545c3-c535-41ef-933d-42d65e406914/scratchpad/talkline/raw/rest.txt (markup and JS, with data URIs removed)

I only screenshotted step 1. Steps 2–5 need a photo and microphone access, so I described them from their markup and CSS instead.