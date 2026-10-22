# DeltaE (zschuessler/DeltaE): what to use for keying in Magic Screen

## 1. What the repo is, and its license

- **URL:** https://github.com/zschuessler/DeltaE (npm `delta-e`, 274 stars, last push 2020-06-21). Description: "CIE color difference formulas in JavaScript".
- **What it is:** a small, pure-JS reference library with three files, `src/dE76.js`, `src/dE94.js` and `src/dE00.js`. Each takes two CIELAB colors `{L, A, B}`. **It has no RGB→Lab conversion, no GPU code, no video and no ML.** It contributes formulas only. There is nothing in it to run in real time.
- **License:** The Unlicense (public domain). This is compatible with a free CC BY-NC-SA app with no conditions. No attribution is required, though a credit line is polite. The GLSL below is my own port, written from the CIE and Sharma (2005) definitions. Its results match the Sharma reference test pairs (see §2).
- **Small issues in the library** (a GLSL port should not copy them):
  - `dE00.getDeltahPrime` tests `C1/C2 === 0` (unprimed chroma). The spec tests `C'1·C'2 == 0`.
  - `getHBarPrime` always adds 360 when `|h1-h2|>180` and never subtracts. It also averages even when one chroma is 0. The resulting error is negligible.
  - `dE94` is **asymmetric**: `SC` and `SH` use `C1`, the first argument. For keying, pass the **key color as the reference**.
  - `dE94` silently changes K1/K2 to the textile constants (0.048/0.014) whenever `lightness != 1`.
  - `dE94` uses `sqrt(...) || 0` to hide a NaN when the value under the root goes negative. Use `max(0.,…)` in GLSL.

## 2. Measured behaviour on green-screen colors (decides the recommendation)

I ported the math to a throwaway Node script (`/private/tmp/claude-501/-Users-md-Green-Screen-2/727545c3-c535-41ef-933d-42d65e406914/scratchpad/verify/de.mjs`). I did not execute any repo code.

- **Checks:**
  - sRGB (0,1,0) gives Lab (87.735, −86.183, 83.179), which is correct.
  - The CIEDE2000 Sharma pairs #1, #7 and #17 give 2.0425, 2.3669 and 27.1492, all exact.
- **Test setup:** the key is sRGB (40,180,75), which is Lab (64.6, −58.0, 42.7). `keyD` is the recommended metric from §3.

| sample (sRGB) | ΔE76 | ΔE94 | ΔE00 | ΔE00 kL=3 | **keyD** |
|---|---|---|---|---|---|
| screen, 50% shadow (25,128,50) | 23.6 | 18.2 | 17.2 | 6.8 | **0.4** |
| screen, 25% shadow (15,92,35) | 41.5 | 31.6 | 31.8 | 12.8 | **0.3** |
| screen, hot spot (70,230,105) | 19.5 | 16.8 | 12.6 | 4.7 | **3.3** |
| forest-green shirt (34,100,40) | 39.3 | 28.3 | 28.5 | 12.0 | **3.2** (ambiguous) |
| lime shirt (150,220,60) | 31.9 | 20.5 | 16.0 | 11.3 | **27.4** |
| sage shirt (140,170,130) | 47.4 | **11.6** | 15.1 | 15.1 | **47.4** |
| skin (225,180,150) | 74.3 | 31.5 | 40.3 | 39.3 | 73.3 |
| dark hair (40,30,25) | 89.3 | 56.6 | 55.5 | 35.6 | 73.9 |

**Conclusions:**

- **CIE94 and CIEDE2000 are the wrong tools for the core key.**
  - They were designed for *small* differences, roughly ΔE < 5, between paint and print samples.
  - When the reference is highly saturated (green screen C* ≈ 70), they divide chroma differences by `SC = 1+0.045·C ≈ 4`. That makes **lightness the dominant term**, which is the opposite of what a keyer needs.
  - Result: CIE94 rates a sage shirt (11.6) *closer* to the screen than the screen's own 25% shadow (31.6). With any single threshold, the shirt disappears while the shadows stay.
  - ΔE00 has the same inversion. It also has known hue discontinuities at large ΔE.
- **Plain ΔE76 cannot key shadows.** A 25% shadow on the screen is ΔE 41, while a lime shirt is 32.
- **A shadow-invariant, one-sided Lab chroma distance ("keyD") separates the cases cleanly:** screen ≤ 3.3, everything else ≥ 27.
  - The one exception is a *dark version of the key color* (forest green), which is physically ambiguous. The shadow-gain clamp sets the trade-off:

    | max gain | 50% shadow | 25% shadow | forest shirt |
    |---|---|---|---|
    | 1.5 | 0.4 | 5.6 | 6.5 |
    | 2.0 | 0.4 | 0.3 | 3.2 |
