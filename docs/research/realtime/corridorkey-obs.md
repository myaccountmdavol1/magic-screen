# corridorkey-obs-filter and CorridorKey v1: what they offer a real-time browser green screen

**Bottom line:** we shouldn't put CorridorKey (v1 or v2) into Magic Screen as a real-time stage. On an iPad in the browser I estimate well under 1 fps at 512px, while needing a 200–400 MB weights download and about 2.4 GB of memory. Its license also blocks us from shipping the weights ourselves. `qshiqshi/corridorkey-obs-filter` is MIT, but it's only a thin Python wrapper with no browser code to reuse. Five pieces of its post-processing are worth porting into our WebGL keyer, though. Each is a few lines of GLSL or JS and costs almost nothing at 60 fps.

---

## 1. What the repo does, how it works, quality, license

**What it is.** About 1,240 lines of Python (`app.py` plus `corridorkey_obs/*.py`, and a 320-line `static/index.html`). The README describes the flow as:
```
Camera → [Chroma Hint Generator] → [CorridorKey Neural Net] → Virtual Camera → OBS
              (simple HSV key)      (AI foreground unmixing)    (or NDI RGBA)
```
It needs `torch`, `timm==1.0.24`, `opencv` and a separate clone of `nikopueringer/CorridorKey` plus `CorridorKey_v1.0.pth` (~300 MB). The README asks for an "NVIDIA GPU with 24+ GB VRAM … or Apple Silicon Mac (M1+)".

**There are two front ends:**
- `main.py` reads frames with OpenCV and outputs to a virtual camera (pyvirtualcam, composited onto `#00B140`) or NDI RGBA.
- `server.py` is a FastAPI WebSocket server. The browser sends JPEG frames at quality 0.90. The server returns one JPEG (quality 92) with **premultiplied RGB on the left and alpha as grayscale on the right**. `index.html` then unpremultiplies it in a WebGL2 shader (`color = a > 0.004 ? premul / a : vec3(0.0)`). All inference happens on the server, so it doesn't run in the browser at all.

**The technique.** `chroma_hint.py` builds a rough "hint" mask that tells CorridorKey roughly where the person is:
```python
hsv = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2HSV)
green_mask = cv2.inRange(hsv, (35,50,50), (85,255,255))
fg_mask = cv2.bitwise_not(green_mask)
fg_mask = cv2.erode(fg_mask, ELLIPSE_5x5, iterations=5)
fg_mask = cv2.dilate(fg_mask, ELLIPSE_5x5, iterations=3)
fg_mask = cv2.GaussianBlur(fg_mask, (21,21), 0)
```
Then `engine_wrapper.py` runs `CorridorKeyEngine.process_frame(image, mask_linear=hint, refiner_scale=1, despill_strength=1, auto_despeckle=True, despeckle_size=400)`, with fp16 and `torch.compile(backend="aot_eager")` on MPS/CUDA.

**Quality.** All of it comes from CorridorKey; the hint is a crude HSV key. The README's own speed numbers on an RTX 4090:
- 2048: "~2-5 fps"
- 1024: "~8-15 fps"
- 512: "~20-30 fps (real-time, lower quality)"

**Licenses.**
- The wrapper is **MIT**. We can copy it into a CC BY-NC-SA app as long as we keep the MIT notice.
- **CorridorKey itself** uses its own "CORRIDOR KEY LICENCE v1.0": CC BY-NC-SA 4.0 **plus extra terms**:
  - 2a: "You may not repackage, redistribute, sublicense, or sell this tool, in whole or in part, as a standalone product or as part of a competing product."
  - 2b: no paid API.
  - 3b: derivatives must keep the "CorridorKey" name prominently.
  - 4: share-alike including these extra terms.
- Our free, non-commercial CC BY-NC-SA app fits the CC part. But **hosting converted weights inside our PWA** risks breaking 2a ("redistribute … in part … as part of a competing product"). That would need written permission from contact@corridordigital.com.
- The CorridorKeyWeb page reaches the same conclusion ("Redistribution of converted models is restricted by those terms") and makes users load the file themselves. That flow (download 400 MB, then pick a file) is unusable for kindergartners.
- GPL is not involved in this chain. The usual GPL trap is elsewhere: Robust Video Matting is GPL-3.0, so we should avoid it in favour of Apache or MIT models.

## 2. Can CorridorKey v1 run in real time in Safari?

