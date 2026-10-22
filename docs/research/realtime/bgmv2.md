# PeterL1n/BackgroundMattingV2 and RobustVideoMatting: can we use them for live green screen on iPad Safari?

**Short answer:**
- **Don't ship BGMv2 as a neural model.** Its one useful idea is the clean background plate, which we can do in GLSL.
- **RVM MobileNetV3 is the only real-time browser candidate.** Its official TF.js int8 model is about 3.7 MB, or 2.7 MB zipped. It would be an optional refinement stage at about 512x288. Our WebGL chroma keyer stays the main matte.
- **RVM is GPL-3.0, which is a real licensing problem for a CC BY-NC-SA app.** See section 1.
- **I found no published fps figure for RVM on an iPad or phone browser.** Every fps number below for iPad or phones is my own estimate and needs checking on a real device.

I read the code from shallow clones in `/private/tmp/claude-501/-Users-md-Green-Screen-2/727545c3-c535-41ef-933d-42d65e406914/scratchpad/rt/` (folders `bgmv2`, `rvm`, `rvm-tfjs`). I did not run any of it.

---

## 1. What they do, how good they are, and licenses

### BackgroundMattingV2 (BGMv2), CVPR 2021
- **Technique.** You give it two images: the frame and a clean photo of the same scene with nobody in it (the "plate"). A base network runs at 1/4 or 1/8 scale and predicts alpha, foreground residual, an error map and hidden features. A refiner then re-processes only the 4x4 patches where the error is highest, at full resolution. From `model/model.py`:
  ```python
  x = torch.cat([src, bgr], dim=1)        # 6-channel input: frame + clean plate
  pha = x[:, 0:1]; fgr = x[:, 1:4].add(src); err = x[:, 4:5]; hid = x[:, 5:]
  ```
