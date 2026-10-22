# What CorridorKey v1 can teach Magic Screen's real-time keyer

**Sources read** (via `gh api`, no code executed):
- `nikopueringer/CorridorKey` at `97e55a4530` (2026-05-28): `CorridorKeyModule/core/color_utils.py`, `inference_engine.py`, `core/model_transformer.py`, `corridorkey_cli.py`, `README.md`, `docs/LLM_HANDOVER.md`
- `qshiqshi/corridorkey-obs-filter` at `8b9a40d53b` (MIT): `chroma_hint.py`, `engine_wrapper.py`, `server.py`, `config.py`, `static/index.html`
- Our current shader, `/Users/md/Green Screen 2/web/src/lib/keyer/shaders.ts`. The guided filter, ML fusion, `despillA` and light wrap from the plan are already in it.

**Clean-room note:** nothing below is copied. I describe CorridorKey's ideas in my own words and cite them by file and line. All GLSL and JS here is original. Blur-fusion (Forte & Pitié 2021), multi-level foreground estimation (Germer et al. 2020), the guided filter, sRGB transfer functions and connected-component labelling are cited as published methods.

## Summary

The biggest lesson is that CorridorKey's real product is the **unmixed straight foreground colour** (`fg`), not the matte (README:11, :27; LLM_HANDOVER.md:11). Our pipeline only *despills* the camera pixel at edges and never unmixes it. That is why semi-transparent hair and motion-blurred arms come out grey or green-tinged.

A cheap GPU version of foreground estimation (blur-fusion over a mip pyramid) costs about 1 ms on A13 and is the main new P0. The rest are smaller wins:
- A one-pass "area-open" despeckle.
- Despill tuning once unmixing exists.
- Moving linear-light compositing earlier.
- A synthetic evaluation harness that scores foreground colour, not just alpha.
- An optional hand-designed "refiner" residual in logit space.

| # | Technique | Priority | Cost at 720p, A13 (estimate) |
|---|---|---|---|
| 1 | Foreground unmixing (blur-fusion pyramid, linear light) | **P0** | ~0.8–1.2 ms |
| 2 | Area-open despeckle with built-in proximity guard, plus hole fill | **P1** | ~0.15 ms |
| 3 | Despill adjustments (keep luma-grey re-add, back off where unmixed) | **P1** | 0 |
| 4 | Linear-light conventions (unmix in linear, 16F for premultiplied buffers, `SRGB8_ALPHA8` stage moved from P2 to P1) | **P1** | ~0.3–0.5 ms for the stage pass |
| 5 | Synthetic evaluation harness and checkerboard QA view | **P1** | offline |
| 6 | Hint recipe gives us a cheap trimap/edge band | P1 (folded into 1 and 2) | ~0 |
| 7 | "Refiner" residual in logit space (detail recovery) | P2 | ~0.15 ms |
| 8 | Exact connected components in a worker | P2 | ~0.2 ms CPU, 1 frame late |
| 9 | Key-direction despill for teal/lime screens | P2 | 0 |

---

## 1. Foreground colour recovery ("unmixing") — P0

**(a) What CorridorKey does**
- The network has a separate foreground decoder that outputs 3 channels of straight colour (`model_transformer.py:185-186`). It is upsampled and refined like alpha and passed through a sigmoid (`:251-295`).
- The `fg` output is "straight, sRGB" (`inference_engine.py:311`; LLM_HANDOVER.md:33-34).
- Compositing then uses that foreground, not the camera pixel: it linearises, premultiplies by alpha and composites in linear light (`inference_engine.py:284-305`, `:360-375`).
- Despill runs on the already-unmixed foreground (`:278`, `:357`), so it only has leftover spill to remove.

**(b) Why it helps.** At an edge pixel the camera sees `I = α·F + (1−α)·B`, where B is the local screen colour.
- Today we output `despill(I)` with α. The green part `(1−α)·B` is clamped away per channel, which leaves grey or magenta wisps and darkened motion blur.
- If we estimate F (and B) and output `α·F + (1−α)·NewBG`, the screen contribution is replaced rather than desaturated. This is what makes CorridorKey's hair and motion blur look right.

