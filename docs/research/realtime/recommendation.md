# Magic Screen: recommended real-time keying stack

**Recommendation:** The live picture should come from a better WebGL2 chroma keyer on every device (Tier 1). On devices that can afford it, add the MediaPipe Selfie Segmenter (Apache-2.0, 249,537 B, already in `public/mediapipe/`) as a "Magic Helper" (Tier 2). It acts as a garbage matte and a core matte; it never decides the edges.

- **No WebGPU, ONNX Runtime or extra model downloads.** Everything runs on the device with no server.
- **Drop CorridorKey completely**, including as an offline "Make it Magic" feature.
- **Exclude RVM.** It is GPL-3.0 and conflicts with the app's CC-BY-NC-SA-4.0 code license.
- **Tier 3 (native iOS with Vision)** is only worth doing if an App Store build is wanted.

**What already exists (I checked `/Users/md/Green Screen 2/web/src/lib`):**
- `keyer/Compositor.ts` (943 lines) already does three things right: it paces uploads with `requestVideoFrameCallback`, uses `blendFuncSeparate` so alpha isn't squared, and handles `webglcontextlost`.
- `keyer/shaders.ts` currently keys in YCbCr and runs the key function 9 times per pixel (3x3 tent). Despill runs before alpha is known and uses the max limit.
- `segmenter.ts` runs MediaPipe `ImageSegmenter` in VIDEO mode (GPU delegate, falling back to CPU). It returns a Canvas2D mask, and it is only used in `segment` mode.

---

## Tier 1: chroma keyer, always on, every device

### Algorithm

1. **Key metric ("keyD").** This is a CIELAB distance that ignores shadows and only counts in one direction. Do not use ΔE76, ΔE94 or ΔE00 for alpha. The DeltaE report measured them: with ΔE94 a sage shirt comes out *closer* to the screen than the screen's own shadow, and ΔE76 cannot key shadows at all.
   - `g = clamp(keyL / max(L,1), 1, MAX_SHADOW_GAIN=2.0)`
   - Scale the pixel's a and b by `g`.
   - `along = dot(ab, keyDir)`, `perp = |ab - along·keyDir|`
   - `shortfall = max(keyC - along, 0)`, so a pixel *more* saturated than the key still counts as screen.
   - `over = max(L·g - keyL, 0)·0.2`
   - `d = |(shortfall, perp, over)|`
   - On the report's samples, screen variants score ≤ 3.3, while shirts, skin and hair score ≥ 27. Forest green scores 3–6; nothing can separate it from the screen by colour, so the app warns about it.
2. **Bake the metric into a 3D lookup table.** Because the key depends only on RGB, compute it once per key colour on the CPU into an `RG8` 3D texture of 48³ cells (64³ if the bake takes under 16 ms).
   - R stores `keyD/48`; G stores the dark-pixel guard `1 - smoothstep(DARK_L_LO=6, DARK_L_HI=14, L)`.
   - The shader applies `smoothstep(lo, hi, d)`, so sliders never need a re-bake. Only a new key colour does.
   - Each tap becomes one texture fetch instead of about 6 `pow` calls. The same JS function drives `autoKey.ts`, its tests and the table, so the CPU and GPU versions cannot drift apart.
3. **Matte pass with temporal smoothing.** One pass at camera resolution (capped at 1280 px wide) writes `(alpha, luma)` into ping-pong RGBA8 buffers.
   - It blends with the previous frame (EMA weight `u_temporal=0.5`) only where luma barely changed: `motion = smoothstep(0.02, 0.10, |Y - Yprev|)`. This stops flicker without ghosting when kids move.
   - Reset the history on camera switch, resize, `visibilitychange` and context restore.
