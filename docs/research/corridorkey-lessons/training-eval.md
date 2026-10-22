# What CorridorKey's training, evaluation and user reports teach our real-time keyer

Sources were read through `gh api` only, and no CorridorKey code was run. Citations are `repo/path:line`, where v1 means `nikopueringer/CorridorKey@main` and v2 means `nikopueringer/CorridorKey2.0@master`. Issue and PR numbers are on v1 unless marked otherwise. All code below is my own, and the techniques are named after their published sources.

## 0. What is actually known about how CorridorKey was trained and tested

**The authors have published no training code, dataset, loss terms or evaluation set for either version.**
- v1 README:190-192 says the training program and datasets will be uploaded "if enough people find this project interesting".
- v1 docs/LLM_HANDOVER.md:63 says training logic was "deliberately stripped" and lives in a separate trainer ("coming soon, maybe?").
- On #152 and #167 the owner promised a dataset release "in a few weeks". #86, #94 and #167 are still open asking for it.

**What can be pieced together:**

| Fact | Source | Confidence |
|---|---|---|
| Trained on coarse, blurry, eroded alpha hints. Good at filling in from a hint, weak at removing extra hint area when the hint is too big. | v1 README:109 | Author |
| Trained on 2048×2048 crops. Inference resizes to 2048 and back with Lanczos. | v1 LLM_HANDOVER.md:39-41; v1 CorridorKeyModule/README.md:6,24 | Author |
| The backing in training was "a variety of colors between blue and yellow", not only green. It is not a general background remover. | owner on #39; #105 cites the Corridor video at t=1184 s ("randomly coloured backgrounds") | Author / user (I did not watch the video) |
| A clean plate of the empty screen was "part of the process". | owner on #114 | Author |
| Training images were CGI subjects **composited** onto background plates, not rendered together with them, so spill was not physically simulated. That is why there is a separate despill step. | #74 (users, from the video) | User inference |
| v1 fine-tunes Hiera from MAE/IN1k weights. The 4th (hint) input channel starts at zero. | #152, #77, #158 logs | User plus logs |
| v2 has MAE pretraining hooks, a "phase-2 training", deep supervision at /2 and /64, RoPE augmentations, and a "dataset contract" that images are multiples of 64 or 128 px. | v2 corridorkey/model.py:10-22,96-110; stage1.py:28-29 | Code comments |
| v2 trains and infers in a signed-asinh HDR linear space, with bf16 giving about 1–2 % relative error. | v2 color_utils.py:98-128; README:351-354 | Code / author |
| v2 lets you say how much to trust a hint (`hint_quality`: 0.95 artist matte, 0.75 automatic, ≤0.5 loose). Frames with no hint inside a hinted window get quality 0. | v2 README:188-215 | Author |
| v2 memory tables were measured "on synthetic test clips". | v2 README:423 | Author |

**Community evaluation work (unmerged, but the design is useful).** I read the PR descriptions, not the code.
- **PR #267** "model-quality benchmark fixtures and metrics" defines four metrics:
  - alpha MAE;
  - foreground MAE where α > 0.01;
  - boundary MAE on 0.01 < α < 0.99 plus a morphological band;
  - recomposition MAE, `Ĉ = α̂F̂ + (1−α̂)B`.

  It also defines 7 generated cases, `opaque_subject, soft_hair, motion_blur, green_foreground, blue_foreground, bad_hint_eroded, bad_hint_dilated`, and keeps "zero binary files tracked in git".
- **PR #268** adds a hint-corruption sweep: erosion, dilation, holes, false islands, blur and edge jitter at 4–16 px, 12 profiles in all. It splits error into **FP α** (background showing through) and **FN α** (foreground lost). Its finding: dilation by 16 px gives fp 0.21 / fn 0.01, and erosion by 16 px gives fn 0.42 / fp 0.004. Global MAE hides this asymmetry.
- **#129 (comment):** the backing problems that break keys in practice are *low-frequency*: hotspots and falloff, wrinkles and cast shadows read as dark edges, and colour bounce on the subject. The commenter also asks for a hair-boundary metric next to recomposition error, so that "dirty screen" robustness is not bought by losing hair.
- **#246:** a fixture list for screen-colour auto-detection: dim plates, close-ups that hide the background, magenta backlight, a subject wearing the screen colour, sodium mixed light, and rough masks.

---

## 1. Techniques to adopt (each new, or sharper than what recommendation.md already has)

### T1 (P0): A synthetic fixture generator with known alpha, plus an objective metric harness