- **Quality.** Very good hair detail at 4K, as long as the plate matches the frame exactly: same camera position, exposure and white balance.
- **Size and speed.** MobileNetV2 version: 5.0M params, 19.4 MB, 9.86 GMACs at HD (from the RVM paper, Table 3/4).
- **License.** MIT (`Copyright (c) 2020 University of Washington`). That works with any free app; it only needs attribution. The training datasets (VideoMatte240K, PhotoMatte85) are separate and their terms are unknown, which matters if anyone argues the weights are derived from them.
- **Release assets** (https://github.com/PeterL1n/BackgroundMattingV2/releases/tag/v1.0.0):
  - `onnx_mobilenetv2_hd.onnx`: 20,007,646 B
  - `onnx_mobilenetv2_4k.onnx`: 20,007,646 B
  - `pytorch_mobilenetv2.pth`: 20,307,935 B
  - `torchscript_mobilenetv2_fp16.pth`: 10,403,951 B
  - The ResNet versions are 80–237 MB.

### RobustVideoMatting (RVM), WACV 2022, the successor
- **Technique.** Needs no plate. It uses a MobileNetV3 encoder, an LR-ASPP module and a decoder with ConvGRU memory. The four recurrent states (r1–r4) are fed from each frame into the next, so the matte is stable over time. The network runs on a downscaled copy of the frame (`downsample_ratio`). A Deep Guided Filter then upsamples the result to full resolution. It outputs foreground and alpha.
- **Size and speed.** 3.749M params, 14.5 MB fp32. 4.15 GMACs at 1080p with ratio 0.25. On a GTX 1080 Ti: 104 fps at HD and 76 fps at 4K.
- **Quality.** Clearly better than BGMv2 and MODNet on hair, and temporally stable. It is trained to matte **humans**. Expect it to drop things kids hold (stuffed animals, cardboard props) or treat them as uncertain.
- **License: GPL-3.0** ("Code is re-released under GPL-3.0 license", Sep 16 2021). The weights come from the same repo, and the `tfjs` branch has no separate license.
  - **CC BY-NC-SA is not GPL-compatible**, because the NonCommercial term is an extra restriction. If we ship RVM's JS or weights in the PWA bundle, that counts as distributing them.
  - **Option A:** release the app's **code** under GPL-3.0. This fits a free, no-paywall, no-login app. Artwork, backgrounds and sounds can stay CC BY-NC-SA as separate works.
  - **Option B:** keep RVM out entirely and use a permissive model (see 3E).
  - Whether model weights are "code" under GPL is legally unsettled. The safe assumption is that they are covered.

**Exact RVM download URLs and sizes** (https://github.com/PeterL1n/RobustVideoMatting/releases/tag/v1.0.0):

| File | Bytes | Use |
|---|---|---|
| `rvm_mobilenetv3_tfjs_int8.zip` | 2,704,179 | **TF.js graph model.** The unzipped tfjs branch has `model/model.json` (626,575 B) and `group1-shard1of1.bin` (3,739,355 B), weights quantized to uint8, made with TF.js Converter v3.7.0 |
| `rvm_mobilenetv3_fp16.onnx` | 7,503,483 | onnxruntime-web WebGPU, if shader-f16 is available |
| `rvm_mobilenetv3_fp32.onnx` | 14,975,696 | onnxruntime-web WebGPU or wasm |
| `rvm_mobilenetv3_1280x720_s0.375_int8.mlmodel` | 3,902,475 | native iOS only (CoreML), useless in Safari |
| `rvm_resnet50_fp16.onnx` | 53,752,431 | too heavy for iPad |

All the ONNX files are opset 12.
- **Inputs:** `src [B,3,H,W]` in 0–1, `r1i..r4i` (start as zero tensors of shape `[1,1,1,1]`), `downsample_ratio` (fp32, shape `[1]`).
- **Outputs:** `fgr, pha, r1o..r4o`.

Official web demo: https://peterl1n.github.io/RobustVideoMatting/#/demo. Starter code is on the `tfjs` branch and uses `@tensorflow/tfjs@3.7.0`:
```js
const model = await tf.loadGraphModel('model/model.json');
let [r1i, r2i, r3i, r4i] = [tf.tensor(0.), tf.tensor(0.), tf.tensor(0.), tf.tensor(0.)];
const downsample_ratio = tf.tensor(0.5);
const [fgr, pha, r1o, r2o, r3o, r4o] = await model.executeAsync(
  {src, r1i, r2i, r3i, r4i, downsample_ratio}, ['fgr','pha','r1o','r2o','r3o','r4o']);
```

**GitHub release assets don't send CORS headers.** We must self-host the model under `/models/` in the PWA and cache it with the service worker, which also makes it work offline.

## 2. Will it run in real time on iPad Safari and phones?

**Resolution guidance** from `documentation/inference.md`: "Set `downsample_ratio` so that the downsampled resolution is between 256 and 512." For full-body shots, which is what kindergarten videos are, the doc says to use a *higher* ratio.

**What I recommend:**
- Feed RVM a **512x288** frame with `downsample_ratio = 1`. At ratio 1 the model skips its internal refiner (`if downsample_ratio != 1: ... self.refiner(...)`). We then do the upsampling to camera resolution ourselves in WebGL (section 3B).
- That makes the network cost roughly 4.15 GMACs x (512·288)/(480·270) ≈ **about 4–4.5 GMACs per frame**. This is my estimate. Almost all of RVM's compute is at the low resolution.

**Estimated fps (my estimates, nothing published; benchmark before relying on them):**

| Device and path | Estimate at 512x288 |
|---|---|
| iPad with M1/M2 or A15+, ORT-web **WebGPU** (Safari 26) | ~20–30 fps |
| Same device, TF.js **WebGL** backend (int8 weights are turned back to fp32 when loaded, so int8 doesn't speed up the GPU path) | ~15–25 fps |
| Older iPad (A12/A13, e.g. 8th–9th gen) | ~8–15 fps (WebGL) |
| Any device, **wasm SIMD** only | ~3–8 fps, not usable live |
| Mid-range Android phone, Chrome WebGPU | ~10–20 fps |

**Practical notes:**
- **Run the model every other frame and the keyer every frame.** The ConvGRU smooths things over time, so feeding RVM at 15 fps while the GLSL keyer composites at 30–60 fps with the latest alpha looks fine for kids.
- **Skip the starter's per-frame readback.** It does `await rgba.data()` and `putImageData` on every frame. Instead, read back only the 512x288 alpha: 147K floats, about 1 ms, done asynchronously. Upload it as an `R8` texture into our own WebGL2 context. Safari can't share textures between two WebGL contexts, so this small readback is the simplest reliable bridge. TF.js `dataToGPU()` only helps if our keyer runs inside TF.js's own GL context.
- **ORT-web:** use `executionProviders: ['webgpu', 'wasm']`. The fp16 model needs the `shader-f16` feature; check `adapter.features.has('shader-f16')` and fall back to fp32. The recurrent states start as `[1,1,1,1]` and then change to full feature-map shapes. ORT handles that, but expect the first 2–3 frames to be slow while shaders compile, so do a warm-up run.
- **Run inference in a Web Worker.** Use OffscreenCanvas plus `createImageBitmap(video)` so the UI never stutters.

**BGMv2 neural model in the browser: no.**
- It needs 9.86 GMACs.
- Its ONNX export relies on `roi_align` and `scatter_elements` for the patch refiner. The authors say: "we found it to be much slower than PyTorch/TorchScript."
- The ONNX files are fixed to HD or 4K input and weigh 20 MB.
- Exporting only the base network (6-channel input at about 480x270, with our own upsampling) would be possible and MIT-licensed. But it inherits BGMv2's weakest point, the plate (section 4).

**Can kids capture a clean plate?** The UX itself is easy: one big button, "Step out of the picture! 3-2-1 *snap*". It breaks when:
- the iPad is handheld or gets bumped;
- auto-exposure or white balance changes when a child walks in (iOS Safari gives no reliable way to lock exposure through `getUserMedia`);
- shadows move.

Fine for a teacher with the iPad on a stand; fragile for kids. So use the plate only as an optional **improvement for the chroma keyer** (3C), never as something the app depends on.

## 3. What to adopt

### A. Pipeline (chroma keyer stays primary; ML is an optional "Magic+" stage)
```
camera VideoFrame ──► [WebGL2 chroma key @ full res] ──► a_key (fine edges, keeps props)
        │
        └─(every Nth frame, 512x288)─► [Worker: RVM tfjs/ORT] ─► pha_lr (R8 texture)
                                                    │
               [guided upsample pha_lr with camera luma] ─► a_ml (full res)
                                                    │
      combine: garbage matte + core matte ─► final alpha ─► despill ─► composite
```
This combination is standard compositing practice:
- **Garbage matte.** Wherever the ML alpha is about 0 (classroom walls past the edge of the green cloth, a teacher's legs), remove it even though it isn't green.
- **Core matte.** Wherever the ML alpha is about 1 (a child in a green T-shirt), fill holes the keyer would cut.
- **Edges come from the chroma key**, which is sharper than ML at 512x288 and keeps props.

```glsl
// combine.frag (WebGL2)
uniform sampler2D uKeyAlpha, uMlAlpha, uSrc;
uniform float uMlWeight;      // 0 = ML off, 1 = full
in vec2 vUv; out vec4 o;
void main(){
  float ak = texture(uKeyAlpha, vUv).r;
  float am = texture(uMlAlpha,  vUv).r;
  float garbage = smoothstep(0.02, 0.25, am);     // ML says "definitely background" -> kill
  float core    = smoothstep(0.85, 0.98, am);     // ML says "definitely person"     -> fill
  float a = max(ak * garbage, core);
  o = vec4(vec3(mix(ak, a, uMlWeight)), 1.0);
}
```
For no-green-screen mode ("magic anywhere"), use `a = am` directly.

### B. Fast Guided Filter upsampling (taken from RVM's `model/fast_guided_filter.py`; the math is public, from He et al. 2015)
RVM's version:
```python
cov_xy = box(lr_x*lr_y) - mean_x*mean_y;  var_x = box(lr_x*lr_x) - mean_x*mean_x
A = cov_xy/(var_x+eps);  b = mean_y - A*mean_x
A,b = bilinear_up(A,b);  return A*hr_x + b
```
In GLSL this is 4 cheap passes at low resolution plus 1 full-resolution pass. Use `RGBA16F` render targets, which need `EXT_color_buffer_float` or `EXT_color_buffer_half_float`; both exist on iOS 15+ WebGL2. If they're missing, fall back to plain bilinear.
```glsl
// pass1 @512x288: pack guide I (luma of downscaled camera) and p (ML alpha)
float I = dot(texture(uSrcLR, vUv).rgb, vec3(0.299,0.587,0.114));
float p = texture(uMlAlpha, vUv).r;
o = vec4(I, p, I*I, I*p);
// pass2/3: separable box blur r=2 (5 taps) horizontally then vertically -> means
// pass4 @512x288: coefficients
vec4 m = texture(uMeans, vUv);           // (mI, mp, mII, mIp)
float varI = m.z - m.x*m.x, covIp = m.w - m.x*m.y;
float A = covIp / (varI + 1e-4);          // eps ~1e-4..1e-3 in 0..1 units
o = vec4(A, m.y - A*m.x, 0, 1);
// pass5 @full res (LINEAR sampling of coefficient texture = bilinear upsample)
vec2 Ab = texture(uAB, vUv).rg;
float Ihr = dot(texture(uSrc, vUv).rgb, vec3(0.299,0.587,0.114));
o = vec4(clamp(Ab.x*Ihr + Ab.y, 0.0, 1.0));
```
This gives sharp, edge-aligned alpha at camera resolution from a 512x288 prediction. **It can also improve our existing keyer:** our 3x3 matte blur could become a guided filter with the chroma alpha as `p`. That softens noise without blurring hair edges.

### C. BGMv2's plate idea, done without ML: a per-pixel key color
If a plate is captured, blur it (for example 9x9 at quarter resolution) and use **its CbCr value at each pixel** as the key color instead of one global key. This handles wrinkles, hot spots and lighting falloff on cheap classroom green cloth. We already compute the CbCr distance, so it's a small change:
```glsl
uniform sampler2D uPlateCbCr; uniform bool uHasPlate;
vec2 keyCbCr = uHasPlate ? texture(uPlateCbCr, vUv).rg : uKeyCbCr;
float d = distance(cbcr(src), keyCbCr);
// optional: difference matte gate — plate RGB vs frame RGB
float diff = length(src - texture(uPlateRGB, vUv).rgb);
float a = smoothstep(uSim, uSim + uSmooth, d);
a = uHasPlate ? max(a, smoothstep(0.25, 0.45, diff) * step(0.5, uDiffWeight)) : a;
```
Two safeguards:
- Automatically ignore the plate if the frame's average brightness drifts more than about 15% from the plate's, because exposure has changed.
- Show a "re-snap" sparkle button when that happens.

### D. Other things to copy from RVM
- **Keep the recurrent state, and reset it on any discontinuity.** Reset when the camera is switched, when the app returns from background, or when the resolution changes, by setting r1–r4 back to zero tensors. Without the reset, ghosting appears.
- **Use the predicted `fgr` as a despill fallback** on the ML-only path. It is the foreground with the background colour removed. On the chroma path our own despill is better.
- **Adapt `downsample_ratio` to the device.** Measure inference time over the first 30 frames and step 512x288 → 384x216 → 256x144 to stay above about 12 inference fps. If even that fails, turn ML off automatically. Kids never see a settings screen.

### E. Permissively licensed ML alternative (if GPL is a dealbreaker)
MediaPipe Selfie Segmentation / Image Segmenter is Apache-2.0, a few hundred KB, and very fast on iPad Safari through WebGL. It's not part of this repo, so it needs its own evaluation. Its edges are worse than RVM's, but for garbage and core mattes (3A) edge quality doesn't matter because the chroma key supplies the edges. That makes it a strong license-safe substitute in the same pipeline.

## 4. Risks and unknowns
1. **No measured iPad or phone fps exists for RVM.** Benchmark the TF.js WebGL and ORT WebGPU paths on our oldest target iPad before committing.
2. **GPL-3.0.** It conflicts with a CC BY-NC-SA code license. We need a decision: GPL-3.0 code, or MediaPipe / BGMv2-base instead.
3. **Safari WebGPU in ORT-web.** Watch for missing ops, `shader-f16` availability, shader compile stalls on first run, and memory pressure. iOS kills tabs above roughly 1–1.5 GB.
4. **TF.js 3.7 model age.** The graph model was converted with TF.js 3.7. It should load in tfjs 4.x, but I haven't verified that. Using the WebGL backend means a second GL context next to our keyer, which costs memory and makes Safari GPU contention possible.
5. **Training-data mismatch.** RVM was trained on adult humans. Small children, costumes, kids lying on the floor, and held props may be matted badly. This is why the ML stage must only gate the chroma matte, never replace it, in green-screen mode.
6. **Warm-up.** RVM's temporal state needs about 5–10 frames to settle. The first frames after starting or a reset flicker, so fade ML in over about 300 ms.
7. **Plate capture.** It's undermined by auto-exposure and white balance, a moving iPad, and shadows, and Safari offers no reliable exposure lock. Keep it optional and detect when it goes stale.
8. **Model weight in the PWA.** The 2.7 MB zipped model must be unzipped at build time and served from the same origin, because GitHub release URLs have no CORS headers. It should be precached so the app works offline, which matters for school Wi-Fi.
9. **BGMv2 dataset terms.** The terms on the datasets behind the weights are unknown. Check them only if we export BGMv2-base ourselves.

Sources:
- https://github.com/PeterL1n/RobustVideoMatting (README, `documentation/inference.md`, `model/model.py`, `model/fast_guided_filter.py`, `tfjs` branch `index.html`, release v1.0.0 asset sizes from the GitHub API)
- https://github.com/PeterL1n/BackgroundMattingV2 (README, LICENSE, `doc/model_usage.md`, `model/model.py`, release v1.0.0 assets)
- [RVM paper, arXiv 2108.11515](https://arxiv.org/html/2108.11515): Tables 3 and 4 for params, size, GMACs and fps; the FGF vs DGF statements
- [RVM web demo](https://peterl1n.github.io/RobustVideoMatting/#/demo)
- [onnxruntime-web README](https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.0/README.md) and [npm package](https://npmjs.com/package/onnxruntime-web)
- [ORT WebGPU EP notes](https://www.mintlify.com/microsoft/onnxruntime/execution-providers/webgpu)
- [VideoMatt CVPRW 2023](https://openaccess.thecvf.com/content/CVPR2023W/MobileAI/papers/Li_VideoMatt_A_Simple_Baseline_for_Accessible_Real-Time_Video_Matting_CVPRW_2023_paper.pdf)
- [HN: SHARP via ORT-web (mobile WebGPU caveats)](https://hn.svelte.dev/item/47995037)
- [awesome.ecosyste.ms RVM entry](https://awesome.ecosyste.ms/projects/github.com%2FPeterL1n%2FRobustVideoMatting)
- [Replicate RVM readme](https://replicate.com/arielreplicate/robust_video_matting/readme)