**(c) Real-time approximation: blur-fusion foreground estimation.**
- Forte & Pitié 2021 compute `F = F̂ + α·(I − α·F̂ − (1−α)·B̂)`, where F̂ and B̂ are alpha-weighted local averages of foreground and background colour. There is no division by α, so it is stable at α→0 (F→F̂) and exact at α=1 (F=I).
- I swap their two large box blurs for a **mip-pyramid normalised convolution**, a cheap multi-scale take on the idea in Germer et al. 2020. Colour is weighted by *confident* alpha only. The nearest confident pixels dominate, and coarser levels fill in when none are close.
- The mip chain is hardware-generated. All maths is in linear light.

Pass graph, added after the guided-filter coefficients and before `FG_FS`:
1. `UNMIX_PREP_FS` at half resolution (640×360). It writes two RGBA16F targets with MRT: `(lin(I)·wF, wF)` and `(lin(I)·wB, wB)`.
2. `gl.generateMipmap` on both targets (about 6 levels).
3. In `FG_FS`: 3 `textureLod` taps per pyramid, then the blur-fusion correction inside the edge band.

Alpha must be the **final composited alpha** (after the guided filter, ML fusion and choke), so that `α·F + (1−α)·B̂ ≈ I` holds for the α we actually blend with. Move that chain into a shared GLSL function, `finalAlpha(uv, c)`, and call it from both passes. At half resolution it is cheap.

```glsl
// ---- shared (inject into UNMIX_PREP_FS and FG_FS) ----
vec3 srgbToLin(vec3 c){ return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }
vec3 linToSrgb(vec3 l){ l = max(l, 0.0); return mix(l * 12.92, 1.055 * pow(l, vec3(1.0/2.4)) - 0.055, step(vec3(0.0031308), l)); }
// float finalAlpha(vec2 uv, vec3 c) { ...existing GF/tent + ML fusion + choke, factored out of FG_FS... }

// ---- UNMIX_PREP_FS @ half res, MRT -> two RGBA16F (mipmapped) ----
#version 300 es
precision highp float;
in vec2 v_uv;
layout(location = 0) out vec4 oF;   // confident-foreground colour, premultiplied by weight
layout(location = 1) out vec4 oB;   // confident-screen colour, premultiplied by weight
uniform sampler2D u_fg;
void main(){
  vec3 c = texture(u_fg, v_uv).rgb;            // LINEAR sampler = 2x2 average
  float a = finalAlpha(v_uv, c);
  vec3 L = srgbToLin(c);
  float wF = smoothstep(0.65, 0.95, a);        // only solid subject pixels donate F colour
  float wB = 1.0 - smoothstep(0.03, 0.30, a);  // only clean screen pixels donate B colour
  oF = vec4(L * wF, wF);
  oB = vec4(L * wB, wB);
}

// ---- FG_FS additions (chroma mode, after a is final) ----
uniform sampler2D u_unmixF, u_unmixB;   // mipmapped, half-res base
uniform float u_unmix;                  // 0..1, default 1
vec4 pyr(sampler2D t, vec2 uv){         // near levels dominate, far levels fill gaps
  return textureLod(t, uv, 1.0) + 0.25 * textureLod(t, uv, 3.0) + 0.0625 * textureLod(t, uv, 5.0);
}
// ...
vec3 I  = srgbToLin(c);
vec3 outLin = I;
float band = step(0.004, a) * step(a, 0.996);        // edge band only; interior and exterior untouched
if (band > 0.0 && u_unmix > 0.0) {
  vec4 sF = pyr(u_unmixF, uv), sB = pyr(u_unmixB, uv);
  vec3 Fh = sF.rgb / max(sF.a, 1e-4);
  vec3 Bh = sB.rgb / max(sB.a, 1e-4);
  vec3 F  = clamp(Fh + a * (I - a * Fh - (1.0 - a) * Bh), 0.0, 1.0);
  float trust = smoothstep(0.02, 0.10, sF.a) * smoothstep(0.02, 0.10, sB.a); // no donors nearby -> fall back
  outLin = mix(I, F, u_unmix * trust);
}
rgb = linToSrgb(outLin);                               // then a gentler despill (section 3), then light wrap
```

