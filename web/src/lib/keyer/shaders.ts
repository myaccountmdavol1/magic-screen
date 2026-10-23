// GLSL ES 3.00 sources for the Compositor. Constants are injected from
// labKey.ts / autoKey.ts so the LUT bake, the CPU fallback, the tests and the
// GPU path cannot drift apart. Pipeline (docs/research/realtime/recommendation.md):
//
//   camera ─► MATTE_FS (LUT key or ML mask, motion-guarded temporal EMA)  [camera res ≤ 1280w, ping-pong]
//          ─► GF_PACK_FS ─► BOX_FS ×2 ─► GF_COEF_FS ─► BOX_FS ×2           [half res, RGBA16F]
//             (guide = keyD + luma mix from the matte pass, not plain luma)
//   mask   ─► MASK_PREP_FS (garbage = dilated/slow decay, core = eroded)   [256 wide, ping-pong]
//   bg     ─► BLUR_DOWN_FS ─► BOX_FS ×2                                    [1/8 stage, light wrap]
//          ─► UNMIX_PREP_FS (chroma; F̂ donors + screen plate B̂, MRT)        [1/4 matte res, mipmapped]
//   FG_FS: FINAL_ALPHA (GF upsample or tent → ML fusion with trust → choke)
//          → blur-fusion unmix in the edge band → despill (backs off where unmixed) → light wrap
//
// All offscreen passes use PASS_VS, which maps texture row 0 to v = 0 (image top),
// the same convention as the camera upload (no FLIP_Y). So every camera-space
// texture is sampled with the same uv.
import { SPILL_EDGE } from './autoKey'
import { DARK_L_HI, DARK_L_LO, LUT_N, LUT_RANGE, L_WEIGHT, MAX_SHADOW_GAIN } from './labKey'
import { FLATTEN_GAIN_MAX, FLATTEN_GAIN_MIN } from './flatten'

const f = (n: number) => (Number.isInteger(n) ? `${n}.0` : `${n}`)

/** Tuning shared by the Compositor (uniform defaults). */
export const KEYER_TUNING = {
  /** EMA weight of the previous matte where the picture is still. */
  temporal: 0.5,
  /** Matte gamma after filtering; > 1 pulls edges in a little (kills green halos). */
  choke: 1.3,
  /** Light-wrap strength at inner edges. */
  wrap: 0.15,
  /** Guided filter regulariser (≈ 0.0245² in luma units). */
  gfEps: 6e-4,
  /** Garbage-matte dilation as a fraction of frame width (keeps held props). */
  dilate: 0.05,
} as const

/**
 * Keyer feature switches (1 = on). Defaults are what ships; the quality harness flips
 * them (Compositor.setKeyerFlags) to A/B a change in one build. Each was kept only if
 * the harness scored it better or equal (docs/research/corridorkey-lessons/plan-final.md).
 */
export interface KeyerFlags {
  /** item 1: mirrored edges on matte / guided-filter / mask-prep targets */
  mirrorEdges: number
  /** item 2: Magic Helper trust (mask age + motion + confidence) drives kill / fill / dilation */
  helperTrust: number
  /** item 3: foreground unmixing at the soft edge (blur-fusion with a local screen plate) */
  unmix: number
  /** item 3 harness only: 1 forces the SRGB8_ALPHA8 fallback targets instead of RGBA16F */
  unmixSrgb8: number
  /** item 3 harness only: colour-line alpha for the colour solve (-1 = UNMIX_TUNING.proj) */
  unmixProj: number
  /** harness only: overrides (-1 = default): UNMIX_TUNING.cap, despill edge boost kept where unmixed, choke */
  unmixCap: number
  unmixSpillKeep: number
  choke: number
  /** harness only: unmix prep taps override (1 or 4; -1 = UNMIX_TUNING.prepTaps) */
  unmixTaps: number
  /** item 4: remove small detached specks (tape, clips) with one box-sum pass */
  despeckle: number
  /** item 4: fill small enclosed screen-coloured holes (same box sum, own flag) */
  holeFill: number
  /** harness only: DS_TUNING overrides as fractions of the matte area (-1 = default) */
  dsMinArea: number
  dsMinHole: number
  /** item 5: motion-guarded EMA on the half-res guided-filter coefficients (and a lower full-res matte EMA) */
  gfTemporal: number
  /** harness only: GF_TEMPORAL_TUNING overrides (-1 = default) */
  gfCT: number
  gfMatteT: number
  /** harness only: motion guard upper edge (lo = hi / 4; -1 = GF_TEMPORAL_TUNING) */
  gfGuard: number
  /** item 6: vote the auto key by border cell (robustBorderKey); 0 = plain hue cluster */
  robustKey: number
  /** harness only: BORDER_KEY.inlierKL / inlierDE overrides (-1 = default) */
  bkKL: number
  bkDE: number
  /** item 7: screen flattening from the learned plate before the key lookup (1 = per-channel gain, 2 = luma-only gain, 3 = per-channel, brighten only) */
  flatten: number
  /** harness only: plate mip level the gain is read from (-1 = FLATTEN_TUNING.lod) */
  flattenLod: number
  /** item 7: hue-matching pixels at any brightness may teach the plate where a trusted Helper says "background" */
  flattenHelperDonors: number
  /** P2 item 16: blend the colour-line (projection) alpha into the edge band, strength 0..1 */
  projAlpha: number
  /** P2 item 16 harness: 1 = also in key-opaque pixels next to the edge (meanP < 1), 0 = soft band only */
  projAlphaWide: number
  /** P2 item 16: taper the alpha lowering where the key is nearly opaque (0..1) */
  projTaper: number
  /** P2 item 12: 16-bit (RGBA16F) matte history when float targets work */
  matte16: number
  /** P2 item 12: ratio-based (log2) luma motion guard, catches dark hair over dark areas */
  ratioGuard: number
}

