// Write a PNG preview of one generated fixture frame: camera | GT alpha | GT fg.
//
//   node e2e/fixtures/gen/preview.ts <scenarioDir> [frame] [out.png]
import fs from 'node:fs'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { encodePNG } from './png.ts'
import { decodeFrameRGBA, parseY4M } from './y4m.ts'

const dir = process.argv[2]
if (!dir) throw new Error('usage: preview.ts <scenarioDir> [frame] [out.png]')
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'))
const k = Math.min(meta.frames - 1, parseInt(process.argv[3] ?? String(meta.frames >> 1), 10))
const out = process.argv[4] ?? path.join(dir, `preview-${k}.png`)
const { width: W, height: H } = meta
const cam = new Uint8Array(fs.readFileSync(path.join(dir, 'cam.y4m')))
const info = parseY4M(cam)
const rgba = decodeFrameRGBA(cam, info, k)
const alpha = gunzipSync(fs.readFileSync(path.join(dir, 'alpha.u8.gz'))).subarray(k * W * H, (k + 1) * W * H)
const fg = gunzipSync(fs.readFileSync(path.join(dir, 'fg.rgb.gz'))).subarray(k * W * H * 3, (k + 1) * W * H * 3)
const sheet = new Uint8Array(W * 3 * H * 3)
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const i = y * W + x
    const o = (y * W * 3 + x) * 3
    for (let c = 0; c < 3; c++) {
      sheet[o + c] = rgba[i * 4 + c]
      sheet[o + W * 3 + c] = alpha[i]
      sheet[o + W * 6 + c] = fg[i * 3 + c]
    }
  }
fs.writeFileSync(out, encodePNG(sheet, W * 3, H, 3))
console.log(out)
