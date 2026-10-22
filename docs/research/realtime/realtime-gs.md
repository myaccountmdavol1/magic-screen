# erikbuck/RealTimeGreenScreen: findings

**Bottom line:** This repo is a 2012 teaching sample. Its whole keyer is one 4-line fragment shader, with no edge, spill or temporal handling. The keyer we already have in `/Users/md/Green Screen 2/web/src/lib/keyer/shaders.ts` is better in every way. There is only one idea worth taking: an optional alpha-gamma step (the `a³` trick, below), plus a cheap "green excess" measure to use as a second opinion. If we go native later, the code that matters here is the zero-copy camera path, not the keyer.

Sources:
- Repo: https://github.com/erikbuck/RealTimeGreenScreen
- Shallow clone (I read it, never ran it): `/private/tmp/claude-501/-Users-md-Green-Screen-2/727545c3-c535-41ef-933d-42d65e406914/scratchpad/rt/RealTimeGreenScreen`

## 1. What it does, technique, quality, license

- **Metadata (gh):** the description reads *"OBSOLETE: OpenGL shader based real-time green-screen video effect of iOS"*. It is Objective-C, has 36 stars, and was last pushed 2022-01-13. Code copyright is 2012. It is the sample code for the InformIT article *"Green-Screen Video Effects for iOS: Video Processing with OpenGL ES"* (http://www.informit.com/articles/article.aspx?p=1946398).
- **Stack:** OpenGL ES 2.0 and GLKit, both deprecated by Apple since iOS 12. Not Metal or CoreImage. Camera frames come from AVCaptureVideoDataOutput (`kCVPixelFormatType_32BGRA`). They reach the GPU with no copy through `CVOpenGLESTextureCacheCreateTextureFromImage`, are drawn over a still background image (`Elephant.jpg`), and are blended in fixed function with `glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA)`.
- **The full keying algorithm** (`GreenScreen/Shaders/greenScreen.fsh`):
  ```glsl
  lowp vec4 tempColor = texture2D(uVideoframe, vCoordinate);
  lowp float rbAverage = tempColor.r * 0.5 + tempColor.b * 0.5;
  lowp float gDelta = tempColor.g - rbAverage;
  tempColor.a = 1.0 - smoothstep(0.0, 0.25, gDelta);
  // "Use the cube of the transparency value ... avoiding almost but not quite
  //  opaque fragments that tend to form halos at color boundaries."
  tempColor.a = tempColor.a * tempColor.a * tempColor.a;
  gl_FragColor = tempColor;
  ```
  - It is a pure RGB "green excess" key, `g − (r+b)/2`.
  - Thresholds are hard-coded (0 to 0.25). There is no key-colour picking, no luma handling, no despill, no blur or choke of the matte, no temporal smoothing, and no premultiplied alpha.
- **Quality:** low.
  - Any green in the subject (shirts, green-tinted skin) turns transparent.
  - A green fringe stays on every edge, because the colour is never despilled.
  - Evenly lit, saturated green works. Anything else breaks.
  - `lowp` precision also causes banding in the ramp.
- **License:** MIT (`License`: "Copyright 2018 Erik M. Buck"; the shader headers say 2012). It is fully compatible with a free CC BY-NC-SA app. MIT only asks that we keep the copyright and permission notice if we copy code. These are three trivial lines of a well-known formula, so writing our own version needs no attribution. Adding a credit line anyway is harmless. There is no GPL involved.

## 2. Real-time feasibility in the browser

- There is no ML model, so no size, no ONNX/TFJS export, and nothing for WebGPU or WASM to run. It costs one texture fetch and a few ALU ops per pixel.
- It would run at full camera frame rate (30–60 fps at 1080p) on any iPad or phone in WebGL1/2 Safari. That is an estimate, I did not run it. Our current keyer is in the same cost range: CbCr distance plus a 3×3 blur, about 10 fetches per pixel. Neither is the bottleneck. The bottleneck is uploading the video frame (`texImage2D(video)`) and compositing.
- Two performance ideas carry over to the web:
  1. **Zero-copy upload.** The native `CVOpenGLESTextureCache` maps to `gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoEl)`, which Safari runs on the GPU path. On WebGPU (Safari 26+) the equivalent is `device.importExternalTexture({source: videoEl})`.
  2. **Drop late frames.** The native `setAlwaysDiscardsLateVideoFrames:YES` maps to driving rendering from `video.requestVideoFrameCallback`, rendering only the newest frame and never queuing. Safari has supported this since 15.4.

## 3. What to adopt

Do **not** replace our YCbCr keyer with this one. Ours already handles any key colour and adds despill and matte blur. Two small, optional pieces are worth adding.

**A. Alpha gamma / "crush" (generalised from `a³`).** Cubing alpha pushes semi-opaque edge pixels toward transparent, which cuts halos at the cost of thinner hair edges. Our smoothstep `lo/hi` pair already allows something similar. A separate gamma uniform gives a kid-friendly "Clean edges" slider without moving the thresholds:
```glsl
uniform float u_alphaGamma;   // 1.0 = off, 2.0–3.0 = Buck-style halo crush
// after: float a = smoothstep(u_lo, u_hi, dist); and after the 3x3 matte blur
a = pow(clamp(a, 0.0, 1.0), u_alphaGamma);
```
Apply it **after** the 3×3 blur. That way the blur feathers first and the gamma then chokes the soft fringe. Default it to around 1.5, or tie it to the existing auto-key confidence.

**B. Green excess as a second background signal (only when the key is green or blue).** `gDelta = g − (r+b)/2` is a different measure from CbCr distance. It is robust when the screen has bright highlights or dark folds that move luma a lot. Combining the two lowers false holes in skin while still keying uneven screens:
```glsl
// key-colour-agnostic generalisation: excess of the key's dominant channel
// u_keyAxis = vec3(-0.5, 1.0, -0.5) for green, vec3(-0.5, -0.5, 1.0) for blue
float excess = dot(rgb, u_keyAxis);                 // == g - (r+b)/2 for green
float aEx    = 1.0 - smoothstep(0.0, 0.25, excess); // Buck's ramp
float aCbCr  = smoothstep(u_lo, u_hi, dist);        // our existing alpha (1 = fg)
float a      = max(aCbCr, aEx);                     // fg if EITHER says fg -> fewer holes
// or min(...) for a more aggressive key; expose as internal constant, test both
```
- Use `mediump`/`highp`, not `lowp`. `lowp` on Apple GPUs is effectively 10-bit and bands.
- The matching despill is the Vlahos/"limit" form, `g' = min(g, max(r,b))` for green, or `min(g, (r+b)/2)` for a gentler result. Our `despill()` in `autoKey.ts` already covers this, so keep ours.

Pipeline position (unchanged apart from the two additions):
```
video → texImage2D → [key pass: CbCr dist ⊕ excess (B)] → [3x3 matte blur]
      → [alpha gamma (A)] → [despill] → premultiplied composite over background
```

**No temporal or edge techniques exist in this repo to adopt.** For temporal stability, the standard cheap option is an exponential moving average of the matte with a ping-pong texture. It is not from this repo:
```glsl
a = mix(texture(u_prevMatte, uv).r, a, u_temporal); // u_temporal ≈ 0.6
```
It needs a motion guard, for example only blending where `abs(lumaNow − lumaPrev) < 0.05`, to avoid ghosting.

**Later Capacitor shell (iOS native).** This repo's GLES code is a dead end there, because GLKit and OpenGL ES are deprecated. A modern native plugin would look like this:
- **Capture:** `AVCaptureVideoDataOutput` (BGRA or 420f) with `alwaysDiscardsLateVideoFrames = true`, the same pattern as `GSVideoProcessor.m` lines 296–301. Zero-copy into Metal via `CVMetalTextureCache`, which replaces `CVOpenGLESTextureCache`.
- **Segmentation:**
  - `VNGeneratePersonSegmentationRequest` (iOS 15+). Use `qualityLevel = .balanced` for video and `.fast` on older iPads. `outputPixelFormat = kCVPixelFormatType_OneComponent8` gives a low-resolution mask, which you then upscale.
  - `VNGeneratePersonInstanceMaskRequest` (iOS 17+) can separate several kids.
  - It runs on the Neural Engine at roughly 30 fps on A12 and later (estimate).
- **Hybrid matte (best quality):** `alpha = max(chromaAlpha, 0)` on the green screen, multiplied by a dilated Vision mask, i.e. `final = chromaAlpha * dilate(personMask)`. The person mask removes everything that is not a person (props, set edges, a green shirt does *not* get holed if you use `max(chromaAlpha, erode(personMask))`). Chroma keeps fine hair detail.
- **Compositing:** do it with CoreImage `CIBlendWithMask` or a Metal shader. Composite **natively** and show it in a native view behind a transparent WKWebView. Do not stream frames into the WebView: base64 or bridge transfer of 30 fps frames is far too slow.

## 4. Risks and unknowns

- **Obsolete code.** None of the Objective-C or GLES code is reusable as-is, in either the web app or a modern iOS app. Its value is educational only.
- **Hard-coded green.** `g − (r+b)/2` fails with blue screens, colour-cast lighting and green clothing. Use it only as a secondary signal (B), gated on hue.
- **Alpha gamma eats fine detail.** Above about 2.0 it erodes hair and motion-blurred hands. Kids move fast, so keep the default modest and test on real classroom footage.
- **`max()` combine can leave screen patches opaque.** Where green excess is weak (dark, desaturated corners of a cheap backdrop), `max()` may keep background visible. Testing is needed to choose between `max` and `min`.
- **Native path unknowns.**
  - Vision mask resolution is low and edges are soft, so it needs a guided upscale.
  - Neural Engine latency adds about one frame.
  - App Store review of a kids' app with camera use needs a privacy manifest and Kids Category rules (no third-party analytics).
  - Capacitor overlay layering (native view under the WebView) needs a custom plugin, and I am not aware of a maintained off-the-shelf one.
- **Image links will rot.** The README images are hosted on ptgmedia.pearsoncmg.com.