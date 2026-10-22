# Lessons from CorridorKey: implementation plan for the Magic Screen real-time keyer

Yes. CorridorKey's design, its user reports and the community's test work give us eight changes worth making and a test harness to check them. The biggest one is **foreground unmixing**: work out the child's real colour at soft edges instead of only removing green. That is what fixes grey-green waving arms and hair. The other changes are small: they make the Magic Helper safer when its mask is late, remove specks, steady the edges and even out uneven screens.

All of this is clean-room. CorridorKey's ideas are described in my own words and all GLSL and JS below is original. No CorridorKey code, weights or name ships, and none was run. Published methods are named where used: blur-fusion foreground estimation (Forte & Pitié 2021), multi-level foreground estimation (Germer et al. 2020), the guided filter (He et al.), Rhemann et al. 2009 matting metrics and dtSSD (Erofeev et al. 2015).

Every cost figure is an estimate for 720p (the matte is capped at 1280×720) and must be measured on an A13 and an M-series iPad. All file paths are under `/Users/md/Green Screen 2/web/src/lib/keyer/` unless shown otherwise.

## What already exists, so it is not proposed again

`recommendation.md` already plans, and `shaders.ts` and `Compositor.ts` already contain:
- the CIELAB keyD distance baked into a 3D LUT;
- the motion-guarded matte EMA;
- the half-res guided filter;
- choke;
- the alpha-aware, luma-keeping despill;
- light wrap;
- auto-key with drift tracking;
- the ML garbage and core mattes with slow decay and slow growth;
- the async PBO readback;
- an `SRGB8_ALPHA8` linear stage (P2);
- an offline two-direction "Make it Magic" render.

The items below only add to or sharpen these.

## Ranked plan: (visible gain for kids) / (GPU cost + risk)

| Rank | Item | Pri | A13 cost | Gain for kids | Risk |
|---|---|---|---|---|---|
| 0 | **Test fixtures with known alpha + metrics harness** | P0 | offline | Every change below gets a score and a pass/fail gate | low |
| 1 | **Mirrored edges** on matte, guided-filter, mask-prep and new targets | P0 | 0 | Small: cleaner edges where arms leave the frame | none |
| 2 | **Magic Helper trust** (mask age + motion + model confidence) | P0 | ≈0 (a few uniforms; JS work only when a new mask arrives) | No ghost fill behind waving arms; a late mask no longer cuts off arms | low |
| 3 | **Foreground unmixing** (blur-fusion over a 1/4-res pyramid) + despill backs off where unmixed | P0 | 0.3–0.6 ms | **Largest**: motion-blurred arms keep skin colour, hair keeps its colour, no grey-green ghosts | medium (Safari support for half-float mipmaps) |
| 4 | **Speck removal + small-hole fill** in one box-sum pass | P1 | ~0.1 ms | No twinkling tape, clip and seam specks (Tier 1-only devices most) | low |
| 5 | **Temporal smoothing on guided-filter coefficients**, lower full-res EMA | P1 | ~0.03 ms | Steady edges on still kids, no smear on waving hands or hair | low–medium |
| 6 | **Robust border key sampler** (covered border, dim screen, ambiguous colour) | P1 | CPU, under 0.1 ms every 2 s | Key no longer jumps to a kid's shirt in close-ups; clear "add light" message | low |
| 7 | **Screen flattening** from the unmix screen layer (flag, off until the harness proves it) | P1 | ~0.05 ms | Shadows, hotspots and corners of uneven sheets key cleanly | medium (green-clothing feedback) |
| 8 | **Segmenter aspect ratio** (landscape model, or letterbox instead of stretch) | P1 (verify first) | 0 | Better helper mask on thin limbs at the frame sides | low |
| 9–15 | P2 list (see the P2 section) | P2 | | | |

Total added cost for items 1–7: about 0.5–0.8 ms on A13 against the 33 ms budget, and under 0.3 ms on M-series against 16.7 ms.

**Delivery order:**
1. **M0:** item 0, plus item 1. Record baseline scores from today's shaders.
2. **M1:** items 2 and 3.
3. **M2:** items 4, 5 and 6.
4. **M3:** items 7 and 8.

Every item ships only if the harness gates in item 0 pass.

---

## 0 (P0). Test fixtures with known alpha + metrics harness

