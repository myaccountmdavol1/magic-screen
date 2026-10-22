# Keyer quality harness

Scores the real keyer (`src/lib/keyer/Compositor.ts`) against generated clips with
exact ground-truth alpha, so every keyer change can be measured before it ships
(plan item 0 in `docs/research/corridorkey-lessons/plan-final.md`).

```sh
cd web
npm run harness -- --label baseline                   # all scenarios, helper off + on, + 720p timing
npm run harness -- --label try1 --compare baseline    # writes results/try1-vs-baseline.md too
npm run harness -- --label quick --only clean,specks --helper off --no-timing
npm run harness -- --label t --timing-only            # render() ms/frame at 1280x720 only
npm run fixtures -- --list                            # scenario ids
node e2e/fixtures/gen/preview.ts e2e/fixtures/out/hair-spill 30   # camera | GT alpha | GT fg PNG
```

Other options: `--helper off,on,force,synth`, `--frames N`, `--size 960x540`,
`--warmup 10`, `--cadence 2`, `--dump` (middle-frame matte + composite PNGs in
`results/<label>/`), `--headed`, `--port 5230` (never 5190, the preview server).

## How it works

1. **Fixtures** (`e2e/fixtures/gen/`, Node ≥ 22.18 runs the TypeScript directly, no
   deps). Each scenario renders a procedural child (or a teacher) with anti-aliased SDF
   layers, sub-pixel hair strands and 8-sub-frame motion blur, composited in linear
   light as `I = P + (1 − A)·B` (`P` premultiplied colour, `A` coverage, `B` backing).
   Then a camera model: white balance/exposure drift, flicker, Poisson–Gaussian noise,
   piecewise sRGB, BT.601 full-range 4:2:0, optional 8×8 DCT blocks. Outputs go to
   `e2e/fixtures/out/<id>/` (gitignored, cached by a hash of the sources + options):
   `cam.y4m`, `alpha.u8.gz` (GT alpha bytes), `fg.rgb.gz` (GT straight foreground,
   camera-referred, no spill/noise), `meta.json`.
2. **Page** (`page/`): built once per run with Vite (production mode, into
   `node_modules/.keyer-harness/`) and served by a tiny static server; it decodes the Y4M into a canvas and feeds the
   canvas to a fresh `Compositor` at **30 fps real time** (so the ML fade, drift sampling
   and helper cadence behave as on a device). Frame 0 runs the app's auto decision
   (`sampleBorderColor()`: screen found → chroma with that key, else AI cutout). After
   each `render()` it reads the matte (`Compositor.debugReadMatte()`, no re-keying) and
   the stage composite (over flat grey 128). Scoring happens after the clip.
3. **Runner** (`run.ts`): generates fixtures, builds + serves the page (no dev server,
   so nothing can hot-reload the page mid-run), drives
   Playwright Chromium (real GPU: ANGLE/Metal on macOS), writes
   `results/<label>.json` + `.md`.

Helper variants: `off` chroma only · `on` real MediaPipe Magic Helper every 2nd frame,
"auto" setting (core fill only after the shirt signal) · `force` helper "on" setting
(core fill always) · `synth` helper "on" setting fed a deterministic GT-derived mask
(256 px, blurred, one frame late) instead of MediaPipe: an upper bound for the helper
path that does not depend on how MediaPipe sees cartoon people (it misses most of the
green-shirt torso, for example). The `classroom` scenario has no screen, so it always runs
the AI cutout (segment) path with MediaPipe whatever the variant.

## Metrics (lower is better)

| metric | definition |
|---|---|
| SAD | Σ\|α − g\| / 1000 per frame |
| SAD edge | SAD inside the GT edge band (±H/60 px around transitions) |
| MSE | mean (α − g)², ×1e3 |
| Grad | Σ(\|∇α\| − \|∇g\|)² / 1000, Gaussian-derivative σ = 1.4 (Rhemann et al. 2009) |
| Conn | connectivity error, thresholds step 0.1, 8-connected (Rhemann et al. 2009) |
| FP bg | mean α where g = 0 (background showing through), ×1e3 |
| FN fg | mean 1 − α where g = 1 (child lost), ×1e3 |
| Flicker | mean \|α_t − α_{t−1}\| where the GT did not change, ×1e3 |
| Spill | mean excess of the key channel over max(other two) in the composite beyond the GT composite's, in GT-opaque pixels next to the edge, ×1e3 |
| Unmix ΔE | mean CIE76 ΔE of composite vs GT composite where 0 < g < 1 (does the soft edge carry the child's colour?) |

The GT composite is blended in the same sRGB-byte space the stage blends in, so
Unmix ΔE measures the keyer's α and colour, not the blend space.

Timing: `cpu` = main-thread time in `render()`, `gpu` = `EXT_disjoint_timer_query_webgl2`
time of the frame, `sync` = `render()` + 1 px `readPixels` (upper bound). The server
sets COOP/COEP so `performance.now()` is fine-grained.

## Gating a change

Run `--label <name> --compare baseline`. Keep a change only if its target scenarios
improve (or stay equal) and no other scenario regresses beyond noise. Runs are
deterministic on one machine (repeat runs matched to all printed digits); GPU and
browser differences between machines are not, so compare runs from the same machine.