Cost at 720p on A13 (estimate, must be measured):
- Prep pass: 230k fragments with about 10 ALU plus a `finalAlpha` call, roughly 0.15 ms.
- Two `generateMipmap` calls on 640×360 RGBA16F: roughly 0.1–0.3 ms. Safari's driver overhead is the unknown. If it is slow, the fallback is 5 explicit 2×2 downsample passes.
- `FG_FS`: 6 extra `textureLod` and about 9 `pow` per edge pixel only (the band is typically under 15% of pixels), roughly 0.3–0.5 ms.
- Total about 0.8–1.2 ms on A13 and about 0.3 ms on M-series.

Requirements:
- RGBA16F colour-renderable (the same `EXT_color_buffer_half_float` gate as the guided filter) and MRT, which is core in WebGL2.
- Verify that `generateMipmap` accepts RGBA16F on iOS Safari.
- If it is unsupported, skip unmixing and keep today's despill path.

Precision: these must be 16F, not RGBA8. Premultiplied sums at small weights lose 3–5 bits in 8-bit.

**(d) Expected visible improvement for kids**
- Waving arms: the motion-blurred trail at α 0.2–0.7 currently reads as a grey-green smear. It becomes a skin-coloured, semi-transparent blur over the new background. This is the most noticeable win.
- Hair: flyaways and curls keep their brown, black or blond colour instead of going grey.
- Edges on an uneven or shadowed screen: B̂ is *local*, so a darker screen region behind the child is unmixed correctly. The global key colour plays no part.
- Because unmixing preserves soft edges cleanly, `u_choke` can drop from 1.3 to about 1.1, which keeps more of the motion blur.
- Risk: a sage shirt mis-keyed to α≈0.5 gets pulled toward neighbouring colours. ML core fill and the shirt warning already cover that case.

**(e) Priority: P0.** It goes after the plan's Tier 1 basics. Ship it behind `u_unmix` with A/B screenshots.

Optional P2 extension: keep a slowly updated, temporally accumulated 1/8-resolution "clean plate" of `oB` (EMA only where wB > 0.9). It supplies B̂ behind a child standing still where no screen pixels are close, and could later provide a per-pixel key colour (the BGMv2 "plate" idea).

---

## 2. Auto-despeckle — P1

**(a) What CorridorKey does**
- `clean_matte_torch` (`color_utils.py:472-505`):
  - Thresholds α > 0.25.
  - Labels connected components with an iterative max-pool label flood (`:385-419`): random initial labels, kernel `2·4+1`, so islands within 4 px merge. It runs only `area_threshold // 20` iterations, enough to tell "big" from "small" (`:482`).
  - Counts areas with `bincount` and keeps components of at least `despeckle_size` (default 400 px; `inference_engine.py:408`, `corridorkey_cli.py:205-211`).
  - **Dilates the keep-mask by about 25 px** (`dilation=25`, `inference_engine.py:272,352`) and blurs it (an 11×11 Gaussian, `blur_size=5`).
  - Multiplies α by the result.
- The OpenCV path is the same idea with exact CC at α > 0.5 (`:422-469`).
- It only removes small *foreground* islands. Holes are never filled.

**(b) Why it helps.** Specks from tracking dots, clamps, seams and wrinkle shadows are small and isolated. The large dilation is the clever part: disconnected hair strands or a pencil tip near the body sit inside the dilated safe zone and survive, while far-away specks die.

**(c) Real-time approximation: "box-mass" area-open, one pass pair at 1/4 resolution.**
- For a small isolated island, the sum of mask coverage in a W×W window centred on it equals its area. Near a large component, the window sum is large.
- So **one separable box-sum is both CorridorKey's area test and its proximity dilation**. Keep a pixel if `boxSum(m) ≥ A_min`.
- Run it on the raw matte (`u_matte.r`, before the guided filter) at 320×180. Each cell covers 4×4 full-resolution pixels.