4. **Edge refinement with a fast guided filter.** This replaces the 3x3 tent. Guide = camera luma, input = matte. It runs at half resolution with a box radius of 4 and `eps = 6e-4`, and the coefficients are upsampled bilinearly in the final pass.
   - Edges stay sharp and aligned to the image while sensor noise is smoothed away.
   - It needs `EXT_color_buffer_half_float` or `EXT_color_buffer_float`. If neither is present, fall back to the 3x3 tent on the matte texture, which is still one fetch per tap.
   - `mean_p` (the blurred alpha) is kept for the light wrap.
5. **Choke.** `a = pow(a, u_choke)` with a default of 1.3 (range 1.0–2.0). Then snap noise with `a = clamp((a - 0.02)/0.96, 0, 1)`.
6. **Despill.** It is alpha-aware and keeps brightness.
   - The limit is `max(other two channels)` inside the subject, which keeps yellow shirts yellow. It moves toward `avg(other two)` at semi-transparent edges, where spill is strongest.
   - The removed spill's luma is added back as neutral grey, so skin does not darken.
   - Despill is switched off where the ML core fill rescued a green shirt; otherwise it would turn the shirt grey.
7. **Light wrap.** At inner edges, mix in a 1/8-resolution blurred background: `w = u_wrap(0.15) · a · (1 - mean_p)`.
8. **Auto-key.**
   - Sample the frame border (existing `pickKeyColor`), but average in **linear** RGB, then convert to Lab.
   - Thresholds from the keyD of the samples: `lo = clamp(p95 + 2, 4, 14)`, `hi = lo + 12`. If p95 > 12, show "add light / screen too wrinkly" instead of loosening the key.
   - Every 2 s, read back a 1/16-resolution frame asynchronously (`PIXEL_PACK_BUFFER` + `fenceSync`), take pixels with matte < 0.05, and EMA the key in Lab with weight 0.2. Re-bake only if ΔE00 between the old and new key is > 2. This tracks iPad auto white balance, which cannot be locked.
   - The "tap your shirt" check uses keyD: if keyD(shirt) < hi + 4, show a friendly "your shirt is screen-coloured" message and turn on the Magic Helper.
   - Slider mapping: `lo = 4 + 16·similarity`, `hi = lo + 6 + 12·smoothness`.
9. **Linear-light compositing (P2, optional).** Render the stage into an `SRGB8_ALPHA8` buffer, with shaders writing linear colour, then do one pass to the canvas. This removes dark fringes at edges. Ship it after everything else.

### Final GLSL (WebGL2, highp; `${}` = constants injected from `labKey.ts`, as `shaders.ts` already does)