export const KEYER_FLAGS: KeyerFlags = {
  mirrorEdges: 1,
  // Off: no harness scenario improved (all equal) and a 6-frame-late mask on the
  // green shirt lost fill (SAD 7.87 -> 8.79). Needs a ghost scenario (fast arm + core
  // fill) to be gated properly; the tracker still runs, so turning it on is one flag.
  helperTrust: 0,
  unmix: 1,
  unmixSrgb8: 0,
  unmixProj: -1,
  unmixCap: -1,
  unmixSpillKeep: -1,
  choke: -1,
  unmixTaps: -1,
  despeckle: 1,
  holeFill: 0,
  dsMinArea: -1,
  dsMinHole: -1,
  // Off: flicker fell 3-5 % but Ghost rose 0.4-0.7 % on every scenario (motion-blur
  // 14.22 -> 14.32) instead of the plan's -30 % target; the full-res matte EMA turned
  // out not to be what causes trails (its own motion guard already stops them).
  gfTemporal: 0,
  gfCT: -1,
  gfMatteT: -1,
  gfGuard: -1,
  robustKey: 1,
  bkKL: -1,
  bkDE: -1,
  // Off (M3 gate failed, plan wanted >= 15 %): per-channel gain (1) and luma gain (2)
  // made hotspot scenes worse (uneven-light FP bg +20 %, Ghost +32 %: edges in the
  // hotspot went more opaque). Brighten-only (3) helped deep-shadow only (SAD -2.2 %,
  // Ghost -6 %, FN fg +0.7 %) for ~0.07 ms GPU. Helper donors changed nothing: the raw
  // key already accepts the shadowed sheet (keyD shadow normalisation).
  flatten: 0,
  flattenLod: -1,
  flattenHelperDonors: 0,
  // On: SAD -8..-25 %, Grad, FP bg, FN fg and Flicker down on every chroma scenario
  // (m3-pa075t2 vs m3-base2). Strength 1 scored SAD a few % better but raised Colour ΔE
  // (closeup +9.6 %) and hair-strand islands more. Taper 1: without it an opaque rim lit
  // by spill lost alpha (FN fg +10 % on hair-spill, +5 % on deep-shadow).
  projAlpha: 0.75,
  projAlphaWide: 0,
  projTaper: 1,
  // Off: 16-bit history moved Flicker -0.8 % and nothing else beyond noise (FN fg
  // +0.6 % on blue-screen); the ratio guard changed nothing (no dark-on-dark motion in
  // the fixtures). Both are one flag away once a scenario needs them.
  matte16: 0,
  ratioGuard: 0,
}

/** Screen flattening (item 7). Gain clamps live in flatten.ts (CPU mirror + tests). */
export const FLATTEN_TUNING = {
  /** plate mip level the gain is read from (+ a quarter of the next level); 1/4 matte res is level 0 */
  lod: 2,
  /** plate confidence (premultiplied weight) ramp: below lo no flattening, above hi full */
  confLo: 0.05,
  confHi: 0.3,
}

/**
 * Item 5: temporal smoothing moves from the full-res matte to the guided-filter
 * coefficients (A, b, mean_p). α = A·guide + b is still evaluated with the current
 * frame's guide, so interiors steady while edges follow the picture.
 */
export const GF_TEMPORAL_TUNING = {
  /** EMA weight of the previous coefficients where the blurred guide is still */
  cTemporal: 0.5,
  /**
   * full-res matte EMA while the coefficient EMA runs (KEYER_TUNING.temporal
   * otherwise). The plan's 0.25 scored no better on Ghost than 0.5 and flickered more.
   */
  matteTemporal: 0.5,
  /** blurred-guide change that counts as motion: ramp lo..hi (0.01..0.04 ghosted more) */
  guardLo: 0.00375,
  guardHi: 0.015,
}

/**
 * Speck removal + hole fill (item 4). One separable box mean over 17x17 cells of
 * 4x4 matte px (a 68 px window at full matte res) measures, around every pixel, how
 * much child (r) and how much screen (g) there is. An isolated speck's child mass is
 * just its own area, so small far-away blobs fade out while anything near the child
 * keeps its big window total (the window doubles as the safe zone). Off-frame taps
 * count as empty child and open screen, never mirrored (an edge speck must not count
 * double; a screen sliver at the frame edge must not be "filled").
 */
export const DS_TUNING = {
  /** blobs smaller than this (fraction of the matte area) go; half of it fully */
  minArea: 2e-3,
  /** enclosed screen holes smaller than this are filled (fraction of the matte area) */
  minHole: 1e-4,
}
/** matte px represented by one unit of the 17x17-cell mean of 4x4-px cells */
export const DS_CELL_PX = 16 * 289

/** Trust ramps for the Magic Helper fusion (item 2): fill and kill fade between lo and hi. */
export const TRUST_RAMP = {
  fillLo: 0.3,
  fillHi: 0.7,
  killLo: 0.1,
  killHi: 0.4,
}

/** Foreground unmixing tuning (item 3). */
export const UNMIX_TUNING = {
  /** plate learn rate per camera frame where the screen is clearly visible */
  plateRate: 0.1,
  /** plate confidence decay per camera frame where the screen is hidden */
  plateDecay: 0.995,
  /** max length of the blur-fusion correction (linear RGB); 0.2 beat 0.35 / 0.6 on spill */
  cap: 0.2,
  /** overall strength (1 = replace the edge colour with the unmixed one) */
  strength: 1,
  /**
   * Solve F with the colour-line alpha (projection of I onto the F̂–B̂ line) instead of
   * the key's alpha. The key alpha runs ~0.17 too opaque in the soft band (harness:
   * mean a − g), which leaves screen colour in "opaque" edge pixels; the colour solve
   * needs the real mixing fraction. Blend alpha is unchanged. 0 = key alpha.
   */
  proj: 1,
  /**
   * Share of the despill edge boost kept where the colour was unmixed (0 = back off
   * fully, as the plan proposed). The harness scored no back-off (1) best: Unmix ΔE and
   * spill were lower on every chroma scenario than with 0 or 0.5, because despill on the
   * unmixed colour still removes the spill light on the child's own rim.
   */
  spillKeep: 1,
  /**
   * Prep taps per texel (4 or 1). 1 tap saves ~0.14 ms GPU at 720p (M5 Pro) but
   * scored Unmix ΔE 0.1-0.4 worse and made yellow-shirt worse than no unmixing.
   */
  prepTaps: 4,
}

/**
 * AI cutout (segment mode, no green screen) tuning. The ML confidence is the matte;
 * a colour-guided filter snaps its edge to the real head/shoulder boundary (a luma
 * guide can't see a skin-toned head on a beige wall). Values picked with the keyer
 * harness (webcam-beige + classroom scenarios); see docs/research/corridorkey-lessons.
 */
export interface SegTuning {
  /** confidence ramp before filtering: centre and half width (0.5 = linear-ish) */
  preCenter: number
  preHalf: number
  /** 1 = colour-guided filter (RGB guide), 0 = the luma guided filter shared with chroma */
  colorGF: number
  /** colour GF working width in px (coefficients are upsampled, edges come from full-res colour) */
  gfW: number
  /** colour GF box radius, in working px */
  gfRadius: number
  /** colour GF regulariser (colour variance units, 0..1 RGB) */
  gfEps: number
  /** ramp after filtering: centre and half width (snaps the soft edge; centre > 0.5 erodes) */
  postCenter: number
  postHalf: number
  /** matte gamma after the ramp (the Outline control scales it like the chroma choke) */
  choke: number
  /** temporal EMA weight on still pixels (motion-guarded) */
  temporal: number
  /** light wrap strength (no screen colour to hide, so off by default) */
  wrap: number
}