```glsl
// DS_DOWN_FS @ 1/4 res -> R16F: coverage of (alpha > 0.25) in the 4x4 footprint (4 bilinear taps of the full-res matte)
// (soft threshold so the result is continuous)
float m(vec2 uv){ return smoothstep(0.2, 0.3, texture(u_matte, uv).r); }
void main(){
  vec2 t = u_fullTexel;
  o = vec4(0.25 * (m(v_uv + vec2(-t.x,-t.y)) + m(v_uv + vec2(t.x,-t.y)) + m(v_uv + vec2(-t.x,t.y)) + m(v_uv + vec2(t.x,t.y))), 0,0,1);
}
// DS_BOX_FS: separable sum, radius R=8 cells (=±32 px full res, 68x68 px window); run H then V -> R16F
void main(){
  float s = 0.0;
  for (int i = -8; i <= 8; i++) s += texture(u_src, v_uv + float(i) * u_step).r;
  o = vec4(s, 0,0,1);                                 // after V pass: sum of coverage cells
}
// FG_FS: keep = smoothstep(0.5*A, A, cells*16.0) where A = u_minArea (px)
float mass = texture(u_dsMass, uv).r * 16.0;          // bilinear = soft safe-zone edge (CorridorKey's blur)
float keep = smoothstep(0.5 * u_minArea, u_minArea, mass);
keep = max(keep, coreML);                             // never despeckle what the ML says is a child
a *= keep;
```

- `u_minArea ≈ 2e-4 · W · H`, which is about 180 px at 720p. CorridorKey's 400 px applies at its native resolution, and the OBS wrapper uses it at webcam resolution.
- A one-frame keep-mask hysteresis (fast attack, slow release) stops a hand that is just entering the frame from popping.
- **Hole fill, which CorridorKey doesn't have:** run the same box-mass on `1 − m` and set `a = max(a, 1 − keepHole)`. This fills small enclosed screen-coloured specks inside the child, such as a green logo dot or an eye glint, while real gaps between arm and body (much larger than A_min) stay open.
- Cost: 3 tiny passes at 320×180, about 57k fragments with 17 taps each, roughly 0.1–0.15 ms. Plus 2 fetches in `FG_FS`.

**(d) Visible improvement.** No more twinkling dots from screen seams, clips, tape, wrinkle lines or glossy hot-spots, which matters most on Tier 1-only devices where there is no ML garbage matte. Fine hair and held props near the body are protected by the 68-px window.

**(e) Priority: P1.** On Tier 2 the garbage matte already removes most far-away junk, so this matters most when ML is off.

---

## 3. Despill: average vs max, and energy redistribution — P1 (tuning)

**(a) What CorridorKey does** (`despill_opencv`, `color_utils.py:210-278`; `despill_torch`, `:281-303`):
- The limit is `avg(other two)` by default. `max` is available only on the OpenCV path (`:252-255`); the torch path hard-codes the average (`:291`).
- The spill `s = max(screen − limit, 0)` is subtracted from the screen channel, and **`s/2` is added to each of the other two channels** (`:265-267`). This preserves the channel sum, not luma.
- Strength is a linear blend (`:275-276`). The CLI default is 5/10, i.e. 0.5 (`corridorkey_cli.py:190-195`); the OBS wrapper uses 1.0 (`config.py:33`).
- It runs on the network's already-unmixed foreground (`inference_engine.py:278`).

**(b) Analysis versus ours.**
- CorridorKey's redistribution changes Rec.601 luma by `0.5s(0.299+0.114) − 0.587s = −0.38·s`, and it tints toward magenta.
- Ours (`despillA`, `shaders.ts:311-321`) adds `s·0.587` to all three channels, so luma is preserved exactly and the result is neutral. For skin with s≈0.06, CorridorKey's approach darkens by about 6 sRGB codes and pinks the cheek. **Keep ours.**
- CorridorKey can use the harsher average limit everywhere only because its input is already unmixed. Our max-inside / average-at-edges split is the right call for raw camera pixels.

