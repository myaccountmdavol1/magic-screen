# chromakey-video-react (anl331): findings for Magic Screen

Repo: https://github.com/anl331/chromakey-video-react (MIT, 6 stars, v0.1.1, last updated 2026-10-20). The playground is at https://chromakey-playground.vercel.app. I shallow-cloned it to `/private/tmp/claude-501/-Users-md-Green-Screen-2/727545c3-c535-41ef-933d-42d65e406914/scratchpad/rt/chromakey-video-react` and did not run any of its code. The whole library is one file, `src/index.tsx` (219 lines).

**Bottom line:** it is a small, naive WebGL1 RGB-dominance keyer for pre-recorded video. Our YCbCr keyer in `/Users/md/Green Screen 2/web/src/lib/keyer/` is already better at the math. A few small ideas are worth taking, and it has several bugs we should make sure our Compositor avoids.

---

## 1. What it does, technique, quality, license

**What it does:** a React component, `<ChromaKeyVideo src color similarity blend despill loop autoPlay className>`. It plays a hidden `<video>`, uploads each frame to a texture, and draws one full-screen quad with a fragment shader onto a transparent canvas. It works on video files only: no camera, no compositing, no recording.

**Technique:** it measures "channel dominance" in RGB. It does not use a colour-distance metric.
```glsl
// key channel = argmax(uKeyColor); avg = mean of the other two channels
float excess    = dominant - avg;
float dominance = excess / (dominant + 0.004);   // saturation-like ratio, brightness-invariant
float brightness = r + g + b;
float alpha = 1.0;
if (excess > 0.12 && brightness > 0.24) {         // hard gates
  if (dominance > uSimilarity) alpha = 0.0;
  else if (dominance > uSimilarity - uBlend)
    alpha = 1.0 - smoothstep(uSimilarity - uBlend, uSimilarity, dominance);
}
// despill: only on kept pixels
if (uDespill > 0.5 && alpha > 0.0 && excess > 0.06) {
  float strength = dominance > 0.15 ? 0.2 : 0.6;  // step function
  despilled = avg + excess * strength;            // pulls the dominant channel toward the AVERAGE
}
```
Defaults: `similarity 0.35`, `blend 0.15`, `color "#00ff00"`.