**The model**, from `CorridorKeyModule/core/model_transformer.py`, is `GreenFormer`:
- **Encoder:** Hiera Base+ (`hiera_base_plus_224.mae_in1k_ft_in1k`). Its input layer is patched to 4 channels (RGB plus hint), with feature channels `[112,224,448,896]`.
- **Decoders:** two SegFormer-style heads (alpha and foreground colour), with embedding 256, working at H/4 and then bilinearly upsampled.
- **Refiner:** `CNNRefinerModule(in=7, hidden=64, out=4)`, four dilated residual blocks (dilations 1, 2, 4, 8) running **at full input resolution**, with output `* 10.0`.
- **Size:** weights are ~400 MB fp32 safetensors (~100M parameters), so roughly 200 MB as fp16. It was trained at 2048, and its position embeddings are bicubically resized for other sizes. The input size must be a multiple of 32.

**Measured native speed.** From `nikopueringer/corridorkey-mlx`, `docs/benchmarks/2026-03-09-wave2-ablation-results.md`. The Apple chip isn't named, but the 26 GB peak at 2048 means a Mac with lots of memory (Pro or Max class).

| img_size | median latency | peak memory |
|---|---|---|
| 512 | **119.6 ms** | **2.4 GB** |
| 1024 | 583 ms | 3.8 GB |
| 2048 | 4,985 ms | 26.7 GB |

**Rough compute cost at 512.**
- The refiner alone is about 9 convolutions × 64×64×9 ≈ 330K multiply-adds per pixel × 262K pixels ≈ **87 GMAC**.
- Hiera Base+ at 512 is about 5.2× its 224 cost, so ≈ 30+ GMAC.
- In total that's about 120+ GMAC, roughly 250 GFLOP per frame.

**Estimate for an iPad M4/M5 in Safari with onnxruntime-web WebGPU:**
- The iPad GPU has about 10 cores, roughly 1/3 to 1/4 of a Max-class Mac.
- ORT-Web WebGPU typically runs 2–4× slower than native MLX/Metal. Its WebGPU backend is still marked "experimental", and Safari is the least-tested target.
- So at 512, 120 ms × 3 × 3 ≈ **~1 s per frame, about 1 fps** (my range: 0.5–2 fps).
- At 256, compute drops about 4× to roughly **2–5 fps**. But that's 1/8 of the training resolution, and hair and edge quality collapse, which removes CorridorKey's only advantage.
- Memory: about 2.4 GB at 512 is likely to get the tab killed by iPadOS's per-tab memory limit, especially on 8 GB iPads.
- Phones are worse.

**Browser exports that already exist:**
- `CorridorKeyWeb/CorridorKeyWeb.github.io`: single-file HTML, `onnxruntime-web@1.22.0` from jsdelivr, backends `webgpu` or `wasm`. It **builds the ONNX graph in JS straight from `CorridorKey_v1.0.safetensors`** (`tensorProto`, `g.op('Resize'…)` etc.). It also ships an `export_onnx.py` (inputs `['input','refiner_scale']`, outputs `['alpha','fg']`) and offers sizes 512/768/1024/2048. It's built for still images and offline video (frame by frame, then MP4 via WebCodecs), not live camera. Its README says "Chrome or Edge" and has no timing numbers. Created 2026-10-09, 0 stars, no license.
- `daniil-lyakhov/CorridorKeyOpenVINO` ships a ready 512×512 IR (Intel only).
- `alexandremendoncaalvaro/CorridorKey-Runtime` (CC BY-NC-SA) has ONNX/TensorRT and MLX tiers named Draft 512, High 1024, Ultra 1536.
- Nobody publishes a hosted ONNX file, because the license forbids redistribution.

**Does "downscaled hint plus guided upsample" make it viable?**
- The hint is already cheap. The expensive part is the image going through Hiera and the full-resolution refiner, so the hint's resolution doesn't matter.
- Running at 256 or 384 and then guided-upsampling alpha with the full-res frame gives a clean silhouette. But a plain chroma key plus a guided filter already gives that, at 60 fps with a 0 MB model.
- **Alternative:** run it asynchronously on keyframes, say every 1–2 s at 384, and use the result only to adapt the chroma-key parameters (screen colour, thresholds) or as a soft "where's the kid" mask. That's technically possible (worker plus WebGPU), but 200 MB and the license issue still apply. **Not viable for this app.**

**Better ML option if we want a refinement stage:** a person-segmentation model used as a soft mask that we combine with the chroma key. Examples are MediaPipe Selfie Segmenter (256×256, ~250 KB tflite, Apache-2.0) or MODNet (Apache-2.0, ~25 MB ONNX, 512). Both run in real time in WebGL or WebGPU on iPads. This fixes the real kindergarten failures: green T-shirts, shadows on the sheet, and the edges of the cloth. Hair-level unmixing doesn't matter much here. Our shader already has a `u_mask` input (`a = u_hasMask ? smoothstep(0.3,0.7, texture(u_mask, uv).r) : 1.0;`), so this slots straight in.

