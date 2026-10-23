// Screen flattening (plan item 7): CPU mirror of the MATTE_FS gain code, for unit
// tests. The slowly learned screen plate (item 3's B̂, linear RGB) gives a per-region
// gain that moves the screen's own colour onto the key colour, so hotspots, colour
// falloff and shadows on the sheet key like the rest of it. The gain is used ONLY for
// the key lookup: displayed colour, despill and unmixing still use the raw pixel.
// Loosely inspired by CorridorKey's global linear exposure adjust (a single gain);
// ours is spatial and original code (clean room).
import type { RGB } from '../../types'
import { linearToSrgb, srgbToLinear } from './labKey'

export const FLATTEN_GAIN_MIN = 0.7
export const FLATTEN_GAIN_MAX = 1.5

/** Per-channel linear gain that maps the plate colour onto the key colour (clamped). */
export function gainFor(keyLin: RGB, plateLin: RGB): RGB {
  return [0, 1, 2].map((i) =>
    Math.min(FLATTEN_GAIN_MAX, Math.max(FLATTEN_GAIN_MIN, keyLin[i] / Math.max(plateLin[i], 1e-3))),
  ) as RGB
}

/**
 * Luma-only variant: one gain for all three channels (fixes brightness, not colour
 * shift), so a saturated child colour is never pushed along the key's hue.
 */
export function lumaGainFor(keyLin: RGB, plateLin: RGB): RGB {
  const y = (c: RGB) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
  const g = Math.min(FLATTEN_GAIN_MAX, Math.max(FLATTEN_GAIN_MIN, y(keyLin) / Math.max(y(plateLin), 1e-3)))
  return [g, g, g]
}

/** The colour the key lookup sees: sRGB in, gain applied in linear light, sRGB out. */
export function flattenSrgb(c: RGB, gain: RGB, strength = 1): RGB {
  return [0, 1, 2].map((i) => linearToSrgb(srgbToLinear(c[i]) * (1 + (gain[i] - 1) * strength))) as RGB
}