export const SEG_TUNING: SegTuning = {
  preCenter: 0.5,
  preHalf: 0.12,
  colorGF: 1,
  gfW: 320,
  gfRadius: 8,
  gfEps: 4e-4,
  postCenter: 0.55,
  postHalf: 0.3,
  choke: 1.3,
  temporal: 0.7,
  wrap: 0,
}

/**
 * One vertex shader for every stage layer. a_pos is a unit quad (0..1). The quad
 * is placed in stage pixels (center, size, rotation) so cover-fit backgrounds,
 * the transformed "Me" layer and rotated stickers all share it.
 * v_uv has v = 0 at the top because textures are uploaded without FLIP_Y.
 */
export const QUAD_VS = /* glsl */ `#version 300 es
in vec2 a_pos;
uniform vec2 u_stage;   // target size in px
uniform vec2 u_center;  // quad center in px (y down)
uniform vec2 u_size;    // quad size in px
uniform float u_rot;    // radians, clockwise on screen (matches CSS rotate)
out vec2 v_uv;
void main() {
  vec2 local = (a_pos - 0.5) * u_size;
  float c = cos(u_rot);
  float s = sin(u_rot);
  vec2 p = u_center + vec2(local.x * c - local.y * s, local.x * s + local.y * c);
  vec2 clip = vec2(p.x / u_stage.x * 2.0 - 1.0, 1.0 - p.y / u_stage.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  v_uv = a_pos;
}
`

/** Full-target pass. Row 0 of the target = v 0 = image top (same as uploads). */
export const PASS_VS = /* glsl */ `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos;
  gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0);
}
`

/** Plain textured quad with straight alpha (backgrounds, stickers). */
export const IMAGE_FS = /* glsl */ `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_tex;
out vec4 outColor;
void main() {
  outColor = texture(u_tex, v_uv);
}
`

/**
 * P2 item 11: "check the key" backdrop for grown-ups. A neutral grey checker (48 px,
 * 0.70 / 0.45) shows holes and soft fringes; one saturated magenta band shows green
 * edges that a grey backdrop would hide. Our own values (clean room).
 */
export const CHECKER_FS = /* glsl */ `#version 300 es
precision mediump float;
uniform vec2 u_stage;
out vec4 o;
void main() {
  vec2 p = vec2(gl_FragCoord.x, u_stage.y - gl_FragCoord.y);
  float band = step(0.40, p.y / u_stage.y) * step(p.y / u_stage.y, 0.52);
  vec2 cell = floor(p / 48.0);
  float g = mod(cell.x + cell.y, 2.0) < 0.5 ? 0.70 : 0.45;
  o = vec4(mix(vec3(g), vec3(0.85, 0.15, 0.75), band), 1.0);
}
`

/** Mode ids passed as u_mode. Keep in sync with Compositor.ts. */
export const MODE_IDS = { chroma: 0, segment: 1, packed: 2, alpha: 3, none: 4 } as const

/** Analytic keyD (debug / fallback when the 3D LUT can't be created). Mirrors labKey.ts. */
const ANALYTIC_KEY_GLSL = /* glsl */ `
uniform vec3 u_keyLab;
uniform vec2 u_keyDirAB;
uniform float u_keyC;
vec3 srgbToLinear(vec3 c) {
  vec3 lo = c / 12.92;
  vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(hi, lo, vec3(lessThanEqual(c, vec3(0.04045))));
}
const mat3 RGB2XYZN = mat3(
  0.433953, 0.2126729, 0.017757,
  0.376214, 0.7151522, 0.109468,
  0.189842, 0.072175, 0.872775);
vec3 labF(vec3 t) {
  vec3 cbrt = pow(max(t, vec3(1e-6)), vec3(1.0 / 3.0));
  return mix((903.2963 * t + 16.0) / 116.0, cbrt, vec3(greaterThan(t, vec3(0.008856452))));
}
vec2 keyDistAndGuard(vec3 srgb) {
  vec3 fv = labF(RGB2XYZN * srgbToLinear(srgb));
  vec3 lab = vec3(116.0 * fv.y - 16.0, 500.0 * (fv.x - fv.y), 200.0 * (fv.y - fv.z));
  float g = clamp(u_keyLab.x / max(lab.x, 1.0), 1.0, ${f(MAX_SHADOW_GAIN)});
  vec2 ab = lab.yz * g;
  float along = dot(ab, u_keyDirAB);
  float perp = length(ab - along * u_keyDirAB);
  float shortfall = max(u_keyC - along, 0.0);
  float over = max(lab.x * g - u_keyLab.x, 0.0) * ${f(L_WEIGHT)};
  return vec2(length(vec3(shortfall, perp, over)), 1.0 - smoothstep(${f(DARK_L_LO)}, ${f(DARK_L_HI)}, lab.x));
}
`

/**
 * Matte pass: raw alpha (r), guided-filter guide (g), and a denoised luma (b)
 * and screen distance (a) for the next frame's motion test. Camera space, never
 * mirrored.
 * u_src 0 = chroma key (LUT or analytic), 1 = ML mask (segment mode).
 * Temporal EMA only where the picture barely changed, so still parts stop
 * flickering and moving kids never ghost. The motion test runs on a 3x3-weighted
 * average (two bilinear taps): on a noisy low-light camera, per-pixel sensor
 * noise alone used to look like motion and switched the EMA off exactly where
 * the matte flickers most. Alpha itself stays per-pixel sharp.
 */