- **Why it works:** for a pure shadow (XYZ scaled by k, above the linear segment of f), L*, a* and b* **all scale by k^(1/3)**. So (a*/L*, b*/L*) does not change under shadow. This is the Lab version of the `u_keyY / y` gain already in `shaders.ts`.

**Recommendation:**
- **Live alpha:** use **keyD**, which is shadow-normalised, one-sided, Lab chroma-plane, with a low lightness weight. It costs about the same as ΔE76.
- **Uses for ΔE00 (offline only):**
  - a calibration and quality check, for example "your shirt is too close to the screen color"
  - baking into a 3D LUT, if you want it at all

  Never compute ΔE00 per tap in the shader.

## 3. GLSL (WebGL2, `precision highp float;`)

Use `highp` throughout. On iOS, `mediump` is fp16, and `25^7 = 6.1e9` and Lab values above 100 overflow or lose precision there.

### 3a. sRGB → linear → XYZ (D65) → CIELAB
```glsl
const float PI = 3.14159265, TAU = 6.2831853;

vec3 srgbToLinear(vec3 c) {
  vec3 lo = c / 12.92;
  vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(hi, lo, vec3(lessThanEqual(c, vec3(0.04045))));
}

// sRGB->XYZ (D65) with the D65 white (0.95047, 1, 1.08883) folded in. GLSL mat3 is column-major.
const mat3 RGB2XYZn = mat3(
  0.433949, 0.2126729, 0.017757,   // R column
  0.376210, 0.7151522, 0.109468,   // G column
  0.189840, 0.0721750, 0.872775);  // B column

vec3 labF(vec3 t) {               // CIE f(t); 0.008856 = (6/29)^3
  vec3 cbrt = pow(max(t, vec3(1e-6)), vec3(1.0 / 3.0));
  return mix(7.787037 * t + 0.137931, cbrt, vec3(greaterThan(t, vec3(0.008856452))));
}

vec3 rgbToLab(vec3 srgb) {        // srgb in 0..1 -> (L 0..100, a, b)
  vec3 f = labF(RGB2XYZn * srgbToLinear(srgb));
  return vec3(116.0 * f.y - 16.0, 500.0 * (f.x - f.y), 200.0 * (f.y - f.z));
}
```

Optional: upload the camera frame into an `SRGB8_ALPHA8` texture so sampling returns linear values for free, which removes 3 `pow` calls. The catch is that every downstream step (despill, composite) then works in linear space and needs an sRGB re-encode on output. Test Safari's video→sRGB-texture upload speed before committing.

### 3b. CIE76 / CIE94 / CIEDE2000
```glsl
float dE76(vec3 a, vec3 b) { return distance(a, b); }

// ref = key color (CIE94 is asymmetric). Graphic arts: kL=1, K1=0.045, K2=0.015.
float dE94(vec3 ref, vec3 s, float kL) {
  float C1 = length(ref.yz), C2 = length(s.yz);
  float dL = ref.x - s.x, dC = C1 - C2;
  vec2  dab = ref.yz - s.yz;
  float dH2 = max(dot(dab, dab) - dC * dC, 0.0);
  float SC = 1.0 + 0.045 * C1, SH = 1.0 + 0.015 * C1;
  float l = dL / kL, c = dC / SC;
  return sqrt(l * l + c * c + dH2 / (SH * SH));
}

float dE00(vec3 l1, vec3 l2, float kL) {           // kC = kH = 1
  const float P25_7 = 6103515625.0;
  float Cb = 0.5 * (length(l1.yz) + length(l2.yz));
  float Cb7 = pow(Cb, 7.0);
  float G = 0.5 * (1.0 - sqrt(Cb7 / (Cb7 + P25_7)));
  float a1 = (1.0 + G) * l1.y, a2 = (1.0 + G) * l2.y;
  float C1 = length(vec2(a1, l1.z)), C2 = length(vec2(a2, l2.z));
  float h1 = C1 < 1e-4 ? 0.0 : atan(l1.z, a1); h1 += h1 < 0.0 ? TAU : 0.0;
  float h2 = C2 < 1e-4 ? 0.0 : atan(l2.z, a2); h2 += h2 < 0.0 ? TAU : 0.0;
  bool  z  = C1 * C2 < 1e-8;
  float dh = h2 - h1;
  dh = z ? 0.0 : (dh > PI ? dh - TAU : (dh < -PI ? dh + TAU : dh));
  float dL = l2.x - l1.x, dC = C2 - C1;
  float dH = 2.0 * sqrt(C1 * C2) * sin(0.5 * dh);
  float Lb = 0.5 * (l1.x + l2.x), Cbp = 0.5 * (C1 + C2);
  float hs = h1 + h2;
  float hb = z ? hs : (abs(h1 - h2) <= PI ? 0.5 * hs : (hs < TAU ? 0.5 * (hs + TAU) : 0.5 * (hs - TAU)));
  float T = 1.0 - 0.17 * cos(hb - radians(30.0)) + 0.24 * cos(2.0 * hb)
              + 0.32 * cos(3.0 * hb + radians(6.0)) - 0.20 * cos(4.0 * hb - radians(63.0));
  float hd = degrees(hb);
  float dTheta = radians(30.0) * exp(-pow((hd - 275.0) / 25.0, 2.0));
  float Cbp7 = pow(Cbp, 7.0);
  float RT = -sin(2.0 * dTheta) * 2.0 * sqrt(Cbp7 / (Cbp7 + P25_7));
  float Lm = (Lb - 50.0) * (Lb - 50.0);
  float SL = 1.0 + 0.015 * Lm / sqrt(20.0 + Lm);
  float SC = 1.0 + 0.045 * Cbp, SH = 1.0 + 0.015 * Cbp * T;
  float l = dL / (kL * SL), c = dC / SC, h = dH / SH;
  return sqrt(l * l + c * c + h * h + RT * c * h);
}
```