```glsl
// ---- MATTE_FS: LUT key + motion-guarded temporal EMA. Camera space, no mirror.
#version 300 es
precision highp float; precision highp sampler3D;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_fg;        // camera
uniform sampler3D u_keyLut;    // RG8: r = keyD/LUT_RANGE, g = dark guard
uniform sampler2D u_prev;      // previous MATTE_FS output (r=a, g=luma)
uniform bool  u_hasPrev;
uniform float u_lo, u_hi;      // ΔE units (default 8 / 20)
uniform float u_temporal;      // 0..0.7, default 0.5
const float LUT_N = ${LUT_N}.0, LUT_RANGE = ${LUT_RANGE}.0;
const vec3 LUMA = vec3(0.299, 0.587, 0.114);
void main(){
  vec3 c = texture(u_fg, v_uv).rgb;
  vec2 k = texture(u_keyLut, c * ((LUT_N - 1.0) / LUT_N) + 0.5 / LUT_N).rg;
  float a = max(smoothstep(u_lo, u_hi, k.r * LUT_RANGE), k.g);
  float y = dot(c, LUMA);
  if (u_hasPrev && u_temporal > 0.0) {
    vec2 p = texture(u_prev, v_uv).rg;
    a = mix(a, p.r, u_temporal * (1.0 - smoothstep(0.02, 0.10, abs(y - p.g))));
  }
  o = vec4(a, y, 0.0, 1.0);
}

// ---- GF_PACK_FS @ half res (LINEAR sampling of matte = 2x2 average) -> RGBA16F
#version 300 es
precision highp float; in vec2 v_uv; out vec4 o;
uniform sampler2D u_matte;     // r = alpha (p), g = luma (I); for segment mode bind mask as p
void main(){ vec2 m = texture(u_matte, v_uv).rg; float I = m.g, p = m.r; o = vec4(I, p, I*I, I*p); }

// ---- BOX_FS: separable box, radius 4 (run H then V) -> RGBA16F
#version 300 es
precision highp float; in vec2 v_uv; out vec4 o;
uniform sampler2D u_src; uniform vec2 u_step;  // (1/w,0) or (0,1/h)
void main(){ vec4 s = vec4(0.0); for (int i = -4; i <= 4; i++) s += texture(u_src, v_uv + float(i) * u_step); o = s / 9.0; }

// ---- GF_COEF_FS -> RGBA16F (A, b, mean_p, 0)
#version 300 es
precision highp float; in vec2 v_uv; out vec4 o;
uniform sampler2D u_means; uniform float u_eps;   // 6e-4
void main(){
  vec4 m = texture(u_means, v_uv);                  // (mI, mp, mII, mIp)
  float A = (m.w - m.x * m.y) / (max(m.z - m.x * m.x, 0.0) + u_eps);
  o = vec4(A, m.y - A * m.x, m.y, 0.0);
}

// ---- MASK_PREP_FS @ mask res (256x256), ping-pong. r = garbage (dilated, slow decay), g = core (eroded, slow grow)
#version 300 es
precision highp float; in vec2 v_uv; out vec4 o;
uniform sampler2D u_mask, u_prevPrep; uniform bool u_hasPrev;
uniform vec2 u_mtexel; uniform float u_dilateStep;   // 3.0 -> ±12 texels ≈ 5% of width (keeps held props)
void main(){
  float mx = 0.0, mn = 1.0;
  for (int j = -4; j <= 4; j++) for (int i = -4; i <= 4; i++)
    mx = max(mx, texture(u_mask, v_uv + vec2(i, j) * u_mtexel * u_dilateStep).r);
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++)
    mn = min(mn, texture(u_mask, v_uv + vec2(i, j) * u_mtexel).r);
  if (u_hasPrev) { vec2 p = texture(u_prevPrep, v_uv).rg; mx = max(mx, p.r - 0.08); mn = min(mn, p.g + 0.15); }
  o = vec4(mx, mn, 0.0, 1.0);
}

// ---- FG_FS chroma branch (replaces the tent + despill in shaders.ts). Mirror applied to uv first; all textures camera-space.
uniform sampler2D u_matte, u_gfAB, u_maskPrep, u_bgBlur;
uniform bool  u_hasGF;
uniform float u_mlWeight;     // 0..1, faded in over 300 ms
uniform float u_choke;        // 1.3
uniform float u_spill;        // 0.9
uniform float u_spillEdge;    // 1.0
uniform int   u_spillCh;      // 0 r, 1 g, 2 b
uniform float u_wrap;         // 0.15
uniform vec2  u_stage; uniform bool u_flipBg;
const vec3 LUMA = vec3(0.299, 0.587, 0.114);

vec3 despillA(vec3 c, float a, float k){
  vec3 dir = u_spillCh == 0 ? vec3(1,0,0) : (u_spillCh == 1 ? vec3(0,1,0) : vec3(0,0,1));
  float dom = dot(c, dir);
  vec3 oth = c * (1.0 - dir);                        // the two other channels (one is 0)
  float mxO = max(max(oth.r, oth.g), oth.b);
  float avO = (oth.r + oth.g + oth.b) * 0.5;
  float edge = 1.0 - abs(2.0 * a - 1.0);
  float limit = mix(mxO, avO, edge);                 // max inside (keeps yellows), avg at edges
  float s = max(dom - limit, 0.0) * clamp(k * (1.0 + u_spillEdge * edge), 0.0, 1.0);
  return c - s * dir + vec3(s * dot(dir, LUMA));     // remove spill, return its luma as neutral grey
}

// in main(), chroma mode:
vec3 c = texture(u_fg, uv).rgb;
float a = texture(u_matte, uv).r, meanP = a;
if (u_hasGF) { vec3 ab = texture(u_gfAB, uv).rgb; a = clamp(ab.x * dot(c, LUMA) + ab.y, 0.0, 1.0); meanP = ab.z; }
float aKey = a, coreFill = 0.0;
if (u_mlWeight > 0.0) {
  vec2 gm = texture(u_maskPrep, uv).rg;
  float garbage = smoothstep(0.05, 0.35, gm.r);      // ML: definitely not a kid -> kill (walls, teacher)
  float core    = smoothstep(0.75, 0.95, gm.g);      // ML: definitely a kid -> fill (green shirt)
  float fused = max(aKey * garbage, core);
  a = mix(aKey, fused, u_mlWeight);
  coreFill = clamp(a - aKey, 0.0, 1.0);
}
a = clamp((pow(a, u_choke) - 0.02) / 0.96, 0.0, 1.0);
rgb = despillA(c, a, u_spill * (1.0 - coreFill));
vec2 sp = gl_FragCoord.xy / u_stage; if (u_flipBg) sp.y = 1.0 - sp.y;
rgb = mix(rgb, texture(u_bgBlur, sp).rgb, u_wrap * a * (1.0 - meanP));
```

