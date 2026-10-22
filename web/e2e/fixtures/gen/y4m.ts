// Minimal YUV4MPEG2 (Y4M) writer + reader, 4:2:0 "C420jpeg" (centre-sited chroma),
// full-range BT.601 (JPEG) YCbCr. Used by the fixture generator (write) and the
// harness page (read). No imports so it runs in Node and in the browser.

export interface Y4MInfo {
  width: number
  height: number
  fps: number
  frames: number
  /** byte offset of each frame's Y plane */
  offsets: number[]
}

export function y4mHeader(width: number, height: number, fps: number): string {
  // XCOLORRANGE=FULL tells ffmpeg/ffplay the samples are full range.
  return `YUV4MPEG2 W${width} H${height} F${fps}:1 Ip A1:1 C420jpeg XCOLORRANGE=FULL\n`
}

export interface Planes420 {
  Y: Uint8Array
  U: Uint8Array
  V: Uint8Array
}

/** sRGB bytes -> full-range BT.601 4:2:0 planes (chroma = 2x2 box average). */
export function rgbToPlanes420(rgb: Uint8Array | Uint8ClampedArray, width: number, height: number, stride = 4): Planes420 {
  const frame = encodeFrame420(rgb, width, height, stride)
  const cw = (width + 1) >> 1
  const ch = (height + 1) >> 1
  const Y = frame.slice(6, 6 + width * height)
  const U = frame.slice(6 + width * height, 6 + width * height + cw * ch)
  const V = frame.slice(6 + width * height + cw * ch)
  return { Y, U, V }
}

/** Planes -> one Y4M frame (including "FRAME\n"). */
export function planesToFrame(p: Planes420): Uint8Array {
  const out = new Uint8Array(6 + p.Y.length + p.U.length + p.V.length)
  out.set([70, 82, 65, 77, 69, 10], 0)
  out.set(p.Y, 6)
  out.set(p.U, 6 + p.Y.length)
  out.set(p.V, 6 + p.Y.length + p.U.length)
  return out
}

/** sRGB bytes (RGBA or RGB, `stride` 4 or 3) -> one Y4M frame (including "FRAME\n"). */
export function encodeFrame420(rgb: Uint8Array | Uint8ClampedArray, width: number, height: number, stride = 4): Uint8Array {
  const cw = (width + 1) >> 1
  const ch = (height + 1) >> 1
  const head = 6 // "FRAME\n"
  const out = new Uint8Array(head + width * height + 2 * cw * ch)
  out.set([70, 82, 65, 77, 69, 10], 0)
  const Y = head
  const U = Y + width * height
  const V = U + cw * ch
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * stride
      const yy = 0.299 * rgb[i] + 0.587 * rgb[i + 1] + 0.114 * rgb[i + 2]
      out[Y + y * width + x] = Math.max(0, Math.min(255, Math.round(yy)))
    }
  }
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      for (let dy = 0; dy < 2; dy++) {
        const y = Math.min(height - 1, cy * 2 + dy)
        for (let dx = 0; dx < 2; dx++) {
          const x = Math.min(width - 1, cx * 2 + dx)
          const i = (y * width + x) * stride
          r += rgb[i]
          g += rgb[i + 1]
          b += rgb[i + 2]
          n++
        }
      }
      r /= n
      g /= n
      b /= n
      const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b
      const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b
      out[U + cy * cw + cx] = Math.max(0, Math.min(255, Math.round(cb)))
      out[V + cy * cw + cx] = Math.max(0, Math.min(255, Math.round(cr)))
    }
  }
  return out
}

export function parseY4M(buf: Uint8Array): Y4MInfo {
  let nl = buf.indexOf(10)
  if (nl < 0) throw new Error('Y4M: no header')
  const header = new TextDecoder().decode(buf.subarray(0, nl))
  if (!header.startsWith('YUV4MPEG2')) throw new Error('Y4M: bad magic')
  let width = 0
  let height = 0
  let fps = 30
  for (const tok of header.split(' ').slice(1)) {
    if (tok[0] === 'W') width = +tok.slice(1)
    else if (tok[0] === 'H') height = +tok.slice(1)
    else if (tok[0] === 'F') {
      const [n, d] = tok.slice(1).split(':').map(Number)
      fps = n / (d || 1)
    } else if (tok[0] === 'C' && !tok.startsWith('C420')) throw new Error(`Y4M: unsupported ${tok}`)
  }
  const cw = (width + 1) >> 1
  const ch = (height + 1) >> 1
  const frameBytes = width * height + 2 * cw * ch
  const offsets: number[] = []
  let p = nl + 1
  while (p < buf.length) {
    nl = buf.indexOf(10, p)
    if (nl < 0) break
    p = nl + 1
    if (p + frameBytes > buf.length) break
    offsets.push(p)
    p += frameBytes
  }
  return { width, height, fps, frames: offsets.length, offsets }
}

/** Decode frame `k` to RGBA bytes (bilinear, centre-sited chroma upsampling). */
export function decodeFrameRGBA(buf: Uint8Array, info: Y4MInfo, k: number, out?: Uint8ClampedArray): Uint8ClampedArray {
  const { width: w, height: h } = info
  const cw = (w + 1) >> 1
  const ch = (h + 1) >> 1
  const Y = info.offsets[k]
  const U = Y + w * h
  const V = U + cw * ch
  const dst = out ?? new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    const fy = Math.min(ch - 1, Math.max(0, (y + 0.5) / 2 - 0.5))
    const y0 = Math.floor(fy)
    const y1 = Math.min(ch - 1, y0 + 1)
    const ty = fy - y0
    for (let x = 0; x < w; x++) {
      const fx = Math.min(cw - 1, Math.max(0, (x + 0.5) / 2 - 0.5))
      const x0 = Math.floor(fx)
      const x1 = Math.min(cw - 1, x0 + 1)
      const tx = fx - x0
      const a = (1 - tx) * (1 - ty)
      const b = tx * (1 - ty)
      const c = (1 - tx) * ty
      const d = tx * ty
      const cb =
        a * buf[U + y0 * cw + x0] + b * buf[U + y0 * cw + x1] + c * buf[U + y1 * cw + x0] + d * buf[U + y1 * cw + x1] - 128
      const cr =
        a * buf[V + y0 * cw + x0] + b * buf[V + y0 * cw + x1] + c * buf[V + y1 * cw + x0] + d * buf[V + y1 * cw + x1] - 128
      const yy = buf[Y + y * w + x]
      const i = (y * w + x) * 4
      dst[i] = yy + 1.402 * cr
      dst[i + 1] = yy - 0.344136 * cb - 0.714136 * cr
      dst[i + 2] = yy + 1.772 * cb
      dst[i + 3] = 255
    }
  }
  return dst
}