**What CorridorKey shows:**
- It trained on computer-generated subjects composited over plates, so alpha and foreground were known exactly (v1 README:109; owner on issues #74 and #114).
- Community PRs #267 and #268 (not merged, design only) define per-case generated fixtures and split errors into background showing through (false positive) and child lost (false negative). PR #268 found that a mask dilated by 16 px gives fp 0.21 / fn 0.01, an imbalance that one overall average hides.
- PR #179 found a despill test that could never fail.
- Today our `e2e/fixtures/make_fake_camera.py` draws hard edges and writes no ground truth, and there are no Playwright specs at all. We cannot currently tell whether a shader change made the matte better or worse.

**Task A: fixture generator.** New file `/Users/md/Green Screen 2/web/e2e/fixtures/make_keyer_fixtures.py` (stdlib only, seeded).
- **Command line:**
  - `--scenario S05 --frames 30|90 --size 640x360|1280x720 --ml-profile dilate8,lag2,cadence3 --x264 CRF` (the last option only if `ffmpeg` is installed).
  - Pull-request CI runs 30 frames at 640×360. A nightly run uses 90 frames.
- **Outputs per scenario** go to `web/e2e/.fixtures/<id>/` (git-ignored, cached by a hash of the script and arguments):
  - `cam.y4m` in C420jpeg, the same as today's file, so it also works as Chrome's fake camera;
  - `alpha.y4m` (ground-truth alpha in Y);
  - `fg.y4m` (straight foreground with no spill);
  - `ml/NNNN.u8` (256×256 masks with corruption applied);
  - `manifest.json` (seed, parameters, per-frame tags, region boxes, and the frame-ID barcode box that metrics skip).
- **Render model.** All of it is done in linear light and encoded once.
  1. **Shapes:** signed-distance shapes with coverage `clamp(0.5 - sd, 0, 1)`, combined front to back with "over".
  2. **Hair:** 150–400 capsule strands of radius 0.25–0.6 px, which gives true partial alpha.
  3. **Motion blur:** average 8 sub-frames of *premultiplied* colour and alpha.
  4. **Spill:** `F_obs = F + k·screen·rim`, with k = 0.12 for skin, 0.35 for hair, 0.08 for shirts, plus 0.03 of ambient bounce. Ground truth keeps the clean F.
  5. **Backing:** vignette, side gradient, hotspot, wrinkles and creases, and a cast shadow (the child's alpha shifted and blurred, darkening by 0.35–0.65 with a slight cool tint).
  6. **Camera:** exposure, auto white balance gains, 100 or 120 Hz rolling flicker, Poisson–Gaussian noise, clipping, the exact piecewise sRGB curve, BT.601 full range, 4:2:0 box chroma subsampling, and optional 8×8 block quantisation.
  7. **Frame ID:** a 16-bit barcode so frames can be matched up.
- **Scenarios, M0 set:**

  | ID | Content |
  |---|---|
  | S00 | clean, plus an exposure sweep |
  | S01 | uneven lighting |
  | S04 | moving shadow |
  | S05 | hair with spill, plus colour swatches: yellow, teal, violet, skin |
  | S06 | arm waving at 3 Hz, shutter 1/60 and 1/30 |
  | S11 | sage and forest-green clothes |
  | S16 | tape and binder clips |
  | S18 | a classroom mix of several of the above |

- **Scenarios, M2 set:** S02 hotspot, S03 wrinkles, S07 low light, S08 compression, S09 white-balance and exposure drift, S10 flicker, S12 screen hues, S13 small screen, S14 close-up, S15 props, S17 walk in and out.
- **ML mask corruption profiles:**
  - `erode4/8/16` and `dilate4/8/16`;
  - `holes` and `islands`;
  - `blur8`;
  - `lag1/2/3`, `cadence2/3` and `dropout15`.

**Task B: metrics.** New file `metrics.ts`, with tests in `metrics.test.ts` (vitest).
- **Metrics:**
  - SAD and MSE over the whole frame and over the edge band U (6 px around the 0.5 contour, or 0.02 < α < 0.98);
  - Grad (σ = 1.4) and Conn (Rhemann et al. 2009);
  - **FP_bg** and **FN_fg** (the PR #268 split);
  - Islands (components under 64 px);
  - dtSSD and Flicker (on pixels whose ground truth is still);
  - Ghost: α̂ where ground truth is 0 but was over 0.5 in one of the two previous frames;
  - Composite ΔE00 over grey and magenta backgrounds;
  - Spill residual `max(G - max(R, B), 0)` in U;
  - Recovery frames after a drift event;
  - Cadence ripple: the difference in SAD between frames with a fresh mask and frames without.
- **Unit tests** on hand-made 4×4 and 8×8 arrays with known answers: identical input gives 0 everywhere; one wrong background pixel gives the expected FP_bg; a Conn example worked by hand; the dtSSD sign convention.

```ts
// metrics.ts (excerpt, original)
export function asym(aHat: Uint8Array, aGt: Uint8Array, skip: Uint8Array) {
  let fp = 0, nb = 0, fn = 0, nf = 0, sad = 0, sadU = 0
  for (let i = 0; i < aGt.length; i++) {
    if (skip[i]) continue
    const g = aGt[i] / 255, h = aHat[i] / 255, d = Math.abs(h - g)
    sad += d
    if (g > 0.02 && g < 0.98) sadU += d
    if (aGt[i] === 0) { fp += Math.max(h - g, 0); nb++ }
    if (aGt[i] === 255) { fn += Math.max(g - h, 0); nf++ }
  }
  return { sad: sad / 1000, sadBand: sadU / 1000, fpBg: fp / Math.max(nb, 1), fnFg: fn / Math.max(nf, 1) }
}
export function ghost(aHat: Uint8Array, gt: Uint8Array, gtM1: Uint8Array, gtM2: Uint8Array) {
  let s = 0, n = 0
  for (let i = 0; i < gt.length; i++)
    if (gt[i] === 0 && Math.max(gtM1[i], gtM2[i]) > 127) { s += aHat[i] / 255; n++ }
  return n ? s / n : 0
}
```

**Task C: deterministic in-browser harness.**
- New files `/Users/md/Green Screen 2/web/harness.html` (a second Vite entry, dev and test only) and `web/src/harness/keyerHarness.ts`.
- **How it runs:**
  - Decode the Y4M to RGBA.
  - Draw each frame into an `HTMLCanvasElement`. Canvas is already a `ForegroundSource`.
  - Call `render()`.
  - Read the matte and the composite back.
  - Feed `ml/NNNN.u8` through `setMaskData`, using the frame index for timing so no wall-clock time is involved.
- **Compositor additions:**
  - `markForegroundDirty()`, so a canvas foreground is uploaded again each step. Check how `upload().fresh` treats canvases.
  - `debugReadMatte(): Uint8Array`, built on the existing `matteGl`.
  - `debugReadComposite(bg: RGB): Uint8ClampedArray`.
  - `setMlWeight(w, { immediate: true })`, which skips the 300 ms fade.
  - `setMlTrust(q)` (see item 2).
- **Playwright:** new `/Users/md/Green Screen 2/web/playwright.config.ts` with **WebKit** (closest to iPad Safari) and Chromium projects. New spec `/Users/md/Green Screen 2/web/e2e/keyer-quality.spec.ts`, which writes one score file per scenario to `web/e2e/baselines/<id>.json`.
- **Gates:**
  - Fail if any metric on any scenario gets more than 5 % worse than the stored baseline.
  - For every ML profile, FP_bg and FN_fg with ML on must not be more than 10 % worse than the chroma-only run. A bad mask must never be worse than no mask.
  - Every despill and unmix swatch must contain spill *before* processing (residual over 0.05), so the test cannot pass without doing anything (the PR #179 lesson).
  - Toggling `u_unmix`, despill or despeckle must change at least 1 % of band pixels. This catches settings that silently do nothing, a bug found in the MIT OBS wrapper.
- Keep `fake-greenscreen.y4m` for the frame-rate smoke test.

---

## 1 (P0). Mirrored edges

**What CorridorKey does:** pads frames and hints by reflection (v2 `corridorkey/video_io.py:103-112,198-207`), uses reflection padding in its refine convolution (`stage2.py:211-213`), and crops back afterwards (`runtime.py:581-584`).

**Why it helps:** with clamp-to-edge, the radius-4 box and the 9×9 mask dilation count the border texel repeatedly. Arms crossing the frame edge pull the filter means toward that one texel, which can cause halos.

**Change in `Compositor.ts`:**
- `createTarget(gl, w, h, float, wrap = gl.CLAMP_TO_EDGE)`, and `makeTargets` passes the wrap mode through.
- In `ensureTargets`, use `gl.MIRRORED_REPEAT` for `matteT`, `gfT` and `prepT`. The new `dsT` and unmix targets also use it.
- `fgTex`, the 3D LUT, `bgBlurT` and `sampleT` stay on clamp.
- WebGL2 allows mirroring on textures whose size is not a power of two.

**Test:** S06 with the arm crossing the left edge. Band SAD inside the 8 px border strip must not get worse, and should improve.

**Cost:** 0. The gain is small but free.

---

## 2 (P0). Magic Helper trust

**What CorridorKey does:**
- v2 gives each hint a scalar trust value in [-1, 1]: 0.95 for an artist matte, 0.75 for an automatic hint, 0.5 or less for a scribble. A frame with no hint inside a hinted window gets 0 (`corridorkey/stage1.py:713-728`; `runtime.py:485-502`; `run_interactive.py:295-313`).
- The hint pixels are never changed, only how much they are trusted.
- v1 can add area from a hint that is too small but cannot remove area from one that is too big (README:109). Users hit this as "half the frames bleed" (#184).

**Why it helps:** MediaPipe runs every 2nd or 3rd frame and is 1–2 frames late. A stale mask behind a waving arm is exactly the "too-big hint in the wrong place" case. Today `u_mlWeight` treats a fresh mask and a stale one the same.

**New pure module `/Users/md/Green Screen 2/web/src/lib/helperTrust.ts`** (unit-tested). The mask motion is measured on the CPU from consecutive 256² masks, which are already in JS. No GPU readback is needed.

```ts
// helperTrust.ts (original)
const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
/** Per new mask: how unsure the model is, and how much the person moved since the last mask. */
export function maskStats(cur: Uint8Array, prev: Uint8Array | null) {
  let amb = 0, diff = 0
  for (let i = 0; i < cur.length; i++) {
    const v = cur[i]
    if (v > 51 && v < 204) amb++                       // 0.2..0.8
    if (prev) diff += Math.abs(v - prev[i])
  }
  return { ambiguousFrac: amb / cur.length, motion: prev ? diff / (255 * cur.length) : 0 }
}
/** Per displayed frame. ageFrames counts from the camera frame the mask was computed on. */
export function helperTrust(s: { ambiguousFrac: number; motion: number }, ageFrames: number) {
  const qModel = clamp01(1 - 4 * Math.max(0, s.ambiguousFrac - 0.04))  // edges are always a little unsure
  const qAge = Math.exp(-ageFrames * (0.04 + 4 * s.motion))            // still kid: slow decay; waving: fast
  return clamp01(qModel * qAge)
}
/** Wider garbage matte while the kid moves fast (keeps arms the late mask hasn't caught up with). */
export const dilateFor = (motion: number, base: number) =>
  base * (1 + 0.6 * Math.min(1, Math.max(0, (motion - 0.01) / 0.05)))
```

**Integration:**
- `/Users/md/Green Screen 2/web/src/lib/segmenter.ts` returns `capturedAt`, the video frame time passed to `segmentForVideo`.
- `useStage.ts`:
  - On each mask, call `maskStats`, then `setMaskData(data, w, h)` and `setMlDilate(dilateFor(...))`.
  - Every frame, call `setMlTrust(helperTrust(stats, (now - capturedAt) / frameMs))`.
- `Compositor.runMaskPrep` uses the dilate value from JS instead of `KEYER_TUNING.dilate`.

**FG_FS ML block**, replacing the current `fused`/`mix`. The idea is to fade the two mattes at different rates: the core matte (fill) loses weight faster than the garbage matte (kill), because a ghost fill is the worse error.

```glsl
uniform float u_mlTrust;                               // 0..1
// ...
vec2 gm = texture(u_maskPrep, uv).rg;
float garbage = smoothstep(0.05, 0.35, gm.r);
float core    = smoothstep(mix(0.97, 0.75, u_mlTrust), mix(0.995, 0.95, u_mlTrust), gm.g);
float killW   = u_mlWeight * smoothstep(0.10, 0.60, u_mlTrust); // stale: stop removing (arm may have moved)
float fillW   = u_mlWeight * u_mlTrust * u_mlTrust;             // stale: fill even less (ghost behind kid)
float aKill   = a * mix(1.0, garbage, killW);
a = max(aKill, core * fillW);
coreFill = clamp(a - aKill, 0.0, 1.0);
```

Default: `u_mlTrust = 1` until a mask arrives, so behaviour is unchanged for single-image input.

**Tests:**
- **Unit (`helperTrust.test.ts`):**
  - A still child (motion 0) at age 2 gives trust ≥ 0.9.
  - motion 0.04 at age 3 gives ≤ 0.6.
  - A mask that is 0.5 everywhere gives ≤ 0.2.
  - Trust falls steadily as age grows.
  - `maskStats` gives the right values on synthetic arrays.
- **E2E:** S06 and S18 × {`lag1/2/3`, `cadence2/3`, `dilate16`, `dropout15`}.
  - The ML-versus-chroma-only gate passes.
  - Ghost on S06 + lag2 is at least 30 % lower than today's baseline.
  - Cadence ripple goes down.

---

## 3 (P0). Foreground unmixing + despill back-off

**What CorridorKey does:**
- Both versions output a separate straight foreground colour next to alpha (v1 `model_transformer.py:185-186,251-295`; v2 `model.py:13-15,276-279`).
- The v2 colour head starts as an exact copy of the input RGB (`stage2.py:16-19,524-526`).
- Composites use the predicted foreground, in linear light (v1 `inference_engine.py:284-305`; v2 `runtime.py:665-683,705-729`).
- Despill runs afterwards on the already-unmixed colour, only at 0.5 strength (v2 `runtime.py:127,604-614`).

**Why it helps:** an edge pixel is `I = αF + (1-α)B`. Despill can only turn the `(1-α)B` part grey. Estimating F and outputting `(F, α)` *replaces* the screen with the new background. Our pipeline today never unmixes, which is why motion-blurred arms come out as a grey-green smear.

**Method: blur-fusion (Forte & Pitié 2021) with a mip-pyramid weighted average** (the multi-scale idea in Germer et al. 2020):
- `F = F̂ + α(I − αF̂ − (1−α)B̂)`, with no division by α. F̂ is the local colour of solid child pixels and B̂ the local colour of clean screen pixels, both averaged over the pyramid.
- B̂ is *local*, so uneven screens and shadows unmix correctly.

**New shared GLSL in `shaders.ts`:**
- `COLOR_GLSL`: the exact piecewise `srgbToLin` / `linToSrgb`. The analytic key path already has the first.
- `FINAL_ALPHA_GLSL`: today's chain from the guided-filter (or tent) upsample through despeckle (item 4), ML fusion (item 2) and choke, moved out of `FG_FS` into `vec2 finalAlpha(vec2 uv, vec3 c, out float meanP)`, which returns `(a, coreFill)`. Both `FG_FS` and the new prep pass include it, so the α used to unmix is exactly the α we blend with.

```glsl
// UNMIX_PREP_FS @ 1/4 matte res (320x180), MRT -> F: RGBA16F (mipmapped), B: RGBA16F ping-pong (mipmapped)
#version 300 es
precision highp float; precision highp sampler3D;
in vec2 v_uv;
layout(location = 0) out vec4 oF;     // (linear colour * w, w) of solid child pixels
layout(location = 1) out vec4 oB;     // (linear colour * conf, conf) of clean screen: slow "plate"
uniform sampler2D u_fg, u_prevB;
uniform sampler3D u_keyLut;
uniform bool u_hasPrevB;
uniform float u_plateRate;            // 0.1; 1.0 for the first frame after reset
uniform float u_lo, u_hi;
// ${COLOR_GLSL} ${FINAL_ALPHA_GLSL} (+ LUT_N / LUT_RANGE constants)
void main() {
  vec3 c = texture(u_fg, v_uv).rgb;   // LINEAR sampler: 2x2 average
  float meanP; vec2 ac = finalAlpha(v_uv, c, meanP);
  float a = ac.x, core = ac.y;
  vec3 L = srgbToLin(c);
  float wF = smoothstep(0.70, 0.95, a);
  // Screen donors: keyed out, not ML-core, locally screen, AND the raw (un-flattened) key agrees.
  float rawD = texture(u_keyLut, c * ((LUT_N - 1.0) / LUT_N) + 0.5 / LUT_N).r * LUT_RANGE;
  float wB = (1.0 - smoothstep(0.02, 0.20, a)) * (1.0 - core)
           * (1.0 - smoothstep(0.02, 0.20, meanP)) * (1.0 - smoothstep(u_lo, u_hi, rawD));
  oF = vec4(L * wF, wF);
  vec4 p = u_hasPrevB ? texture(u_prevB, v_uv) : vec4(0.0);
  vec3 pB = p.rgb / max(p.a, 1e-4);
  vec3 B = mix(pB, L, p.a < 1e-3 ? 1.0 : u_plateRate * wB);   // the screen is static: learn slowly
  float conf = max(wB, p.a * 0.995);                           // decays slowly where the kid stands
  oB = vec4(B * conf, conf);
}
```

```glsl
// FG_FS additions (chroma mode, after a and coreFill are final)
uniform sampler2D u_unF, u_unB;
uniform bool u_hasUnmix;
uniform float u_unmix;                                         // default 1.0
vec4 pyr(sampler2D t, vec2 uv) {                               // near levels dominate, far ones fill gaps
  return textureLod(t, uv, 0.0) + 0.25 * textureLod(t, uv, 2.0) + 0.0625 * textureLod(t, uv, 4.0);
}
// ...
float unW = 0.0;
if (u_hasUnmix && a > 0.004 && a < 0.996) {                    // edge band only
  vec4 sF = pyr(u_unF, uv), sB = pyr(u_unB, uv);
  vec3 Fh = sF.rgb / max(sF.a, 1e-4), Bh = sB.rgb / max(sB.a, 1e-4);
  vec3 I = srgbToLin(c);
  vec3 F = clamp(Fh + a * (I - a * Fh - (1.0 - a) * Bh), 0.0, 1.0);
  unW = u_unmix * smoothstep(0.02, 0.10, sF.a) * smoothstep(0.02, 0.10, sB.a) * (1.0 - coreFill);
  rgb = mix(c, linToSrgb(F), unW);
}
if (u_spill > 0.0) rgb = despillA(rgb, a, u_spill * (1.0 - coreFill), SPILL_EDGE * (1.0 - unW));
```

- `despillA` gains a 4th parameter, `edgeBoost`, which replaces the `SPILL_EDGE` constant inside it.
- Despill then mainly removes **interior bounce spill** (green light on heads and cheeks at α = 1), which unmixing cannot fix.
- Keep our max-inside / average-at-edge limit and the grey luma re-add. Do **not** adopt CorridorKey's half-to-each-channel return: it darkens skin by about 0.38·s luma and tints it magenta.
- Mirror the change in the CPU `autoKey.despill` with an optional `edgeBoost`.

**Compositor integration (`prepareFg`):**
- **Pass order:** matte → guided filter → **UNMIX_PREP** (chroma mode with `floatOk` only) → `generateMipmap` on F and on the B just written → draw.
- **Targets:** `st.unT = { F, B: [B0, B1] }` at `ceil(mw/4) × ceil(mh/4)`.
  - Allocate with `texStorage2D(RGBA16F, levels = 5)` and `MIN_FILTER = LINEAR_MIPMAP_NEAREST`.
  - Use two FBOs, each with F on attachment 0 and Bi on attachment 1, plus `drawBuffers([COLOR_ATTACHMENT0, COLOR_ATTACHMENT1])`.
- **Fallback:** if the FBO is incomplete, or `generateMipmap` raises a GL error once at start-up, set `unmixOk = false`. That gives `u_hasUnmix = 0` and today's despill path. If mipmaps are slow on Safari, replace them with 4 explicit 2×2 downsample passes.
- **Reset:** `resetTemporal()` also clears `unBHasPrev`, so the next frame uses `u_plateRate = 1`.
- **Defaults:**
  - `u_unmix = 1`.
  - `u_spill` default: try lowering it from 0.9 to 0.6, and decide on the S05 and S12 swatch ΔE scores.
  - `KEYER_TUNING.choke`: try 1.3 → 1.15, because unmixing keeps soft edges clean. Decide on S06 FN_fg and Composite ΔE.
- **Compositing:** stays in sRGB with hardware blending for now (see the P2 linear-stage item).

**Cost on A13:**
- prep, 57.6k fragments, about 6 fetches each: ~0.05 ms;
- two mip chains: 0.05–0.2 ms (Safari is the unknown);
- band-only FG work, about 15 % of pixels × 6 `textureLod` + 2 sRGB conversions: 0.2–0.35 ms;
- **total 0.3–0.6 ms.** About 0.15 ms on M-series.

**Tests:**
- **Unit:** new `unmix.ts` with `blurFusionF(I, a, Fh, Bh)`, a JS copy of the GLSL in the same style as `despill`.
  - α = 1 gives F = I.
  - α → 0 gives F → F̂.
  - Synthetic `I = 0.3·skin + 0.7·green` with exact F̂ and B̂ gives back skin within 1e-6.
  - Output stays in [0, 1].
- **E2E:**
  - S05 and S06: Composite ΔE00 in band U improves by ≥ 25 %, and Spill residual by ≥ 40 %.
  - S11: no FN_fg regression.
  - Toggling `u_unmix` changes the output (the "does something" check).
  - WebKit project: if `unmixOk` is false, the test must report fallback mode rather than fail silently.

---

## 4 (P1). Speck removal + small-hole fill with one box-sum

**What CorridorKey does:** v1 "auto-despeckle":
- threshold, label connected parts, keep parts of at least 400 px;
- **dilate the keep mask by about 25 px** and blur it, then multiply it into α (v1 `color_utils.py:422-505`; `inference_engine.py:270-272,352,406-408`).
- The big dilation is what protects hair strands and pencil tips near the body.
- It never fills holes.

**Our version, one idea:** for an isolated speck, the total foreground coverage inside a 68×68 px window equals the speck's area. Near the child, the window total is large. So one separable box-sum does both CorridorKey's size test *and* its safe-zone dilation. Running the same sum on the screen coverage also finds small enclosed holes (green logo dots, eye glints) while real gaps stay open.

```glsl
// DS_DOWN_FS @ 1/4 matte res -> RG (RG16F if floatOk, else RGBA8): r = child coverage, g = screen coverage
uniform sampler2D u_matte; uniform vec2 u_mtexel;
float cov(vec2 uv) { return smoothstep(0.20, 0.30, texture(u_matte, uv).r); }
void main() {
  vec2 t = u_mtexel;   // 4 bilinear taps = the 4x4 footprint
  float m = 0.25 * (cov(v_uv + vec2(-t.x, -t.y)) + cov(v_uv + vec2(t.x, -t.y))
                  + cov(v_uv + vec2(-t.x,  t.y)) + cov(v_uv + vec2(t.x,  t.y)));
  o = vec4(m, 1.0 - m, 0.0, 1.0);
}
// DS_BOX_FS: radius 8 cells (±32 px), H then V; stores the MEAN so RGBA8 works
uniform sampler2D u_src; uniform vec2 u_step;
void main() { vec4 s = vec4(0.0); for (int i = -8; i <= 8; i++) s += texture(u_src, v_uv + float(i) * u_step); o = s / 17.0; }
```

```glsl
// in FINAL_ALPHA_GLSL, after the GF/tent upsample, before ML fusion
uniform sampler2D u_dsMass; uniform bool u_hasDs; uniform float u_minArea, u_minHole;
const float DS_PX = 16.0 * 289.0;                       // full-res px per unit of the 17x17 mean
if (u_hasDs) {
  vec2 mass = texture(u_dsMass, uv).rg * DS_PX;         // bilinear = soft safe-zone edge
  a *= smoothstep(0.5 * u_minArea, u_minArea, mass.x);  // small far-away child-coloured blobs go
  a = max(a, 1.0 - smoothstep(0.5 * u_minHole, u_minHole, mass.y)); // small enclosed screen holes fill
}
// ML core fill afterwards (max(..., core)) still protects anything the helper calls "child"
```

- **Integration:** new `dsT` (3 targets at 1/4 res, mirrored), run in `runMatte` straight after the matte. Bind as sampler unit 5 in `FG_FS` and the prep pass.
- **Defaults:**
  - `u_minArea = 2e-4·W·H`, about 184 px at 1280×720;
  - `u_minHole = 1e-4·W·H`;
  - the hole fill gets its own flag, on by default only if S05 (hair) and S06 (gaps between fingers and between arm and body) show no FN_fg or Conn regression.
- **Cost:** 3 passes at 320×180 with 4–17 taps each, plus 1 fetch: **~0.1 ms**.
- **E2E tests:**
  - S16: Islands = 0 and FP_bg improves by ≥ 50 % with ML off.
  - S05: hair band SAD within +3 %.
  - S03: islands drop.
  - The toggle changes the output.

---

## 5 (P1). Temporal smoothing on guided-filter coefficients

**What CorridorKey does:** all temporal mixing happens at /64 and /16 resolution. The full-resolution stage works frame by frame and re-reads the raw RGB to draw the edges ("No temporal processing here", v2 `stage1.py:1-24`, `stage2.py:1-24,511-530`).

**Ours:** apply the motion-guarded EMA to the half-res `(A, b, mean_p)`, then evaluate `α = A·I_current + b`. Interiors are steadied while edges follow the current frame. The full-res matte EMA can then be lowered, which reduces trails on hair and slow-moving arms.

```glsl
// GF_COEF_FS: store mean I in .w (was 0) so the guard has it after the box blur
o = vec4(A, m.y - A * m.x, m.y + 0.5, m.x + 0.5);
// GF_TEMPORAL_FS @ half res, ping-pong RGBA16F
uniform sampler2D u_cur, u_prev; uniform bool u_hasPrev; uniform float u_cTemporal; // 0.5
void main() {
  vec4 cur = texture(u_cur, v_uv);
  if (!u_hasPrev) { o = cur; return; }
  vec4 prv = texture(u_prev, v_uv);
  float still = 1.0 - smoothstep(0.01, 0.04, abs(cur.w - prv.w)); // blurred-luma guard: tighter thresholds
  o = vec4(mix(cur.xyz, prv.xyz, u_cTemporal * still), cur.w);    // always keep the fresh mean
}
```

- **Integration:**
  - `gfT` grows to 5 targets; the extra two are coefficient history.
  - `runGuidedFilter` ends with this pass, and `drawFg` binds the history output instead of `gfT[1]`.
  - `resetTemporal` clears it.
- **Defaults:** `u_cTemporal = 0.5`; `KEYER_TUNING.temporal` goes from 0.5 to 0.25 when the guided filter is active. The tent fallback keeps 0.5.
- **Cost:** about 0.03 ms.
- **E2E gates:** S06 Ghost ↓ ≥ 30 %; S00 and S07 Flicker ≤ baseline; dtSSD on S05 ≤ baseline.

---

## 6 (P1). Robust border key sampler

**What CorridorKey does:** it guesses the screen colour from the mean of background pixels on the first frame. Its guards are coverage ≥ 1 % and |G−B| ≥ 0.05, falling back to green (v1 `color_utils.py:329-383`). Issue #246 lists how this fails: close-ups that hide the background, dim plates, a subject wearing the screen colour, mixed light.

**Ours:** keep `pickKeyColor(samples)`, and add `robustBorderKey(cells, prevKey)` to `autoKey.ts`. The auto-key sampler in `Compositor.ts` sorts border samples into 24 cells, averaged in linear RGB and converted to Lab.

```ts
// autoKey.ts (original)
export function robustBorderKey(cells: { lab: Lab; n: number }[], prev: Lab | null) {
  const cand = cells.filter((c) => c.n > 0 && Math.hypot(c.lab[1], c.lab[2]) > 15 && c.lab[0] > 12)
  if (cand.length < 8) return { key: prev, status: 'border-covered' as const }       // kid close to iPad
  const med = [0, 1, 2].map((i) => median(cand.map((c) => c.lab[i]))) as Lab
  const inl = cand.filter((c) => deltaE00(c.lab, med) < 10)
  if (inl.length < 0.6 * cand.length) return { key: prev ?? med, status: 'ambiguous' as const }
  const W = inl.reduce((t, c) => t + c.n, 0)
  const key = [0, 1, 2].map((i) => inl.reduce((t, c) => t + c.lab[i] * c.n, 0) / W) as Lab
  return { key, status: med[0] < 25 ? ('too-dark' as const) : ('ok' as const) }
}
```

- `'border-covered'` keeps the previous key and retries in 2 s.
- `'too-dark'` shows the existing "add light" message.
- **Unit tests (`autoKey.test.ts`):**
  - 24 green cells give status `ok` and a key within ΔE 1.
  - 18 cells covered by shirt colour give `border-covered`.
  - 9 green + 9 sage give `ambiguous`.
  - L = 20 gives `too-dark`.
- **E2E:** S14 status is `border-covered` at the start, and the key ends within ΔE00 3 of the true screen after the child steps back. S12 converges for all screen hues.

---

## 7 (P1, behind a flag). Screen flattening from the unmix screen layer

**What CorridorKey does:**
- An optional exposure change in linear light before the model, with its exact inverse applied to the foreground afterwards (v2 `video_io.py:159-181,308-311`; `runtime.py:595-601,667`).
- The owner says a clean plate of the empty screen was part of training (#114).
- Issue #129 names low-frequency backing variation (hotspots, falloff, wrinkles, shadows) as what breaks keys.

**Ours:**
- Reuse the B̂ layer from item 3 as a running plate of the empty screen.
- A tiny pass turns it into a per-cell gain that moves each screen pixel toward the key colour.
- The gain is used **only for the LUT lookup**. Displayed colour, despill and unmixing all use the raw pixel.
- `MATTE_FS` uses the previous frame's plate. The screen does not move, so one frame of lag is harmless.

```glsl
// GAIN_FS @ 1/32 matte res (40x23), RGBA8
uniform sampler2D u_unB; uniform vec3 u_keySrgb;
// ${COLOR_GLSL}
void main() {
  vec4 s = textureLod(u_unB, v_uv, 3.0) + 0.25 * textureLod(u_unB, v_uv, 4.0);
  float conf = smoothstep(0.05, 0.30, s.a);
  vec3 plate = linToSrgb(s.rgb / max(s.a, 1e-4));
  vec3 g = clamp(u_keySrgb / max(plate, vec3(0.02)), vec3(0.7), vec3(1.5));
  o = vec4(g * 0.5, conf);                         // 1.0 is stored as 0.5
}
// MATTE_FS: before keyAlpha()
uniform sampler2D u_gain; uniform float u_flatten;  // default 0 until the harness gate passes
vec4 gm = texture(u_gain, v_uv);
vec3 ck = clamp(c * mix(vec3(1.0), gm.rgb * 2.0, gm.a * u_flatten), 0.0, 1.0);
float a = u_src == 0 ? keyAlpha(ck) : /* segment */ ...;  // y (luma for the motion guard) still from c
```

**Guard against feedback** (a green shirt teaching the plate, which then keys more of the shirt). Three things prevent it:
- the donor rule in `UNMIX_PREP_FS` requires the *raw, un-flattened* keyD to be below `hi`;
- ML core pixels never donate;
- the gain is clamped to [0.7, 1.5].

**Camera bump:** if the median |ΔE| of confident plate cells in the 2-s drift readback exceeds 8 for 10 frames, reset the plate.

**Cost:** ~0.05 ms (one tiny pass plus 1 fetch in the matte pass).

**Gate to turn `u_flatten` on:** S01, S02, S03, S04 and S18 band SAD or FP_bg improve by ≥ 15 %, **and** no FN_fg regression on S11 (green clothes) or S17 (walk in and out).

**Unit test:** a JS copy `gainFor(keySrgb, plate)` in `labKey.test.ts` style: an even plate gives gain 1; the clamps hold; and a shadowed plate pixel × gain lands within keyD < `lo`.

---

## 8 (P1, verify first). Segmenter aspect ratio

**What CorridorKey does:** it sizes each foundation-model input so the patch grid lands on its /64 grid "with no resize or aspect distortion" (v2 `model.py:91,226-229`; `runtime.py:283-292`). Each model gets the input encoding it was trained on (`video_io.py:299-320`).

**Ours:**
1. Check with a harness frame whether MediaPipe's 256×256 selfie model stretches a 16:9 frame. Use a 16:9 frame containing a circular "head" and test whether the mask comes back circular.
2. If it stretches, try `selfie_segmenter_landscape` (144×256, Apache-2.0, same family) on landscape cameras. Otherwise letterbox the frame to square with mirror padding on a small canvas and crop the mask back.

Always feed raw camera pixels (no flattening or despill).

**Gate:** S06 + ML FN_fg on the arm core improves, and the benchmark stays in the same cadence band.

---

## P2 items (after M3, each gated on the harness)

| # | Item | Source of the idea | Notes |
|---|---|---|---|
| 9 | **Linear-light stage** (`SRGB8_ALPHA8`) | v1 `inference_engine.py:284-305`; LLM_HANDOVER.md:38,71 | Stays P2. Unmixing already removes most of the edge error, and the stage pass costs 0.3–0.5 ms. Promote to P1 only if band Composite ΔE over magenta and white is ≥ 3 worse than a linear reference render. |
| 10 | **Recorder-only symmetric smoothing** (3-tap 0.25/0.5/0.25 with motion gates on the coefficient history from item 5, written one frame late) | v2 Hann windows `video_io.py:582-604`, `runtime.py:550-561` | Recording only, so the live mirror has no lag. ~0.15 ms + 3 targets. "Make it Magic" offline already plans two-direction smoothing; use a 7-tap cos² window there. |
| 11 | **Checkerboard "check the key" view** (teacher/dev): `u_matteOut` gains mode 2, a 64-px 0.75/0.5 grey checker with one saturated stripe | v2 `video_io.py:792-797`; v1 `color_utils.py:508-547` | Cost ~0. Attach a JSON settings snapshot to harness receipts and bug reports. |
| 12 | **16-bit matte history** when `floatOk`; ratio-based motion guard `smoothstep(0.03, 0.12, abs(log2((y+0.02)/(p.g+0.02))))` | v2 asinh encoding `color_utils.py:98-128` (precision lesson only) | Removes leftover 8-bit EMA residue; catches dark hair moving over dark areas. |
| 13 | **Logit-space detail residual** after the guided filter (`a = sigmoid(logit(a) + 0.5·edge·clamp(logit(aRaw) - logit(a), -3, 3))`) | v1 refiner adds ×10 delta logits, `model_transformer.py:99-142,285-295` | ~0.12 ms. May bring edge noise back; ship only if hair Grad improves and Flicker does not get worse. |
| 14 | **"Trim to screen" box**, suggested from the screen bounding box in the 2-s readback, teacher-confirmed; pixels the ML core calls "child" are kept | v1 garbage matte `color_utils.py:186-207`; #180 | Cost 0 in the shader; needs teacher UI. Score on S13. |
| 15 | **Key-direction despill** (spill measured along the key's chroma direction) for yellow-green or teal fabric | original | Cost 0. Score on S12. |
| — | Harness hardening: despill swatches (yellow, violet on blue, teal, lime, skin), exposure ±1 stop sweep, full vs limited-range YUV, and a test that `srgbToLinear` matches the IEC curve (not gamma 2.2) | #28, #195, PR #179 | Part of task 0 in M2. |

---

## What NOT to adopt, and why

| Not adopted | Reason |
|---|---|
| CorridorKey network, weights or any of its code (runtime, offline or server) | Licence clause 2a forbids redistribution; 200–400 MB and about 2.4 GB of memory; about 1 fps; a server would upload children's video. Ideas only, re-derived from published methods. |
| Unmixing by dividing by α (`F = B + (I - B)/α`) | Unstable at low α, which is exactly the motion-blur case, and needs ad-hoc caps. Blur-fusion has no division and is exact at α = 1. |
| A separate per-frame raw-LUT pre-pass to build the plate | An extra full-res LUT pass. Item 3 builds the plate at 1/4 res from the current frame's final α plus a raw-key check. |
| Opening-by-reconstruction despeckle (~9 passes) and exact connected-component labelling (GPU flood or worker) | The box-sum in item 4 does the same size test and safe-zone dilation in 3 tiny passes. A GPU flood needs scatter counting (`EXT_float_blend`, uncertain on iOS). A worker version is one frame late. Revisit only if item 4 fails S16 or S05. |
| CorridorKey's despill formula (average limit everywhere, half of the spill to each other channel) | Shifts Rec.601 luma by about −0.38·s (darker, pinker skin). Destroys violet (#195). Our alpha-aware, luma-keeping despill stays. Only its "gentler after unmixing" lesson is used (item 3). |
| asinh HDR encoding, 2048 resize, padding to multiples of 128, bf16 | The camera is 8-bit SDR; these exist for a transformer's patch grid. |
| Feeding our own output back as the next hint in the live preview ("Hann carry") | The README warns it drifts. Our anti-drift equivalent is item 2's hard reset on every fresh mask. |
| Symmetric past-and-future windows in the live preview | They add latency to the mirror kids watch. Recorder and offline only (item 10). |
| Moving the `SRGB8_ALPHA8` stage to P1 now | 0.3–0.5 ms full-screen pass and riskier on Safari. Unmixing captures most of the gain; promote only on the metric in item 9. |
| Per-frame GPU readback of mask/key agreement (IoU) as a trust input | Adds a GPU synchronisation point. Mask motion and ambiguity, computed on the CPU from masks we already have, cover the main cases. |
| Sizing settings from free memory | Our planned `deviceTier` benchmark and back-off already do this. |
| Training a learned keyer on the generated fixtures | Out of scope (no network at runtime). The fixtures are for evaluation and tuning only. |

---

## Where each change lands in the pass graph

```
camera ─► MATTE_FS [+u_gain flatten (7)] ─► DS_DOWN/DS_BOX (4) ─► GF_PACK ─► BOX² ─► GF_COEF(.w=mean I) ─► BOX² ─► GF_TEMPORAL (5)
mask   ─► MASK_PREP_FS (dilate from JS, item 2)
        ─► UNMIX_PREP_FS (MRT F + B-plate ping-pong, uses FINAL_ALPHA_GLSL) ─► mipmaps (3) ─► GAIN_FS (7, used next frame)
FG_FS: FINAL_ALPHA_GLSL [GF upsample → despeckle/hole (4) → ML fusion with u_mlTrust (2) → choke]
       → blur-fusion unmix in the edge band (3) → despillA(edgeBoost = SPILL_EDGE·(1−unW)) → light wrap
All new matte-domain targets use MIRRORED_REPEAT (1). New uniforms keep the existing fixed-sampler-unit
pattern in link(): u_dsMass = 5, u_unF = 6, u_unB = 7 (FG_FS); u_gain = 4 (MATTE_FS).
```

## Files to change

**Existing (edit):**
- `/Users/md/Green Screen 2/web/src/lib/keyer/shaders.ts`
- `/Users/md/Green Screen 2/web/src/lib/keyer/Compositor.ts`
- `/Users/md/Green Screen 2/web/src/lib/keyer/autoKey.ts`
- `/Users/md/Green Screen 2/web/src/lib/segmenter.ts`
- `/Users/md/Green Screen 2/web/src/lib/useStage.ts`

**New:**
- `/Users/md/Green Screen 2/web/src/lib/helperTrust.ts` and its test
- `/Users/md/Green Screen 2/web/src/lib/keyer/unmix.ts` and its test
- `/Users/md/Green Screen 2/web/src/lib/keyer/metrics.ts` and its test
- `/Users/md/Green Screen 2/web/e2e/fixtures/make_keyer_fixtures.py`
- `/Users/md/Green Screen 2/web/harness.html`
- `/Users/md/Green Screen 2/web/src/harness/keyerHarness.ts`
- `/Users/md/Green Screen 2/web/playwright.config.ts`
- `/Users/md/Green Screen 2/web/e2e/keyer-quality.spec.ts`
- `/Users/md/Green Screen 2/web/e2e/baselines/`

**Plan to update:** `/Users/md/Green Screen 2/docs/research/realtime/recommendation.md`. Add items 0–3 as P0 and 4–8 as P1, and replace "BGMv2 plate: possible P3" with item 7.