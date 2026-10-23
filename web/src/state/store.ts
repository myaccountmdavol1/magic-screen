import { create } from 'zustand'
import type {
  BackgroundChoice,
  CaptureResult,
  MeTransform,
  OutputKind,
  PlacedSticker,
  ScreenId,
  Settings,
  StepId,
} from '../types'

export const STEPS: StepId[] = ['world', 'me', 'stickers', 'action', 'keep']

// Spoken prompts and sound effects start off; a teacher turns them on in Teacher settings.
// VITE_QUIET=1 additionally forces them off, even over a saved choice (silent previews).
const QUIET = import.meta.env.VITE_QUIET === '1'

export const DEFAULT_SETTINGS: Settings = {
  voice: false,
  sounds: false,
  mirror: true,
  facing: 'user',
  resolution: '720p',
  maxVideoSec: 60,
  countdownSec: 3,
  key: { color: [0.2, 0.75, 0.3], similarity: 0.4, smoothness: 0.08, spill: 0.6 },
  greenScreenMode: 'auto',
  outline: 0,
  magicHelper: 'auto',
}

const SETTINGS_KEY = 'magicscreen.settings'

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return DEFAULT_SETTINGS
    const parsed = JSON.parse(raw) as Partial<Settings> & Record<string, unknown>
    // Only copy keys the current Settings shape knows about, so settings persisted by
    // older builds (e.g. a removed server-URL setting) don't linger in state or storage.
    const known: Partial<Settings> = {}
    for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
      if (k in parsed && parsed[k] !== undefined) (known as Record<string, unknown>)[k] = parsed[k]
    }
    const merged = { ...DEFAULT_SETTINGS, ...known, key: { ...DEFAULT_SETTINGS.key, ...parsed.key } }
    return QUIET ? { ...merged, voice: false, sounds: false } : merged
  } catch {
    return DEFAULT_SETTINGS
  }
}

function saveSettings(s: Settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s))
  } catch {
    /* private mode: settings live for this session only */
  }
}

export const DEFAULT_ME: MeTransform = { x: 0.5, y: 0.5, scale: 1 }

interface AppState {
  screen: ScreenId
  step: StepId
  /** furthest step reached; steps <= this are tappable in the stepper */
  maxStep: number
  background: BackgroundChoice | null
  stickers: PlacedSticker[]
  selectedStickerUid: string | null
  me: MeTransform
  outputKind: OutputKind
  capture: CaptureResult | null
  /** id of the creation currently open in the 'view' screen */
  viewingId: string | null
  settings: Settings
  /** set once the child has tapped anything (unlocks audio/speech on iOS) */
  audioUnlocked: boolean

  goScreen: (s: ScreenId) => void
  goStep: (s: StepId) => void
  nextStep: () => void
  prevStep: () => void
  setBackground: (b: BackgroundChoice | null) => void
  addSticker: (stickerId: string) => void
  updateSticker: (uid: string, patch: Partial<PlacedSticker>) => void
  removeSticker: (uid: string) => void
  selectSticker: (uid: string | null) => void
  clearStickers: () => void
  setMe: (patch: Partial<MeTransform>) => void
  setOutputKind: (k: OutputKind) => void
  setCapture: (c: CaptureResult | null) => void
  viewCreation: (id: string) => void
  updateSettings: (patch: Partial<Settings>) => void
  unlockAudio: () => void
  /** reset the make-flow for a brand new creation */
  newCreation: () => void
}

let uidCounter = 0
const uid = () => `s${Date.now().toString(36)}${(uidCounter++).toString(36)}`

export const useApp = create<AppState>((set, get) => ({
  screen: 'home',
  step: 'world',
  maxStep: 0,
  background: null,
  stickers: [],
  selectedStickerUid: null,
  me: DEFAULT_ME,
  outputKind: 'photo',
  capture: null,
  viewingId: null,
  settings: loadSettings(),
  audioUnlocked: false,

  goScreen: (screen) => set({ screen }),
  goStep: (step) => {
    const i = STEPS.indexOf(step)
    set((s) => ({ step, maxStep: Math.max(s.maxStep, i) }))
  },
  nextStep: () => {
    const i = STEPS.indexOf(get().step)
    if (i < STEPS.length - 1) get().goStep(STEPS[i + 1])
  },
  prevStep: () => {
    const i = STEPS.indexOf(get().step)
    if (i > 0) set({ step: STEPS[i - 1] })
    else set({ screen: 'home' })
  },
  setBackground: (background) => set({ background }),
  addSticker: (stickerId) => {
    const n = get().stickers.length
    const placed: PlacedSticker = {
      uid: uid(),
      stickerId,
      // fan new stickers out so they don't stack exactly
      x: 0.25 + ((n * 0.17) % 0.5),
      y: 0.3 + ((n * 0.11) % 0.4),
      scale: 1,
      rotation: 0,
    }
    set((s) => ({ stickers: [...s.stickers, placed], selectedStickerUid: placed.uid }))
  },
  updateSticker: (id, patch) =>
    set((s) => ({ stickers: s.stickers.map((st) => (st.uid === id ? { ...st, ...patch } : st)) })),
  removeSticker: (id) =>
    set((s) => ({
      stickers: s.stickers.filter((st) => st.uid !== id),
      selectedStickerUid: s.selectedStickerUid === id ? null : s.selectedStickerUid,
    })),
  selectSticker: (selectedStickerUid) => set({ selectedStickerUid }),
  clearStickers: () => set({ stickers: [], selectedStickerUid: null }),
  setMe: (patch) => set((s) => ({ me: { ...s.me, ...patch } })),
  setOutputKind: (outputKind) => set({ outputKind }),
  setCapture: (capture) => set({ capture }),
  viewCreation: (viewingId) => set({ viewingId, screen: 'view' }),
  updateSettings: (patch) => {
    const settings = { ...get().settings, ...patch }
    saveSettings(settings)
    set({ settings })
  },
  unlockAudio: () => set({ audioUnlocked: true }),
  newCreation: () =>
    set({
      screen: 'make',
      step: 'world',
      maxStep: 0,
      background: null,
      stickers: [],
      selectedStickerUid: null,
      me: DEFAULT_ME,
      outputKind: 'photo',
      capture: null,
    }),
}))