export function matteFs(analytic: boolean): string {
  return /* glsl */ `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_fg;
uniform sampler2D u_mask;
uniform sampler2D u_prev;
uniform sampler3D u_keyLut;
uniform int u_src;
uniform bool u_hasMask;
uniform bool u_hasPrev;
uniform float u_lo;
uniform float u_hi;
uniform float u_temporal;
uniform vec2 u_ftexel; // 1 / camera texture size
uniform bool u_ratioGuard; // P2 item 12: relative (log2) luma change counts as motion too
uniform float u_segLo; // ML confidence ramp (segment mode); moved by the Outline control
uniform float u_segHi;
// Item 7: screen flattening. u_plate = the unmix screen plate (linear B·conf, conf),
// mipmapped, from the previous camera frame (the screen does not move).
uniform sampler2D u_plate;
uniform bool u_hasPlate;
uniform float u_flatten;   // 0 off, 1 per-channel gain, 2 luma-only gain, 3 per-channel brighten-only
uniform float u_plateLod;
uniform vec3 u_keyLin;     // key colour, linear RGB
const float LUT_N = ${f(LUT_N)};
const float LUT_RANGE = ${f(LUT_RANGE)};
const vec3 LUMA = vec3(0.299, 0.587, 0.114);
${analytic ? ANALYTIC_KEY_GLSL : ''}
${COLOR_GLSL}
// Gain (linear) that moves the local screen plate onto the key colour; 1 where the
// plate is unknown. Used only for the key lookup (shown colour stays raw).
vec3 flattenGain() {
  vec4 s = textureLod(u_plate, v_uv, u_plateLod) + 0.25 * textureLod(u_plate, v_uv, u_plateLod + 1.0);
  float conf = smoothstep(${f(FLATTEN_TUNING.confLo)}, ${f(FLATTEN_TUNING.confHi)}, s.a * 0.8);
  vec3 plate = s.rgb / max(s.a, 1e-4);
  vec3 g = u_flatten > 1.5
    ? vec3(dot(u_keyLin, vec3(0.2126, 0.7152, 0.0722)) / max(dot(plate, vec3(0.2126, 0.7152, 0.0722)), 1e-3))
    : u_keyLin / max(plate, vec3(1e-3));
  // mode 3: shadows only (never darken), so hotspots are left to the key's own L guard
  g = clamp(g, vec3(u_flatten > 2.5 ? 1.0 : ${f(FLATTEN_GAIN_MIN)}), vec3(${f(FLATTEN_GAIN_MAX)}));
  return mix(vec3(1.0), g, conf);
}
// (keyD in ΔE units, dark guard)
vec2 keyLookup(vec3 c) {
${
  analytic
    ? '  return keyDistAndGuard(c);'
    : '  vec2 k = texture(u_keyLut, c * ((LUT_N - 1.0) / LUT_N) + 0.5 / LUT_N).rg;\n  return vec2(k.r * LUT_RANGE, k.g);'
}
}
void main() {
  vec3 c = texture(u_fg, v_uv).rgb;
  vec3 cs = 0.5 * (texture(u_fg, v_uv + 0.5 * u_ftexel).rgb + texture(u_fg, v_uv - 0.5 * u_ftexel).rgb);
  float y = dot(c, LUMA);
  float ys = dot(cs, LUMA);
  float a;
  float guide;
  float ks; // denoised "how un-screen-like" (0..1), motion test only
  if (u_src == 0) {
    if (u_hasPlate && u_flatten > 0.0) {
      vec3 g = flattenGain();
      c = linToSrgb(srgbToLin(c) * g);
      cs = linToSrgb(srgbToLin(cs) * g);
    }
    vec2 k = keyLookup(c);
    a = max(smoothstep(u_lo, u_hi, k.x), k.y);
    // Guided-filter guide: mostly "how un-screen-like", plus some luma. A pure
    // luma guide can't see edges between the screen and colours of the same
    // brightness (a red shirt on green), so the filter would smear them.
    guide = 0.65 * clamp(k.x / 24.0, 0.0, 1.0) + 0.35 * y;
    ks = clamp(keyLookup(cs).x / 24.0, 0.0, 1.0);
  } else {
    a = u_hasMask ? smoothstep(u_segLo, u_segHi, texture(u_mask, v_uv).r) : 1.0;
    guide = y;
    ks = ys;
  }
  if (u_hasPrev && u_temporal > 0.0) {
    vec4 p = texture(u_prev, v_uv); // (alpha, guide, denoised luma, denoised key)
    // Motion = luma OR screen distance changed, so same-brightness colour changes count too.
    float d = max(abs(ys - p.b), 0.65 * abs(ks - p.a));
    // Dark hair moving over a dark area changes luma by a small absolute but a large
    // relative amount: map a doubling to the same motion as a 0.1 absolute step.
    if (u_ratioGuard) d = max(d, 0.1 * abs(log2((ys + 0.02) / (p.b + 0.02))));
    a = mix(a, p.r, u_temporal * (1.0 - smoothstep(0.02, 0.10, d)));
  }
  o = vec4(a, guide, ys, ks);
}
`
}

/**
 * Guided filter, step 1 (half res; LINEAR sampling of the matte = 2x2 average).
 * Values are centred on 0.5 so the I² and I·p products keep precision in fp16.
 */
export const GF_PACK_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_matte;
void main() {
  vec2 m = texture(u_matte, v_uv).rg - 0.5;
  float p = m.r;
  float I = m.g;
  o = vec4(I, p, I * I, I * p);
}
`

/** Separable box filter, radius 4 (run horizontally, then vertically). */
export const BOX_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_src;
uniform vec2 u_step;
void main() {
  vec4 s = vec4(0.0);
  for (int i = -4; i <= 4; i++) s += texture(u_src, v_uv + float(i) * u_step);
  o = s / 9.0;
}
`

/**
 * Colour guided filter (He et al., RGB guide), step 1, at the GF working size.
 * Four outputs (MRT) hold the 13 products the filter needs, centred on 0.5 so the
 * squares keep precision in fp16. Guide = camera colour (4 bilinear taps, a small
 * box so decimation doesn't alias); p = the segment matte.
 */
export const CGF_PACK_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
layout(location = 3) out vec4 o3;
uniform sampler2D u_fg;
uniform sampler2D u_matte;
uniform vec2 u_otexel; // 1 / GF working size
void main() {
  vec2 d = 0.25 * u_otexel;
  vec3 I = 0.25 * (texture(u_fg, v_uv + vec2(-d.x, -d.y)).rgb + texture(u_fg, v_uv + vec2(d.x, -d.y)).rgb
                 + texture(u_fg, v_uv + vec2(-d.x, d.y)).rgb + texture(u_fg, v_uv + vec2(d.x, d.y)).rgb) - 0.5;
  float p = texture(u_matte, v_uv).r - 0.5;
  o0 = vec4(I, p);
  o1 = vec4(I.r * I.r, I.r * I.g, I.r * I.b, I.g * I.g);
  o2 = vec4(I.g * I.b, I.b * I.b, I.r * p, I.g * p);
  o3 = vec4(I.b * p, 0.0, 0.0, 1.0);
}
`

/** Separable box filter over four MRT inputs at once; radius from a uniform. */
export const BOX4_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
layout(location = 3) out vec4 o3;
uniform sampler2D u_s0;
uniform sampler2D u_s1;
uniform sampler2D u_s2;
uniform sampler2D u_s3;
uniform vec2 u_step;
uniform int u_radius;
void main() {
  vec4 a = vec4(0.0), b = vec4(0.0), c = vec4(0.0), e = vec4(0.0);
  for (int i = -u_radius; i <= u_radius; i++) {
    vec2 uv = v_uv + float(i) * u_step;
    a += texture(u_s0, uv);
    b += texture(u_s1, uv);
    c += texture(u_s2, uv);
    e += texture(u_s3, uv);
  }
  float n = float(2 * u_radius + 1);
  o0 = a / n;
  o1 = b / n;
  o2 = c / n;
  o3 = e / n;
}
`