`segment` mode (no green screen) gets the same passes: bind the ML mask as `p` in GF_PACK. That gives guided-filter edges instead of the current `smoothstep(0.3, 0.7)`.

**Budget at 720p** (estimated; must be measured): the matte pass is 1 fetch per pixel plus prev; the guided filter is 4 passes at 640x360 plus 1 bilinear fetch. That should be under 3 ms on A13 and newer.
- Targets: 60 fps on M-series iPads, at least 30 fps on iPad 9th gen (A13) and phones.

---

## Tier 2: Magic Helper (ML), automatic on capable devices

**Model:** keep MediaPipe Selfie Segmenter, square 256x256, float16. It is Apache-2.0 (tasks-vision and the model card) and 249,537 B, already self-hosted in `/mediapipe/`.
- Source URL: `https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite`
- Rejected:
  - `selfie_multiclass_256x256` (~16 MB): not worth the weight.
  - RVM: GPL-3.0; its 2.7 MB tfjs int8 model is otherwise good.
  - MODNet: ~25 MB, and its license needs checking (the README appears to say CC BY-NC-SA).
  - Any WebGPU or ORT path.

**Fusion:** see `MASK_PREP_FS` and the FG branch above.
- The garbage matte is dilated about 5% of the frame width and decays slowly, so props a kid holds and the 1–2 frames of mask lag survive.
- The core matte is eroded and grows slowly, so it never fills the background behind a moving kid.
- Edges always come from the chroma key. `u_mlWeight` fades from 0 to 1 over 300 ms after warm-up.

**Data path:** `segmentForVideo` gives a confidence mask. Call `getAsFloat32Array()`, convert to a `Uint8Array` (65K values), and upload with `texSubImage2D` into an R8 LINEAR texture in the Compositor's context. This drops the Canvas2D detour; no context sharing is needed.

**Cadence and device detection** (`deviceTier.ts`):
- No WebGL2: Canvas2D `keyAlphaFast` fallback, no ML.
- WebGL2 without a half-float colour buffer: Tier 1 with the tent filter.
- After the camera starts, lazy-load the segmenter when idle, warm up 5 frames, then time the median of 20 frames:
  - ≤ 25 ms: every frame (cap 30 Hz)
  - ≤ 50 ms: every 2nd frame
  - ≤ 90 ms: every 3rd frame
  - otherwise: off
