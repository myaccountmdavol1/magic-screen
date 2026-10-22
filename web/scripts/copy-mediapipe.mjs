#!/usr/bin/env node
// postinstall: make MediaPipe's wasm runtime and the selfie segmenter model
// available under public/mediapipe/ so "AI cutout" works offline in the PWA.
// Never fails the install: a missing model only disables AI cutout mode.
import { copyFile, mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcWasm = join(webRoot, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm')
const outDir = join(webRoot, 'public', 'mediapipe')
const outWasm = join(outDir, 'wasm')
const modelPath = join(outDir, 'selfie_segmenter.tflite')
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite'

async function exists(p) {
  try {
    return (await stat(p)).size > 0
  } catch {
    return false
  }
}

async function copyWasm() {
  let files
  try {
    files = await readdir(srcWasm)
  } catch {
    console.warn('[copy-mediapipe] @mediapipe/tasks-vision not installed; skipping wasm copy')
    return
  }
  await mkdir(outWasm, { recursive: true })
  for (const f of files) await copyFile(join(srcWasm, f), join(outWasm, f))
  console.log(`[copy-mediapipe] copied ${files.length} wasm files to public/mediapipe/wasm`)
}

async function downloadModel() {
  if (await exists(modelPath)) {
    console.log('[copy-mediapipe] model already present')
    return
  }
  if (process.env.MAGIC_SKIP_MODEL_DOWNLOAD) {
    console.warn('[copy-mediapipe] MAGIC_SKIP_MODEL_DOWNLOAD set; skipping model download')
    return
  }
  const tmp = `${modelPath}.part`
  try {
    const res = await fetch(MODEL_URL, { signal: AbortSignal.timeout(60_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 10_000) throw new Error(`unexpectedly small model (${buf.length} bytes)`)
    await mkdir(outDir, { recursive: true })
    // Write then rename so an interrupted download never leaves a corrupt model.
    await writeFile(tmp, buf)
    await rename(tmp, modelPath)
    console.log(`[copy-mediapipe] downloaded selfie_segmenter.tflite (${Math.round(buf.length / 1024)} KB)`)
  } catch (err) {
    await unlink(tmp).catch(() => {})
    console.warn(`[copy-mediapipe] could not download model (${err.message}); AI cutout needs it. Re-run "node scripts/copy-mediapipe.mjs" when online.`)
  }
}

// Apache-2.0 asks for the license/notice to travel with redistributed copies.
async function copyLicense() {
  const src = join(webRoot, 'THIRD_PARTY_LICENSES.md')
  if (!(await exists(src))) return
  await mkdir(outDir, { recursive: true })
  await copyFile(src, join(outDir, 'LICENSE.md'))
}

try {
  await copyWasm()
  await copyLicense()
  await downloadModel()
} catch (err) {
  console.warn('[copy-mediapipe] skipped:', err?.message ?? err)
}
