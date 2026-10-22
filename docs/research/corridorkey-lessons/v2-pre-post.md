# What CorridorKey v2 can teach our real-time keyer

I read the CorridorKey v2 source at `/private/tmp/claude-501/-Users-md-Green-Screen-2/727545c3-c535-41ef-933d-42d65e406914/scratchpad/ck/repo`. No CorridorKey code was run or copied: every idea below is described in my own words, and all GLSL/JS is original. I checked each idea against `/Users/md/Green Screen 2/docs/research/realtime/recommendation.md`, so only new or better ideas are listed. Paths in citations are relative to that repo.

**Things the repo does not contain:**
- **No training data, augmentation code or evaluation metrics.** `scripts/smoke_test_runtime.py:28-29` only checks the checkpoint format. Anything below about training is an inference, and is marked as one.
- **No despeckle, morphology or choke at runtime.** Alpha is only clamped to [0,1] (`corridorkey/runtime.py:653,656`). All matte cleanup is learned by the network. There is nothing hand-made to borrow here; our `MASK_PREP_FS` plus choke stays as planned.

## Summary (priority order)

| # | Idea | What it fixes for kids | Cost @720p (A13 estimate) | Priority |
|---|---|---|---|---|
| 1 | **Screen plate + foreground unmixing** in linear light (predict the subject's colour separately from alpha) | Green, see-through waving arms (motion blur), green-tinted hair edges | ~0.25–0.35 ms | **P0** |
| 2 | **Mirrored texture wrap** for box/dilate/erode passes (no clamped edge bias) | Halos where an arm leaves the frame edge | 0 | **P0** |
| 3 | Linear-light compositing moves from P2 to **P1** (#1 depends on it); decode in the shader | Dark edge fringes; correct light wrap | ~0.05 ms | **P1** |
| 4 | **Flatten the key with the plate:** per-pixel gain in linear light before the LUT lookup | Uneven screens, kid shadows, white-balance drift with no LUT re-bake "pop" | ~0.1 ms | **P1** |
| 5 | **Trust value for the Magic Helper:** a per-frame confidence that drives dilation, core threshold and weight | Mask lag on skipped frames, wrong-person fills, helper fighting a good key | ~0.2 ms in JS | **P1** |
| 6 | **Temporal smoothing at coarse scale:** EMA on the guided-filter (A,b) coefficients, not on full-res alpha | Flicker removed *without* ghosting hair or arm edges | ~0.05 ms (saves bandwidth) | **P1** |
| 7 | Lower despill strength once unmixing exists; keep our alpha-aware limit | Skin and yellow shirts look natural | 0 | **P1** |
| 8 | Keep the segmenter input at the right aspect ratio (landscape model or pad instead of stretch) | Better helper mask on 16:9 frames | 0 | **P1** (verify the model) |
| 9 | **Hann-weighted symmetric filter, delayed only in the recorder** (and in "Make it Magic") | Smoother saved video, live preview still has no lag | ~0.15 ms + 3 textures | P2 |
| 10 | Checkerboard "matte check" view for teachers; per-render settings log | Faster calibration, reproducible bugs | ~0 | P2 |
| 11 | Matte history in 16-bit float; ratio-based (asinh-style) motion guard | No 8-bit EMA residue; dark hair motion detected | ~0 | P2 |
| 12 | Evaluation set with synthetically degraded helper masks + standard matting metrics | Proves 1–6 actually help | offline | P2 |

---

## 1. Screen plate + foreground colour unmixing (P0)

**(a) What CorridorKey does.**
- The network outputs **two separate things: alpha and a foreground colour** (`corridorkey/model.py:13-15`; split at `corridorkey/model.py:276-279`).
- The colour head starts out as an exact copy of the input RGB, and alpha starts at zero (`corridorkey/stage2.py:16-19, 524-526`; `corridorkey/blocks.py:144-159`). So the network learns *corrections to the camera colour* only where the pixel is a mix of subject and screen.
- Every composite uses the **predicted foreground**, not the camera pixel: `comp = F·a + bg·(1−a)` in linear light (`corridorkey/runtime.py:665-683, 705-729`).
- Despill is applied on top afterwards, and only at strength 0.5 (`corridorkey/runtime.py:127`).

**(b) Why it helps.** A semi-transparent pixel is `I = a·F + (1−a)·B`. Despill can only make green grey. Unmixing solves for F, so a motion-blurred arm turns back into *arm colour* at partial alpha instead of grey-green mush. Hair strands get their real colour back. This is the compositing equation (Smith & Blinn 1996). Closed-form foreground estimation is published work (e.g. Germer et al. 2020, "Fast multi-level foreground estimation").

**(c) Real-time version.** We need a per-pixel estimate of the *local screen colour* B, so the formula also copes with uneven screens.
- **Build the screen plate at 1/8 resolution with push-pull.** Weight each pixel by how screen-like it is in the *current* frame's raw LUT key. Do not use the previous frame's alpha: an arm that just moved would contaminate the plate.
- Take a slow EMA of the plate over time, since the screen does not move.

```glsl
// PLATE_DOWN_FS: 1/8 res, 4x4 taps over camera. out = (sum w*lin, sum w), RGBA16F
uniform sampler2D u_fg, u_rawKey;   // u_rawKey.r = un-smoothed LUT alpha of this frame
uniform vec2 u_texel;
vec3 toLin(vec3 s){ return s*(s*(s*0.3053+0.6822)+0.0125); } // cheap sRGB->linear fit
void main(){
  vec4 acc = vec4(0.0);
  for (int j=0;j<4;j++) for (int i=0;i<4;i++){
    vec2 uv = v_uv + (vec2(i,j)-1.5)*u_texel;
    float scr = 1.0 - texture(u_rawKey, uv).r;     // 1 = surely screen
    float w = scr*scr*scr*scr;                      // only near-certain screen votes
    acc += vec4(toLin(texture(u_fg, uv).rgb)*w, w);
  }
  o = acc / 16.0;
}
// PULL_FS: build mip chain (one LINEAR fetch = 2x2 average of weighted sums)
// PUSH_FS (coarse -> fine): fill holes where the subject hides the screen
vec4 f = texture(u_fine, v_uv), c = texture(u_coarse, v_uv);
vec4 filled = f + c * clamp(1.0 - f.a * 8.0, 0.0, 1.0);
// temporal: plateNew = mix(filled, prevPlate, 0.85); reset with the matte history
```

Then, in `FG_FS`, after the final `a` is known:

```glsl
vec4 P = texture(u_plate, uv);  vec3 B = P.rgb / max(P.a, 1e-4);
vec3 I = toLin(c);
float aU = max(a, 0.10);                         // don't divide by ~0
vec3 F = B + (I - B) / aU;                       // compositing equation solved for F
vec3 d = F - I;  float m = length(d);
F = I + d * min(1.0, 0.6 / max(m, 1e-4));        // cap the correction (wrong B -> no blow-up)
F = clamp(F, 0.0, 1.0);
float edgeW = 1.0 - smoothstep(0.85, 0.99, a);   // full unmix at soft edges, none in the core
vec3 Flin = mix(I, F, edgeW * (1.0 - coreFill)); // skip where ML rescued a green shirt
```

Then apply despill (#7) and composite in linear (#3).
- **Cost:** plate down ~0.08 ms, push-pull over 4 tiny levels ~0.05 ms, plus 1 fetch and ~15 ALU in `FG_FS` (~0.1 ms). That is about 0.3 ms on A13.
- **Memory:** a few hundred KB of RGBA16F.
- Without half-float render targets, use RGBA8 with the weight stored in alpha (coarser, but it works).

**(d) What kids will see.**
- Fast-waving arms keep skin and sleeve colour through the motion blur instead of a green or grey ghost.
- Frizzy hair keeps its real colour.
- Uneven screen lighting doesn't leave a tint at the edges, because B is local, not one global key colour.

**(e)** P0. It is the largest visible gain CorridorKey's design points to.

## 2. Mirrored border handling (P0)

**(a) What CorridorKey does.**
- Frames are centre-padded to a multiple of 128 with *reflect-101* padding (`corridorkey/video_io.py:103-112, 198-207`) and cropped back afterwards (`corridorkey/runtime.py:581-584`). Hints get the same padding (`corridorkey/video_io.py:475, 494-497`).
- Its convolution refine block pads with reflection (`corridorkey/stage2.py:211-213`).

**(b) Why it helps.** Clamp-to-edge repeats the border pixel, so a box filter near the edge over-counts it. An arm crossing the frame edge pulls the guided-filter means and the dilation toward that one pixel, which shows up as halos or bleeding along the border.

**(c) Real-time version.** For the matte, guided-filter means and mask-prep textures, change `CLAMP_TO_EDGE` to `MIRRORED_REPEAT` (currently at `/Users/md/Green Screen 2/web/src/lib/keyer/Compositor.ts:365-366`). WebGL2 allows this on non-power-of-two textures.
- Keep the camera and LUT textures on clamp: the LUT must not mirror.
- GL mirroring repeats the edge texel once (reflect, not reflect-101). That is close enough for radius-4 boxes.
- Cost: 0.

**(d)** Cleaner edges where arms, heads or props cross the frame edge, which happens constantly with kids close to the iPad.

**(e)** P0 (one-line change).

## 3. Linear-light compositing moves up to P1; decode in the shader

**(a) What CorridorKey does.**
- Composites in linear light: decode the foreground and the checkerboard, mix by alpha, re-encode (`corridorkey/runtime.py:720-729`; `corridorkey/video_io.py:800-806`; `corridorkey/color_utils.py:32-90`).
- Its float output path keeps colour unclamped and only clamps alpha (`corridorkey/runtime.py:645-651`).
- Despill is computed on *display-coded* values; only the mix is linear (`corridorkey/runtime.py:718, 724-726`).

**(b) Why it helps.** Mixing in gamma space darkens edges (the dark fringe), and light wrap and blur look muddy. #1 is only physically correct in linear light.

**(c) Real-time version.** Skip the `SRGB8_ALPHA8` stage buffer the plan describes; Safari's handling of video into sRGB textures is the risky part. Instead:
- Decode the camera and background in the shader with the cubic fit above.
- Encode once at the end with a cheap fit such as `max(1.055*pow(x,0.41667)-0.055, 0.0)` (or `sqrt`-based).
- Keep despill on display-coded values (perceptual, like CorridorKey). Run unmixing, light wrap and the final mix in linear light.
- Cost: ~0.05 ms.

**(d)** No dark outline around kids against bright backgrounds, and the light wrap looks like light instead of a smudge.

**(e)** P1 (it is required for #1).

## 4. Flatten the key with the screen plate (P1)

**(a) What CorridorKey does.**
- An optional exposure and contrast change in linear light around a 0.18 pivot is applied before the model (`corridorkey/video_io.py:159-181, 308-311`; `corridorkey/runtime.py:121-123`).
- Its exact inverse is applied to the predicted foreground (`corridorkey/runtime.py:595-601, 667`).
- The idea: normalise exposure in linear light for the keying decision, then undo it for the colour.

**(b) Why it helps.** Our key compares against *one* key colour. Uneven classroom screens, hotspots, kid shadows and iPad auto white balance all move the screen away from it. Normalising each pixel by its local screen colour brings every screen pixel close to the reference before keyD is measured.

**(c) Real-time version.** Reuse the plate B from #1. In `MATTE_FS`:

```glsl
vec3 I = toLin(c);
vec4 P = texture(u_plate, v_uv); vec3 B = P.rgb / max(P.a, 1e-4);
vec3 g = clamp(u_keyLin / max(B, vec3(1e-3)), vec3(0.5), vec3(2.5)); // per-channel gain
vec3 cn = toSrgbApprox(I * g);                    // LUT is indexed in sRGB
vec2 k = texture(u_keyLut, cn*((LUT_N-1.0)/LUT_N) + 0.5/LUT_N).rg;
```

- The *uncorrected* foreground is still what gets displayed. Only the key decision uses `cn`, which is the "inverse afterwards" part.
- The plate is temporally smoothed and built from current-frame "surely screen" pixels, and push-pull only extrapolates under the subject. So subject pixels get a smooth, plausible gain and stay far from the key.
- This also replaces most of the 2 s white-balance re-bake loop. Global drift now shows up in B every frame, smoothly, so a LUT re-bake is needed only for a big hue change.
- Cost: 1 fetch and ~12 ALU, ~0.1 ms. It needs one raw-LUT pre-pass (or last frame's raw key) to build the plate, which is 1 more LUT fetch.

**(d)** Kid shadows on the screen and badly lit corners key cleanly without loosening `lo/hi`, so green shirts and hair are safer. There is no visible jump when the iPad shifts white balance. **Risk:** large green clothing next to the screen can bias B. The "surely screen" weighting (w = scr⁴) and the gain clamp limit this; test it with the forest-green case.

**(e)** P1.

## 5. A trust value for the Magic Helper (P1)

**(a) What CorridorKey does.**
- Each frame's hint carries a **scalar trust** in [−1, 1]: −1 = "decide the subject yourself", 0 = "this window has a hinted subject but this frame has no hint", 1 = perfect (`corridorkey/stage1.py:713-728, 741`).
- The trust feeds AdaLN conditioning in the first 2 encoder blocks (`corridorkey/stage1.py:304, 371`; `corridorkey/blocks.py:2729-2773`).
- How trust is assigned per frame: `corridorkey/runtime.py:485-502`.
- Presets: 0.95 for an artist matte, 0.75 for a rough automated hint, ≤ 0.5 for a scribble (`run_interactive.py:295-313`; README "Hint Quality").
- The hint pixels themselves are never altered, only how much they are trusted (README "Hint Quality").
- The README warns that the result follows systematic bias in a hint (too eroded, too dilated, wrong subject).
- *Inference, not visible in this repo:* training probably degraded hints synthetically to match these trust levels.

**(b) Why it helps.** Our helper mask is good on some frames and stale or wrong on others: frames skipped by cadence 2–3, a teacher walking in, a fast arm with 1–2 frames of lag. A fixed `u_mlWeight` treats all of them the same.

**(c) Real-time version.** Compute `q` in JS from the 256² mask (65K values, about 0.2 ms) plus one value read back from the GPU:

```js
// per helper frame
const amb = fracInRange(mask, 0.2, 0.8);        // model unsure
const qModel = clamp(1 - 4 * amb, 0, 1);
const qAgree = iouInScreenRegion(mask, keyAlphaLowRes); // 1/16 readback from the existing PBO path
// per displayed frame
const age = framesSinceMask;                     // 0 on fresh mask
const qAge = Math.exp(-age * (0.15 + 2.0 * motionEnergy)); // motion = mean |Y-Yprev| (GPU 1/16 reduce)
const q = qModel * (0.5 + 0.5 * qAgree) * qAge;
uniforms: u_mlWeight = fadeIn * q;
          u_dilateStep = mix(4.5, 2.0, q);       // low trust -> wider garbage (keep props)
          u_coreLo = mix(0.97, 0.75, q);         // low trust -> core fill only where very sure
```

Mirroring CorridorKey's tri-state: on a skipped frame, the carried mask is used at reduced trust (the "0" case), not at full trust. With no helper at all, the chroma key decides alone (the "−1" case).

**(d)**
- Fewer "the background behind my arm got filled in" moments right after fast motion.
- Less "the helper ate my held prop".
- When the screen is clean, the helper backs off on its own.

**(e)** P1.

## 6. Temporal smoothing at coarse scale, edges from the current frame (P1)

**(a) What CorridorKey does.**
- All temporal mixing happens at /64 and /16 resolution in Stage 1.
- Stage 2 is **per-frame** and re-reads the raw RGB at full resolution to produce the edges (`corridorkey/stage1.py:1-24`; `corridorkey/stage2.py:1-24`, "No temporal processing here").
- It also has a late raw-RGB skip and a /4 refine head (`corridorkey/stage2.py:511-519, 528-530, 220-277`).

**(b) Why it helps.** A full-resolution alpha EMA, even with a motion guard, can leave faint trails on fine hair and on arms that move slowly enough to slip under the guard threshold. Smoothing the *low-frequency decision* while taking edges from the current frame gives flicker-free interiors with edges that line up with the current frame.

**(c) Real-time version.** The guided filter already splits the two: `alpha = A·I + b`. Run the motion-guarded EMA on the half-res `(A, b)` coefficients, then apply them to the **current** full-res guide I:

```glsl
// GF_COEF_FS addition (half res, ping-pong RGBA16F)
vec4 cur = vec4(A, b, m.y, m.x);                 // m.x = mean I of this frame
vec4 prv = texture(u_prevCoef, v_uv);
float mot = smoothstep(0.015, 0.06, abs(m.x - prv.w));
o = mix(cur, prv, u_temporal * (1.0 - mot));
o.w = m.x;                                       // store the fresh mean for the next guard
```

- The full-res matte EMA can then be lowered to ≈0.2 or dropped, which saves a full-res read per frame.
- Cost: +1 half-res fetch, about 0.05 ms, minus the full-res EMA read.

**(d)** Static kids don't shimmer, and waving hands and hair stay crisp with no smear behind them.

**(e)** P1. Keep the current full-res EMA when the tent fallback is in use.

## 7. Despill after unmixing: lower strength, keep our formula (P1)

**(a) What CorridorKey does.**
- "Average" despill: `s = max(G − (R+B)/2, 0)`, subtract s from G, add s/2 to each of R and B. This keeps the R+G+B sum, not luma.
- It is applied to display-coded values, mixed in at **0.5 by default**, and does not depend on alpha (`corridorkey/runtime.py:604-614`; `corridorkey/video_io.py:809-820`; default at `corridorkey/runtime.py:127`).

**(b) Why it matters.** Because the foreground is already unmixed, despill is only a light finishing step. Our formula is already better in two ways: an alpha-aware limit that moves from max to average, and spill luma returned as neutral grey, which keeps Rec.601 luma and is better for skin than keeping the channel sum.

**(c) Change.** Once #1 ships, drop the interior `u_spill` from 0.9 to ≈0.5 and keep `u_spillEdge`. Unmixing now does the heavy work at edges. Cost: 0.

**(d)** Skin stops looking slightly grey or magenta, and yellow and teal shirts look more natural.

**(e)** P1, bundled with #1.

## 8. Keep the segmenter input at the right aspect ratio (P1, verify first)

**(a) What CorridorKey does.** It sizes each foundation-model input so the patch grid lands on the /64 grid "with no resize or aspect distortion" (`corridorkey/model.py:91, 226-229`; `corridorkey/runtime.py:283-292`). Each consumer gets the encoding it was trained on: the foundation models get clipped display sRGB, and the keyer network gets asinh-encoded linear light (`corridorkey/video_io.py:299-320`).

**(b) Why it matters.** The square 256×256 selfie model squashes a 16:9 frame, which makes thin arms thinner and hurts the core and garbage mattes.

**(c) Change.**
- Check whether MediaPipe's landscape selfie segmenter (144×256, also Apache-2.0) is available as a tasks-vision model. If it is, use it on landscape cameras.
- If not, letterbox to square (mirror-pad) and crop the mask back, instead of stretching.
- Keep feeding MediaPipe the raw camera frame: no despill, no plate normalisation.
- Cost: 0. A landscape model is about the same size.

**(d)** A more accurate helper mask on thin limbs and at the frame sides.

**(e)** P1, after the check.

## 9. Hann-weighted symmetric filter, recorder only (P2)

**(a) What CorridorKey does.**
- Runs Stage 1 on overlapping windows (80/40 by default; `corridorkey/runtime.py:100-101`).
- Weights each window with raised-cosine ramps `w_i = ½(1 − cos(π(i+1)/(n+1)))` on the overlapping ends (`corridorkey/video_io.py:582-604`). A ramp and its mirror sum to 1, so the weights partition unity across overlaps.
- Divides by the accumulated weight (`corridorkey/runtime.py:550-561, 468-478`).
- "Hann carry": each window's own predicted matte becomes the next window's hint at trust 0.95 (`corridorkey/runtime.py:538-549, 492-496`). The README warns this "can drift" on long or crowded shots.

**(b) Why it helps.** Symmetric smoothing (past and future frames) has no lag. Feeding back its own output is a strong prior, but it can lock in errors.

**(c) Real-time version.**
- **Live preview:** stays zero-latency, with #6 and #5's age decay as the carry, plus a hard reset on each fresh helper frame. That reset is the anti-drift lesson from Hann carry.
- **Recorder (and "Make it Magic"):** keep a 3-frame ring buffer of the camera and coefficient textures, and write frame t−1 with a Hann-weighted, motion-guarded average of t−2, t−1 and t:

```glsl
// weights 0.25/0.5/0.25 (3-tap Hann), each outer tap gated by its own motion guard
float g0 = 1.0 - smoothstep(0.015,0.06,abs(Im1 - Im2));
float g2 = 1.0 - smoothstep(0.015,0.06,abs(Im1 - I0));
vec4 ab = (0.5*abM1 + 0.25*g0*abM2 + 0.25*g2*ab0) / (0.5 + 0.25*(g0+g2));
```

- Saved video is one frame late, which nobody notices in a recording.
- Cost: ~0.15 ms plus about 11 MB of textures. Enable only while recording.

**(d)** Recordings look steadier than the live view, with no lag where it matters (the mirror).

**(e)** P2.

## 10. Checkerboard matte check and settings log (P2)

**(a) What CorridorKey does.**
- Its review output is the despilled foreground over a 64-px grey checkerboard (0.75 / 0.5), composited in linear light (`corridorkey/video_io.py:792-797`; `corridorkey/runtime.py:720-729`). The output file name records the despill strength (`corridorkey/runtime.py:778`).
- Each render writes a settings log (`corridorkey/runtime.py:802-835`).
- The cutout is straight (not premultiplied) colour with linear alpha (`corridorkey/runtime.py:712-719`; `run_interactive.py:359`).

**(c) Change.**
- Add a teacher-only "check the key" toggle that draws the checkerboard background. Holes and spill show up at once. Cost ~0.
- Attach a JSON settings snapshot to Playwright matte snapshots and to bug reports.
- If a sticker or cutout export is ever added, write straight-alpha PNG/WebM.

**(e)** P2.

## 11. Precision details (P2)

**(a) What CorridorKey does.**
- Model input is signed asinh-encoded linear light, `asinh(x/0.008)/asinh(16/0.008)` (`corridorkey/color_utils.py:4-5, 98-128`; contract at `corridorkey/model.py:4`, `corridorkey/stage1.py:734`). It is log-like, with a finite slope at 0, handles negatives and values above 1, and is exactly invertible. This gives roughly even precision from shadows to highlights.
- Alpha and colour are never 8-bit until the final encode, which is 16-bit or float (`corridorkey/runtime.py:617-639`).

**(b) Relevance to us.** An 8-bit SDR camera doesn't need HDR. The two useful lessons are about precision.

**(c) Changes.**
- (i) When half-float buffers exist, keep the temporal history in RG16F. An EMA at 0.5 in RGBA8 sticks 1–2 LSB above 0, which the 0.02 snap hides but which biases the guided filter.
- (ii) Make the motion guard ratio-based so dark hair over dark areas is detected as reliably as bright regions: `mot = smoothstep(0.03, 0.12, abs(log2((Y+0.02)/(Yp+0.02))))/k`, an asinh-like compression.
- Cost: ~0.

**(e)** P2.

## 12. Evaluation (P2)

CorridorKey ships no evaluation. Its hint-trust presets imply robustness to degraded hints (an inference). Proposed tests:
- Golden classroom clips (shadows, wrinkles, green shirt, a held prop, waving arms).
- Ground-truth-free metrics: background leakage (alpha > 0.05 inside the plate region) and edge colour error (distance of unmixed F from the subject's interior colour). Where a matte exists: SAD, MSE, gradient and connectivity error (Rhemann et al. 2009), and temporal dtSSD / MESSDdt (Erofeev et al. 2015).
- **Synthetic helper-mask degradation:** erode/dilate ±3–8 px, shift by 1–2 frames, drop frames. Check that #5 keeps quality steady.

This runs offline in Playwright and Node.

---

## Things to borrow conceptually but not build

- **Auto window size from free memory, with a safety margin** (`corridorkey/runtime.py:172-201`; margin ×1.1 + 0.3 GB at lines 148-149). This matches our planned `deviceTier` benchmark. The only new detail: choose the *largest* setting that fits the measured budget with a margin, then back off.
- **Coarse decides, fine draws the edge** (Stage 1 → Stage 2). This confirms the Tier 1 + Tier 2 split in the plan; #6 applies the same principle inside Tier 1.

## Files referenced

- `/Users/md/Green Screen 2/docs/research/realtime/recommendation.md`
- `/Users/md/Green Screen 2/web/src/lib/keyer/Compositor.ts` (wrap modes at lines 365-366)
- CorridorKey source: `/private/tmp/claude-501/-Users-md-Green-Screen-2/727545c3-c535-41ef-933d-42d65e406914/scratchpad/ck/repo/corridorkey/{runtime.py,video_io.py,color_utils.py,stage1.py,stage2.py,model.py,blocks.py}`, plus `infer.py`, `run_interactive.py` and `README.md` in the same repo folder.