**(a) What CorridorKey does.**
- It trains on CGI composites where alpha and foreground are known exactly (§0).
- Its community harness generates fixtures in code and scores alpha, foreground, boundary and recomposition, split into FP and FN (PR #267, #268).
- v2 sizes its runtime from synthetic clips (v2 README:423).

**(b) Why it matters.** Our `make_fake_camera.py` draws hard-edged shapes and writes no ground truth. That means the e2e test can only check that something renders and how fast. We currently cannot tell whether the LUT key, guided filter, EMA, choke or despill made a matte better or worse.

**(c) Approach.**
- Write `web/e2e/fixtures/make_keyer_fixtures.py` (stdlib only), with the full spec in §2.
- Add a deterministic in-browser harness that feeds decoded Y4M frames into `Compositor` and reads back the matte, plus `metrics.ts` (§3).
- Cost: none at runtime. Generation takes about 20–60 s per scenario at 640×360×90 frames in pure Python.

**(d) Visible improvement.** Indirect but large: every later tuning step (thresholds, `u_temporal`, `eps`, choke, despill) gets a number and a regression gate.

**(e) Priority: P0.**

### T2 (P0): Treat ML-mask fusion as deliberately asymmetric, add a mask-age trust term, and test it with a corruption sweep

**(a) What CorridorKey does.**
- The model learned to *grow* from eroded hints but cannot *remove* area from dilated ones (v1 README:109). Users hit this as "half the frames bleed green" (#184), and PR #268 measured it.
- v2 passes a scalar trust per hint, `hint_quality` (v2 README:188-215).
- v2 also feeds its own previous predictions forward as a hint with separate trust, "Hann carry" (v2 README:131-141, 163-165).

**(b) Why it helps.**
- Our plan already uses the ML mask in only two ways: a dilated "garbage" matte that may only remove, and an eroded "core" matte that may only add. That is the right lesson.
- What's missing is that MediaPipe runs every 2nd or 3rd frame and lags 1–2 frames. A stale mask behind a waving arm is exactly the "dilated hint in the wrong place" case.
- Trust should therefore fall with mask age and scene motion: the garbage matte loosens and the core matte tightens. This mirrors v2's quality scalar.

**(c) GLSL sketch (original).** Changes to the `FG_FS` ML block. `u_maskAge` is the number of camera frames since the mask was produced; `u_motion` is the mean |ΔY| from the existing 1/16 readback.
```glsl
uniform float u_maskAge, u_motion;
float trust = exp2(-u_maskAge / 3.0) * (1.0 - smoothstep(0.03, 0.12, u_motion));
vec2 gm = texture(u_maskPrep, uv).rg;
// Stale mask: kill less (garbage threshold drops toward 0) and fill less (core needs higher confidence).
float garbage = smoothstep(0.05 * trust, 0.05 * trust + 0.30, gm.r);
float core    = smoothstep(mix(0.97, 0.75, trust), mix(0.995, 0.95, trust), gm.g);
float fused   = max(aKey * garbage, core);
a = mix(aKey, fused, u_mlWeight * mix(0.5, 1.0, trust));
```
- JS side: `u_dilateStep = 3.0 + 1.0 * min(maskAge, 3)` in `MASK_PREP_FS`.
- Cost: about 6 ALU ops per pixel, no extra fetches, effectively 0 ms.

**Test.** Build ML masks from the generator's ground truth at 256×256 and pass them through `setMaskData`, using the corruption profiles in §2.4. Add lag of 1, 2 and 3 frames and cadence dropout to PR #268's set. Pass rule: **FP_bg and FN_fg must not exceed the chroma-only run by more than 10 % for any profile.** In other words, a bad mask must never make things worse than no mask.

**(d) Visible improvement.** Removes the green "halo ghost" trailing a fast-waving arm when the mask is late. It also stops a stale core matte from filling the background behind a moving kid.

**(e) Priority: P0**, because it guards the Tier 2 design itself.

### T3 (P1): Flatten the screen with a clean plate or running plate (low-res gain map)

**(a) What CorridorKey does.**
- The clean plate was part of training (owner on #114).
- The #129 discussion says low-frequency backing variation (hotspots, falloff, wrinkles) is what breaks keys.
- recommendation.md lists the BGMv2 plate idea only as a "possible P3". The author's confirmation, plus our classroom conditions, justify a cheap version now.

**(b) Why it helps.** keyD handles *darkening* well through its shadow gain. It handles hue shifts across a cheap, unevenly lit screen less well: falloff toward fluorescent tubes, paint-roller patches, a faded poster board. Normalising each pixel by the local screen colour lets the global thresholds `lo` and `hi` tighten. This is the classic "screen correction" step in hardware keyers.

**(c) Approach.**
- Keep a 160×90 RGBA8 gain map, rebuilt in a tiny pass. Each cell is updated by EMA (w = 0.1) from the 1/8 downsampled camera frame only where the 1/8 matte < 0.05 (a running plate).
- On the first second of an empty screen, use w = 1.
- Run a 2-level push-pull to fill cells hidden by the kid.
- Store gain in the sRGB domain, `(keySrgb / plateSrgb)` clamped to [0.6, 1.8], so the per-pixel cost is one fetch and one multiply.
- Use the flattened colour **only for the LUT lookup**. Displayed colour and despill stay on the raw pixel.
```glsl
// MATTE_FS: before the LUT fetch
uniform sampler2D u_gain;   // 160x90, rgb = gain/2 (so 1.0 -> 0.5), a = confidence
uniform float u_flatten;    // 0..1
vec4 gm = texture(u_gain, v_uv);
vec3 ck = clamp(c * mix(vec3(1.0), gm.rgb * 2.0, gm.a * u_flatten), 0.0, 1.0);
vec2 k = texture(u_keyLut, ck * ((LUT_N - 1.0) / LUT_N) + 0.5 / LUT_N).rg;
```
```glsl
// PLATE_FS @160x90, ping-pong: u_cam8 = camera at 1/8, u_matte8 = matte at 1/8
vec3 cam = texture(u_cam8, v_uv).rgb; float bg = 1.0 - smoothstep(0.02, 0.08, texture(u_matte8, v_uv).r);
vec4 prev = texture(u_prevPlate, v_uv);
vec3 plate = mix(prev.rgb, cam, bg * u_rate);           // u_rate 0.1 (1.0 during empty-screen capture)
float conf = clamp(prev.a * 0.995 + bg * 0.05, 0.0, 1.0); // decays slowly where never seen
o = vec4(plate, conf);  // gain = clamp(u_keySrgb / max(plate,1e-3), .6, 1.8) computed in a 2nd tiny pass
```
- Camera bump detection: if the median background residual |ΔE| across confident cells exceeds 8 for 10 frames, reset confidence.
- Cost: about 0.05 ms for the plate passes plus one extra fetch per pixel in the matte pass.

**(d) Visible improvement.** Corners and folds of a wrinkly bedsheet or poster board stop "sparkling" through. Auto-key can choose tighter thresholds, which keeps more hair and fewer green fringes. The "screen too wrinkly" warning fires less often.

**(e) Priority: P1.** Score it on S01, S02, S03 and S18 (§2.3). Ship only if band SAD improves by at least 15 % with no FN_fg regression on S11 (green clothing).

### T4 (P1): Island removal by temporally amortised morphological reconstruction (low res)

**(a) What CorridorKey does.** Its "auto-despeckle" removes disconnected islands smaller than 400 px. The recipe is: threshold, keep large connected components, dilate, blur, then multiply that "safe zone" into alpha (v1 README:31,185; v1 CorridorKeyModule/core/color_utils.py:422-470; called at v1 inference_engine.py:270-272; defaults at :406-408). It runs *before* despill. The README notes it is "not just for tracking dots".

**(b) Why it helps.** Classrooms add tape, binder clips, thumbtacks, poster edges and noisy dark corners. Each leaves small specks that flicker on the virtual background. Full connected-component labelling per frame is too costly on a GPU. Plain opening (erode then dilate) would cut off fingers.

**(c) Approach.** Use opening-by-reconstruction (Vincent 1993, published) at 1/4 resolution, carrying the reconstruction from the previous frame so each frame needs only a few geodesic dilation steps:
```glsl
// MORPH_FS @ 320x180 (1/4 of 720p). u_mode: 0 = erode(min 3x3), 1 = geodesic dilate (max 3x3, then AND with mask)
uniform sampler2D u_src, u_mask; uniform vec2 u_tx; uniform int u_mode;
void main(){
  float m = u_mode == 0 ? 1.0 : 0.0;
  for (int j=-1;j<=1;j++) for (int i=-1;i<=1;i++){
    float s = texture(u_src, v_uv + vec2(i,j)*u_tx).r;
    m = u_mode == 0 ? min(m, s) : max(m, s);
  }
  if (u_mode == 1) m = min(m, step(0.5, texture(u_mask, v_uv).r));  // stay inside current mask
  o = vec4(m, 0, 0, 1);
}
// Per frame:
//   marker = max(erode^3(mask), min(prevRecon, mask), coreML)
//   recon  = geoDilate^4(marker)
//   safe   = blur3(dilate1(recon))
// FG_FS:  a *= max(texture(u_safe, uv).r, coreFill);   (bilinear upsample)
```
- What it removes: anything smaller than about 7×4 ≈ 28 px across at 720p that never contained a large core.
- What it keeps: fingers, hair outlines and held props, because they are connected to the kid's core.
- It needs about 9 passes at 57.6K px, roughly 5M fetches. Estimated cost is 0.2–0.4 ms on A13 (to be measured).

**(d) Visible improvement.** No more speckles from tape and clips, and no twinkling corner noise. Thin features are kept.

**(e) Priority: P1.** Score on S16 (tape and clips) with the island count, and S05 (hair) as a guard.

### T5 (P1): A "stage box" garbage matte, suggested automatically from the screen

**(a) What CorridorKey does.** It multiplies alpha by a dilated garbage matte (v1 color_utils.py:186-207). Users asked for a processing box (#180). v2's no-hint mode "may pick a different subject" when several are plausible (v2 README:110-115).

**(b) Why it helps.** Classroom screens are often smaller than the camera view. Walls, whiteboards, classmates and the teacher are not green, so the chroma key keeps them. MediaPipe keeps any *person*.

**(c) Approach.**
- Suggest a box automatically: take the bounding box of confident plate cells with keyD < `hi` (from T3), padded by 2 %.
- The teacher can drag the corners in a teacher-gated mode.
```glsl
uniform vec4 u_box;  // x0,y0,x1,y1 in uv; u_boxSoft = 0.01
vec2 q = min(uv - u_box.xy, u_box.zw - uv);
a *= smoothstep(0.0, u_boxSoft, min(q.x, q.y));
```
- Cost: about 0.

**(d) Visible improvement.** Removes the whiteboard edge, door frame and classmates walking past at the sides.

**(e) Priority: P1.** Score on S13.

### T6 (P1): A robust border key sampler (cover, dim and ambiguity guards)

**(a) What CorridorKey does.** It auto-detects screen colour from the mean of background pixels on the first frame. Its guards are coverage ≥ 1 % and |G−B| ≥ 0.05, with a fall-back to green (v1 color_utils.py:329-383). #246 lists how this fails: close-ups that hide the background, dim plates, subjects wearing the screen colour, mixed light.

**(b) Why it helps.** Our `pickKeyColor` samples the frame border. A kindergartner standing close to the iPad covers the border. A green shirt inside the border sample pulls the key toward the shirt.

**(c) JS sketch (original).**
```js
// segments: 24 border cells, each {lab:[L,a,b], n} averaged in linear RGB then -> Lab
export function robustBorderKey(segments, prevKey, deltaE00) {
  const cand = segments.filter(s => s.n > 0 && Math.hypot(s.lab[1], s.lab[2]) > 15 && s.lab[0] > 12);
  if (cand.length < 8) return { key: prevKey, status: 'border-covered' };       // close-up guard
  const med = [0,1,2].map(i => median(cand.map(s => s.lab[i])));
  const inl = cand.filter(s => deltaE00(s.lab, med) < 10);
  if (inl.length < 0.6 * cand.length) return { key: prevKey ?? med, status: 'ambiguous' };
  const key = [0,1,2].map(i => inl.reduce((t, s) => t + s.lab[i] * s.n, 0) / inl.reduce((t, s) => t + s.n, 0));
  return { key, status: med[0] < 25 ? 'too-dark' : 'ok' };                      // dim-screen guard -> "add light"
}
```
- Cost: CPU only, under 0.1 ms every 2 s.

**(d) Visible improvement.** The key no longer jumps to the kid's shirt when they lean in. The app gives a clear "add light" prompt instead of a bad key.

**(e) Priority: P1.** Score on S14 and S17.

### T7 (P2): Despill colour regression set and luminance check

**(a) What CorridorKey does.**
- Average-limit despill puts the removed energy back half into each of the other channels (v2 corridorkey/runtime.py:604-614, default strength 0.5 at README:290).
- v1 offers both "average" and "max" limits (v1 color_utils.py:210-230), and its handover stresses "luminance-preserving despill" (LLM_HANDOVER.md:22).
- #195 shows the average limit destroying violet when channels are swapped for a blue screen.
- PR #179 found a despill test that passed trivially because the grey mock had no spill to remove.

**(b) Why it helps.** We use the max limit inside the subject and the average limit at edges. The fixture set must include colours where each limit fails.

**(c) Approach.** No shader change. Add GT foreground swatches to S05 and S12: yellow (1,1,0), violet (0.6,0.2,0.9) on a blue screen, teal (0,0.6,0.6), lime and skin tones. Assert:
- ΔE00 of the despilled foreground versus ground truth is ≤ 3 at α = 1;
- green residual `max(G − max(R,B), 0)` in the edge band is < 0.02;
- every fixture actually contains spill (pre-despill residual > 0.05), so the test cannot pass vacuously (the #179 lesson).

**(d) Visible improvement.** Yellow shirts stay yellow, blond hair is not greyed, and skin does not darken.

**(e) Priority: P2.**

### T8 (P2): Temporal metrics and an offline bidirectional window for "Make it Magic"

**(a) What CorridorKey does.**
- v1 had visible temporal flicker (#72; "texture alternates" on a semi-transparent cup, #191).
- #113 suggests recurrent memory.
- v2 answers with overlapping temporal windows combined by a Hann taper (v2 README:217-250), giving better continuity with larger windows.

**(b) Why it helps.**
- Live: our motion-gated EMA is the real-time version. It needs a ghosting metric as well as a flicker metric, so `u_temporal` can be tuned.
- Offline re-render: a symmetric window (past and future) has no lag.

**(c) Approach.**
- Offline: `α_t = Σ_k w_k·g_k·α_{t+k} / Σ w_k·g_k` with k ∈ [−3, 3], Hann weights `w_k = cos²(πk/8)`, and motion gate `g_k = 1 − smoothstep(.02, .10, |Y_t − Y_{t+k}|)`.
- This is 7 matte fetches per pixel in the offline pass only, so no real-time cost.

**(d) Visible improvement.** Recorded clips get rock-steady edges with no trailing ghost.

**(e) Priority: P2.**

### T9 (P2): Exposure, transfer and range consistency checks

**(a) What CorridorKey does.**
- A tracked bug mixed gamma 2.2 with piecewise sRGB, a 4.7 % difference at linear 0.01 (#28).
- "Crushed shadows or dark fringes" are blamed on conversion order (LLM_HANDOVER.md:38,71).
- v2 has test-only linear brightness and contrast controls with pivot 0.18 (v2 README:553-567).
- HDR highlights above 1.0 were clamped in v1 (#146).

**(c) Approach.**
- Generate S00 with an exposure sweep of −1, −0.5, +0.5 and +1 stop, applied in linear light.
- Add a full-range versus limited-range YUV variant (Chrome's `C420jpeg` is full range; iPad camera paths are usually limited range).
- Assert band SAD stays within 1.3× of nominal.
- Add a unit test that `labKey.srgbToLinear` matches the IEC piecewise curve, not gamma 2.2.

**(e) Priority: P2.**

---

## 2. Spec: `web/e2e/fixtures/make_keyer_fixtures.py` (Python stdlib, deterministic)

### 2.1 Outputs per scenario `<id>`

| File | Content |
|---|---|
| `<id>.y4m` | Camera clip, `YUV4MPEG2 W640 H360 F30:1 Ip A1:1 C420jpeg` (full-range BT.601, same as the existing file). `--hd` gives 1280×720. Works as Chrome's fake camera. |
| `<id>.alpha.y4m` | Ground-truth α in the Y plane (0–255), U and V = 128. Same frame count. |
| `<id>.fg.y4m` | Ground-truth **straight, unspilled** foreground (sRGB→YUV). Black where α = 0. |
| `<id>.ml/####.u8` | Optional. 256×256 R8 "segmenter masks" made from ground truth plus a corruption profile (§2.4), one per *mask frame* (cadence 1/2/3). |
| `<id>.json` | Manifest: seed, all parameters, per-frame tags (`fast`, `shadow`, `awb`, `flicker`, `mask_frame`), region boxes (`hair`, `hand`, `shadow`, `tape`, `prop`), `ml_only` flag, and the frame-ID strip box excluded from metrics. |

Do not commit the outputs. Generate them in CI with `npm run fixtures`, cached by a hash of script and arguments, as PR #267 does. Keep the existing `fake-greenscreen.y4m` for the fps smoke test.

### 2.2 Render model (everything in float **linear light**, then encoded once)

1. **Subject geometry as signed distance fields** (circle, capsule, rounded rectangle, ellipse). Pixel coverage is `cov = clamp(0.5 − sd, 0, 1)`, which gives analytic anti-aliasing without supersampling. Shapes are combined front to back with "over": `α ← α + (1−α)·cov`, `P ← P + (1−α_prev)·cov·F_shape`.
2. **Hair:** 150–400 strands as capsules of radius 0.25–0.6 px along jittered quadratic curves around the head outline. This gives true partial α of 0.05–0.7 that ground truth knows exactly.
3. **Motion blur:** for tagged frames, render S = 8 sub-frames across the shutter (`shutter = 0.5` → 1/60 s) and average **premultiplied** colour and α. This is the physically correct blur alpha. Render only inside the subject's bounding box for speed.
4. **Spill (on the observed foreground only; ground truth keeps F):** `F_obs = F + k·screen_lin·rim`, where `rim = clamp(1 − blur_r12(α_core), 0, 1)` (blur by repeated box at 1/4 res). Use k_skin = 0.12, k_hair = 0.35 and k_shirt = 0.08 per material, plus a uniform term k_amb = 0.03 for green bounce light over the whole subject.
5. **Backing B(x, y, t)** = screen colour × lighting field:
   - Vignette: `1 − v·r²`, v = 0.2–0.45.
   - Side gradient: 1.0 to 1.6 left to right.
   - Hotspot: `1 + h·exp(−d²/2σ²)`, h up to +1.3 stops, clipped later.
   - Wrinkles: `1 − w·max(0, sin(2π(x·cosθ + y·sinθ)/λ + φ(y)))^4`, with 4–8 folds, w = 0.15–0.35 and λ = 60–140 px, plus 2 sharp crease lines with a 1-px dark core.
   - Sag: a quadratic darkening band at the top.
   - **Ground truth α is 0 everywhere on the backing.**
6. **Kid's cast shadow:** the subject's α translated by (dx, dy) = (30–60, 5–15) px and blurred with r = 10–20 px. Then `B ← B·(1 − ρ·shadow)`, with ρ = 0.35–0.65 and a slight cool tint (×(0.97, 1.0, 1.04)). Ground truth α stays 0.
7. **Composite:** `C = α·F_obs + (1−α)·B` in linear light. Classroom-wall and whiteboard regions (S13) are drawn as backing with `ml_only` tags.
8. **Camera model, in order:**
   1. Exposure (stops) × AWB gains `(g_r, 1, g_b)(t)`.
   2. Flicker: `× (1 + m·sin(2π·f·(t + row·t_line)))`, with f = 100 or 120 Hz, m = 0.04–0.10 and `t_line = 0.8/(30·H)` for a rolling shutter.
   3. Poisson–Gaussian noise: `σ² = a·I + b`, with a = 2e-4 to 1.5e-3 and b = 1e-6 to 2e-5, cycled from 8 precomputed noise fields for speed.
   4. Clip to [0, 1].
   5. Piecewise sRGB OETF.
   6. BT.601 full range to YUV.
   7. **4:2:0 box chroma subsampling**, the main real-world source of chroma edge stair-steps.
   8. Optional blockiness.
9. **Blockiness (stdlib):** per 8×8 block of Y (and 8×8 of U and V, which is 16×16 in luma), `p' = μ + q·round((p − μ)/q)`, with q_Y = 6–14 and q_C = 10–20. This gives visible block steps and colour banding. With `--x264 CRF`, if `ffmpeg` is on PATH, round-trip instead through `ffmpeg -f yuv4mpegpipe -i - -c:v libx264 -crf CRF -preset veryfast -f h264 - | ffmpeg -i - -f yuv4mpegpipe -`.
10. **Frame ID:** a 64×8 px barcode in the bottom-right corner (16 bits, white/black). Tag it in the manifest and exclude it from all metrics, so camera-path tests can align frames even when Chrome loops or drops frames.

Minimal SDF core (original):
```python
def sd_capsule(px, py, ax, ay, bx, by, r):
    vx, vy, wx, wy = bx-ax, by-ay, px-ax, py-ay
    h = max(0.0, min(1.0, (wx*vx + wy*vy) / (vx*vx + vy*vy or 1e-9)))
    return math.hypot(wx - vx*h, wy - vy*h) - r

def over(acc_a, acc_p, cov, col):                 # premultiplied front-to-back
    k = (1.0 - acc_a) * cov
    return acc_a + k, (acc_p[0] + k*col[0], acc_p[1] + k*col[1], acc_p[2] + k*col[2])

def srgb_oetf(x):  # IEC 61966-2-1
    return 12.92*x if x <= 0.0031308 else 1.055*x**(1/2.4) - 0.055
```

### 2.3 Scenario set (90 frames each unless noted)

| ID | Degradation(s) | Main metric(s) |
|---|---|---|
| S00 `clean` | Even light, no spill, slow sway, plus an exposure sweep (T9) | All metrics, tight. Sanity baseline. |
| S01 `uneven` | Vignette 0.4 + 1.6:1 side gradient | FP_bg, band SAD |
| S02 `hotspot` | +1.3-stop hotspot, partly clipped (cf. #146) | FP_bg in hotspot box |
| S03 `wrinkles` | Folds, creases, sag | FP_bg, island count |
| S04 `shadow` | Moving cast shadow ρ = 0.55 | FP_bg in shadow box |
| S05 `spill_hair` | Frizzy hair strands, rim spill, despill swatches (T7) | Band SAD/Grad on hair box, composite ΔE, spill residual |
| S06 `fast_wave` | Arm waving 3 Hz ±70°, shutter 1/60 and 1/30 (blur 30–80 px) (cf. #39) | FN_fg on arm core, ghost, dtSSD |
| S07 `lowlight` | −1.5 stop, a = 1.5e-3, chroma noise ×2 | Flicker (static), FP_bg |
| S08 `compressed` | 4:2:0 + blocks q_Y = 12/q_C = 18 (or x264 CRF 32) | Band SAD, Conn |
| S09 `awb_ae` | AWB gains drift R 1→1.12, B 1→0.9 over 4 s (120 frames); +0.5-stop AE jump when the kid enters | Recovery frames, FP_bg over time |
| S10a/b `flicker` | 100 Hz (50 Hz mains, 10 Hz beat at 30 fps) and 120 Hz (bands only), m = 0.08 | Flicker, dtSSD |
| S11 `green_clothes` | Sage shirt, forest-green sleeve, teal stripes | FN_fg, scored chroma-only and chroma+ML separately (`ml_only` regions) |
| S12 `screen_hues` | Backings: yellow-green, teal, blue felt, faded pastel green (CK trains on blue–yellow, #39/#105) | All metrics; auto-key must converge |
| S13 `small_screen` | Beige wall and whiteboard on 15 % of left and top, plus a classmate at the edge | FP outside the screen (T5, ML) |
| S14 `closeup` | Kid covers 85 % of the frame and every border cell at start (cf. #246) | Key status, FP_bg after the kid steps back |
| S15 `props` | Clear cup α = 0.3 with green showing through (cf. #191), paper with drawing, shiny sticker reflecting green | Flicker on prop box, FN_fg |
| S16 `tape_clips` | Dark tape strips, binder clips, thumbtacks on the screen | Island count, FP_bg |
| S17 `enter_exit` | 30 empty frames, then walk in and out (150 frames) | Time to first good key, plate capture, ghost |
| S18 `classroom` | S01+S03+S04+S05+S06+S07+S08+S09 at moderate strength | **Headline score** |

### 2.4 ML-mask corruption profiles (for T2; masks made from ground truth at 256×256)

- Morphology: `erode4/8/16`, `dilate4/8/16` (at camera-pixel scale).
- Topology: `holes` (3–6 elliptical holes of 8–20 px), `islands` (4–10 false blobs on the backing).
- Edges: `blur8`.
- Temporal: `lag1/lag2/lag3` (mask from t−k), `cadence2/3` (mask only every 2nd or 3rd frame, the in-between frames reuse the last mask, with `mask_frame` tags), `dropout` (no mask for 15 frames).
- Report FP_bg and FN_fg per profile against the chroma-only run (as PR #268 does).

---

## 3. Metrics (`web/src/lib/keyer/metrics.ts`, unit-tested in vitest; computed in-page)

**Harness.**
- A `?harness` route or a Playwright `page.evaluate` fetches `<id>.y4m` and the ground-truth files and decodes YUV to RGBA (full range). Each frame goes in as the foreground source (`ImageData` or `VideoFrame`), then the harness calls `render()`.
- It reads the **matte** at camera resolution through a debug getter on the existing `readPixels` path. It reads the **final stage** composited over two fixed backgrounds: grey 0.5 and saturated magenta (1, 0, 1).
- This path is deterministic: no camera timing and no loop drift. It also runs in **Playwright WebKit**, which is closer to iPad Safari than Chromium, and the fake-camera flag is Chromium-only.

**Regions.** Pixels flagged in the manifest are excluded.
- `U` (band): pixels within 6 px of the ground-truth α = 0.5 contour, or with 0.02 < α < 0.98.
- `BG`: α = 0. `FG`: α = 1.
- Plus the manifest boxes.

| Metric | Definition | Catches |
|---|---|---|
| **SAD** | Σ\|α̂−α\| / 1000, over the whole frame and over U (alphamatting.com convention, Rhemann et al. 2009) | Overall error |
| **MSE** | mean (α̂−α)² × 10³, over the whole frame and over U | Large errors |
| **Grad** | Σ(\|∇G_σα̂\| − \|∇G_σα\|)² / 1000 with σ = 1.4 (Rhemann 2009), over U | Blurry or jaggy edges, block steps |
| **Conn** | Rhemann 2009 connectivity: sweep t = 0…1 in steps of 0.1. Ω = largest 4-connected component of {α̂ ≥ t ∧ α ≥ t}. lᵢ = last t where pixel i is in Ω; dᵢ = αᵢ − lᵢ; φᵢ = 1 − dᵢ·[dᵢ ≥ 0.15]. Conn = Σ\|φ(α̂) − φ(α)\| / 1000 | Detached specks and holes |
| **FP_bg** | Σ_BG max(α̂−α, 0) / \|BG\| (PR #268 asymmetry) | Shadows, wrinkles, tape left visible |
| **FN_fg** | Σ_FG max(α−α̂, 0) / \|FG\| | Holes in the kid, vanishing arms |
| **Islands** | Number of components with α̂ > 0.5 and area < 64 px inside BG, plus holes with α̂ < 0.5 and area < 64 px inside FG | Speckle |
| **dtSSD** | sqrt(mean_U(((α̂_t − α̂_{t−1}) − (α_t − α_{t−1}))²)) (Erofeev et al. 2015) | Temporal incoherence |
| **Flicker** | mean \|α̂_t − α̂_{t−1}\| over pixels where the ground truth is static (α_t = α_{t−1}) | Shimmer from noise or flicker |
| **Ghost** | Σ α̂_t over {α_t = 0 ∧ max(α_{t−1}, α_{t−2}) > 0.5} / count | EMA or ML-lag trails |
| **Composite ΔE** | Mean ΔE00 between the stage output and α·F + (1−α)·B_ref, over U and over FG, for each B_ref (PR #267 recomposition idea) | Dark fringes (linear vs sRGB), despill errors |
| **Spill residual** | mean_U max(G − max(R, B), 0) of the stage foreground | Green edges on hair |
| **Recovery** | Frames after an AWB/AE event until band SAD is within 1.1× of the pre-event median | Auto-key tracking |
| **Cadence ripple** | \|mean SAD on mask frames − mean SAD on non-mask frames\| | Pulsing from ML cadence (cf. #184 "half the frames worse") |
| **Perf** | p50/p90 frame time from `getStats()` | Budget |

Sketch (original):
```ts
export function asym(aHat: Uint8Array, aGt: Uint8Array, skip: Uint8Array) {
  let fp = 0, nb = 0, fn = 0, nf = 0, sad = 0, sadU = 0;
  for (let i = 0; i < aGt.length; i++) {
    if (skip[i]) continue;
    const g = aGt[i] / 255, h = aHat[i] / 255, d = Math.abs(h - g);
    sad += d; if (g > 0.02 && g < 0.98) sadU += d;
    if (aGt[i] === 0)   { fp += Math.max(h - g, 0); nb++; }
    if (aGt[i] === 255) { fn += Math.max(g - h, 0); nf++; }
  }
  return { sad: sad / 1000, sadBand: sadU / 1000, fpBg: fp / Math.max(nb, 1), fnFg: fn / Math.max(nf, 1) };
}
export function dtSSD(h0: Uint8Array, h1: Uint8Array, g0: Uint8Array, g1: Uint8Array, band: Uint8Array) {
  let s = 0, n = 0;
  for (let i = 0; i < band.length; i++) if (band[i]) { const e = ((h1[i]-h0[i]) - (g1[i]-g0[i])) / 255; s += e*e; n++; }
  return Math.sqrt(s / Math.max(n, 1));
}
```

**Gates.**
1. Record a baseline JSON "receipt" per scenario from the current `shaders.ts`.
2. CI fails if any metric on any scenario gets more than 5 % worse, or more than 10 % worse for scenarios tagged `ml_only` when ML is on.
3. Absolute targets, to be tuned after the first baseline:
   - S00: FP_bg < 0.002, FN_fg < 0.002, Islands = 0.
   - S18: band SAD at most 0.6× the current shader's value.
   - Ghost < 0.05 on S06.

---

## 4. Failure modes the real-time keyer must handle, and how CorridorKey users reported them

| # | Failure mode | In a classroom | CorridorKey report | Our mechanism | Fixture |
|---|---|---|---|---|---|
| F1 | **Fast limbs disappear, and the background bleeds through motion blur** | Waving arms, jumping | #39 (closed): "arms/legs with a lot of motion blur tend to disappear… background still bleeds through the motion blur". The owner says it is a hint and scope limit. Even a 300 MB network fails here. | Motion-gated EMA (no ghost), ML core grows slowly, T2 mask-age trust. Accept soft blur. Score FN_fg on the arm core, not exact blur α. | S06 |
| F2 | **An over-expanded hint lets the screen bleed in** | A stale or dilated MediaPipe mask behind a moving kid | v1 README:109; #184 (half the frames bleed); PR #268 measured fp 0.21 vs fn 0.01 | ML may only add from an eroded core and only remove with a dilated garbage matte. T2 trust and corruption sweep. | §2.4 + S06/S18 |
| F3 | **Temporal flicker or alternation on semi-transparent things** | Clear cups, hair strands, tutu or tulle | #191 (texture alternates on a cup); #72 ("visible temporal issues", "flickering glass"); #113 suggests memory | EMA plus Flicker/dtSSD metrics; T8 offline window | S15, S05, S07 |
| F4 | **Low-frequency backing variation**: hotspots, falloff, wrinkles and shadows read as edges | Bedsheet or poster screen, window light, overhead tubes | #129 comment lists exactly these | keyD shadow gain; T3 plate flattening; auto-key "too wrinkly" warning | S01–S04 |
| F5 | **Green spill and colour bounce on the subject**, and despill damaging legitimate colours | Green glow on blond hair and cheeks; a yellow or violet shirt greyed | #74 (training composites miss spill, so separate despill); #195 (average limit eats violet); PR #179 (vacuous despill test) | Alpha-aware despill (max limit inside, average at edges) + T7 swatches with a non-vacuous assertion | S05, S12 |
| F6 | **Subject wears the screen colour** | Green t-shirt, St Patrick's day, teal leggings | #195 (green elements keyed out); #246 fixture "subject wearing predominantly green" | "Your shirt is screen-coloured" warning + ML core fill; despill off where the core filled | S11 |
| F7 | **Wrong or ambiguous screen colour detection** | Kid close to the iPad covers the border; dim room; blue felt board | #246: underexposed blue routes to green, close-ups trigger the coverage fallback, front-lit blue | T6 robust sampler with cover, dim and ambiguity guards; slow re-key | S12, S14, S17 |
| F8 | **Small specks: tracking markers or stray objects** | Tape, binder clips, thumbtacks, poster edges | v1 README:31,185 (auto-despeckle exists for this) | T4 reconstruction-based island removal | S16 |
| F9 | **Non-screen background inside the frame** | Wall, whiteboard and classmates beyond the screen edge | #39 ("outside of the bounds of the backdrop"); #180 (processing box); v2 README:113-115 (wrong subject) | T5 stage box + ML garbage matte | S13 |
| F10 | **Gamma or transfer mistakes give dark fringes or crushed shadows** | Dark halo round the kid on a bright background | #28 (2.2 vs piecewise); LLM_HANDOVER.md:38,71 | Piecewise sRGB in `labKey`; P2 linear compositing; composite ΔE metric over two backgrounds | S00 sweep, S05 |
| F11 | **Clipped highlights** | Sunny window on the screen, hotspot from the iPad's own light | #146 (values above 1.0 clamped) | keyD "over" term; T3 flattening; "too much light" warning | S02 |
| F12 | **Illumination drift: AWB, AE, mains flicker** | iPad AWB cannot be locked; fluorescent tubes on 50 or 60 Hz mains | No direct CK report (offline tool). v2 adds linear exposure test controls (README:553-567) for this kind of testing. | 2 s auto-key EMA with ΔE00 > 2 re-bake; Recovery metric | S09, S10 |
| F13 | **Compression and chroma subsampling** | Low-end phones, Safari camera path, recorded clips | Implicit: v2 writes 4:4:4 10-bit by default (README:378) to avoid subsampling the matte | Guided filter on luma (full-res guide) smooths 4:2:0 chroma steps; Grad/Conn metrics | S08 |
| F14 | **Sensor noise in low light** | Dim classroom corners, winter afternoons | No direct report; covered by v2's noise-free synthetic assumption | Dark guard in the LUT; EMA; guided filter `eps` | S07 |
| F15 | **Per-frame quality ripple tied to the processing schedule** | ML at every 2nd or 3rd frame makes the edges pulse | #184 ("about half" of frames worse; it was a backend/GUI issue) | T2 trust, slowly decaying garbage matte; Cadence-ripple metric | §2.4 cadence2/3 |

**Bottom line for the recommendation doc.**
1. Add **T1** (fixture generator plus metrics) and **T2** (asymmetric, age-aware ML trust, tested with corruption sweeps) as P0, before tuning any shader constants.
2. Add **T3** plate flattening, **T4** reconstruction despeckle, **T5** stage box and **T6** robust sampler as P1. Gate each on §3 metrics against its scenarios.
3. T7 to T9 are P2 test hardening.
4. The one firm thing known about CorridorKey's training (composited CGI with exact alpha over varied backing colours, with a clean plate) is what the generator in §2 reproduces cheaply for our evaluation.

**Limits of this research.**
- CorridorKey's official training details are unpublished. The video-based claims in #74, #105 and #114 come from users (except the owner's one-line confirmations), and I did not watch the video.
- PRs #267 and #268 were not merged, and I used only their descriptions.
- Every cost figure above is an estimate to be measured on A13 and M-series iPads.

Files consulted: `/Users/md/Green Screen 2/docs/research/realtime/recommendation.md`, `/Users/md/Green Screen 2/docs/research/realtime/corridorkey-obs.md`, `/Users/md/Green Screen 2/web/e2e/fixtures/make_fake_camera.py`, and `/Users/md/Green Screen 2/web/src/lib/keyer/Compositor.ts`, which already has `setMaskData`, `resetTemporal` and a `readPixels` path to build the harness hook on.