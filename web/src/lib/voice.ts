// Spoken prompts for pre-readers, via the browser's built-in SpeechSynthesis.
import { useApp } from '../state/store'

// Warm, clear voices across iOS/macOS, Chrome, Edge and Android, best first.
const PREFERRED = [
  'Samantha',
  'Google US English',
  'Microsoft Aria',
  'Microsoft Jenny',
  'Ava',
  'Allison',
  'Susan',
  'Karen',
  'Moira',
  'Tessa',
  'Microsoft Zira',
  'Alex',
]

// Apple novelty voices that would confuse or scare five-year-olds.
const NOVELTY =
  /\b(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Deranged|Good News|Hysterical|Jester|Junior|Organ|Pipe Organ|Ralph|Superstar|Trinoids|Whisper|Wobble|Zarvox|Fred|Kathy|Grandma|Grandpa|Eddy|Flo|Reed|Rocko|Sandy|Shelley)\b/i

let cachedVoice: SpeechSynthesisVoice | null = null
let voicesHooked = false

function synth(): SpeechSynthesis | null {
  return typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null
}

function pickVoice(s: SpeechSynthesis): SpeechSynthesisVoice | null {
  if (cachedVoice) return cachedVoice
  const voices = s.getVoices().filter((v) => !NOVELTY.test(v.name))
  if (voices.length === 0) return null
  const en = voices.filter((v) => v.lang.toLowerCase().startsWith('en'))
  const us = en.filter((v) => v.lang.replace('_', '-').toLowerCase() === 'en-us')
  let best: SpeechSynthesisVoice | undefined
  for (const name of PREFERRED) {
    best = us.find((v) => v.name.includes(name)) ?? en.find((v) => v.name.includes(name))
    if (best) break
  }
  best ??= us.find((v) => v.localService) ?? us[0] ?? en[0]
  cachedVoice = best ?? null
  return cachedVoice
}

function hookVoices(s: SpeechSynthesis) {
  if (voicesHooked) return
  voicesHooked = true
  // Chrome loads voices asynchronously; re-pick once the list arrives.
  s.addEventListener?.('voiceschanged', () => {
    cachedVoice = null
  })
}

export function speak(text: string): void {
  const s = synth()
  if (!s || !text) return
  if (!useApp.getState().settings.voice) return
  hookVoices(s)
  // Tapping 🔊 repeatedly should restart, not queue up.
  s.cancel()
  const u = new SpeechSynthesisUtterance(text)
  const v = pickVoice(s)
  if (v) {
    u.voice = v
    u.lang = v.lang
  } else {
    u.lang = 'en-US'
  }
  u.rate = 0.95
  u.pitch = 1.1
  u.volume = 1
  try {
    s.speak(u)
  } catch {
    /* speech is a nicety */
  }
}

export function stopSpeaking(): void {
  synth()?.cancel()
}