- The CPU delegate is allowed only if it is ≤ 50 ms.
- Thermal backoff: if the compositor's frame interval p90 stays above 24 ms (iPad) or 40 ms (phone) for 3 s, step the cadence down, then turn ML off. Try stepping back up after 30 s.
- Pause on `visibilitychange`.
- A teacher-gated setting offers "Magic Helper: Auto / On / Off". Kids never see it.

---

## Tier 3 (later, only for an App Store build)

- **3a:** wrap the same PWA in a Capacitor WKWebView. WebGL2, getUserMedia and MediaPipe all work there. This is the cheapest route.
- **3b (only if 3a measures short):**
  - Capture: native `AVCaptureVideoDataOutput` (with `alwaysDiscardsLateVideoFrames`) into `CVMetalTextureCache`.
  - Segmentation: `VNGeneratePersonSegmentationRequest` (`.balanced`; `.fast` on A12).
  - Compositing: the same fusion math in a Metal shader, drawn natively under a transparent WebView that only shows the UI. Do not stream frames over the bridge. The camera cannot be reliably shared between getUserMedia and AVCaptureSession.
- Kids Category rules apply: no third-party analytics or ads, a privacy manifest, and a parental gate for external links.

## CorridorKey 2.0 / v1: drop it, including offline

- **License:** clause 2a bans redistribution "in whole or in part" and "as part of a competing product". The CorridorKey name must be kept on derivatives, and share-alike carries the extra terms. We could not host the weights without written permission.
- **Size and memory:** 200–400 MB download and about 2.4 GB of memory at 512 px, which would get the iPad tab killed. Roughly 1 fps.
- **A server version is out:** uploading children's video conflicts with no-server, no-login, privacy (COPPA / GDPR-K) and zero hosting cost.
- **"Make it Magic" without it:** re-render a recorded raw clip offline using Tier 1+2 at full settings. That means ML on every frame, the guided filter at full resolution, and temporal smoothing in both directions. This needs the recorder to keep the raw camera clip alongside.

## Licenses

| Component | License | Use | Fit with free CC-BY-NC-SA app |
|---|---|---|---|
| @mediapipe/tasks-vision + selfie_segmenter.tflite | Apache-2.0 | shipped | Yes. Must include LICENSE and NOTICE in `THIRD_PARTY_LICENSES` |
| DeltaE (zschuessler) | Unlicense | formulas only (ΔE00 for warnings) | Yes, no conditions |
| chromakey-video-react | MIT | idea only (alpha-aware despill) | Yes. Re-implemented, so no notice needed |
| RealTimeGreenScreen | MIT | idea only (alpha gamma) | Yes |
| corridorkey-obs-filter | MIT | idea only (hint/morphology recipe) | Yes |
| CorridorKey despill/linear compositing | CorridorKey licence | **not copied**. Average-limit despill and sRGB↔linear are standard formulas written from first principles | Yes |
| BGMv2 | MIT | not shipped (the plate idea is a possible P3 per-pixel key) | Yes |
| Guided filter (He et al. 2015) | published algorithm | written from the paper | Yes (not legally reviewed) |
| RVM | GPL-3.0 | **excluded** | No, unless the app code is relicensed GPL-3.0 |
| CorridorKey weights | CC BY-NC-SA + extra terms | **excluded** | No (no redistribution) |

## Implementation tasks

**`web/src/lib/keyer/`**
1. **`labKey.ts` (new):**
   - Functions: `srgbToLinear`, `rgbToLab`, `keyLabParams(keyRGB)`, `keyDistLab`, `autoThresholds(samples) → {lo, hi, tooUneven}`, `deltaE00` (warnings only).
   - Constants: `MAX_SHADOW_GAIN=2.0`, `L_WEIGHT=0.2`, `LUT_N=48`, `LUT_RANGE=48`, `DARK_L_LO=6`, `DARK_L_HI=14`.
