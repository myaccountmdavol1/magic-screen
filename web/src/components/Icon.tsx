import type { ReactNode } from 'react'

export type IconName =
  | 'back'
  | 'next'
  | 'speaker'
  | 'camera'
  | 'video'
  | 'photo'
  | 'flip'
  | 'plus'
  | 'minus'
  | 'reset'
  | 'trash'
  | 'close'
  | 'check'
  | 'play'
  | 'pause'
  | 'stop'
  | 'save'
  | 'share'
  | 'gear'
  | 'home'
  | 'upload'
  | 'sparkle'
  | 'finger'
  | 'star'
  | 'lock'
  | 'download'
  | 'refresh'
  | 'image'
  | 'smile'
  | 'move'
  | 'edgeIn'
  | 'edgeOut'

/**
 * Line icons on a 24-grid. Everything strokes with currentColor so an icon
 * always matches the text/button color it sits in (Talkline style).
 */
const PATHS: Record<IconName, ReactNode> = {
  back: <path d="M15 5l-7 7 7 7" />,
  next: <path d="M9 5l7 7-7 7" />,
  speaker: (
    <>
      <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
      <path d="M15.5 9a4 4 0 0 1 0 6" />
      <path d="M18 6.5a7.5 7.5 0 0 1 0 11" />
    </>
  ),
  camera: (
    <>
      <path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.2l1.6-2.2h5.4L16.3 7h2.2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z" />
      <circle cx="12" cy="13" r="3.4" />
    </>
  ),
  video: (
    <>
      <rect x="3" y="6.5" width="12.5" height="11" rx="2.2" />
      <path d="M15.5 10.5l5-3v9l-5-3z" />
    </>
  ),
  photo: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="M20.5 15.5l-4.5-4.5-8.5 8" />
    </>
  ),
  flip: (
    <>
      <path d="M4 12a8 8 0 0 1 13.7-5.6L20 8.5" />
      <path d="M20 4v4.5h-4.5" />
      <path d="M20 12a8 8 0 0 1-13.7 5.6L4 15.5" />
      <path d="M4 20v-4.5h4.5" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  reset: (
    <>
      <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" />
      <path d="M4.5 4.5v4h4" />
    </>
  ),
  trash: (
    <>
      <path d="M4.5 7h15" />
      <path d="M9.5 7V5h5v2" />
      <path d="M6.5 7l1 12.5h9l1-12.5" />
      <path d="M10.5 11v5M13.5 11v5" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6L6 18" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  play: <path d="M8 5.5v13l10.5-6.5z" />,
  pause: <path d="M8.5 5.5v13M15.5 5.5v13" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2.5" />,
  save: (
    <>
      <path d="M12 4v11" />
      <path d="M7.5 10.5L12 15l4.5-4.5" />
      <path d="M5 16.5V19h14v-2.5" />
    </>
  ),
  share: (
    <>
      <path d="M12 3.5v11" />
      <path d="M8 7.5l4-4 4 4" />
      <path d="M8.5 10.5H6.5A1.5 1.5 0 0 0 5 12v6.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V12a1.5 1.5 0 0 0-1.5-1.5h-2" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" />
    </>
  ),
  home: (
    <>
      <path d="M4 11l8-6.5 8 6.5" />
      <path d="M6.5 9.5V19.5h11V9.5" />
      <path d="M10 19.5v-5h4v5" />
    </>
  ),
  upload: (
    <>
      <path d="M12 15V4" />
      <path d="M7.5 8.5L12 4l4.5 4.5" />
      <path d="M5 15v4h14v-4" />
    </>
  ),
  sparkle: (
    <>
      <path d="M11 3.5l1.8 5.2 5.2 1.8-5.2 1.8L11 17.5l-1.8-5.2L4 10.5l5.2-1.8z" />
      <path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" />
    </>
  ),
  finger: (
    <>
      <path d="M9.5 12V5.5a1.5 1.5 0 0 1 3 0V11" />
      <path d="M12.5 10.5a1.5 1.5 0 0 1 3 0V12" />
      <path d="M15.5 11.5a1.5 1.5 0 0 1 3 0v3a6 6 0 0 1-6 6h-1a6 6 0 0 1-4.6-2.2L5 15.5a1.5 1.5 0 0 1 2.3-1.9L9.5 16" />
    </>
  ),
  star: <path d="M12 3.8l2.5 5.1 5.6.8-4 4 .9 5.6-5-2.7-5 2.7.9-5.6-4-4 5.6-.8z" />,
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="2.5" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
      <path d="M12 14.5v2" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v11" />
      <path d="M7.5 10.5L12 15l4.5-4.5" />
      <path d="M5 19.5h14" />
    </>
  ),
  refresh: (
    <>
      <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
      <path d="M19.5 4.5v4h-4" />
    </>
  ),
  image: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="M3.5 16l5-5 4 4 2.5-2.5 5.5 5.5" />
      <circle cx="15.5" cy="9" r="1.5" />
    </>
  ),
  smile: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.5 14a4.5 4.5 0 0 0 7 0" />
      <path d="M9 9.8v.4M15 9.8v.4" />
    </>
  ),
  move: (
    <>
      <path d="M12 3v18M3 12h18" />
      <path d="M9.5 5.5L12 3l2.5 2.5M9.5 18.5L12 21l2.5-2.5M5.5 9.5L3 12l2.5 2.5M18.5 9.5L21 12l-2.5 2.5" />
    </>
  ),
  // Outline control: a little person with arrows hugging in (tighter) or pushing out (looser).
  edgeIn: (
    <>
      <circle cx="12" cy="8.5" r="2.8" />
      <path d="M8 19.5a4 4 0 0 1 8 0" />
      <path d="M2.5 13h3.5M4.5 11l2 2-2 2M21.5 13H18M19.5 11l-2 2 2 2" />
    </>
  ),
  edgeOut: (
    <>
      <circle cx="12" cy="8.5" r="2.8" />
      <path d="M8 19.5a4 4 0 0 1 8 0" />
      <path d="M6 13H2.5M4.5 11l-2 2 2 2M18 13h3.5M19.5 11l2 2-2 2" />
    </>
  ),
}

export function Icon({ name, size = 24, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  )
}
