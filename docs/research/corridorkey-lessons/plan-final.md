# Lessons from CorridorKey: corrected implementation plan for the Magic Screen real-time keyer (after adversarial review)

**Answer to "can we learn anything from CorridorKey?":** yes. The ranking holds. The biggest gain is foreground unmixing, which recovers the child's real colour at soft edges instead of only removing green. The second is a trust value for the Magic Helper mask, so a late mask behind a waving arm stops causing ghosts or cut-off arms. The other items are smaller.

The review checked every citation against the v2 checkout, the v1 copy in the scratchpad (`ck/README.md`, `ck/CorridorKeyModule/`, `ck/docs/`) and `gh api` for `nikopueringer/CorridorKey`. It also read today's `shaders.ts` and `Compositor.ts`. No CorridorKey code was run. All the GLSL, TS and JS is original: CorridorKey contains no GLSL, only PyTorch and NumPy, and none of the sketches follow its structure.

## Review log: what changed and why

**Citations corrected**
- **Item 0:** README:109 does not say the model was trained on computer-generated subjects. It says the model "was trained on coarse, blurry, eroded masks" and is "less effective at subtracting" a hint that is too big. The render-composited-onto-plate claim comes from a *user* in #74, citing the Corridor Crew video. The owner only confirms in #114 that a clean plate was "part of the process".
- **Item 2:** `stage1.py:713-728` defaults to trust 1.0 when a hint is present. In `runtime.py:485-502`, a frame with no hint inside the window gets 0, and a window with no hints at all gets −1. The values 0.95 and 0.75 are the menu choices in `run_interactive.py:295-313`, and carried hints also get 0.95. **The "scribble ≤ 0.5" claim was not found and is removed.** #184 is titled "Inconsistent quality": about half the frames are worse with automatic BiRefNet hints. It does not prove the "too-big hint bleeds" story, so the plan now says only "inconsistent per-frame quality with automatic hints".
- **Item 3:** `model.py:276-279` is the stage-2 call. The foreground-output evidence is `model.py:13-15` and `runtime.py:665-683`. The other citations check out: the colour head starts as a copy of the input RGB (`stage2.py:16-19, 524-526`), and despill defaults to 0.5 with its formula at `runtime.py:127, 604-614`.
- **Item 6:** `color_utils.py:329-383` (`estimate_screen_color`) does not estimate a key colour. It compares mean G with mean B where `alpha_hint < 0.3`, to choose the **green or blue checkpoint**, using the first frame (#246). Its guards are coverage ≥ 1 % and |G−B| ≥ 0.05, falling back to green.
- **Item 7 and the "not adopted" table:** #129 is a user suggesting textured, gradient and reflective screens for training augmentation. #195's violet failure is about the *blue↔green channel-swap hack* hurting alpha, not about despill. The despill objection now rests only on our own luma analysis. The linear-adjust citation is accurate, but it is a single global gain and contrast around a 0.18 pivot, so item 7 is only "loosely inspired" by it.
- **Gates:** the "MIT OBS wrapper setting that silently does nothing" could not be verified, so the attribution is dropped. The gate stays.
- **Item 11:** CorridorKey's checker is 64 px at 0.75/0.5 (`video_io.py:792-797`). To keep the clean-room distance obvious, we use our own values: 48 px at 0.70/0.45.
- **Verified as cited:** mirrored padding (`video_io.py:103-112, 198-207`, `stage2.py:211-213` reflect else replicate, `runtime.py:581-584`); v1 despeckle (threshold 0.5 in the OpenCV path and 0.25 in the torch path, keep parts ≥ 400 px, dilation 25, blur 5, multiply, no hole fill; `color_utils.py:422-505`, `inference_engine.py:270-272, 352, 406-408`); temporal mixing only in stage 1 (`stage1.py:1-24`, `stage2.py:1-24, 511-530`); aspect-preserving area resize (`model.py:91, 226-229`, `runtime.py:283-292`); cosine taper windows (`video_io.py:582-604`, `runtime.py:550-561`); asinh encoding (`color_utils.py:98-128`); handover notes on piecewise sRGB (`LLM_HANDOVER.md:38, 71`); PR #268 fp 0.2055 / fn 0.0100 for dilation 16 px (not merged); #267 not merged; #179 **merged**.

**Technical fixes**
- **Item 0:** a standard-library-only Python generator is far too slow. 8 sub-frames × up to 400 strands × 1280×720 in CPython takes minutes per frame. It is now written in **TypeScript run by Node** (`tsx`) with typed arrays, sharing the sRGB code with vitest. Gates now use per-engine baselines with an absolute floor, because WebKit on Linux CI is not iPad Safari and GPU rounding differs.
- **Item 1:** the despeckle sums (`dsT`) must **not** use mirrored edges. Mirroring doubles or quadruples the counted area of a speck at the frame edge, so edge specks would survive. `dsT` uses clamp with out-of-range taps set to zero.
- **Item 2:** the rewrite dropped the existing `u_coreWeight` (`shaders.ts:374`); it is restored. The "model unsure" fraction is now measured relative to the outline length, so a close-up child is not distrusted just for having more edge. Mask age is measured in video-frame timestamps, not display time.
- **Item 3:**
  - The prep pass and the plate average must run **only when a new camera frame arrives**. Today the matte runs only on fresh frames (`Compositor.ts:1273`). Otherwise a 60 Hz display over a 30 fps camera runs the plate's learn and decay rates twice per camera frame.
  - When half-float mipmaps fail, fall back to **`SRGB8_ALPHA8`** targets. They are colour-renderable and mipmappable in core WebGL2, and give enough precision for premultiplied weights. Today's plan instead turns unmixing off.
  - Costs are restated for the existing 1080p preset (`useStage.ts:80`). The final draw runs at canvas resolution, so edge-band work there is about 2.25× the 720p figure.
  - A WebGL feedback-loop rule is added.
- **Item 4:** stored in a half-float target when `floatOk`. An 8-bit mean rounds to about 18 px of area per step, which is acceptable as a fallback.
- **Item 6:** `median`, `deltaE00` and 24-cell binning do not exist yet (checked `autoKey.ts` and `labKey.ts`); they are new code. A fixed chroma cut of C > 15 would call a dim, washed-out screen "border-covered", so the threshold now depends on `MIN_KEY_C` and the previous key.
- **Item 7:** the anti-feedback donor rule (raw keyD must be below `hi`) blocks exactly the deep-shadow pixels that flattening exists to fix. The donor rule now also accepts pixels whose hue matches the key at any brightness, if the Helper is confident they are background. The gain is applied in linear light. The existing CIELAB keyD already ignores much of a shadow, so the expected gain is smaller: it stays P1 behind a flag.
- **New P2 item 16:** projection alpha in the edge band. It reuses the F̂ and B̂ samples from item 3 at almost no cost.
- **Dropped:** none of the core items.

---

## Ranked plan

| Rank | Item | Pri | A13 cost (720p) | Gain for kids | Risk |
|---|---|---|---|---|---|
| 0 | Test fixtures with known alpha + metrics harness | P0 | offline | Every change is scored and gated | low |
| 1 | Mirrored edges on matte, guided-filter, mask-prep and unmix targets (not `dsT`) | P0 | 0 | Small: cleaner edges where arms leave the frame | none |
| 2 | Magic Helper trust (age + motion + outline-relative confidence) | P0 | ≈0 GPU; ~0.1 ms JS per mask | No ghost fill behind waving arms; a late mask no longer cuts arms | low |
| 3 | Foreground unmixing (blur-fusion over a 1/4-res pyramid) + despill backs off where unmixed | P0 | 0.3–0.6 ms (band part ×2.25 at 1080p) | **Largest**: blurred arms and hair keep their colour, no grey-green ghosts | medium |
| 4 | Speck removal + small-hole fill with one box sum | P1 | ~0.1 ms | No twinkling tape or clip specks | low |
| 5 | Temporal smoothing of guided-filter coefficients, lower full-res EMA | P1 | ~0.03 ms | Steady edges on still kids, less smear on hands and hair | low–medium |
| 6 | Robust border key sampler | P1 | CPU, under 0.1 ms every 2 s | Key no longer jumps to a shirt in close-ups; "add light" message | low |
| 7 | Screen flattening from the plate (flag off until gated) | P1 | ~0.07 ms | Hotspots, colour falloff, deep shadows | medium |
| 8 | Segmenter aspect ratio (verify first) | P1 | 0 | Better Helper mask on thin limbs at the frame sides | low |
| 9–16 | P2 list | P2 | | | |

**Totals:** items 1–7 add about 0.5–0.9 ms on A13 against the 33 ms budget, and under 0.3 ms on M-series against 16.7 ms. At the 1080p preset, add about 0.3 ms on A13.

**Delivery:**
- M0: items 0 and 1, plus baseline scores.
- M1: items 2 and 3.
- M2: items 4, 5 and 6.
- M3: items 7 and 8.

Every item ships only if its harness gates pass.

---

## 0 (P0). Test fixtures with known alpha + metrics harness

**(a) What CorridorKey shows**
- The hint model was trained on coarse, blurry, eroded masks (v1 README:109).
- The owner confirms a clean plate was used in training (#114). A user describes the training data as renders composited onto plates (#74).
- PRs #267 and #268 (closed, not merged) designed generated fixtures and split errors into background showing through (fp) and child lost (fn). Dilating the mask by 16 px gave fp 0.2055 / fn 0.0100.
- Merged PR #179 replaced a despill test that could never fail.
- Our `make_fake_camera.py` has hard edges and no ground truth, and there are no Playwright specs.

**(b) Why it helps:** without known-alpha fixtures we cannot tell whether any shader change made the matte better or worse.

**(c) What to build**

*Generator:* `/Users/md/Green Screen 2/web/e2e/fixtures/makeKeyerFixtures.ts`, run with Node and `tsx`, seeded, no native dependencies. It uses the same command-line options, outputs, render model, scenarios (M0: S00 S01 S04 S05 S06 S11 S16 S18; M2: the rest) and mask-corruption profiles as the original plan:
- Outputs `cam.y4m` (C420jpeg), `alpha.y4m`, `fg.y4m`, `ml/NNNN.u8` and `manifest.json`, cached by hash.
- Rendering is linear-light. Hair is capsule strands. Motion blur averages 8 sub-frames of premultiplied colour and alpha. Spill is `F_obs = F + k·screen·rim`. The backing has vignette, gradient, hotspot, wrinkles and a cast shadow. The camera model has white balance, flicker, Poisson–Gaussian noise, piecewise sRGB, BT.601 full range and 4:2:0. Each frame carries a frame-ID barcode.
- Each strand is rasterised only inside its bounding box, which gives about 1–3 s per 720p frame in Node.
- PR CI runs 30 frames at 640×360. A nightly run uses 90 frames at 1280×720.

*Metrics:* `metrics.ts` and `metrics.test.ts`, unchanged from the original plan:
- SAD and MSE over the whole frame and the edge band;
- Grad and Conn (Rhemann et al. 2009);
- FP_bg and FN_fg;
- Islands;
- dtSSD (Erofeev et al. 2015) and Flicker;
- Ghost;
- Composite ΔE00;
- Spill residual;
- Recovery frames after a drift event;
- Cadence ripple.

The `asym` and `ghost` excerpts from the original plan stand. They are original and correct; SAD uses the /1000 convention.

*Harness:* `/Users/md/Green Screen 2/web/harness.html` and `web/src/harness/keyerHarness.ts`. The Compositor additions are unchanged: `markForegroundDirty`, `debugReadMatte` (built on the existing synchronous `matteGl`, which is fine in a harness), `debugReadComposite`, `setMlWeight(w, {immediate:true})` and `setMlTrust`. Masks are fed by frame index, so no wall-clock time is involved.

*Playwright:* `/Users/md/Green Screen 2/web/playwright.config.ts` and `/Users/md/Green Screen 2/web/e2e/keyer-quality.spec.ts`.

**Gate changes**
- Baselines are stored **per engine and platform**: `baselines/<engine>-<os>/<id>.json`. WebKit on Linux CI may use a software GL with different float support from iPad Safari.
- Regression rule: fail if `metric > base·1.05 + ε`, where ε is a fixed small amount per metric (e.g. 0.002 for FP_bg and FN_fg, 0.5 for ΔE00).
- The run records `floatOk`, `unmixOk` and the target formats, so a fallback path is reported, never silently scored.
- Kept from the original plan:
  - ML-on must not be more than 10 % worse than chroma-only for every mask profile.
  - Every despill swatch must contain spill before processing (residual > 0.05).
  - Each toggle must change at least 1 % of band pixels.
- Before release, run on a real iPad through Safari Web Inspector remote, at least once per milestone.

**(d) Gain:** indirect, but it prevents regressions on shadows, spill and motion. **(e)** P0.

---

## 1 (P0). Mirrored edges

**(a) What CorridorKey does:** pads frames with reflection (`video_io.py:103-112, 198-207`, BORDER_REFLECT_101), uses reflect padding in its refine convolution when the tensor is big enough and replicate otherwise (`stage2.py:211-213`), and crops back afterwards (`runtime.py:581-584`).

**(b) Why it helps:** with clamp, box filters and the mask dilation count the edge texel several times.

**(c) Change**
- `createTarget(gl, w, h, float, wrap = gl.CLAMP_TO_EDGE)`; today wrap is hard-coded at `Compositor.ts:382-383`.
- Use `MIRRORED_REPEAT` for `matteT`, `gfT`, `prepT` and the unmix targets.
- Keep **clamp** for `fgTex`, the LUT, `bgBlurT`, `sampleT` and `dsT` (see item 4).
- WebGL2 allows mirroring on textures whose size is not a power of two.

**(d) Gain:** small, in the 8 px border strip on S06. **(e)** P0, because it is free. Cost: 0.

---

## 2 (P0). Magic Helper trust

**(a) What CorridorKey does:**
- Each hint frame gets one trust value in [−1, 1] that goes into the network. Hint pixels are never changed.
- The default is 1.0 when a hint is present (`stage1.py:713-728`).
- Inside a window, frames without a hint get 0, and a window with no hints gets −1 (`runtime.py:485-502`).
- The user menu offers 0.95 for an artist matte and 0.75 for an automatic hint; carried hints get 0.95 (`run_interactive.py:295-313`).
- The model can add area from a hint but struggles to remove it (README:109).

**(b) Why it helps:** MediaPipe runs every 2nd or 3rd frame and is 1–2 frames late. Today `u_mlWeight` treats fresh and stale masks the same.

**(c) Pure module `/Users/md/Green Screen 2/web/src/lib/helperTrust.ts`** (original; replaces the earlier `maskStats`):

```ts
const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
/** Per new 256x256 mask: outline-relative uncertainty + motion vs previous mask. */
export function maskStats(cur: Uint8Array, prev: Uint8Array | null, w = 256) {
  let amb = 0, outline = 0, diff = 0
  for (let i = 0; i < cur.length; i++) {
    const v = cur[i]
    if (v > 51 && v < 204) amb++
    if (i % w && (v > 127) !== (cur[i - 1] > 127)) outline++          // horizontal crossings
    if (i >= w && (v > 127) !== (cur[i - w] > 127)) outline++         // vertical crossings
    if (prev) diff += Math.abs(v - prev[i])
  }
  // a crisp mask has ~3 uncertain px per outline px; more means the model is guessing
  const excess = amb / Math.max(1, 3 * outline)
  return { excess, motion: prev ? diff / (255 * cur.length) : 0 }
}
export function helperTrust(s: { excess: number; motion: number }, ageFrames: number) {
  const qModel = clamp01(1.5 - 0.5 * s.excess)                       // 1 up to 1x, 0 at 3x
  const qAge = Math.exp(-ageFrames * (0.04 + 4 * s.motion))
  return clamp01(qModel * qAge)
}
export const dilateFor = (motion: number, base: number) =>
  base * (1 + 0.6 * clamp01((motion - 0.01) / 0.05))
```

**Integration**
- `segmenter.ts` returns `capturedAt`, the `t` passed to `segmentForVideo` (line 70).
- In `useStage.ts`, the age is `(currentVideoFrameTime − capturedAt) / frameMs`, using the `requestVideoFrameCallback` `mediaTime` (or `video.currentTime`), not `performance.now()`.
- `runMaskPrep` uses the JS dilate value instead of `KEYER_TUNING.dilate` (`Compositor.ts:1143`).

**FG_FS ML block** (replaces lines 371–378; keeps `u_coreWeight`):

```glsl
uniform float u_mlTrust;                                   // 1.0 until a mask arrives
vec2 gm = texture(u_maskPrep, uv).rg;
float garbage = smoothstep(0.05, 0.35, gm.r);
float core = smoothstep(mix(0.97, 0.75, u_mlTrust), mix(0.995, 0.95, u_mlTrust), gm.g) * u_coreWeight;
float killW = u_mlWeight * smoothstep(0.10, 0.60, u_mlTrust);  // stale: stop removing
float fillW = u_mlWeight * u_mlTrust * u_mlTrust;              // stale: fill even less
float aKill = aKey * mix(1.0, garbage, killW);
a = max(aKill, core * fillW);
coreFill = clamp(a - aKill, 0.0, 1.0);
```

At trust = 1 and weight = 1 this gives the same result as today: `max(a·garbage, core)`.

**Tests**
- Unit:
  - a still child at age 2 gives ≥ 0.9;
  - motion 0.04 at age 3 gives ≤ 0.6;
  - a mask that is 0.5 everywhere gives ≤ 0.2;
  - trust falls steadily as age grows;
  - a close-up silhouette with a crisp outline gives qModel = 1.
- E2E: S06 and S18 × the lag, cadence, dilate16 and dropout15 profiles.
  - The ML-versus-chroma gate passes.
  - Ghost on S06 + lag2 drops by at least 30 %.
  - Cadence ripple goes down.

**Cost:** about 0.1 ms of JS per mask (65k pixels), one uniform per frame.

**(d) Gain:** no ghost fill behind waving arms, and no amputated arms from a late mask. **(e)** P0.

---

## 3 (P0). Foreground unmixing + despill back-off

**(a) What CorridorKey does:**
- Outputs a straight foreground next to alpha (v1 `model_transformer.py:185-186, 251-295`; v2 `model.py:13-15`, `runtime.py:665-683`).
- The v2 colour head starts as an exact copy of the input RGB (`stage2.py:16-19, 524-526`).
- Composites in linear light (v1 `inference_engine.py:284-305`; v2 `runtime.py:665-683, 705-729`).
- Then applies a gentler despill to the unmixed colour, default strength 0.5 (`runtime.py:127, 604-614`).

**(b) Why it helps:** an edge pixel is `I = αF + (1−α)B`. Despill only turns the B part grey. Estimating F and outputting it *replaces* the screen.

**(c) Method:** blur-fusion (Forte & Pitié 2021), `F = F̂ + α(I − αF̂ − (1−α)B̂)`, with F̂ and B̂ taken from a weighted mip pyramid (the multi-scale idea in Germer et al. 2020). B̂ is local and is also a slowly learned plate of the empty screen.

The `UNMIX_PREP_FS` and FG_FS sketches from the original plan stand (they are original and the formula is correct), with these changes:
1. **Run only on fresh camera frames.** Prep, mipmaps and the plate update run inside the same `up.fresh || matteDirty || …` branch that runs the matte (`Compositor.ts:1273`), so the 0.1 learn rate and 0.995 decay are per camera frame.
2. **Targets and fallback:**
   - First choice: `texStorage2D(RGBA16F, 5 levels)` when `floatOk`.
   - Otherwise, or if mipmap generation errors at start-up: `SRGB8_ALPHA8` with 5 levels, which is core-renderable and mipmappable. Store `vec4(L·w, w)` as usual. Hardware encodes RGB as sRGB and stores the weight in the linear 8-bit alpha. sRGB encoding keeps small premultiplied values precise, and Apple GPUs filter sRGB textures in linear space.
   - Only if both fail does `unmixOk = false` fall back to today's despill path.
3. **Feedback-loop rule:** the prep program must not have `u_unF` or `u_unB` bound on any sampler unit while F and B are attached. Bind them only in FG_FS (units 6 and 7) and GAIN_FS.
4. `despillA(c, a, k)` gains `edgeBoost` (it replaces `SPILL_EDGE` at `shaders.ts:336`) and is called with the **unmixed** `rgb`, not `c`. Keep our max-inside / average-at-edge limit and the luma re-add. Mirror the change in `autoKey.despill`.
5. `FINAL_ALPHA_GLSL` is factored out exactly as planned, so the α used to unmix is exactly the α used to blend. The prep pass binds the matte, `gfAB`, `maskPrep` and `dsMass`.
6. Defaults: `u_unmix = 1`. Try `u_spill` 0.9 → 0.6 and choke 1.3 → 1.15, and decide on the harness scores.

**Cost on A13**

| Part | 720p | 1080p preset |
|---|---|---|
| Prep at 320×180 | ~0.05 ms | same (matte capped at 1280) |
| Two mip chains | 0.05–0.2 ms | same |
| Edge-band work in the final draw (~10–15 % of pixels × 6 `textureLod` + 2 conversions) | 0.2–0.35 ms | 0.45–0.8 ms |

M-series: about 0.15 ms at 720p.

**Tests:** unit tests on `unmix.ts` as in the original plan. E2E:
- S05 and S06: band ΔE00 improves by ≥ 25 % and spill residual by ≥ 40 %.
- S11: no FN_fg regression.
- Toggling unmixing changes the output.
- The report shows which target format was used (`RGBA16F`, `SRGB8_ALPHA8` or off).

**(d) Gain:** largest. Motion-blurred arms and hair keep their own colour. **(e)** P0.

---

## 4 (P1). Speck removal + small-hole fill with one box sum

**(a) What CorridorKey does:** threshold the matte (0.5 in OpenCV, 0.25 in torch), label connected parts, keep parts of at least 400 px (default), dilate about 25 px, blur, then multiply into α. It never fills holes (`color_utils.py:422-505`; `inference_engine.py:270-272, 352, 406-408`).

**(b) Why ours is different:** one box sum over a 68 px window does both the size test and the safe-zone dilation. The same sum on screen coverage finds small enclosed holes.

**(c) Sketch:** `DS_DOWN_FS` and the `FINAL_ALPHA` block from the original plan stand. `DS_BOX_FS` changes so the frame edge counts as empty, never mirrored:

```glsl
uniform sampler2D u_src; uniform vec2 u_step;
void main() {
  vec4 s = vec4(0.0);
  for (int i = -8; i <= 8; i++) {
    vec2 q = v_uv + float(i) * u_step;
    float inside = step(0.0, q.x) * step(q.x, 1.0) * step(0.0, q.y) * step(q.y, 1.0);
    s += texture(u_src, q) * inside;   // off-frame counts as empty, not mirrored
  }
  o = s / 17.0;
}
```

**Changes from the original plan**
- `dsT` uses clamp, not mirror.
- Use RGBA16F when `floatOk` (half-float colour buffers are renderable with `EXT_color_buffer_half_float`), and RGBA8 only as a fallback.
- The hole fill keeps its own flag, gated on S05 and S06 (finger gaps of about 5×40 px are close to `u_minHole`).

**Cost:** about 0.1 ms. **Tests:** as in the original plan, plus an S16 variant with a speck touching the frame edge.

**(d) Gain:** no twinkling tape and clip specks, mostly on Tier-1-only devices. **(e)** P1.

---

## 5 (P1). Temporal smoothing of guided-filter coefficients

**(a) What CorridorKey does:** does all temporal work at low resolution in stage 1. The full-resolution stage 2 runs per frame and re-reads the raw RGB (`stage1.py:1-24`; `stage2.py:1-24, 511-530`).

**(b) Why it helps:** apply the EMA to (A, b, mean_p) at half resolution and evaluate α = A·guide + b each frame. Interiors stay steady while edges follow the current guide.

**(c) Sketch:** stands as originally written. `GF_COEF_FS` writes `.w = m.x + 0.5`, matching the existing +0.5 convention for centred values at `shaders.ts:217`. A ping-pong `GF_TEMPORAL_FS` follows the second box blur.
- Runs only when the guided filter runs (fresh frames).
- `gfT` grows to 5 targets, and `resetTemporal` clears the history.
- `u_cTemporal = 0.5`, and the full-res `temporal` drops 0.5 → 0.25 only when the guided filter is active. The tent fallback keeps 0.5.

**Caveat:** the guard uses a box-blurred mean, so motion of very thin strands is under-detected. Hair still follows, because α uses the current guide; the gate below checks this.

**Cost:** about 0.03 ms. **Gates:** S06 Ghost down ≥ 30 %; S00 and S07 Flicker ≤ baseline; S05 dtSSD ≤ baseline.

**(d) Gain:** steady edges on still kids and less smear on hands and hair. **(e)** P1.

---

## 6 (P1). Robust border key sampler

**(a) What CorridorKey does:** `estimate_screen_color` picks the green or blue checkpoint from mean G versus mean B where `alpha_hint < 0.3` on the first frame. It falls back to green if coverage is under 1 % or |G−B| < 0.05 (`color_utils.py:329-383`). #246 lists the failure cases: close-ups, dim plates, a subject wearing the screen colour, mixed light.

**(b) Why it helps:** the same failure cases hit our auto-key in close-ups and dim rooms.

**(c) Sketch:** the `robustBorderKey` sketch stands, with these changes:
- The chroma cut becomes `C > max(MIN_KEY_C, 0.5·C_prev)` instead of a fixed 15, so a dim, washed-out screen is not called "border-covered".
- New helpers `median` and `deltaE00` go in `labKey.ts`, with unit tests against published CIEDE2000 test pairs.
- The 24 border cells are binned in JS from the existing PBO readback grid, by sample position. The readback already returns positions.

**Cost:** CPU, under 0.1 ms every 2 s. **Tests:** as in the original plan.

**(d) Gain:** the key no longer jumps to a kid's shirt in close-ups, and teachers get a clear "add light" message. **(e)** P1.

---

## 7 (P1, flag off). Screen flattening from the plate

**(a) What CorridorKey does:** applies an optional global linear gain and contrast before the model, with the exact inverse on the foreground afterwards (`video_io.py:159-181, 308-311`; `runtime.py:595-601, 667`). It used a clean plate in training (#114). #129 suggests textured and gradient screens for augmentation. Our spatial gain map is only loosely inspired by these.

**(b) Why it helps:** low-frequency changes across the screen (hotspots, colour falloff, deep shadows) push screen pixels away from the key colour.

**(c) Changes from the original plan**
- **Gain in linear light.** GAIN_FS computes the gain from the linear plate. MATTE_FS applies it as `ck = linToSrgb(clamp(srgbToLin(c) * g, 0., 1.))` before the LUT lookup. That is 2 conversions per matte pixel, about 0.02 ms at 720p.
- **Donor rule widened**, so deep shadows can teach the plate:

  ```glsl
  float hueOk = smoothstep(0.80, 0.94, dot(normalize(lab.yz + 1e-4), u_keyHueDir)); // chroma direction ≈ key
  float bgByHelper = (1.0 - smoothstep(0.05, 0.20, gmR)) * step(0.6, u_mlTrust);
  float rawOk = 1.0 - smoothstep(u_lo, u_hi, rawD);
  wB *= max(rawOk, hueOk * bgByHelper);
  ```

  `lab` is the pixel's CIELAB value at prep resolution and `gmR` is the garbage channel of `maskPrep`. Without a confident Helper, only raw-key donors count, as before.
- Kept from the original plan: ML-core pixels never donate; the gain is clamped to [0.7, 1.5]; the plate resets on a camera bump.

**Cost:** about 0.07 ms.

**Gate to turn it on:** S01, S02, S03, S04 and S18 improve band SAD or FP_bg by ≥ 15 %, with no FN_fg regression on S11 or S17.

**Note:** keyD already ignores much of a plain shadow, so the main benefit is hotspots and colour falloff. If S04 shows no gain, ship the hotspot and falloff benefit only and move the shadow part to P2.

**(d) Gain:** cleaner keys on uneven classroom sheets. **(e)** P1, behind a flag.

---

## 8 (P1, verify first). Segmenter aspect ratio

**(a) What CorridorKey does:** sizes each foundation-model input with an area resize to H/4, so there is "no resize or aspect distortion" (`model.py:91, 226-229`; `runtime.py:283-292`).

**(b) Why it helps:** a stretched input distorts the Helper mask on thin limbs.

**(c) Steps:**
1. Run the circle-head harness test on `selfie_segmenter.tflite`, which `segmenter.ts:42` uses today.
2. If the mask comes back stretched, try `selfie_segmenter_landscape` (144×256) on landscape cameras, or letterbox to square with mirror padding and crop the mask back.
3. Always feed raw camera pixels.

**Gate:** S06 + ML FN_fg on the arm core improves, and the benchmark stays in the same cadence band.

**(d) Gain:** better Helper mask on thin limbs at the frame sides. **(e)** P1, after verification.

---

## P2 items (each gated on the harness)

| # | Item | Source of the idea | Notes |
|---|---|---|---|
| 9 | Linear-light compositing stage (`SRGB8_ALPHA8`) | v1 `inference_engine.py:284-305`; `LLM_HANDOVER.md:38, 71` | Promote only if band ΔE over magenta or white is ≥ 3 worse than a linear reference |
| 10 | Recorder-only symmetric 3-tap smoothing; 7-tap cos² window in the offline render | taper windows `video_io.py:582-604`, `runtime.py:550-561` | Recording only, so the live mirror has no lag |
| 11 | "Check the key" checker view | v2 `video_io.py:792-797` | Use **our own** 48 px, 0.70/0.45 checker |
| 12 | 16-bit matte history + ratio-based motion guard | asinh precision lesson only (`color_utils.py:98-128`) | Removes leftover 8-bit EMA residue (`matteT` is RGBA8 today) |
| 13 | Logit-space detail residual after the guided filter | v1 refiner, ×10 delta logits (`model_transformer.py:99-142, 285-295`) | Ship only if hair Grad improves without more Flicker |
| 14 | "Trim to screen" box | v1 `color_utils.py:186-207`; #180 | Needs teacher UI |
| 15 | Key-direction despill | original | For yellow-green or teal fabric |
| 16 | **New: projection alpha in the edge band** | Standard colour-line matting (Chuang et al. 2001; Levin et al. 2008) | See below |

**Item 16 detail.** Reuse the F̂ and B̂ samples from item 3:

```glsl
vec3 d = Fh - Bh;
float aProj = clamp(dot(I - Bh, d) / max(dot(d, d), 1e-4), 0., 1.);
float wP = smoothstep(0.01, 0.05, dot(d, d));          // only where F̂ and B̂ differ clearly
a = mix(a, aProj, 0.5 * wP * unW);
```

It fixes α where the keyD smoothstep misjudges the real mixing fraction in motion blur. It adds about 0.02 ms because the fetches are shared. It is risky on green clothing, so it needs an S11 gate.

**Harness hardening** (part of task 0 in M2): extra despill swatches, a ±1 stop exposure sweep, full and limited range YUV, and an IEC sRGB curve test (#28, #179).

---

## What NOT to adopt, and why

The original table stands, with two corrections:
- **CorridorKey's despill formula:** reject it on our own analysis (Rec.601 luma shift of about −0.38·s, giving darker, pinker skin). #195 is not evidence against the formula.
- **Hann carry:** the drift warning is our own inference from the carry design (`runtime.py:485-502` carry cache). The README does not state it.

The rest is unchanged:
- No CorridorKey network, weights or code.
- No unmixing by dividing by α.
- No separate raw-LUT plate pass.
- No exact connected-component labelling.
- No asinh encoding, 2048 resize or bf16.
- No symmetric windows in the live preview.
- No linear stage at P1 for now.
- No GPU IoU readback for trust.
- No memory-based sizing.
- No training on the fixtures.

## Where each change lands in the pass graph

```
camera (fresh only) ─► MATTE_FS [+u_gain, linear (7)] ─► DS_DOWN/DS_BOX (4, clamp + zero-outside)
   ─► GF_PACK ─► BOX² ─► GF_COEF(.w = mean I) ─► BOX² ─► GF_TEMPORAL (5)
   ─► UNMIX_PREP_FS (MRT F + B-plate, RGBA16F | SRGB8_ALPHA8) ─► mipmaps (3) ─► GAIN_FS (7, next frame)
mask ─► MASK_PREP_FS (dilate from JS, item 2)
FG_FS (canvas res): FINAL_ALPHA_GLSL [GF → despeckle/hole (4) → ML fusion with u_mlTrust and u_coreWeight (2) → choke]
   → blur-fusion unmix in the band (3) [+ projection α (16)] → despillA(rgb, …, SPILL_EDGE·(1−unW)) → light wrap
Mirrored: matteT, gfT, prepT, unT. Clamp: fgTex, LUT, bgBlurT, sampleT, dsT.
Sampler units: u_dsMass = 5, u_unF = 6, u_unB = 7 (FG_FS); u_gain = 4 (MATTE_FS); unF/unB never bound in the prep program.
```

## Files to change

**Edit:**
- `/Users/md/Green Screen 2/web/src/lib/keyer/shaders.ts`
- `/Users/md/Green Screen 2/web/src/lib/keyer/Compositor.ts`
- `/Users/md/Green Screen 2/web/src/lib/keyer/autoKey.ts`
- `/Users/md/Green Screen 2/web/src/lib/keyer/labKey.ts` (adds `median` and `deltaE00`)
- `/Users/md/Green Screen 2/web/src/lib/segmenter.ts`
- `/Users/md/Green Screen 2/web/src/lib/useStage.ts`

**New:**
- `/Users/md/Green Screen 2/web/src/lib/helperTrust.ts` and its test
- `/Users/md/Green Screen 2/web/src/lib/keyer/unmix.ts` and its test
- `/Users/md/Green Screen 2/web/src/lib/keyer/metrics.ts` and its test
- `/Users/md/Green Screen 2/web/e2e/fixtures/makeKeyerFixtures.ts` (replaces the planned Python script)
- `/Users/md/Green Screen 2/web/harness.html`
- `/Users/md/Green Screen 2/web/src/harness/keyerHarness.ts`
- `/Users/md/Green Screen 2/web/playwright.config.ts`
- `/Users/md/Green Screen 2/web/e2e/keyer-quality.spec.ts`
- `/Users/md/Green Screen 2/web/e2e/baselines/<engine>-<os>/`

**Plan to update:** `/Users/md/Green Screen 2/docs/research/realtime/recommendation.md`. Add items 0–3 as P0 and 4–8 as P1. Replace "BGMv2 plate: possible P3" with item 7, and add P2 item 16.