**Approximate cost per evaluation** (my estimate from operation counts, not measured on a device):

| step | transcendentals | other ops |
|---|---|---|
| `rgbToLab` | about 6 (`pow` ×6) | about 25 MAD |
| `dE76` | 1 sqrt | none |
| `dE94` | 3 sqrt | none |
| `dE00` | about 17 (atan ×2, sin ×2, cos ×4, exp, pow ×3, sqrt ×5) | branches |

The current shader calls `keyAlpha` **9 times per pixel** (3×3 tent). At 720p that is about 8.3M evaluations per frame. With `dE00` that means roughly 1G transcendentals per second at 60 fps. That is heavy on older A-series iPads and drains battery. Two ways out:
- **(a)** Split into two passes. Pass 1 computes alpha once per pixel into an R8 texture. Pass 2 does the 3×3 tent and the composite.
- **(b)** Bake a LUT (§3d). This is what I recommend.

### 3c. Recommended key metric (Lab version of the existing YCbCr logic)
```glsl
uniform vec3  u_keyLab;     // key color in Lab (from calibration, averaged in Lab)
uniform vec2  u_keyDirAB;   // normalize(u_keyLab.yz)
uniform float u_keyC;       // length(u_keyLab.yz)
uniform float u_lo, u_hi;   // ΔE-units thresholds, see below
const float MAX_SHADOW_GAIN = 2.0;  // 1.5 = safer for dark-green clothing, 2.0 = keys deeper shadows
const float L_WEIGHT = 0.2;         // only penalises pixels BRIGHTER than the key

float keyDistLab(vec3 lab) {
  float g = clamp(u_keyLab.x / max(lab.x, 1.0), 1.0, MAX_SHADOW_GAIN); // shadow invariance
  vec2  ab = lab.yz * g;
  float along = dot(ab, u_keyDirAB);
  float perp  = length(ab - along * u_keyDirAB);         // hue error
  float shortfall = max(u_keyC - along, 0.0);            // one-sided: MORE saturated green is still screen
  float over = max(lab.x * g - u_keyLab.x, 0.0) * L_WEIGHT; // bright highlights / whites
  return length(vec3(shortfall, perp, over));
}

float keyAlpha(vec3 rgb) {
  return smoothstep(u_lo, u_hi, keyDistLab(rgbToLab(rgb)));
}
```

**Mapping ΔE to alpha:**
- `alpha = smoothstep(lo, hi, keyD)`.
- Defaults for an evenly lit screen: **lo ≈ 8, hi ≈ 20**, in Lab units.
- Measured on the sample colors: screen variants come out 0.3 to 3.3, a forest shirt 3–6, and lime, sage, skin and hair 27 and up.
- **Auto-calibration:** sample about 200 pixels the kid confirms are screen, then compute keyD for each one.
  - `lo = clamp(p95 + 2, 4, 14)`
  - `hi = lo + clamp(10, 8, 16)`
  - If `p95 > 12`, show "the screen is too uneven, add light" instead of loosening the thresholds.
- If you ever map plain ΔE76 instead, a typical band is lo 15–20 / hi 30–35, but shadows will not key. That is the reason to avoid it.
- Keep the existing `dark` override (`1 - smoothstep(DARK_LO, DARK_HI, y)`), or its Lab version on L* < 8–12. Below that, a and b are pure noise and `g` saturates.

### 3d. Best quality per cost: bake any metric into a 3D LUT
Alpha depends only on RGB, so precompute it once per calibration on the CPU and turn every tap into one texture fetch.