/** Single-target separable box filter with a uniform radius. */
export const BOXR_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_src;
uniform vec2 u_step;
uniform int u_radius;
void main() {
  vec4 s = vec4(0.0);
  for (int i = -u_radius; i <= u_radius; i++) s += texture(u_src, v_uv + float(i) * u_step);
  o = s / float(2 * u_radius + 1);
}
`

/**
 * Colour guided filter coefficients: a = (Σ_I + εU)⁻¹ cov(I, p), b = mean_p − a·mean_I
 * (centred values). Output (a.rgb, b); the final pass evaluates a·I + b with the
 * full-resolution camera colour, so the edge lands on real colour boundaries.
 */
export const CGF_COEF_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_m0;
uniform sampler2D u_m1;
uniform sampler2D u_m2;
uniform sampler2D u_m3;
uniform float u_eps;
void main() {
  vec4 m0 = texture(u_m0, v_uv); // mean I.rgb, mean p
  vec4 m1 = texture(u_m1, v_uv); // rr rg rb gg
  vec4 m2 = texture(u_m2, v_uv); // gb bb rp gp
  float bp = texture(u_m3, v_uv).r;
  vec3 mI = m0.rgb;
  float mp = m0.a;
  float rr = m1.x - mI.r * mI.r + u_eps;
  float rg = m1.y - mI.r * mI.g;
  float rb = m1.z - mI.r * mI.b;
  float gg = m1.w - mI.g * mI.g + u_eps;
  float gb = m2.x - mI.g * mI.b;
  float bb = m2.y - mI.b * mI.b + u_eps;
  vec3 cov = vec3(m2.z - mI.r * mp, m2.w - mI.g * mp, bp - mI.b * mp);
  // symmetric 3x3 inverse via cofactors
  float c00 = gg * bb - gb * gb;
  float c01 = rb * gb - rg * bb;
  float c02 = rg * gb - rb * gg;
  float c11 = rr * bb - rb * rb;
  float c12 = rb * rg - rr * gb;
  float c22 = rr * gg - rg * rg;
  float det = rr * c00 + rg * c01 + rb * c02;
  vec3 a = vec3(c00 * cov.x + c01 * cov.y + c02 * cov.z,
                c01 * cov.x + c11 * cov.y + c12 * cov.z,
                c02 * cov.x + c12 * cov.y + c22 * cov.z) / max(det, 1e-12);
  o = vec4(a, mp - dot(a, mI));
}
`

/** Guided filter coefficients: (A, b, mean_p) with centred values. */
export const GF_COEF_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_means;
uniform float u_eps;
void main() {
  vec4 m = texture(u_means, v_uv); // (mI, mp, mII, mIp)
  float varI = max(m.z - m.x * m.x, 0.0);
  float A = (m.w - m.x * m.y) / (varI + u_eps);
  o = vec4(A, m.y - A * m.x, m.y + 0.5, m.x + 0.5); // .w = mean guide (item 5 motion guard)
}
`

/**
 * Item 5: motion-guarded EMA of the box-blurred guided-filter coefficients, half
 * res, ping-pong (never samples the target it writes). The guard compares the
 * blurred mean guide, so it reacts to the picture moving, not to the matte.
 */
export const GF_TEMPORAL_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_cur;
uniform sampler2D u_prev;
uniform bool u_hasPrev;
uniform float u_cTemporal;
uniform vec2 u_guard;
void main() {
  vec4 cur = texture(u_cur, v_uv);
  if (!u_hasPrev) { o = cur; return; }
  vec4 prv = texture(u_prev, v_uv);
  float still = 1.0 - smoothstep(u_guard.x, u_guard.y, abs(cur.w - prv.w));
  o = vec4(mix(cur.xyz, prv.xyz, u_cTemporal * still), cur.w);
}
`

/**
 * Item 4, step 1 (1/4 matte res): child coverage of each 4x4 matte cell (4 bilinear
 * taps = the cell's 16 px). r = child, g = screen.
 */
export const DS_DOWN_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_matte;
uniform vec2 u_mtexel; // 1 / matte size
float cov(vec2 uv) { return smoothstep(0.20, 0.30, texture(u_matte, uv).r); }
void main() {
  vec2 t = u_mtexel;
  float m = 0.25 * (cov(v_uv + vec2(-t.x, -t.y)) + cov(v_uv + vec2(t.x, -t.y))
                  + cov(v_uv + vec2(-t.x, t.y)) + cov(v_uv + vec2(t.x, t.y)));
  o = vec4(m, 1.0 - m, 0.0, 1.0);
}
`

/**
 * Item 4, step 2: box mean over 17 cells (run H then V). Taps past the frame edge
 * count as no child and open screen, so edge specks are measured at their real size.
 */
export const DS_BOX_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_src;
uniform vec2 u_step;
void main() {
  vec4 s = vec4(0.0);
  for (int i = -8; i <= 8; i++) {
    vec2 q = v_uv + float(i) * u_step;
    bool inside = all(greaterThanEqual(q, vec2(0.0))) && all(lessThanEqual(q, vec2(1.0)));
    s += inside ? texture(u_src, q) : vec4(0.0, 1.0, 0.0, 0.0);
  }
  o = s / 17.0;
}
`

/**
 * ML mask prep at ~256 wide, ping-pong. r = garbage (dilated, slow decay: held
 * props and 1–2 frames of mask lag survive), g = core (eroded, slow growth: never
 * fills the screen behind a moving kid).
 */