## 3. What to adopt into `/Users/md/Green Screen 2/web/src/lib/keyer/`

### A. Luminance-preserving despill (from CorridorKey `color_utils.despill_torch`)
Ours, in `shaders.ts` lines 94–99, uses `limit = max(other two)` and only subtracts. That darkens skin and leaves it slightly magenta. CorridorKey uses the **average** of the other two channels and **puts the removed energy back**:
```python
limit = (a + b) / 2.0
spill = clamp(screen - limit, min=0)
screen_new = screen - spill;  a_new = a + spill*0.5;  b_new = b + spill*0.5
out = mix(image, despilled, strength)
```
GLSL drop-in:
```glsl
vec3 despill(vec3 c) {
  vec3 o = c;
  if (u_spillCh == 1) {            // green
    float limit = 0.5 * (c.r + c.b);   // CorridorKey "average" mode
    float s = max(c.g - limit, 0.0);
    o = vec3(c.r + 0.5*s, c.g - s, c.b + 0.5*s);
  } else if (u_spillCh == 2) {     // blue
    float limit = 0.5 * (c.r + c.g);
    float s = max(c.b - limit, 0.0);
    o = vec3(c.r + 0.5*s, c.g + 0.5*s, c.b - s);
  } else {
    float limit = 0.5 * (c.g + c.b);
    float s = max(c.r - limit, 0.0);
    o = vec3(c.r - s, c.g + 0.5*s, c.b + 0.5*s);
  }
  return mix(c, o, u_spill);
}
```
Optionally keep `max` as a "strong" mode for heavy spill. Average mode removes more green, so tune `u_spill` to about 0.8 by default.

### B. Composite in linear light (from `_postprocess_opencv`)
CorridorKey does `srgb_to_linear`, then `premultiply`, then composites in linear, then `linear_to_srgb`. Mixing in sRGB, which most keyers do, gives dark fringes around edges with alpha between 0 and 1.
```glsl
vec3 toLin(vec3 c){ return mix(c/12.92, pow((c+0.055)/1.055, vec3(2.4)), step(0.04045, c)); }
vec3 toSrgb(vec3 c){ return mix(c*12.92, 1.055*pow(c, vec3(1.0/2.4))-0.055, step(0.0031308, c)); }
// final:
vec3 outLin = toLin(fg) * a + toLin(bg) * (1.0 - a);
fragColor = vec4(toSrgb(outLin), 1.0);
```
Alternatively, make the canvas and textures sRGB (`SRGB8_ALPHA8`) so the hardware does the conversions.

### C. Core and garbage matte from the hint recipe (erode 5×, dilate 3×, blur 21)
This makes a conservative "definitely the kid" core and a "definitely background" zone, with the soft chroma alpha used only in the band between them.
- **Pipeline (all at 1/4 resolution, about 480×270):**
  1. Threshold the chroma alpha at 0.5.
  2. Erode with a 3×3 min filter, 2–3 passes. This is the core.
  3. Dilate with a max filter, 4–6 passes. This is the outer limit.
  4. Separable blur.
- **Final alpha:** `a = max(a_key, core_soft) * outer_soft`.
- This fills speckled holes inside the child (glasses glints, shadows) and removes noise in the corners.
- Every pass is a 9-tap fragment shader, about 0.3 ms at 1/4 res.

### D. Despeckle "safe zone" (from `clean_matte_opencv`)
CorridorKey thresholds alpha at 0.5, drops connected components smaller than 400 px, dilates by 25, blurs by 5, and multiplies alpha by the result.
- Connected components don't map well to the GPU. Two options:
  - Read back the 1/8-res mask, which is tiny (240×135), every N frames. Label it in JS (union-find, about 0.2 ms) and upload a "keep" mask. Use area threshold ≈ 400/64 ≈ 6 px at 1/8 scale.
  - Use C (morphological open) as the GPU-only approximation.

### E. Guided (or joint-bilateral) upsample instead of the 3×3 matte blur
This is the "downscaled plus guided upsample" idea applied to *our* keyer, or to a future segmentation mask. Compute alpha at 1/2 or 1/4 res, then upsample it guided by the full-res luminance. That keeps edges sharp but stable, and it's cheaper than computing everything at full res.
```glsl
// joint bilateral upsample: low-res alpha guided by full-res luma
float jbu(vec2 uv){
  float yC = dot(texture(u_frame, uv).rgb, vec3(0.299,0.587,0.114));
  float sum=0., wsum=0.;
  for(int j=-1;j<=1;j++) for(int i=-1;i<=1;i++){
    vec2 o = uv + vec2(i,j)*u_lowTexel;
    float yN = dot(textureLod(u_frameLow, o, 0.).rgb, vec3(0.299,0.587,0.114));
    float w = exp(-float(i*i+j*j)*0.5) * exp(-pow((yC-yN)*u_sigmaInv,2.));
    sum += texture(u_alphaLow, o).r * w; wsum += w;
  }
  return sum/wsum;
}
```

