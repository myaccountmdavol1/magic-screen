// "Compression-like" artifacts for the keyer fixtures: 8x8 DCT blocks quantised
// with the JPEG Annex K example tables (IJG quality scaling), applied to each
// YCbCr plane. This reproduces the blocking and chroma smearing of cheap camera /
// screen-share codecs without needing an encoder. No imports; runs in Node.

const LUMA_Q = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87,
  80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92,
  95, 98, 112, 100, 103, 99,
]
const CHROMA_Q = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99,
]

/** IJG quality (1..100) -> quantisation table. */
function scaledTable(base: number[], quality: number): Float32Array {
  const q = Math.min(100, Math.max(1, quality))
  const s = q < 50 ? 5000 / q : 200 - 2 * q
  const t = new Float32Array(64)
  for (let i = 0; i < 64; i++) t[i] = Math.min(255, Math.max(1, Math.floor((base[i] * s + 50) / 100)))
  return t
}

// Orthonormal 8-point DCT-II basis: C[u][x] = a(u) cos((2x+1)u pi / 16)
const C = new Float32Array(64)
for (let u = 0; u < 8; u++) {
  const a = u === 0 ? Math.SQRT1_2 / 2 : 0.5
  for (let x = 0; x < 8; x++) C[u * 8 + x] = a * Math.cos(((2 * x + 1) * u * Math.PI) / 16)
}

/** In-place: quantise one plane through 8x8 DCT blocks (edge blocks replicate). */
export function dctQuantizePlane(plane: Uint8Array, w: number, h: number, quality: number, chroma: boolean): void {
  const Q = scaledTable(chroma ? CHROMA_Q : LUMA_Q, quality)
  const blk = new Float32Array(64)
  const tmp = new Float32Array(64)
  for (let by = 0; by < h; by += 8) {
    for (let bx = 0; bx < w; bx += 8) {
      for (let y = 0; y < 8; y++) {
        const sy = Math.min(h - 1, by + y)
        for (let x = 0; x < 8; x++) blk[y * 8 + x] = plane[sy * w + Math.min(w - 1, bx + x)] - 128
      }
      // forward: rows then columns
      for (let y = 0; y < 8; y++)
        for (let u = 0; u < 8; u++) {
          let s = 0
          for (let x = 0; x < 8; x++) s += C[u * 8 + x] * blk[y * 8 + x]
          tmp[y * 8 + u] = s
        }
      for (let u = 0; u < 8; u++)
        for (let v = 0; v < 8; v++) {
          let s = 0
          for (let y = 0; y < 8; y++) s += C[v * 8 + y] * tmp[y * 8 + u]
          const q = Q[v * 8 + u]
          blk[v * 8 + u] = Math.round(s / q) * q
        }
      // inverse: columns then rows
      for (let u = 0; u < 8; u++)
        for (let y = 0; y < 8; y++) {
          let s = 0
          for (let v = 0; v < 8; v++) s += C[v * 8 + y] * blk[v * 8 + u]
          tmp[y * 8 + u] = s
        }
      for (let y = 0; y < 8; y++) {
        if (by + y >= h) break
        for (let x = 0; x < 8; x++) {
          if (bx + x >= w) break
          let s = 0
          for (let u = 0; u < 8; u++) s += C[u * 8 + x] * tmp[y * 8 + u]
          plane[(by + y) * w + bx + x] = Math.max(0, Math.min(255, Math.round(s + 128)))
        }
      }
    }
  }
}
