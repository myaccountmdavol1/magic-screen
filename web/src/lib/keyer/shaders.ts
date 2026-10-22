// GLSL ES 3.00 sources for the Compositor. Constants are injected from
// labKey.ts / autoKey.ts so the LUT bake, the CPU fallback, the tests and the
// GPU path cannot drift apart. Pipeline (docs/research/realtime/recommendation.md):
//
//   camera ─► MATTE_FS (LUT key or ML mask, motion-guarded temporal EMA)  [camera res ≤ 1280w, ping-pong]
//          ─► GF_PACK_FS ─► BOX_FS ×2 ─► GF_COEF_FS ─► BOX_FS ×2           [half res, RGBA16F]
//             (guide = keyD + luma mix from the matte pass, not plain luma)
//   mask   ─► MASK_PREP_FS (garbage = dilated/slow decay, core = eroded)   [256 wide, ping-pong]
//   bg     ─► BLUR_DOWN_FS ─► BOX_FS ×2                                    [1/8 stage, light wrap]
//   FG_FS: guided-filter upsample (or 3x3 tent) → ML fusion → choke → despill → light wrap
//
// All offscreen passes use PASS_VS, which maps texture row 0 to v = 0 (image top),
// the same convention as the camera upload (no FLIP_Y). So every camera-space
// texture is sampled with the same uv.
import { SPILL_EDGE } from './autoKey'
import { DARK_L_HI, DARK_L_LO, LUT_N, LUT_RANGE, L_WEIGHT, MAX_SHADOW_GAIN } from './labKey'

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
uniform float u_segLo; // ML confidence ramp (segment mode); moved by the Outline control
uniform float u_segHi;
const float LUT_N = ${f(LUT_N)};
const float LUT_RANGE = ${f(LUT_RANGE)};
const vec3 LUMA = vec3(0.299, 0.587, 0.114);
${analytic ? ANALYTIC_KEY_GLSL : ''}
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
  o = vec4(A, m.y - A * m.x, m.y + 0.5, 0.0);
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

/**
 * The "Me" layer. Produces straight-alpha colour, or (u_matteOut) an opaque
 * grayscale matte used by renderMatte() (debug / export of the live key).
 */
export const FG_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_fg;
uniform sampler2D u_matte;    // MATTE_FS output (r = alpha, g = guide)
uniform sampler2D u_gfAB;     // (A, b, mean_p), half res
uniform sampler2D u_maskPrep; // (garbage, core)
uniform sampler2D u_bgBlur;   // 1/8 stage, blurred background
uniform int u_mode;
uniform bool u_mirror;
uniform bool u_matteOut;
uniform bool u_hasMatte;
uniform bool u_hasGF;
uniform bool u_hasBgBlur;
uniform vec2 u_texel;         // 1 / fg texture size (packed mode seam)
uniform vec2 u_mtexel;        // 1 / matte size (tent fallback)
uniform vec2 u_stage;
uniform float u_mlWeight;
uniform float u_coreWeight;   // core fill is opt-in (screen-coloured clothing / helper "On")
uniform float u_choke;
uniform float u_spill;
uniform float u_wrap;
uniform int u_spillCh;        // 0 r, 1 g, 2 b
out vec4 outColor;

const vec3 LUMA = vec3(0.299, 0.587, 0.114);
const float SPILL_EDGE = ${f(SPILL_EDGE)};

// Alpha-aware, luminance-preserving despill. Mirrors autoKey.despill.
vec3 despillA(vec3 c, float a, float k) {
  vec3 dir = u_spillCh == 0 ? vec3(1.0, 0.0, 0.0) : (u_spillCh == 1 ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0));
  float dom = dot(c, dir);
  vec3 oth = c * (1.0 - dir);
  float mxO = max(max(oth.r, oth.g), oth.b);
  float avO = (oth.r + oth.g + oth.b) * 0.5;
  float edge = 1.0 - abs(2.0 * a - 1.0);
  float limit = mix(mxO, avO, edge);
  float s = max(dom - limit, 0.0) * clamp(k * (1.0 + SPILL_EDGE * edge), 0.0, 1.0);
  return min(c - s * dir + vec3(s * dot(dir, LUMA)), vec3(1.0));
}

float tent(vec2 uv) {
  vec2 t = u_mtexel;
  float s = texture(u_matte, uv).r * 4.0;
  s += (texture(u_matte, uv + vec2(-t.x, 0.0)).r + texture(u_matte, uv + vec2(t.x, 0.0)).r
      + texture(u_matte, uv + vec2(0.0, -t.y)).r + texture(u_matte, uv + vec2(0.0, t.y)).r) * 2.0;
  s += texture(u_matte, uv - t).r + texture(u_matte, uv + t).r
     + texture(u_matte, uv + vec2(-t.x, t.y)).r + texture(u_matte, uv + vec2(t.x, -t.y)).r;
  return s / 16.0;
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
      float meanP;
      if (u_hasGF) {
        vec3 ab = texture(u_gfAB, uv).rgb;
        float guide = texture(u_matte, uv).g;
        a = clamp(ab.x * (guide - 0.5) + ab.y + 0.5, 0.0, 1.0);
        meanP = ab.z;
      } else {
        a = tent(uv);
        meanP = a;
      }
      float coreFill = 0.0;
      if (u_mode == ${MODE_IDS.chroma} && u_mlWeight > 0.0) {
        vec2 gm = texture(u_maskPrep, uv).rg;
        float garbage = smoothstep(0.05, 0.35, gm.r); // ML: clearly not a kid -> remove
        float core = smoothstep(0.75, 0.95, gm.g) * u_coreWeight; // ML: clearly a kid -> keep (green shirt)
        float fused = max(a * garbage, core);
        float aKey = a;
        a = mix(aKey, fused, u_mlWeight);
        coreFill = clamp(a - aKey, 0.0, 1.0);
      }
      a = clamp((pow(a, u_choke) - 0.02) / 0.96, 0.0, 1.0);
      if (u_spill > 0.0) rgb = despillA(c, a, u_spill * (1.0 - coreFill));
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