**Recommended pipeline** (WebGL2, all real time):
```
camera tex → (1/4) CbCr-distance key → C: erode/dilate/blur core+garbage
          → [optional] segmentation mask (MediaPipe/MODNet, every 2nd frame, worker) → combine via u_mask
          → E: joint-bilateral upsample to full res
          → A: average despill (weighted by 1-a near edges)
          → B: linear-light composite over background
```
**Optional ML stage:** MediaPipe Selfie Segmenter, `selfie_segmenter.tflite` (~250 KB, 256×256, Apache-2.0), loaded through `@mediapipe/tasks-vision` ImageSegmenter on the GPU delegate. Combine it as `a = clamp(a_key, 0, 1) * smoothstep(0.2, 0.6, seg)`, which kills false foreground, and `a = max(a, step(0.9, seg) * core)`, which fills green-shirt holes only deep inside the person. **Do not use** CorridorKey in the product.

## 4. Risks and unknowns

- **No real iPad measurement.** I didn't run anything (the task said not to execute repo code). The ~1 fps figure at 512 is extrapolated from MLX's 119.6 ms on an unnamed Apple chip, plus usual ORT-Web overhead. The real number should be measured, but it would take more than a 10× improvement to change the conclusion.
- **ORT-Web WebGPU in Safari 26:** operator coverage and fp16 support in Safari are unproven for Hiera's reshape-heavy graph. corridorkey-mlx even warns that "shape-dependent reshapes in the Hiera backbone" break shapeless compile. Fall back to WASM and it's seconds per frame.
- **Memory:** about 2.4 GB at 512 in native MLX. The browser will likely use more, and iPadOS may kill the tab.
- **Download:** 200–400 MB on first load makes PWA caching and a kid-friendly startup impractical.
- **License:** CorridorKey's extra terms (no redistribution "in part" or in a "competing product", the name must be kept, share-alike with the extra terms) make bundling the weights legally unclear without written permission. The MIT wrapper is fine but has nothing to reuse in the browser.
- **CorridorKeyWeb** has no license, 0 stars, is two weeks old and is Chrome-oriented. Treat it only as proof that the graph can be built in ORT-Web, not as something to depend on.
- **Our side:** the average-mode despill and the linear compositing change the look, so we need to retune the defaults in `autoKey.ts`. The every-N-frames despeckle readback (D) could cause pipeline stalls in Safari. Use the `PIXEL_PACK_BUFFER` plus `fenceSync` async pattern, or skip D.
- **Segmentation fallback:** MediaPipe Tasks on iPad Safari's GPU delegate works with WebGL2. Check that its WASM and model files are hosted locally so the app needs no third-party CDN and works offline.

**Sources:**
- [qshiqshi/corridorkey-obs-filter](https://github.com/qshiqshi/corridorkey-obs-filter)
- [nikopueringer/CorridorKey](https://github.com/nikopueringer/CorridorKey) (LICENSE, `CorridorKeyModule/core/model_transformer.py`, `color_utils.py`, `inference_engine.py`)
- [nikopueringer/corridorkey-mlx](https://github.com/nikopueringer/corridorkey-mlx) (benchmark doc)
- [CorridorKeyWeb/CorridorKeyWeb.github.io](https://github.com/CorridorKeyWeb/CorridorKeyWeb.github.io)
- [alexandremendoncaalvaro/CorridorKey-Runtime](https://github.com/alexandremendoncaalvaro/CorridorKey-Runtime)
- [daniil-lyakhov/CorridorKeyOpenVINO](https://github.com/daniil-lyakhov/CorridorKeyOpenVINO)
- [ONNX Runtime Web README](https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/README.md)
- [ORT WebGPU announcement](https://opensource.microsoft.com/blog/2024/02/29/onnx-runtime-web-unleashes-generative-ai-in-the-browser-using-webgpu/)

Shallow clones (read only, never run) are in `/private/tmp/claude-501/-Users-md-Green-Screen-2/727545c3-c535-41ef-933d-42d65e406914/scratchpad/rt/` (`corridorkey-obs-filter`, `CorridorKey`, `ckweb`).