export const MASK_PREP_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_mask;
uniform sampler2D u_prevPrep;
uniform bool u_hasPrev;
uniform vec2 u_dilateStep; // uv per dilation tap (±4 taps ≈ 5% of width)
uniform vec2 u_texel;      // uv per prep texel (erosion)
void main() {
  float mx = 0.0;
  float mn = 1.0;
  for (int j = -4; j <= 4; j++)
    for (int i = -4; i <= 4; i++)
      mx = max(mx, texture(u_mask, v_uv + vec2(float(i), float(j)) * u_dilateStep).r);
  // ±3 texels ≈ 1.2% of width: thin concave gaps (arm against body) stay chroma-keyed.
  for (int j = -3; j <= 3; j++)
    for (int i = -3; i <= 3; i++)
      mn = min(mn, texture(u_mask, v_uv + vec2(float(i), float(j)) * u_texel).r);
  if (u_hasPrev) {
    vec2 p = texture(u_prevPrep, v_uv).rg;
    mx = max(mx, p.r - 0.08);
    mn = min(mn, p.g + 0.15);
  }
  o = vec4(mx, mn, 0.0, 1.0);
}
`

/**
 * Background downsample for the light wrap. Drawn with QUAD_VS (cover-fit rect)
 * into a 1/8-stage target; 4x4 bilinear taps average the footprint so the small
 * image doesn't alias. BOX_FS then blurs it further.
 */
export const BLUR_DOWN_FS = /* glsl */ `#version 300 es
precision mediump float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_tex;
uniform vec2 u_footprint; // uv covered by one output pixel
void main() {
  vec4 s = vec4(0.0);
  for (int j = 0; j < 4; j++)
    for (int i = 0; i < 4; i++)
      s += texture(u_tex, v_uv + (vec2(float(i), float(j)) - 1.5) * 0.25 * u_footprint);
  o = vec4(s.rgb / 16.0, 1.0);
}
`

/**
 * Tiny readback frame for the auto-key drift tracker and the "shirt is
 * screen-coloured" check: rgb = camera colour, a = matte (high nibble) and ML
 * core (low nibble), both 4-bit, which is plenty for counting pixels.
 */
export const SAMPLE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_fg;
uniform sampler2D u_matte;
uniform sampler2D u_maskPrep;
uniform bool u_hasPrep;
void main() {
  vec3 c = texture(u_fg, v_uv).rgb;
  float a = texture(u_matte, v_uv).r;
  float core = u_hasPrep ? texture(u_maskPrep, v_uv).g : 0.0;
  o = vec4(c, (floor(a * 15.0 + 0.5) * 16.0 + floor(core * 15.0 + 0.5)) / 255.0);
}
`

/** Exact piecewise sRGB <-> linear (IEC 61966-2-1). */
export const COLOR_GLSL = /* glsl */ `
vec3 srgbToLin(vec3 c) {
  return mix(pow((c + 0.055) / 1.055, vec3(2.4)), c / 12.92, vec3(lessThanEqual(c, vec3(0.04045))));
}
vec3 linToSrgb(vec3 l) {
  l = clamp(l, 0.0, 1.0);
  return mix(1.055 * pow(l, vec3(1.0 / 2.4)) - 0.055, l * 12.92, vec3(lessThanEqual(l, vec3(0.0031308))));
}
`

/**
 * The final alpha chain shared by FG_FS and UNMIX_PREP_FS, so the alpha used to
 * unmix is exactly the alpha that is blended: guided-filter upsample (or colour GF
 * in segment mode, or a 3x3 tent) → Magic Helper fusion (with trust) → choke.
 */
export const FINAL_ALPHA_GLSL = /* glsl */ `
uniform sampler2D u_matte;    // MATTE_FS output (r = alpha, g = guide)
uniform sampler2D u_gfAB;     // (A, b, mean_p), half res
uniform sampler2D u_maskPrep; // (garbage, core)
uniform sampler2D u_cgf;      // colour guided filter (a.rgb, b), segment mode
uniform int u_mode;
uniform bool u_hasGF;
uniform bool u_hasCGF;
uniform vec2 u_post;          // segment mode: ramp after filtering (lo, hi)
uniform vec2 u_mtexel;        // 1 / matte size (tent fallback)
uniform float u_mlWeight;
uniform float u_mlTrust;      // 0..1, Magic Helper trust (mask age, motion, confidence); 1 = fresh
uniform float u_coreWeight;   // core fill is opt-in (screen-coloured clothing / helper "On")
uniform float u_choke;
uniform sampler2D u_dsMass;   // item 4: (child mass, screen mass) as 17x17-cell means
uniform bool u_hasDs;
uniform float u_dsMinArea;    // matte px; <= 0 = off
uniform float u_dsMinHole;    // matte px; <= 0 = off

float tent(vec2 uv) {
  vec2 t = u_mtexel;
  float s = texture(u_matte, uv).r * 4.0;
  s += (texture(u_matte, uv + vec2(-t.x, 0.0)).r + texture(u_matte, uv + vec2(t.x, 0.0)).r
      + texture(u_matte, uv + vec2(0.0, -t.y)).r + texture(u_matte, uv + vec2(0.0, t.y)).r) * 2.0;
  s += texture(u_matte, uv - t).r + texture(u_matte, uv + t).r
     + texture(u_matte, uv + vec2(-t.x, t.y)).r + texture(u_matte, uv + vec2(t.x, -t.y)).r;
  return s / 16.0;
}

// c = camera colour at uv (sRGB). Returns the choked alpha.
float finalAlpha(vec2 uv, vec3 c, out float coreFill, out float meanP) {
  float a;
  if (u_hasCGF) {
    vec4 ab = texture(u_cgf, uv);
    float q = dot(ab.rgb, c - 0.5) + ab.a + 0.5;
    a = smoothstep(u_post.x, u_post.y, q);
    meanP = texture(u_matte, uv).r;
  } else if (u_hasGF) {
    vec3 ab = texture(u_gfAB, uv).rgb;
    float guide = texture(u_matte, uv).g;
    a = clamp(ab.x * (guide - 0.5) + ab.y + 0.5, 0.0, 1.0);
    meanP = ab.z;
  } else {
    a = tent(uv);
    meanP = a;
  }
  // Item 4: speck kill / hole fill factors (applied below, after the helper has had its say).
  float dsKill = 1.0;
  float dsFill = 0.0;
  if (u_hasDs) {
    vec2 mass = texture(u_dsMass, uv).rg * ${f(DS_CELL_PX)};
    if (u_dsMinArea > 0.0) dsKill = smoothstep(0.5 * u_dsMinArea, u_dsMinArea, mass.x);
    if (u_dsMinHole > 0.0) dsFill = 1.0 - smoothstep(0.5 * u_dsMinHole, u_dsMinHole, mass.y);
  }
  coreFill = 0.0;
  bool ml = u_mode == ${MODE_IDS.chroma} && u_mlWeight > 0.0;
  vec2 gm = ml ? texture(u_maskPrep, uv).rg : vec2(0.0);
  float garbage = smoothstep(0.05, 0.35, gm.r); // ML: clearly not a kid -> remove
  float killW = u_mlWeight * smoothstep(${f(TRUST_RAMP.killLo)}, ${f(TRUST_RAMP.killHi)}, u_mlTrust);
  // A trusted helper saying "kid here" lifts the speck kill (small kept bits of a
  // kid whose clothing the key ate are not specks).
  if (ml) dsKill = mix(dsKill, 1.0, killW * smoothstep(0.35, 0.6, gm.r));
  a = max(a * dsKill, dsFill);
  if (ml) {
    // Trust only bites once a mask is clearly stale or unsure: a normal 1-2 frame old
    // mask (trust ~0.85-0.97) keeps today's behaviour. (The plan's linear fill = trust²
    // made the green-shirt fill pulse with the helper cadence: SAD 7.4 -> 10.4.)
    float tFill = smoothstep(${f(TRUST_RAMP.fillLo)}, ${f(TRUST_RAMP.fillHi)}, u_mlTrust);
    // ML: clearly a kid -> keep (green shirt). A stale / unsure mask must be surer.
    float core = smoothstep(mix(0.97, 0.75, tFill), mix(0.995, 0.95, tFill), gm.g) * u_coreWeight;
    // Fade the two mattes at different rates: a ghost fill behind a moving kid is
    // the worse error, so the fill fades first; the kill stops when the mask is stale.
    float fillW = u_mlWeight * tFill;
    float aKill = a * mix(1.0, garbage, killW);
    a = max(aKill, core * fillW);
    coreFill = clamp(a - aKill, 0.0, 1.0);
  }
  return clamp((pow(a, u_choke) - 0.02) / 0.96, 0.0, 1.0);
}
`

