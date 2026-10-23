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
// Both ~250 KB, Apache-2.0. The landscape model is the AI cutout default for
// landscape cameras; the square one serves portrait cameras (src/lib/segmenter.ts).
const MODELS = ['selfie_segmenter', 'selfie_segmenter_landscape'].map((name) => ({
  name,
  path: join(outDir, `${name}.tflite`),
  url: `https://storage.googleapis.com/mediapipe-models/image_segmenter/${name}/float16/latest/${name}.tflite`,
}))

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

async function downloadModel({ name, path: modelPath, url: MODEL_URL }) {
  if (await exists(modelPath)) {
    console.log(`[copy-mediapipe] ${name} already present`)
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
    console.log(`[copy-mediapipe] downloaded ${name}.tflite (${Math.round(buf.length / 1024)} KB)`)
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
  for (const m of MODELS) await downloadModel(m)
} catch (err) {
  console.warn('[copy-mediapipe] skipped:', err?.message ?? err)
}