**Bake (JS):**
```ts
// 32^3 = 32K texels (~1 ms bake in JS); 64^3 = 262K (~10–30 ms). R8, LINEAR filtering (core in WebGL2).
const N = 64, data = new Uint8Array(N * N * N);
for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++)
  data[r + N * (g + N * b)] = 255 * smoothstep(lo, hi, keyD(rgbToLab(r/(N-1), g/(N-1), b/(N-1)), keyLab));
gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, N, N, N, 0, gl.RED, gl.UNSIGNED_BYTE, data);
// TEXTURE_MIN/MAG_FILTER = LINEAR, WRAP_S/T/R = CLAMP_TO_EDGE
```

**Sample (GLSL):**
```glsl
uniform highp sampler3D u_keyLut;
float keyAlpha(vec3 rgb) {
  const float N = 64.0;
  return texture(u_keyLut, rgb * ((N - 1.0) / N) + 0.5 / N).r;  // texel-centre remap
}
```
- **Why this is better:**
  - The 9-tap tent drops from about 54 `pow` calls to 9 fetches.
  - The same JS `keyD`/`rgbToLab` (or even `delta-e`'s `getDeltaE00` for experiments) drives both the shader and `autoKey.ts`, so they never drift apart.
  - Threshold sliders only need a re-bake.
- **Precision:** 64 steps is one LUT cell per 4 camera code values, which is well below sensor noise.
- **Debug path:** keep the analytic shader (3c) for debugging and for devices without float/3D texture support. WebGL2 guarantees 3D textures, so the fallback should rarely be needed.

### 3e. Lab-based despill (optional improvement)
```glsl
// pull a* (green-red axis) toward 0 only for greenish pixels, keep L → no darkening of edges
vec3 lab = rgbToLab(rgb);
float spillAmt = clamp(dot(lab.yz, u_keyDirAB) / u_keyC, 0.0, 1.0) * u_spill;
lab.yz -= u_keyDirAB * max(dot(lab.yz, u_keyDirAB), 0.0) * spillAmt;
// then labToRgb (inverse of 3a) — or keep the cheaper existing RGB limiter, which is fine for kids' use
```

## 4. Pitfalls and risks

1. **Lightness weighting:**
   - Full L weighting (ΔE76/94/00 with kL=1) un-keys every shadow and wrinkle.
   - Zero L weighting with unlimited shadow gain makes every dark green (and near-black noise) transparent.
   - The fix is shadow gain clamped to 1.5–2.0, a one-sided L term, and a dark override. Clothing that is a darker shade of the screen color cannot be fully separated by any color metric. The app should warn on calibration: compute ΔE00 or keyD between the screen sample and a "tap your shirt" sample, and if it is below about 10, show a friendly "that shirt is screen-colored" warning.
2. **CIE94 and ΔE00 invert priorities for saturated references** (§2 table). Do not use them for alpha. ΔE00 is fine for UI checks and threshold heuristics.
3. **One-sided chroma matters.** Symmetric distances un-key the *over*-saturated hot spots on the screen (ΔE76 19.5 for the bright patch).
4. **Average the key color in Lab or linear space**, never in sRGB. Recompute it when the iPad's camera auto-exposure or white balance changes; `getUserMedia` on Safari cannot lock these. Shadow normalisation absorbs exposure drift but not white-balance hue shifts, so offer a "re-tap screen" button or a slow EMA re-calibration on confirmed-screen pixels.
5. **Precision:** `highp` is required. Guard `atan(0,0)`, which is undefined in GLSL, and `pow(negative, …)`. The snippets above guard both.
6. **Color space assumptions:**
   - iPad and iPhone cameras may deliver BT.709 or Display-P3-tagged frames. Safari's `texImage2D(video)` conversion to sRGB is not guaranteed.
   - A small primaries mismatch only shifts the key color, and calibration absorbs that. Do not hard-code Lab thresholds from swatches; derive them from samples.
6b. **Unmeasured performance:** none of the cost figures were measured on an iPad. Run a quick on-device check of the analytic `keyDistLab` ×9 versus the LUT at 720p/1080p before choosing a default. The video texture upload is often the real bottleneck in Safari.
7. **Matte cleanliness:** with the LUT in place, an ML refinement stage stays optional. Spend that budget instead on a small two-pass morphology (erode 1 px, then the tent) to remove the green fringe around kids' hair.

**Files:**
- Repo clone (read only, never executed): `/private/tmp/claude-501/-Users-md-Green-Screen-2/727545c3-c535-41ef-933d-42d65e406914/scratchpad/rt/DeltaE`
- Verification script with the numbers above: `/private/tmp/claude-501/-Users-md-Green-Screen-2/727545c3-c535-41ef-933d-42d65e406914/scratchpad/verify/de.mjs`
- Existing keyer the snippets plug into: `/Users/md/Green Screen 2/web/src/lib/keyer/shaders.ts` (`keyAlpha`) and `/Users/md/Green Screen 2/web/src/lib/keyer/autoKey.ts`