/**
 * Foreground unmixing prep (item 3), at 1/4 matte resolution, MRT, fresh camera
 * frames only. Four taps per texel (each its own colour + final alpha) so the
 * decimation neither aliases nor mixes edge colour into the donors.
 *   oF = (linear colour · w, w) of solid child pixels (local foreground colour F̂)
 *   oB = (linear colour · conf, conf): a slowly learned plate of the empty screen
 *        (local background colour B̂); remembered with decaying confidence where the
 *        child stands. Never samples the textures it writes (no feedback loop).
 * Both are mipmapped afterwards; FG_FS reads a few levels as a pyramid average.
 */
export function unmixPrepFs(analytic: boolean): string {
  return /* glsl */ `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 v_uv;
layout(location = 0) out vec4 oF;
layout(location = 1) out vec4 oB;
uniform sampler2D u_fg;
uniform sampler2D u_prevB;
uniform sampler3D u_keyLut;
uniform bool u_hasPrevB;
uniform float u_plateRate;
uniform float u_plateDecay;
uniform float u_lo;
uniform float u_hi;
uniform vec2 u_ptexel; // 1 / prep size
uniform int u_taps;    // 4 (default) or 1
uniform float u_helperDonors; // item 7: 1 = hue-matching pixels the trusted Helper calls background may donate
uniform vec2 u_keyHueDir;     // unit (a, b) direction of the key
const float LUT_N = ${f(LUT_N)};
const float LUT_RANGE = ${f(LUT_RANGE)};
${analytic ? ANALYTIC_KEY_GLSL : ''}
${COLOR_GLSL}
${FINAL_ALPHA_GLSL}
// CIELAB (a, b) of a linear colour (D65 white folded into the matrix), for the hue test.
vec2 labAB(vec3 L) {
  vec3 xyz = mat3(0.433953, 0.2126729, 0.017757, 0.376214, 0.7151522, 0.109468, 0.189842, 0.072175, 0.872775) * L;
  vec3 t = max(xyz, vec3(1e-6));
  vec3 fv = mix((903.2963 * t + 16.0) / 116.0, pow(t, vec3(1.0 / 3.0)), vec3(greaterThan(t, vec3(0.008856452))));
  return vec2(500.0 * (fv.x - fv.y), 200.0 * (fv.y - fv.z));
}
float rawKeyD(vec3 c) {
${
  analytic
    ? '  return keyDistAndGuard(c).x;'
    : '  return texture(u_keyLut, c * ((LUT_N - 1.0) / LUT_N) + 0.5 / LUT_N).r * LUT_RANGE;'
}
}
void main() {
  vec2 d = 0.25 * u_ptexel;
  vec4 accF = vec4(0.0);
  vec4 accB = vec4(0.0);
  for (int k = 0; k < u_taps; k++) {
    vec2 uv = u_taps == 1 ? v_uv : v_uv + vec2((k & 1) == 0 ? -d.x : d.x, k < 2 ? -d.y : d.y);
    vec3 c = texture(u_fg, uv).rgb;
    float core, meanP;
    float a = finalAlpha(uv, c, core, meanP);
    vec3 L = srgbToLin(c);
    float wF = smoothstep(0.70, 0.95, a);
    // Screen donors: keyed out, not ML core, locally screen, and the raw key agrees.
    float rawOk = 1.0 - smoothstep(u_lo, u_hi, rawKeyD(c));
    if (u_helperDonors > 0.0 && u_mlWeight > 0.0) {
      // Deep shadow / hotspot on the sheet: the raw key rejects it, but if its hue is
      // the key's and a trusted Helper says "no kid here", it may still teach the plate.
      vec2 ab = labAB(L);
      float hueOk = smoothstep(0.80, 0.94, dot(ab / max(length(ab), 1e-4), u_keyHueDir)) * smoothstep(3.0, 6.0, length(ab));
      float bgByHelper = (1.0 - smoothstep(0.05, 0.20, texture(u_maskPrep, uv).r)) * step(0.6, u_mlTrust) * step(0.5, u_mlWeight);
      rawOk = max(rawOk, hueOk * bgByHelper);
    }
    float wB = (1.0 - smoothstep(0.02, 0.20, a)) * (1.0 - core) * (1.0 - smoothstep(0.02, 0.20, meanP)) * rawOk;
    accF += vec4(L * wF, wF);
    accB += vec4(L * wB, wB);
  }
  float inv = 1.0 / float(u_taps);
  oF = accF * inv;
  float wB = accB.a * inv;
  vec3 Bobs = accB.rgb / max(accB.a, 1e-5);
  vec4 p = u_hasPrevB ? textureLod(u_prevB, v_uv, 0.0) : vec4(0.0);
  vec3 B;
  float conf;
  if (p.a < 1e-3) {
    B = Bobs;
    conf = wB;
  } else {
    vec3 pB = p.rgb / p.a;
    B = mix(pB, Bobs, clamp(u_plateRate * wB, 0.0, 1.0)); // the screen is static: learn slowly
    conf = max(wB, p.a * u_plateDecay);                  // forget slowly where the child stands
  }
  oB = vec4(B * conf, conf);
}
`
}

/**
 * The "Me" layer. Produces straight-alpha colour, or (u_matteOut) an opaque
 * grayscale matte used by renderMatte() (debug / export of the live key).
 */