**(c) Changes once section 1 lands** (original, zero cost):

```glsl
// in FG_FS: unmixing already explains edge green, so don't double-correct
float edgeBoost = SPILL_EDGE * (1.0 - u_unmix * trust * band);
// pass edgeBoost into despillA instead of the constant SPILL_EDGE; keep max-limit inside (bounce light on cheeks)
```

Despill then targets **interior bounce spill** (green light on the tops of heads and cheeks, where α=1 and unmixing can't help) and no longer greys out edges. CorridorKey's 0.5 default hints that once colours are unmixed, a gentler strength looks better. Try `u_spill` 0.9 → 0.6 with unmixing on.

**(d) Visible improvement.** Hair edges stop turning grey or magenta. Yellow and teal shirts stay saturated.

**(e) Priority: P1.** It is trivial, but it depends on section 1.

---

## 4. Premultiply and gamma conventions — P1

**(a) What CorridorKey does**
- Alpha is treated as linear coverage. The foreground is straight sRGB. It linearises with the exact piecewise sRGB curve (`color_utils.py:55-72`; LLM_HANDOVER.md:38 calls out a past bug from using a 2.2 power).
- It premultiplies only after linearising (`inference_engine.py:283-285`) and composites in linear (`:299-305`).
- When the input is linear, it resizes in linear "to preserve energy/highlights" (`:219-228`).
- LLM_HANDOVER.md:71 says "dark fringes" are almost always a step done in the wrong colour space.

The OBS wrapper is a counter-example:
- It premultiplies in sRGB, quantises to 8-bit, JPEG-encodes (`server.py:132-146`) and unpremultiplies in the browser with `a > 0.004 ? premul / a` (`index.html:183`).
- At α=0.05 one 8-bit step becomes about 0.08 of straight colour, before JPEG noise.
- It also returns the **raw** `fg`/`alpha` (`engine_wrapper.py:149-156`), not `processed`. So its `despill_strength=1.0, auto_despeckle=True` settings (`server.py:115-122`) silently do nothing.

**(c) What to adopt**
- Do the unmix maths in linear in-shader (section 1). That is the exact piecewise curve, which `shaders.ts:88` already has.
- Any premultiplied or weighted-sum buffer (unmix pyramid, light-wrap blur) must be 16F. Never round-trip premultiplied 8-bit. Our straight-alpha uploads (`Compositor.ts:950`) and straight "packed" mode are already right.
- Move the plan's linear-light stage (`SRGB8_ALPHA8` stage buffer, plan step 9) from P2 to **P1**. Unmixed F composited with sRGB-space blending still leaves a dark ring at α≈0.5 on bright backgrounds. Cost is one full-screen resolve pass, about 0.3–0.5 ms on A13.
- Average the 1/8-resolution light-wrap background blur in linear (P2 polish).
- Test lesson from the wrapper bug: add unit and Playwright assertions that toggling despill, despeckle or unmix actually changes output pixels.

**(d) Visible improvement.** No dark or bright halo where a child's edge meets a bright cartoon background.

**(e) Priority: P1.**

---

## 5. Evaluation (and training-data lessons) — P1

**(a) What CorridorKey does**
- Training data and the trainer are not released (README:190-192). We do know it was trained at 2048 (LLM_HANDOVER.md:40) on "coarse, blurry, eroded masks", and that it is good at *adding* detail but poor at *subtracting* an over-expanded hint (README:109).
- Its QA output is a comp over a dark/light grey checkerboard: sRGB 0.15/0.55, 128-px squares, composited in linear (`inference_engine.py:293-305`; `color_utils.py:508-547`). This exposes halos and leftover spill that a single background hides.

**(c) What we can build (original)**
- **Synthetic harness** (Node or Playwright, offline):
  - Take CC0 or licensed RGBA cut-outs (hair, hands, motion-blurred arms; motion blur is made by averaging shifted copies of `α` and `α·F`).
  - Composite with `I = α·F + (1−α)·S(x)`, where `S` is a key colour with a low-frequency luminance gradient (0.5–1.2×), a wrinkle-shadow texture, camera noise σ≈2/255, and spill `F' = F + k·(1−dist/20px)·(K−grey(K))` near edges.
  - Run our keyer headlessly and score on the edge band:
    - alpha SAD and gradient error
    - **ΔE00 of the composited foreground colour against ground truth over a magenta and a white background**
    - temporal flicker (mean |α_t − α_{t−1}| on static frames)
  - This turns every threshold in the plan (`lo/hi`, choke, `SPILL_EDGE`, `u_minArea`, unmix weights) into a measurable choice.
- **Teacher/dev "check" view:** add a checkerboard mode to `u_matteOut`, with two greys plus one saturated stripe. Kids never see it.

**(d) Visible improvement.** Indirect, but this is what tells us whether a change actually looks better.

**(e) Priority: P1.** Build it before tuning section 1.

---

## 6. Hint recipe (erode → dilate → blur), and what we take from it

**(a) What the wrapper does** (`chroma_hint.py:10-55`, defaults `config.py:26-29`):
1. HSV in-range green, inverted.
2. Erode 5 iterations with a 5×5 ellipse (about 10 px).
3. Dilate 3 iterations (about 6 px).
4. Gaussian blur 21×21.

The net effect is a morphological opening, which deletes foreground bits narrower than about 20 px (specks, thin seams), plus about 4 px of net shrink and a soft ±10 px ramp. That matches CorridorKey's training on eroded, blurry hints and its weakness at subtracting (README:109): **the hint should err inside the subject.**

CorridorKey's own garbage matte is the opposite: it is dilated before multiplying (`apply_garbage_matte`, `color_utils.py:186-207`, default 10 px).

**Our takeaways**
- The plan's ML fusion already follows the same asymmetry: an eroded core and a dilated garbage matte. This confirms it.
- New: the same recipe applied to *our* chroma matte gives a free **edge band / trimap** for devices with no ML. Band = `dilate(α>0.02) ∖ erode(α>0.98)`. Use it to restrict unmixing (section 1) and the despill edge boost (section 3). In practice the `band`/`trust` terms above already serve this purpose; a separate pass is only worth it if band leakage shows up in testing.
- The HSV hint itself is worse than our LUT keyD. Nothing to take there.

**Priority:** folded into sections 1 and 2.

---

## 7. The "refiner" residual: can a tiny hand-made GPU pass emulate it? — P2

**(a) What CorridorKey does**
- Coarse alpha and foreground logits come from decoders at H/4 and are upsampled bilinearly (`model_transformer.py:250-256`).
- A full-resolution CNN refiner takes RGB plus coarse probabilities (7 channels). It has a stem and 4 residual blocks with dilations 1/2/4/8, a receptive field of about 65 px, GroupNorm and 64 channels (`:99-142`).
- It outputs **delta logits ×10** (`:142`), added to the coarse logits before the sigmoid (`:285-295`). The comment explains the idea: the residual lives in logit space, so confident pixels are hard to move and uncertain ones easy (`:288-289`).
- Its documented job is fixing "macroblocking" from the coarse stage (`:101-103`). A `refiner_scale` forward hook acts as a strength knob (`inference_engine.py:463-470`; README:183 says keep it at 1.0).

**(b) Why it helps.** It splits the work: a coarse stage makes robust decisions, and a full-resolution stage puts detail back that lines up with the image.

**(c) Ours.** The half-resolution guided filter already *is* the coarse-to-fine split. What's missing is detail the guided filter smooths away (single hairs). A hand-designed residual in **logit space**, gated by image-edge strength, gives some of that back:

```glsl
float logit(float x){ x = clamp(x, 1e-3, 1.0 - 1e-3); return log(x / (1.0 - x)); }
// in FG_FS, right after the GF reconstruction, before ML fusion:
float aRaw = texture(u_matte, uv).r;                         // full-res LUT key (pre-GF)
vec2 t = u_mtexel;
float gx = texture(u_matte, uv + vec2(t.x,0)).g - texture(u_matte, uv - vec2(t.x,0)).g;   // matte.g = luma
float gy = texture(u_matte, uv + vec2(0,t.y)).g - texture(u_matte, uv - vec2(0,t.y)).g;
float detail = smoothstep(0.03, 0.12, length(vec2(gx, gy)));  // real image edge, not sensor noise
float d = clamp(logit(aRaw) - logit(a), -3.0, 3.0);           // bounded correction, like a residual head
a = 1.0 / (1.0 + exp(-(logit(a) + u_refine * detail * d)));   // u_refine 0..1 (default 0.5)
```

- Cost: 4 fetches and about 20 ALU per pixel, roughly 0.1–0.15 ms at 720p.
- Working in logit space means solid inside and outside stay solid. Only the uncertain band moves.
- Optional follow-up: try a 2-channel guide (luma plus a chroma-opponent `G − (R+B)/2`) in the guided filter. Green screen and skin often have similar luma, so a luma-only guide can't see that edge. This would cost roughly double the guided filter.

**(d) Visible improvement.** Crisper flyaway hair and finger gaps without bringing noise back on flat screen areas.

**(e) Priority: P2.** Check it with the section 5 harness first, because it can bring back edge noise.

---

## 8. Exact connected components in a worker — P2 (if section 2's box-mass misbehaves)

CorridorKey's GPU CC uses an iterative max-label flood (`color_utils.py:385-419`). In WebGL2 the flood itself is easy, about 20 passes at 160×90. Counting areas needs a scatter histogram, though, which means float blending (`EXT_float_blend`) that may not be on iOS.

A safer option is to reuse the plan's async PBO+fence readback:
1. Every frame, read back 160×90 of `α > 0.25`, first dilated by one cell to copy CorridorKey's 4-px merge distance.
2. Label it in a worker with two-pass union-find, under 0.3 ms for 14.4k px.
3. Upload an R8 keep-mask, one frame late, and box-dilate it on the GPU.

```js
// original two-pass union-find, 8-connectivity
function keepMask(bin, w, h, minCells) {
  const lab = new Int32Array(w * h), par = [0]; let n = 0;
  const find = x => { while (par[x] !== x) x = par[x] = par[par[x]]; return x; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (!bin[i]) continue;
    let best = 0;
    for (const [dx, dy] of [[-1,0],[-1,-1],[0,-1],[1,-1]]) {
      const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w) continue;
      const l = lab[yy * w + xx]; if (!l) continue;
      const r = find(l); if (!best) best = r; else if (r !== best) { const a = Math.min(r, best), b = Math.max(r, best); par[b] = a; best = a; }
    }
    if (!best) { best = ++n; par[n] = n; }
    lab[i] = best;
  }
  const area = new Uint32Array(n + 1);
  for (let i = 0; i < lab.length; i++) if (lab[i]) area[lab[i] = find(lab[i])]++;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < lab.length; i++) out[i] = lab[i] && area[lab[i]] >= minCells ? 255 : 0;
  return out;
}
```

---

## 9. Key-direction despill — P2 (new, not from CorridorKey)

Both CorridorKey and we despill along a pure RGB axis (G or B). Cheap classroom fabric is often yellow-green or teal-green, so a pure-G limit leaves a tint.
- Use the auto-key colour's chroma direction instead. In linear RGB, `d = normalize(K − dot(K, LUMA))`.
- Measure the excess as `s = max(dot(c − grey(c), d) − τ, 0)`, subtract `s·d` and keep luma.
- It's a drop-in change to `despillA`, chosen by `u_spillDir`, at no extra cost.

---

## Licence check

- Everything above is either a published method (blur-fusion foreground estimation, multi-level foreground estimation, guided filter, sRGB transfer, union-find CC) or an original design.
- No CorridorKey code, weights or names would ship.
- The MIT wrapper is used only for the ideas in sections 4 and 6, so no notice is needed.

Downloaded sources used for citations are in `/private/tmp/claude-501/-Users-md-Green-Screen-2/727545c3-c535-41ef-933d-42d65e406914/scratchpad/ck/`. The current shader I compared against is `/Users/md/Green Screen 2/web/src/lib/keyer/shaders.ts`.