2. **`labKey.test.ts` (new):** ΔE00 against Sharma pairs #1, #7, #17 (2.0425 / 2.3669 / 27.1492), and keyD on the DeltaE report's sample colours (screen ≤ 3.5, lime/sage/skin ≥ 25).
3. **`keyLut.ts` (new):** `bakeKeyLut(params) → Uint8Array` (RG, N³) and `uploadKeyLut(gl, tex, data)` (TEXTURE_3D, RG8, LINEAR, CLAMP). Add a test that compares trilinear sampling against analytic keyD.
4. **`autoKey.ts`:**
   - `pickKeyColor` averages in linear RGB.
   - New slider mapping to lo/hi in ΔE units.
   - CPU `despill(px, key, strength, alpha)` mirrors `despillA`.
   - Keep the YCbCr `keyAlphaFast` for the Canvas2D fallback.
   - Update `autoKey.test.ts`, including a despill check that yellow `(1,1,0)` is unchanged at a=1.
5. **`shaders.ts`:**
   - Add `MATTE_FS`, `GF_PACK_FS`, `BOX_FS`, `GF_COEF_FS`, `MASK_PREP_FS` and `BLUR_DOWN_FS` (background 1/8).
   - Rewrite the `FG_FS` chroma branch as above and give the `segment` branch the guided filter.
   - Keep the analytic `keyDistLab` GLSL behind a define as a debug and fallback path.
6. **`Compositor.ts`:**
   - Pass graph per new camera frame: matte ping-pong (RGBA8, camera resolution ≤ 1280 wide), then the guided-filter buffers (RGBA16F, half resolution; feature-detect, fall back to tent), then mask prep (only when a new mask arrives), then draw.
   - API: `setMaskData(u8, w, h)`, `setMlWeight`, `resetTemporal()`.
   - Background blur texture: rebuilt on `setBackground`, per frame at 1/8 for video backgrounds.
   - Async key-sampling readback (PBO + fence).
   - Frame-time stats for `deviceTier`.
   - Rebuild every buffer on `webglcontextrestored`.
   - P2: `SRGB8_ALPHA8` stage buffer for linear-light compositing.

**`web/src/lib/`**
7. **`segmenter.ts`:** return `{data: Uint8Array, w, h}` instead of a canvas; add `benchmark(n)` and cadence control. Usable in chroma mode as the helper.
8. **`deviceTier.ts` (new) + test:** tiers, benchmark thresholds and backoff state machine as above. Pure logic, unit-tested.
9. **`useStage.ts`:** always run Tier 1. Start the helper per `deviceTier` and settings, fade `mlWeight` in, reset temporal state and ML on camera switch, resize or visibility change. Wire the "shirt is screen-coloured" warning and the slow auto-key re-calibration.
10. **Settings store:** add a teacher-gated `magicHelper: 'auto' | 'on' | 'off'`.
11. **PWA:** precache only the SIMD `vision_wasm_internal.*` and the model. Runtime-cache the `nosimd`/`module` variants (about 13 MB each, needed only on iOS < 16.4).
12. **`THIRD_PARTY_LICENSES`:** add the MediaPipe Apache-2.0 LICENSE and NOTICE and show them on the About screen.
13. **Testing:**
    - Playwright with a fake camera green-screen clip (Chrome): compare matte snapshots and check fps.
    - Manual iPad checklist on an A13 floor device and an M-series device: shadows, wrinkles, green shirt, held prop, fast motion.
    - Record measured fps, because every fps figure here is an estimate.

The current files are `/Users/md/Green Screen 2/web/src/lib/keyer/shaders.ts`, `/Users/md/Green Screen 2/web/src/lib/keyer/Compositor.ts`, `/Users/md/Green Screen 2/web/src/lib/keyer/autoKey.ts`, `/Users/md/Green Screen 2/web/src/lib/segmenter.ts` and `/Users/md/Green Screen 2/web/src/lib/useStage.ts`.