export const FG_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_fg;
uniform sampler2D u_bgBlur;   // 1/8 stage, blurred background
uniform sampler2D u_unF;      // unmix: (linear F · w, w), mipmapped, 1/4 matte res
uniform sampler2D u_unB;      // unmix: screen plate (linear B · conf, conf), mipmapped
uniform bool u_mirror;
uniform bool u_matteOut;
uniform bool u_hasMatte;
uniform bool u_hasBgBlur;
uniform bool u_hasUnmix;
uniform float u_unmix;        // unmix strength (0 = off)
uniform float u_unCap;        // max correction length (linear RGB)
uniform float u_unProj;       // 1 = solve F with the colour-line alpha
uniform float u_unSpillKeep;  // share of the despill edge boost kept where unmixed
uniform float u_projAlpha;    // P2 item 16: strength of the colour-line alpha in the blend alpha
uniform bool u_projWide;      // item 16: also key-opaque pixels next to the edge
uniform float u_projTaper;    // item 16: 1 = no alpha lowering where the key is nearly opaque
uniform vec2 u_texel;         // 1 / fg texture size (packed mode seam)
uniform vec2 u_stage;
uniform float u_spill;
uniform float u_wrap;
uniform int u_spillCh;        // 0 r, 1 g, 2 b
out vec4 outColor;

const vec3 LUMA = vec3(0.299, 0.587, 0.114);
const float SPILL_EDGE = ${f(SPILL_EDGE)};
${COLOR_GLSL}
${FINAL_ALPHA_GLSL}

// Alpha-aware, luminance-preserving despill. Mirrors autoKey.despill. edgeBoost
// backs off where the edge colour was already unmixed (the screen is gone there).
vec3 despillA(vec3 c, float a, float k, float edgeBoost) {
  vec3 dir = u_spillCh == 0 ? vec3(1.0, 0.0, 0.0) : (u_spillCh == 1 ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0));
  float dom = dot(c, dir);
  vec3 oth = c * (1.0 - dir);
  float mxO = max(max(oth.r, oth.g), oth.b);
  float avO = (oth.r + oth.g + oth.b) * 0.5;
  float edge = 1.0 - abs(2.0 * a - 1.0);
  float limit = mix(mxO, avO, edge);
  float s = max(dom - limit, 0.0) * clamp(k * (1.0 + edgeBoost * edge), 0.0, 1.0);
  return min(c - s * dir + vec3(s * dot(dir, LUMA)), vec3(1.0));
}

// Near pyramid levels dominate, far ones fill gaps (premultiplied weights).
vec4 pyr(sampler2D t, vec2 uv) {
  return textureLod(t, uv, 0.0) + 0.25 * textureLod(t, uv, 2.0) + 0.0625 * textureLod(t, uv, 4.0);
}

void main() {
  vec2 uv = v_uv;
  if (u_mirror) uv.x = 1.0 - uv.x;
  vec3 rgb;
  float a = 1.0;

  if (u_mode == ${MODE_IDS.chroma} || u_mode == ${MODE_IDS.segment}) {
    vec3 c = texture(u_fg, uv).rgb;
    rgb = c;
    if (u_hasMatte) {
      float coreFill, meanP;
      a = finalAlpha(uv, c, coreFill, meanP);
      // Foreground unmixing (blur-fusion, Forte & Pitié 2021): at the soft edge
      // I = aF + (1-a)B, so F = F^ + a(I - aF^ - (1-a)B^) with local F^ / B^ from the
      // pyramids, in linear light, correction capped. Replaces the screen instead of
      // greying it. The "a" of the colour solve is the colour-line fraction of I
      // between B^ and F^ where they differ clearly (the key's alpha is too opaque
      // at edges); it also covers key-opaque pixels next to the edge (meanP < 1)
      // that still carry screen light. Skipped where the core fill rescued the pixel.
      float unW = 0.0;
      float aKey = a; // despill keeps the key's alpha (item 16 only changes the blend alpha)
      if (u_hasUnmix && a > 0.004 && (a < 0.996 || meanP < 0.995)) {
        vec4 sF = pyr(u_unF, uv);
        vec4 sB = pyr(u_unB, uv);
        unW = u_unmix * smoothstep(0.02, 0.10, sF.a) * smoothstep(0.02, 0.10, sB.a) * (1.0 - coreFill);
        if (unW > 0.0) {
          vec3 Fh = sF.rgb / max(sF.a, 1e-4);
          vec3 Bh = sB.rgb / max(sB.a, 1e-4);
          vec3 I = srgbToLin(c);
          vec3 dFB = Fh - Bh;
          float d2 = dot(dFB, dFB);
          float aP = clamp(dot(I - Bh, dFB) / max(d2, 1e-4), 0.0, 1.0);
          float wP = smoothstep(0.01, 0.05, d2);
          float au = mix(a, aP, u_unProj * wP);
          vec3 corr = au * (I - au * Fh - (1.0 - au) * Bh);
          float len = length(corr);
          if (len > u_unCap) corr *= u_unCap / len;
          if (!u_matteOut) rgb = mix(c, linToSrgb(Fh + corr), unW);
          // Item 16: the key's smoothstep misjudges the real mixing fraction in blur and
          // hair; pull the blend alpha toward the colour-line fraction where F^ and B^
          // differ clearly (colour-line matting, Chuang 2001 / Levin 2008).
          if (u_projAlpha > 0.0 && (u_projWide || a < 0.996)) {
            // Taper: where the key is nearly opaque, only let the colour line LOWER alpha a
            // little (an opaque rim lit by screen spill looks "part screen" on the line).
            float wT = aP < a ? 1.0 - u_projTaper * smoothstep(0.80, 0.99, a) : 1.0;
            a = mix(a, aP, u_projAlpha * wP * unW * wT);
          }
        }
      }
      if (u_spill > 0.0) rgb = despillA(rgb, aKey, u_spill * (1.0 - coreFill), SPILL_EDGE * (1.0 - unW * (1.0 - u_unSpillKeep)));
      if (u_hasBgBlur && u_wrap > 0.0) {
        vec3 bg = texture(u_bgBlur, gl_FragCoord.xy / u_stage).rgb;
        // meanP is the chroma matte's local mean; where ML rescued a screen-coloured
        // shirt it is ~0, so the wrap is faded out there too.
        rgb = mix(rgb, bg, u_wrap * a * (1.0 - clamp(meanP, 0.0, 1.0)) * (1.0 - coreFill));
      }
    }
  } else if (u_mode == ${MODE_IDS.packed}) {
    // Top half = straight color, bottom half = alpha. Clamp half a texel away from
    // the seam so linear filtering never mixes the two halves.
    float h = u_texel.y * 0.5;
    rgb = texture(u_fg, vec2(uv.x, clamp(uv.y * 0.5, 0.0, 0.5 - h))).rgb;
    a = texture(u_fg, vec2(uv.x, clamp(0.5 + uv.y * 0.5, 0.5 + h, 1.0))).r;
  } else if (u_mode == ${MODE_IDS.alpha}) {
    vec4 c = texture(u_fg, uv);
    rgb = c.rgb;
    a = c.a;
  } else {
    rgb = texture(u_fg, uv).rgb;
  }

  outColor = u_matteOut ? vec4(vec3(a), 1.0) : vec4(rgb, a);
}
`