**Quality:** acceptable for clean, evenly lit, AI-generated green backgrounds (the author's use case). On a classroom camera feed it is weak:
- **Hard edges at the gates.** The two gates (`excess > 0.12`, `brightness > 0.24`) switch alpha straight from blended to 1, so edges can flicker and look stepped on noisy webcam input.
- **The key's hue is ignored.** Only the argmax channel of `color` is used, so `#00ff00`, `#40c040` and teal-green all key the same. A yellow-green or cyan screen keys poorly. It also keys any strongly green object: a green shirt with `dominance > 0.35` disappears.
- **Banding in the despill.** The despill strength jumps from 0.2 to 0.6 at `dominance = 0.15`.
- **Despill shifts warm colours.** Clamping toward the average desaturates yellows and skin toward grey-magenta. Our max-limit despill is the correct choice.
- **No matte filtering.** There is no blur, erode or temporal smoothing.

**License:** MIT. It is fully compatible with a free CC BY-NC-SA app. If we copy code, we only need to keep the MIT copyright and permission notice (for example in a THIRD_PARTY notices file). We would actually copy about 10 lines at most, so we may just re-implement the ideas, which needs no notice.

## 2. Real-time feasibility on iPad Safari and phones

- There is no ML model: 0 bytes, no ONNX/TFJS/WASM. It is one WebGL1 pass with 1 texture fetch per pixel. On any iPad or phone since about 2017 it is effectively free; 1080p at 60 fps is limited only by video decode and upload. Ours does 9 `keyAlpha` evaluations per pixel (the 3x3 tent), which is still comfortably 60 fps at 720p/1080p on A12 or newer.
- **Uploads every animation frame.** `texImage2D(..., video)` runs every `requestAnimationFrame`, even when no new frame has been decoded. `video.requestVideoFrameCallback` (Safari 15.4+) avoids redundant uploads, which saves battery on iPads.
- **Safari details:**
  - It uses `precision mediump float`, which is fp16 on iOS. That is fine for 8-bit colour, but our CbCr math with shadow gain should stay `highp` (it already does).
  - It sets `playsInline` and `muted`, which iOS needs for inline autoplay. Correct.
  - It sets `crossOrigin='anonymous'`, which is needed for remote videos.
- **No WebGPU path, and none is needed** for this class of shader.

## 3. What to adopt, and what to avoid

### Ideas worth adopting (small)

**A. Alpha-aware despill.** This is the one useful idea: despill harder where the pixel is an edge or semi-transparent, and gently where it is solid. Their version is a binary step; make it continuous and use our matte instead of their dominance value. Reuse our max-limit despill:
```glsl
uniform float u_spillEdgeBoost; // e.g. 1.0
vec3 despillA(vec3 c, float a) {
  float dom   = u_spillCh == 0 ? c.r : (u_spillCh == 1 ? c.g : c.b);
  float limit = u_spillCh == 0 ? max(c.g,c.b) : (u_spillCh == 1 ? max(c.r,c.b) : max(c.r,c.g));
  // edge factor: 1 at a=0.5, 0 at a=0 or 1
  float edge  = 1.0 - abs(a * 2.0 - 1.0);
  float k     = clamp(u_spill * (1.0 + u_spillEdgeBoost * edge), 0.0, 1.0);
  float excess = max(dom - limit, 0.0) * k;
  if (u_spillCh == 0) c.r -= excess; else if (u_spillCh == 1) c.g -= excess; else c.b -= excess;
  return c;
}
// in main(), chroma branch: compute `a` (the tent sum) FIRST, then rgb = despillA(center.rgb, a);
```
This needs reordering in `FG_FS`: right now `rgb = despill(center.rgb)` runs before `a` is computed. Mirror it in `autoKey.ts` (`despill(px, key, strength, alpha?)`) and add a test so the CPU and GPU versions stay in step.

**B. Dominance ratio as a cheap sanity check (optional).** `excess / (dominant + eps)` behaves like the HSV saturation of the key channel and ignores brightness. Our `MAX_SHADOW_GAIN` CbCr scaling already covers shadows, so I would not add it to the main path. A possible use is in `pickKeyColor` alongside `chroma/max < 0.3`. Those are nearly the same test, so this is low value.

**C. Small UX and integration patterns:**
- `onContextMenu={e => e.preventDefault()}` on the canvas. For kids on an iPad, also set CSS `-webkit-touch-callout: none; user-select: none;` so a long press doesn't open the iOS save-image sheet.
- `getContext(..., { alpha: true, premultipliedAlpha: false })` for straight-alpha output when the canvas sits over HTML backgrounds. Only use this if our Compositor outputs straight alpha to the page. If the Compositor draws the backgrounds itself, use `alpha: false`, which is faster and avoids the bug below.
- The README tip to offer magenta as a key colour when the subject wears green. Our autoKey rejects hues outside 70–270°, so magenta screens are currently impossible. Consider allowing manual override to any hue.

### Bugs to avoid in our Compositor

`web/src/lib/keyer/Compositor.ts` does not exist yet; `grep` found no WebGL context code in `web/src`. Check for each of these when it lands.

1. **Squared alpha from blending.** They call `gl.enable(BLEND); gl.blendFunc(SRC_ALPHA, ONE_MINUS_SRC_ALPHA)` onto a canvas cleared to (0,0,0,0) with `premultipliedAlpha:false`. The written alpha becomes `a*a`, so soft edges get thinner and darker than the matte says. Fix it either way:
   ```js
   gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
   // or output premultiplied: outColor = vec4(rgb * a, a); blendFunc(ONE, ONE_MINUS_SRC_ALPHA); premultipliedAlpha: true
   ```
2. **Full GL rebuild on every prop change.** Their `useEffect` deps are `[src, color, similarity, blend, despill, loop, autoPlay]`. Every slider tick creates a new GL context, program and `<video>`, deletes nothing, and never calls `WEBGL_lose_context`. Safari caps live WebGL contexts at about 16 and then drops the oldest, which shows up as black canvases. Their key-param updates also restart playback. **Our pattern:** create the context, programs and textures once in a mount-only effect. Keep params in a ref (or store) and set uniforms in the render loop. On unmount call `gl.getExtension('WEBGL_lose_context')?.loseContext()`.
3. **No error checks.** There is no `getShaderParameter` or `getProgramParameter` check, so failures are silent. We need it, plus a fallback to our Canvas2D `keyAlphaFast` path.
4. **No context-loss handling.** iPadOS drops GL contexts when backgrounded or under memory pressure. Handle `webglcontextlost` (call `preventDefault`) and `webglcontextrestored` (rebuild).
5. **Frame upload pacing.** Prefer:
   ```js
   const step = () => { upload(); draw(); handle = video.requestVideoFrameCallback(step); };
   if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) video.requestVideoFrameCallback(step); else rafLoop();
   ```
6. **No Y-flip or FLIP_Y mismatch.** They flip in the vertex shader (`1.0 - y`). We already document `v = 0 at top, no FLIP_Y`. Fine; just stay consistent.

### Side-by-side comparison

| | chromakey-video-react | Magic Screen keyer |
|---|---|---|
| GL | WebGL1, mediump | WebGL2 / GLSL 300 es, highp |
| Metric | RGB dominance ratio, key hue ignored | YCbCr distance from the key direction (along/perp), uses the key hue |
| Shadows | brightness ratio (implicit) | explicit `MAX_SHADOW_GAIN` CbCr scaling |
| Dark pixels | hard gate `brightness > 0.24` (discontinuous) | smooth `DARK_LO..DARK_HI` guard |
| Edge | single smoothstep plus hard gates | smoothstep plus 3x3 tent on the matte |
| Despill | toward the average, stepped 0.2/0.6 | toward max(other channels), uniform strength (adopt the alpha-aware boost) |
| Auto key | none (hex prop) | border sampling, hue cluster, median |
| CPU twin and tests | none | `autoKey.ts` plus tests, constants injected into GLSL |
| Lifecycle | rebuild per prop change, leaks | (to verify in Compositor) |

## 4. Risks and unknowns

- **It isn't a quality upgrade.** Nothing here improves hair or fine detail. Those need a refinement stage (guided filter or a light matting network such as RVM or MODNet, covered in the other repo reports), not this repo.
- **Unused claims.** "60fps" and "97%+ coverage" are README claims with no benchmarks. None of our design relies on them.
- **Early-stage project.** v0.1.1, 6 stars, single author, no tests. Don't take it as an npm dependency, because it adds React-version coupling and the bugs above. Re-implement the ideas.
- **The alpha-aware despill needs tuning.** A boost that is too strong turns edges magenta or grey on skin, so expose it carefully or fix it at about 0.5–1.0 and test on real classroom footage.
- **Squared-alpha risk carries over.** It applies to us if our Compositor uses `blendFunc(SRC_ALPHA, ONE_MINUS_SRC_ALPHA)` onto a transparent canvas, so verify that when `Compositor.ts` is written.

Files referenced:
- Clone: `/private/tmp/claude-501/-Users-md-Green-Screen-2/727545c3-c535-41ef-933d-42d65e406914/scratchpad/rt/chromakey-video-react/src/index.tsx`
- Ours: `/Users/md/Green Screen 2/web/src/lib/keyer/shaders.ts`, `/Users/md/Green Screen 2/web/src/lib/keyer/autoKey.ts`