// 3D lookup table of the key metric. keyD depends only on RGB, so it is baked
// once per key colour (≈ 110k cells) and every shader tap becomes one texture
// fetch instead of ~6 pow() calls. Thresholds are applied after the fetch, so the
// teacher sliders never trigger a re-bake.
//
// Layout: RG8, index = r + N * (g + N * b), which matches texImage3D's x/y/z order
// so `texture(u_keyLut, rgb)` addresses (r, g, b) directly.
//   R = min(keyD / LUT_RANGE, 1) * 255
//   G = darkGuard(L*) * 255
import { DARK_L_HI, DARK_L_LO, LUT_N, LUT_RANGE, keyDistLab, linearToLab, srgbToLinear, type KeyLab } from './labKey'

export function bakeKeyLut(key: KeyLab, n: number = LUT_N): Uint8Array {
  const data = new Uint8Array(n * n * n * 2)
  const lin = new Float64Array(n)
  for (let i = 0; i < n; i++) lin[i] = srgbToLinear(i / (n - 1))
  const span = DARK_L_HI - DARK_L_LO
  let o = 0
  for (let bi = 0; bi < n; bi++) {
    for (let gi = 0; gi < n; gi++) {
      for (let ri = 0; ri < n; ri++) {
        const lab = linearToLab(lin[ri], lin[gi], lin[bi])
        const d = keyDistLab(lab, key)
        const t = Math.min(1, Math.max(0, (lab[0] - DARK_L_LO) / span))
        data[o++] = Math.round(Math.min(1, d / LUT_RANGE) * 255)
        data[o++] = Math.round((1 - t * t * (3 - 2 * t)) * 255)
      }
    }
  }
  return data
}

/**
 * CPU twin of the GPU's trilinear LUT fetch. Returns [keyD, guard] in metric units.
 * Used by the tests (to bound interpolation error) and the auto-key statistics.
 */
export function sampleKeyLut(data: Uint8Array, n: number, r: number, g: number, b: number): [number, number] {
  const f = (v: number) => Math.min(n - 1, Math.max(0, v * (n - 1)))
  const x = f(r)
  const y = f(g)
  const z = f(b)
  const x0 = Math.min(n - 2, Math.floor(x))
  const y0 = Math.min(n - 2, Math.floor(y))
  const z0 = Math.min(n - 2, Math.floor(z))
  const fx = x - x0
  const fy = y - y0
  const fz = z - z0
  let d = 0
  let gd = 0
  for (let k = 0; k < 2; k++) {
    for (let j = 0; j < 2; j++) {
      for (let i = 0; i < 2; i++) {
        const w = (i ? fx : 1 - fx) * (j ? fy : 1 - fy) * (k ? fz : 1 - fz)
        if (w === 0) continue
        const idx = ((x0 + i) + n * ((y0 + j) + n * (z0 + k))) * 2
        d += w * data[idx]
        gd += w * data[idx + 1]
      }
    }
  }
  return [(d / 255) * LUT_RANGE, gd / 255]
}

/**
 * Fast nearest-cell lookup for the Canvas2D fallback: maps 8-bit channels to LUT
 * cells once, so the per-pixel cost is three table reads and one array read.
 */
export function makeByteIndex(n: number = LUT_N): Uint16Array {
  const idx = new Uint16Array(256)
  for (let v = 0; v < 256; v++) idx[v] = Math.round((v / 255) * (n - 1))
  return idx
}

/** (Re)upload the LUT into a TEXTURE_3D (RG8, LINEAR, CLAMP_TO_EDGE). */
export function uploadKeyLut(gl: WebGL2RenderingContext, tex: WebGLTexture, data: Uint8Array, n: number = LUT_N): void {
  gl.bindTexture(gl.TEXTURE_3D, tex)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RG8, n, n, n, 0, gl.RG, gl.UNSIGNED_BYTE, data)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
  gl.bindTexture(gl.TEXTURE_3D, null)
}
