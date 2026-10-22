// Built-in sticker art. Hand-built flat SVG on a 100x100 grid in the Talkline sticker
// style: flat fills, a thick darker outline in the same hue, round joins. No emoji fonts,
// so every sticker looks identical on iPad, Android and desktop.

export type StickerPack = 'fun' | 'faces' | 'animals' | 'weather'

export interface StickerDef {
  id: string
  name: string // spoken + aria label
  svg: string // 100x100 viewBox, no width/height (svg.ts sizes it when rasterizing)
  pack: StickerPack
}

/** Pack order + labels for the sticker tray tabs. */
export const STICKER_PACKS: { id: StickerPack; name: string }[] = [
  { id: 'fun', name: 'Fun' },
  { id: 'faces', name: 'Faces' },
  { id: 'animals', name: 'Animals' },
  { id: 'weather', name: 'Weather' },
]

const wrap = (body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g stroke-linejoin="round" stroke-linecap="round" stroke-width="4.5">${body}</g></svg>`

const r1 = (n: number): number => Math.round(n * 10) / 10

/** Points for an n-pointed star polygon. */
function starPts(cx: number, cy: number, R: number, r: number, n = 5): string {
  const out: string[] = []
  for (let i = 0; i < n * 2; i++) {
    const a = (Math.PI * i) / n - Math.PI / 2
    const rad = i % 2 === 0 ? R : r
    out.push(`${r1(cx + rad * Math.cos(a))},${r1(cy + rad * Math.sin(a))}`)
  }
  return out.join(' ')
}

/** Four-point "twinkle" sparkle path. */
const sparkle = (cx: number, cy: number, r: number): string =>
  `M${cx} ${cy - r}Q${cx} ${cy} ${cx + r} ${cy}Q${cx} ${cy} ${cx} ${cy + r}Q${cx} ${cy} ${cx - r} ${cy}Q${cx} ${cy} ${cx} ${cy - r}Z`

/** Small heart centred on (cx, cy), roughly 2s wide. */
const heartPath = (cx: number, cy: number, s: number): string =>
  `M${cx} ${r1(cy + s * 0.9)}C${r1(cx - s * 1.3)} ${r1(cy)} ${r1(cx - s)} ${r1(cy - s)} ${cx} ${r1(cy - s * 0.45)}C${r1(cx + s)} ${r1(cy - s)} ${r1(cx + s * 1.3)} ${r1(cy)} ${cx} ${r1(cy + s * 0.9)}Z`

const SHINE = 'fill="none" stroke="#fff" stroke-opacity=".75" stroke-width="5"'

// ---- faces -----------------------------------------------------------------
const F = '#3a2a00' // facial feature colour (Talkline)
const face = (features: string, cheeks = true): string =>
  wrap(
    `<circle cx="50" cy="50" r="43" fill="#ffd83d" stroke="#e6a700"/>` +
      (cheeks ? `<g fill="#fb923c" opacity=".35" stroke="none"><circle cx="22" cy="60" r="7"/><circle cx="78" cy="60" r="7"/></g>` : '') +
      features,
  )
const dotEyes = `<g fill="${F}" stroke="none"><ellipse cx="35" cy="40" rx="5" ry="7"/><ellipse cx="65" cy="40" rx="5" ry="7"/></g>`
const eyeShine = `<g fill="#fff" stroke="none"><circle cx="36.5" cy="37" r="1.8"/><circle cx="66.5" cy="37" r="1.8"/></g>`

// ---- animals helpers --------------------------------------------------------
const INK = '#1e293b'
const animalEyes = (y: number, dx = 15): string =>
  `<g fill="${INK}" stroke="none"><ellipse cx="${50 - dx}" cy="${y}" rx="4.5" ry="5.5"/><ellipse cx="${50 + dx}" cy="${y}" rx="4.5" ry="5.5"/></g><g fill="#fff" stroke="none"><circle cx="${51.5 - dx}" cy="${y - 2}" r="1.6"/><circle cx="${51.5 + dx}" cy="${y - 2}" r="1.6"/></g>`

// ---- weather helpers --------------------------------------------------------
const CLOUD = 'M22 74Q6 74 6 60Q6 46 22 46Q24 26 44 24Q60 22 66 36Q72 30 80 34Q92 38 90 52Q98 56 96 66Q94 74 84 74Z'
// Inlined twice (not <use>) so sticker markup never relies on document-unique ids.
const WING = `<path d="M48 46Q30 6 12 18Q2 34 22 48Q34 52 48 50Z" fill="#f9a8d4" stroke="#db2777"/><path d="M48 54Q24 54 19 72Q22 88 38 81Q48 72 48 58Z" fill="#c4b5fd" stroke="#7c3aed"/><g fill="#fff" stroke="none" opacity=".85"><circle cx="24" cy="30" r="5"/><circle cx="34" cy="40" r="3"/><circle cx="31" cy="70" r="4"/></g>`
const snowArm = 'M50 50V10M50 22L41 13M50 22L59 13M50 36L42 28M50 36L58 28'
const snowArms = (stroke: string, w: number): string =>
  [0, 60, 120, 180, 240, 300]
    .map((a) => `<path d="${snowArm}" fill="none" stroke="${stroke}" stroke-width="${w}" transform="rotate(${a} 50 50)"/>`)
    .join('')

export const STICKERS: StickerDef[] = [
  // ---------------------------------------------------------------- fun
  {
    id: 'star',
    name: 'Star',
    pack: 'fun',
    svg: wrap(`<polygon points="${starPts(50, 54, 45, 20)}" fill="#fbbf24" stroke="#f59e0b"/><path d="M36 40l6-10" ${SHINE}/>`),
  },
  {
    id: 'heart',
    name: 'Heart',
    pack: 'fun',
    svg: wrap(
      `<path d="M50 88C20 68 7 52 7 35C7 20 18 11 31 11C40 11 46 16 50 23C54 16 60 11 69 11C82 11 93 20 93 35C93 52 80 68 50 88Z" fill="#fb6f92" stroke="#e11d6f"/><path d="M20 32c1-7 6-11 13-11" ${SHINE}/>`,
    ),
  },
  {
    id: 'crown',
    name: 'Crown',
    pack: 'fun',
    svg: wrap(
      `<path d="M13 74L8 30L30 48L50 18L70 48L92 30L87 74Z" fill="#fcd34d" stroke="#d97706"/><rect x="11" y="70" width="78" height="15" rx="5" fill="#fbbf24" stroke="#d97706"/><g stroke-width="3"><circle cx="8" cy="30" r="5" fill="#fcd34d" stroke="#d97706"/><circle cx="50" cy="18" r="5.5" fill="#fcd34d" stroke="#d97706"/><circle cx="92" cy="30" r="5" fill="#fcd34d" stroke="#d97706"/><circle cx="30" cy="77.5" r="4.5" fill="#f87171" stroke="#dc2626"/><circle cx="50" cy="77.5" r="4.5" fill="#60a5fa" stroke="#2563eb"/><circle cx="70" cy="77.5" r="4.5" fill="#4ade80" stroke="#16a34a"/></g><path d="M24 58v-6" ${SHINE}/>`,
    ),
  },
  {
    id: 'sunglasses',
    name: 'Sunglasses',
    pack: 'fun',
    svg: wrap(
      `<path d="M4 38H96" fill="none" stroke="#0f172a" stroke-width="6"/><path d="M44 43Q50 37 56 43" fill="none" stroke="#0f172a" stroke-width="5"/><path d="M8 35H45V50Q45 68 28 68Q8 68 8 50Z" fill="#1f2937" stroke="#0f172a"/><path d="M55 35H92V50Q92 68 72 68Q55 68 55 50Z" fill="#1f2937" stroke="#0f172a"/><path d="M16 50l10-9M63 50l10-9" fill="none" stroke="#fff" stroke-opacity=".7" stroke-width="4.5"/>`,
    ),
  },
  {
    id: 'top-hat',
    name: 'Top Hat',
    pack: 'fun',
    svg: wrap(
      `<rect x="27" y="10" width="46" height="58" rx="6" fill="#374151" stroke="#111827"/><rect x="27" y="50" width="46" height="12" fill="#ef4444" stroke="#991b1b"/><rect x="8" y="64" width="84" height="15" rx="7.5" fill="#374151" stroke="#111827"/><path d="M36 19V41" fill="none" stroke="#9ca3af" stroke-width="5"/>`,
    ),
  },
  {
    id: 'party-hat',
    name: 'Party Hat',
    pack: 'fun',
    svg: wrap(
      `<path d="M50 12L80 84Q50 94 20 84Z" fill="#a78bfa" stroke="#7c3aed"/><path d="M38 41Q50 46 62 41M30 61Q50 68 70 61" fill="none" stroke="#f472b6" stroke-width="7"/><path d="M50 12L80 84Q50 94 20 84Z" fill="none" stroke="#7c3aed"/><g fill="#fde047" stroke="none"><circle cx="48" cy="30" r="3"/><circle cx="56" cy="52" r="3"/><circle cx="40" cy="52" r="3"/><circle cx="50" cy="76" r="3"/><circle cx="64" cy="74" r="3"/><circle cx="35" cy="74" r="3"/></g><circle cx="50" cy="11" r="9" fill="#fde047" stroke="#eab308"/>`,
    ),
  },
  {
    id: 'magic-wand',
    name: 'Magic Wand',
    pack: 'fun',
    svg: wrap(
      `<path d="M16 90L56 44" stroke="#1e293b" stroke-width="14"/><path d="M16 90L56 44" stroke="#475569" stroke-width="6"/><path d="M46 55.5L56 44" stroke="#fff" stroke-width="6"/><polygon points="${starPts(64, 34, 26, 11)}" fill="#fde047" stroke="#eab308"/><path d="${sparkle(22, 24, 10)}" fill="#67e8f9" stroke="#06b6d4" stroke-width="3.5"/><path d="${sparkle(88, 70, 8)}" fill="#f9a8d4" stroke="#db2777" stroke-width="3.5"/>`,
    ),
  },
  {
    id: 'rainbow',
    name: 'Rainbow',
    pack: 'fun',
    svg: wrap(
      [
        [39, '#dc2626', '#f87171'],
        [30, '#ca8a04', '#fde047'],
        [21, '#16a34a', '#4ade80'],
        [12, '#2563eb', '#60a5fa'],
      ]
        .map(
          ([r, dark, light]) =>
            `<path d="M${50 - (r as number)} 76A${r} ${r} 0 0 1 ${50 + (r as number)} 76" fill="none" stroke="${dark}" stroke-width="10" stroke-linecap="butt"/><path d="M${50 - (r as number)} 76A${r} ${r} 0 0 1 ${50 + (r as number)} 76" fill="none" stroke="${light}" stroke-width="5" stroke-linecap="butt"/>`,
        )
        .join('') +
        `<path d="M2 88Q2 76 12 77Q14 68 24 70Q32 72 30 80Q36 82 34 88Z" fill="#fff" stroke="#60a5fa" stroke-width="4"/><path d="M98 88Q98 76 88 77Q86 68 76 70Q68 72 70 80Q64 82 66 88Z" fill="#fff" stroke="#60a5fa" stroke-width="4"/>`,
    ),
  },
  {
    id: 'balloon',
    name: 'Balloon',
    pack: 'fun',
    svg: wrap(
      `<path d="M50 80C46 86 56 90 50 98" fill="none" stroke="#64748b" stroke-width="3"/><path d="M50 6C72 6 85 24 85 41C85 61 67 73 50 75C33 73 15 61 15 41C15 24 28 6 50 6Z" fill="#f87171" stroke="#dc2626"/><path d="M45 82L50 75L55 82Z" fill="#f87171" stroke="#dc2626" stroke-width="3.5"/><path d="M28 34Q30 22 40 18" ${SHINE}/>`,
    ),
  },
  {
    id: 'wow',
    name: 'Wow',
    pack: 'fun',
    svg: wrap(
      `<path d="M14 12H86Q94 12 94 20V62Q94 70 86 70H46L26 89L31 70H14Q6 70 6 62V20Q6 12 14 12Z" fill="#fff" stroke="#7c3aed"/><text x="50" y="51" text-anchor="middle" font-family="'Arial Rounded MT Bold','Arial Black',Arial,Helvetica,sans-serif" font-weight="900" font-size="27" textLength="74" lengthAdjust="spacingAndGlyphs" fill="#7c3aed" stroke="none">WOW!</text>`,
    ),
  },
  {
    id: 'lightning',
    name: 'Lightning',
    pack: 'fun',
    svg: wrap(`<path d="M60 5L20 56H46L37 95L81 40H55Z" fill="#facc15" stroke="#ca8a04"/><path d="M50 20l-12 16" ${SHINE}/>`),
  },
  {
    id: 'sparkle',
    name: 'Sparkle',
    pack: 'fun',
    svg: wrap(
      `<path d="${sparkle(44, 54, 38)}" fill="#67e8f9" stroke="#06b6d4"/><path d="${sparkle(80, 20, 13)}" fill="#67e8f9" stroke="#06b6d4" stroke-width="3.5"/><path d="${sparkle(84, 78, 9)}" fill="#67e8f9" stroke="#06b6d4" stroke-width="3.5"/><path d="M38 40l-4 8" ${SHINE}/>`,
    ),
  },

  // ---------------------------------------------------------------- faces
  {
    id: 'face-happy',
    name: 'Happy',
    pack: 'faces',
    svg: face(`${dotEyes}${eyeShine}<path d="M30 58Q50 78 70 58" fill="none" stroke="${F}" stroke-width="5"/>`),
  },
  {
    id: 'face-laughing',
    name: 'Laughing',
    pack: 'faces',
    svg: face(
      `<path d="M26 42Q35 31 44 42M56 42Q65 31 74 42" fill="none" stroke="${F}" stroke-width="5"/><path d="M25 54H75Q73 84 50 84Q27 84 25 54Z" fill="${F}" stroke="${F}" stroke-width="3"/><path d="M29 56H71V62H29Z" fill="#fff" stroke="none"/><path d="M37 76Q50 66 63 76Q57 82 50 82Q43 82 37 76Z" fill="#f87171" stroke="none"/><path d="M14 46q-5 9 0 12q5-3 0-12z" fill="#7dd3fc" stroke="#0ea5e9" stroke-width="2.5"/>`,
      false,
    ),
  },
  {
    id: 'face-cool',
    name: 'Cool',
    pack: 'faces',
    svg: face(
      `<path d="M14 37H86" stroke="${F}" stroke-width="5"/><path d="M18 36H47V44Q47 56 32 56Q18 56 18 44Z" fill="${F}"/><path d="M53 36H82V44Q82 56 68 56Q53 56 53 44Z" fill="${F}"/><path d="M25 46l7-6M60 46l7-6" stroke="#fff" stroke-opacity=".7" stroke-width="3.5"/><path d="M36 68Q54 76 68 62" fill="none" stroke="${F}" stroke-width="5"/>`,
      false,
    ),
  },
  {
    id: 'face-heart-eyes',
    name: 'Heart Eyes',
    pack: 'faces',
    svg: face(
      `<path d="${heartPath(34, 40, 11)}" fill="#ef4444" stroke="#b91c1c" stroke-width="3"/><path d="${heartPath(66, 40, 11)}" fill="#ef4444" stroke="#b91c1c" stroke-width="3"/><path d="M30 58Q50 84 70 58Z" fill="${F}" stroke="${F}" stroke-width="3"/><path d="M40 70Q50 64 60 70Q56 75 50 75Q44 75 40 70Z" fill="#f87171" stroke="none"/>`,
    ),
  },
  {
    id: 'face-silly',
    name: 'Silly',
    pack: 'faces',
    svg: face(
      `<circle cx="35" cy="40" r="10" fill="#fff" stroke="${F}" stroke-width="3.5"/><circle cx="37" cy="43" r="4.5" fill="${F}" stroke="none"/><path d="M58 34L71 41L58 48" fill="none" stroke="${F}" stroke-width="5"/><path d="M28 60Q50 70 72 60" fill="none" stroke="${F}" stroke-width="5"/><path d="M43 64V76Q50 88 58 76V63" fill="#f87171" stroke="#dc2626" stroke-width="3.5"/><path d="M50.5 66V76" stroke="#dc2626" stroke-width="2.5"/>`,
    ),
  },
  {
    id: 'face-surprised',
    name: 'Surprised',
    pack: 'faces',
    svg: face(
      `<path d="M26 26Q34 20 42 25M58 25Q66 20 74 26" fill="none" stroke="${F}" stroke-width="4.5"/><circle cx="35" cy="41" r="7" fill="${F}" stroke="none"/><circle cx="65" cy="41" r="7" fill="${F}" stroke="none"/>${eyeShine.replace(/cy="37"/g, 'cy="38.5"')}<ellipse cx="50" cy="68" rx="9" ry="12" fill="${F}" stroke="none"/>`,
      false,
    ),
  },
  {
    id: 'face-wink',
    name: 'Wink',
    pack: 'faces',
    svg: face(
      `<ellipse cx="35" cy="40" rx="5" ry="7" fill="${F}" stroke="none"/><circle cx="36.5" cy="37" r="1.8" fill="#fff" stroke="none"/><path d="M57 42Q65 34 73 42" fill="none" stroke="${F}" stroke-width="5"/><path d="M30 58Q50 78 70 58" fill="none" stroke="${F}" stroke-width="5"/><path d="M52 66Q60 78 66 64" fill="#f87171" stroke="#dc2626" stroke-width="3"/>`,
    ),
  },
  {
    id: 'face-star-eyes',
    name: 'Star Eyes',
    pack: 'faces',
    svg: face(
      `<polygon points="${starPts(34, 40, 12, 5.5)}" fill="#f97316" stroke="#c2410c" stroke-width="3"/><polygon points="${starPts(66, 40, 12, 5.5)}" fill="#f97316" stroke="#c2410c" stroke-width="3"/><path d="M26 56H74Q72 82 50 82Q28 82 26 56Z" fill="${F}" stroke="${F}" stroke-width="3"/><path d="M30 58H70V63H30Z" fill="#fff" stroke="none"/>`,
      false,
    ),
  },

  // ---------------------------------------------------------------- animals
  {
    id: 'cat',
    name: 'Cat',
    pack: 'animals',
    svg: wrap(
      `<path d="M18 32L20 8L40 22Q50 19 60 22L80 8L82 32Q92 44 89 60Q83 87 50 89Q17 87 11 60Q8 44 18 32Z" fill="#fdba74" stroke="#ea580c"/><path d="M24 27L25 16L34 23ZM76 27L75 16L66 23Z" fill="#f9a8d4" stroke="#f9a8d4" stroke-width="2"/><path d="M50 26V34M41 28L43 34M59 28L57 34" stroke="#ea580c" stroke-width="3.5"/>${animalEyes(50)}<path d="M45 60H55L50 66Z" fill="#f472b6" stroke="#db2777" stroke-width="2.5"/><path d="M42 70Q46 74 50 67Q54 74 58 70" fill="none" stroke="${INK}" stroke-width="3"/><path d="M30 62L12 59M30 67L13 70M70 62L88 59M70 67L87 70" stroke="#ea580c" stroke-width="2.5"/>`,
    ),
  },
  {
    id: 'dog',
    name: 'Dog',
    pack: 'animals',
    svg: wrap(
      `<circle cx="50" cy="54" r="35" fill="#e7b98a" stroke="#a16207"/><path d="M38 34Q30 30 26 40Q28 50 38 48Q44 42 38 34Z" fill="#c08457" stroke="none"/><path d="M24 22Q6 22 7 48Q8 66 20 64Q30 50 32 28Z" fill="#92400e" stroke="#78350f"/><path d="M76 22Q94 22 93 48Q92 66 80 64Q70 50 68 28Z" fill="#92400e" stroke="#78350f"/>${animalEyes(46, 14)}<ellipse cx="50" cy="68" rx="18" ry="14" fill="#fef3c7" stroke="#a16207" stroke-width="3.5"/><ellipse cx="50" cy="62" rx="7" ry="5" fill="${INK}" stroke="none"/><path d="M44 72Q50 76 56 72" fill="none" stroke="${INK}" stroke-width="3"/><path d="M47 75V81Q50 86 53 81V75" fill="#f87171" stroke="#dc2626" stroke-width="2.5"/>`,
    ),
  },
  {
    id: 'bunny',
    name: 'Bunny',
    pack: 'animals',
    svg: wrap(
      `<path d="M38 46Q22 4 33 4Q46 4 46 44Z" fill="#f8fafc" stroke="#94a3b8"/><path d="M62 46Q78 4 67 4Q54 4 54 44Z" fill="#f8fafc" stroke="#94a3b8"/><path d="M39 38Q30 14 34 12Q40 12 42 38ZM61 38Q70 14 66 12Q60 12 58 38Z" fill="#f9a8d4" stroke="none"/><ellipse cx="50" cy="64" rx="33" ry="28" fill="#f8fafc" stroke="#94a3b8"/>${animalEyes(60, 14)}<g fill="#f9a8d4" stroke="none"><circle cx="26" cy="70" r="5"/><circle cx="74" cy="70" r="5"/></g><path d="M46 68H54L50 72Z" fill="#f472b6" stroke="#db2777" stroke-width="2.5"/><path d="M50 72V76M44 76Q47 79 50 76Q53 79 56 76" fill="none" stroke="${INK}" stroke-width="2.5"/><rect x="46" y="78" width="8" height="7" rx="1.5" fill="#fff" stroke="#94a3b8" stroke-width="2"/>`,
    ),
  },
  {
    id: 'bear',
    name: 'Bear',
    pack: 'animals',
    svg: wrap(
      `<circle cx="22" cy="24" r="13" fill="#c08457" stroke="#7c4a1e"/><circle cx="78" cy="24" r="13" fill="#c08457" stroke="#7c4a1e"/><circle cx="22" cy="24" r="6" fill="#e7b98a" stroke="none"/><circle cx="78" cy="24" r="6" fill="#e7b98a" stroke="none"/><circle cx="50" cy="55" r="36" fill="#c08457" stroke="#7c4a1e"/>${animalEyes(47, 14)}<ellipse cx="50" cy="68" rx="16" ry="13" fill="#e7b98a" stroke="#7c4a1e" stroke-width="3.5"/><ellipse cx="50" cy="63" rx="6.5" ry="4.5" fill="${INK}" stroke="none"/><path d="M50 67V71M44 72Q47 76 50 71Q53 76 56 72" fill="none" stroke="${INK}" stroke-width="3"/>`,
    ),
  },
  {
    id: 'unicorn',
    name: 'Unicorn',
    pack: 'animals',
    svg: wrap(
      `<circle cx="29" cy="30" r="11" fill="#f9a8d4" stroke="#db2777"/><circle cx="24" cy="48" r="11" fill="#c4b5fd" stroke="#7c3aed"/><circle cx="27" cy="66" r="10" fill="#7dd3fc" stroke="#0284c7"/><path d="M34 32L30 16L44 26ZM66 32L70 16L56 26Z" fill="#fff" stroke="#a78bfa"/><ellipse cx="50" cy="56" rx="24" ry="33" fill="#fff" stroke="#a78bfa"/><circle cx="37" cy="29" r="8" fill="#f9a8d4" stroke="#db2777"/><path d="M42 31L50 1L58 31Z" fill="#fde047" stroke="#eab308"/><path d="M46 16L54 13M44.5 23L55.5 20" stroke="#eab308" stroke-width="2.5"/><ellipse cx="50" cy="77" rx="17" ry="11" fill="#fbcfe8" stroke="#a78bfa" stroke-width="3.5"/><g fill="#db2777" stroke="none"><circle cx="44" cy="77" r="2.5"/><circle cx="56" cy="77" r="2.5"/></g><path d="M35 52Q40 58 45 52M55 52Q60 58 65 52M36 54L33 57M64 54L67 57" fill="none" stroke="${INK}" stroke-width="3"/><g fill="#f9a8d4" stroke="none" opacity=".8"><circle cx="32" cy="63" r="4"/><circle cx="68" cy="63" r="4"/></g>`,
    ),
  },
  {
    id: 'dino',
    name: 'Dino',
    pack: 'animals',
    svg: wrap(
      `<path d="M24 50L28 38L35 46L41 34L47 44L53 33L58 45Z" fill="#fb923c" stroke="#ea580c" stroke-width="3.5"/><path d="M22 72Q4 74 2 58Q14 66 26 60Z" fill="#86efac" stroke="#16a34a"/><ellipse cx="44" cy="68" rx="28" ry="21" fill="#86efac" stroke="#16a34a"/><path d="M54 58Q50 30 70 24Q92 20 95 38Q97 54 78 55Q70 56 68 66Z" fill="#86efac" stroke="#16a34a"/><ellipse cx="44" cy="74" rx="16" ry="11" fill="#dcfce7" stroke="none"/><rect x="26" y="80" width="12" height="14" rx="6" fill="#86efac" stroke="#16a34a"/><rect x="50" y="80" width="12" height="14" rx="6" fill="#86efac" stroke="#16a34a"/><ellipse cx="76" cy="34" rx="4.5" ry="5.5" fill="${INK}" stroke="none"/><circle cx="77.5" cy="32" r="1.6" fill="#fff" stroke="none"/><path d="M76 46Q85 50 92 44" fill="none" stroke="${INK}" stroke-width="3"/><circle cx="90" cy="34" r="1.8" fill="#16a34a" stroke="none"/><circle cx="68" cy="42" r="4" fill="#f9a8d4" stroke="none" opacity=".8"/>`,
    ),
  },
  {
    id: 'butterfly',
    name: 'Butterfly',
    pack: 'animals',
    svg: wrap(
      `${WING}<g transform="translate(100 0) scale(-1 1)">${WING}</g><path d="M47 30Q40 14 34 12M53 30Q60 14 66 12" fill="none" stroke="#1e293b" stroke-width="3"/><rect x="44.5" y="28" width="11" height="52" rx="5.5" fill="#475569" stroke="#1e293b" stroke-width="3.5"/>`,
    ),
  },
  {
    id: 'fish',
    name: 'Fish',
    pack: 'animals',
    svg: wrap(
      `<path d="M24 50L4 30Q9 50 4 70Z" fill="#fb923c" stroke="#ea580c"/><path d="M46 28Q56 12 70 26" fill="#fb923c" stroke="#ea580c"/><path d="M16 50Q34 18 66 25Q86 31 91 50Q86 69 66 75Q34 82 16 50Z" fill="#fb923c" stroke="none"/><path d="M42 26Q34 50 42 77M64 25Q58 50 64 75" fill="none" stroke="#fff" stroke-width="8" stroke-linecap="butt"/><path d="M16 50Q34 18 66 25Q86 31 91 50Q86 69 66 75Q34 82 16 50Z" fill="none" stroke="#ea580c"/><ellipse cx="75" cy="44" rx="4.5" ry="5.5" fill="${INK}" stroke="none"/><circle cx="76.5" cy="42" r="1.6" fill="#fff" stroke="none"/><path d="M76 58Q82 60 86 55" fill="none" stroke="${INK}" stroke-width="3"/><circle cx="92" cy="22" r="4" fill="none" stroke="#38bdf8" stroke-width="3"/><circle cx="84" cy="12" r="2.5" fill="none" stroke="#38bdf8" stroke-width="2.5"/>`,
    ),
  },

  // ---------------------------------------------------------------- weather
  {
    id: 'sun',
    name: 'Sun',
    pack: 'weather',
    svg: wrap(
      `<g fill="#fde047" stroke="#f59e0b" stroke-width="4">${[0, 45, 90, 135, 180, 225, 270, 315]
        .map((a) => `<path d="M50 3L58 19H42Z" transform="rotate(${a} 50 50)"/>`)
        .join('')}</g><circle cx="50" cy="50" r="27" fill="#fde047" stroke="#f59e0b"/><g fill="${F}" stroke="none"><ellipse cx="41" cy="46" rx="3.5" ry="4.5"/><ellipse cx="59" cy="46" rx="3.5" ry="4.5"/></g><path d="M40 56Q50 65 60 56" fill="none" stroke="${F}" stroke-width="4"/><g fill="#fb923c" opacity=".45" stroke="none"><circle cx="34" cy="56" r="4"/><circle cx="66" cy="56" r="4"/></g>`,
    ),
  },
  {
    id: 'cloud',
    name: 'Cloud',
    pack: 'weather',
    svg: wrap(
      `<path d="${CLOUD}" fill="#fff" stroke="#60a5fa"/><g fill="#1e3a8a" stroke="none"><circle cx="42" cy="54" r="3.5"/><circle cx="62" cy="54" r="3.5"/></g><path d="M46 62Q52 67 58 62" fill="none" stroke="#1e3a8a" stroke-width="3.5"/><g fill="#f9a8d4" stroke="none" opacity=".8"><circle cx="34" cy="62" r="4"/><circle cx="70" cy="62" r="4"/></g>`,
    ),
  },
  {
    id: 'rain-cloud',
    name: 'Rain',
    pack: 'weather',
    svg: wrap(
      `<g fill="#38bdf8" stroke="#0284c7" stroke-width="3"><path d="M28 74q-6 10 0 14q6-4 0-14z"/><path d="M50 78q-6 10 0 14q6-4 0-14z"/><path d="M72 74q-6 10 0 14q6-4 0-14z"/></g><path d="${CLOUD}" transform="translate(0 -16)" fill="#cbd5e1" stroke="#64748b"/><g fill="#334155" stroke="none"><circle cx="42" cy="40" r="3.5"/><circle cx="62" cy="40" r="3.5"/></g><path d="M46 49Q52 45 58 49" fill="none" stroke="#334155" stroke-width="3.5"/>`,
    ),
  },
  {
    id: 'snowflake',
    name: 'Snowflake',
    pack: 'weather',
    svg: wrap(`${snowArms('#0ea5e9', 11)}${snowArms('#e0f2fe', 5)}<circle cx="50" cy="50" r="7" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="3.5"/>`),
  },
  {
    id: 'umbrella',
    name: 'Umbrella',
    pack: 'weather',
    svg: wrap(
      `<path d="M50 54V84Q50 94 40 94Q31 94 31 85" fill="none" stroke="#334155" stroke-width="10"/><path d="M50 54V84Q50 94 40 94Q31 94 31 85" fill="none" stroke="#64748b" stroke-width="4"/><path d="M50 12V5" stroke="#334155" stroke-width="5"/><path d="M8 54Q12 12 50 12Q88 12 92 54Q81.5 44 71 54Q60.5 44 50 54Q39.5 44 29 54Q18.5 44 8 54Z" fill="#f472b6" stroke="#be185d"/><path d="M50 12Q36 30 29 54Q39.5 44 50 54Q60.5 44 71 54Q64 30 50 12Z" fill="#fbcfe8" stroke="#be185d" stroke-width="3.5"/>`,
    ),
  },
  {
    id: 'tornado',
    name: 'Tornado',
    pack: 'weather',
    svg: wrap(
      `<path d="M8 16Q50 4 92 16Q88 30 72 35Q74 46 61 53Q65 64 54 71Q58 82 48 94Q42 82 45 73Q36 63 43 55Q28 47 32 37Q12 31 8 16Z" fill="#cbd5e1" stroke="#64748b"/><path d="M18 22Q50 30 82 20M34 38Q52 43 70 35M44 55Q54 58 61 53M46 72Q51 74 54 71" fill="none" stroke="#64748b" stroke-width="3.5"/><g fill="#94a3b8" stroke="none"><circle cx="16" cy="56" r="3"/><circle cx="80" cy="70" r="3.5"/><circle cx="24" cy="80" r="2.5"/></g>`,
    ),
  },
]

/** Lookup by id; undefined if unknown (e.g. a sticker removed in a later version). */
export function getSticker(id: string): StickerDef | undefined {
  return STICKERS.find((s) => s.id === id)
}
