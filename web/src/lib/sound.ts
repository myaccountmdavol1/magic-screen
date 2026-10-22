// Cute UI sounds, synthesized with WebAudio so there are no asset files to cache.
import { useApp } from '../state/store'

export type SoundName = 'tap' | 'pop' | 'success' | 'countdown' | 'shutter' | 'start' | 'stop' | 'magic'

type Ctor = typeof AudioContext
let ctx: AudioContext | null = null
let master: GainNode | null = null
let noiseBuffer: AudioBuffer | null = null

function getCtx(): AudioContext | null {
  if (ctx) return ctx
  const AC: Ctor | undefined =
    typeof window !== 'undefined'
      ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext)
      : undefined
  if (!AC) return null
  try {
    ctx = new AC()
    master = ctx.createGain()
    // Kept gentle: little ears, classroom full of iPads.
    master.gain.value = 0.35
    master.connect(ctx.destination)
  } catch {
    ctx = null
  }
  return ctx
}

/**
 * Call from the first user gesture (tap). iOS keeps AudioContext suspended until resumed
 * inside a gesture; playing a silent buffer here also wakes the iPhone ringer-switch path.
 */
export function unlock(): void {
  const c = getCtx()
  if (!c || !master) return
  if (c.state !== 'running') void c.resume().catch(() => undefined)
  try {
    const src = c.createBufferSource()
    src.buffer = c.createBuffer(1, 1, c.sampleRate)
    src.connect(master)
    src.start(0)
  } catch {
    /* ignore */
  }
}

interface ToneOpts {
  type?: OscillatorType
  freq: number
  /** glide to this frequency over the duration */
  to?: number
  start?: number
  dur: number
  gain?: number
  attack?: number
}

function tone(c: AudioContext, out: AudioNode, o: ToneOpts) {
  const t0 = c.currentTime + (o.start ?? 0)
  const osc = c.createOscillator()
  const g = c.createGain()
  osc.type = o.type ?? 'sine'
  osc.frequency.setValueAtTime(o.freq, t0)
  if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t0 + o.dur)
  const peak = o.gain ?? 0.5
  const attack = o.attack ?? 0.008
  g.gain.setValueAtTime(0.0001, t0)
  g.gain.exponentialRampToValueAtTime(peak, t0 + attack)
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur)
  osc.connect(g).connect(out)
  osc.start(t0)
  osc.stop(t0 + o.dur + 0.02)
}

function noise(c: AudioContext, out: AudioNode, start: number, dur: number, gain: number, hp: number) {
  if (!noiseBuffer || noiseBuffer.sampleRate !== c.sampleRate) {
    const len = Math.floor(c.sampleRate * 0.25)
    noiseBuffer = c.createBuffer(1, len, c.sampleRate)
    const d = noiseBuffer.getChannelData(0)
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
  }
  const t0 = c.currentTime + start
  const src = c.createBufferSource()
  src.buffer = noiseBuffer
  const f = c.createBiquadFilter()
  f.type = 'highpass'
  f.frequency.value = hp
  const g = c.createGain()
  g.gain.setValueAtTime(gain, t0)
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
  src.connect(f).connect(g).connect(out)
  src.start(t0)
  src.stop(t0 + dur + 0.02)
}

const C5 = 523.25
const E5 = 659.25
const G5 = 783.99
const C6 = 1046.5

const SOUNDS: Record<SoundName, (c: AudioContext, out: AudioNode) => void> = {
  tap: (c, o) => tone(c, o, { type: 'sine', freq: 880, to: 990, dur: 0.07, gain: 0.25 }),
  pop: (c, o) => {
    tone(c, o, { type: 'sine', freq: 320, to: 1200, dur: 0.11, gain: 0.45 })
    tone(c, o, { type: 'triangle', freq: 1400, start: 0.05, dur: 0.06, gain: 0.12 })
  },
  success: (c, o) => {
    ;[C5, E5, G5].forEach((f, i) => tone(c, o, { type: 'triangle', freq: f, start: i * 0.11, dur: 0.22, gain: 0.4 }))
    tone(c, o, { type: 'sine', freq: C6, start: 0.33, dur: 0.4, gain: 0.3 })
  },
  countdown: (c, o) => tone(c, o, { type: 'square', freq: 660, dur: 0.14, gain: 0.12 }),
  shutter: (c, o) => {
    noise(c, o, 0, 0.05, 0.6, 2000)
    noise(c, o, 0.07, 0.06, 0.4, 1200)
    tone(c, o, { type: 'square', freq: 180, dur: 0.03, gain: 0.15 })
  },
  start: (c, o) => {
    tone(c, o, { type: 'sine', freq: 600, to: 1100, dur: 0.12, gain: 0.4 })
    tone(c, o, { type: 'sine', freq: 900, to: 1500, start: 0.12, dur: 0.12, gain: 0.35 })
  },
  stop: (c, o) => {
    tone(c, o, { type: 'sine', freq: 1100, to: 700, dur: 0.12, gain: 0.4 })
    tone(c, o, { type: 'sine', freq: 800, to: 450, start: 0.12, dur: 0.14, gain: 0.35 })
  },
  magic: (c, o) => {
    // Sparkly shimmer: a quick upward run of high sine partials with soft tails.
    const partials = [1568, 1976, 2349, 2637, 3136, 3520, 3951, 4699]
    partials.forEach((f, i) => {
      tone(c, o, { type: 'sine', freq: f, start: i * 0.055, dur: 0.5, gain: 0.12, attack: 0.01 })
      tone(c, o, { type: 'sine', freq: f * 1.005, start: i * 0.055 + 0.02, dur: 0.4, gain: 0.06 })
    })
  },
}

export function playSound(name: SoundName): void {
  if (!useApp.getState().settings.sounds) return
  const c = getCtx()
  if (!c || !master) return
  // iOS reports 'interrupted' (not 'suspended') after a call, Siri or backgrounding.
  if (c.state !== 'running') void c.resume().catch(() => undefined)
  try {
    SOUNDS[name](c, master)
  } catch {
    /* audio is decoration; never break the UI */
  }
}
