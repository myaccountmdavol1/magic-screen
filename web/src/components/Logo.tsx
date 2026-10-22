/** Yellow tile with a smiling TV wearing a sparkle — the Magic Screen face. */
function LogoMark() {
  return (
    <span className="logo-mark" aria-hidden="true">
      <svg viewBox="0 0 40 40" width="32" height="32">
        {/* antenna */}
        <path d="M15 8l5 5 5-5" fill="none" stroke="#1b3a6b" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        {/* screen body */}
        <rect x="6" y="12.5" width="28" height="20" rx="6" fill="#7cc6f5" stroke="#2f8fef" strokeWidth="2.6" />
        {/* green-screen glow inside */}
        <rect x="10" y="16" width="20" height="13" rx="3.5" fill="#86efac" opacity=".55" />
        <circle cx="16" cy="21.5" r="1.7" fill="#1b3a6b" />
        <circle cx="24" cy="21.5" r="1.7" fill="#1b3a6b" />
        <path d="M16 25.2q4 3 8 0" fill="none" stroke="#1b3a6b" strokeWidth="2" strokeLinecap="round" />
        {/* sparkle */}
        <path d="M32.5 4.5l1.2 3.1 3.1 1.2-3.1 1.2-1.2 3.1-1.2-3.1-3.1-1.2 3.1-1.2z" fill="#fff" stroke="#ec4899" strokeWidth="1.3" strokeLinejoin="round" />
      </svg>
    </span>
  )
}

const ACCENTS = ['pink', 'sun', 'mint', 'blue', 'pink', 'sun'] as const

/**
 * Wordmark: "Magic" in deep blue, "Screen" letters in rotating Talkline accents.
 * Renders as a button (going home) when onClick is passed.
 */
export function Logo({ onClick }: { onClick?: () => void }) {
  const content = (
    <>
      <LogoMark />
      <span className="wordmark" aria-hidden="true">
        Magic{' '}
        {'Screen'.split('').map((ch, i) => (
          <span key={i} className={ACCENTS[i]}>
            {ch}
          </span>
        ))}
      </span>
    </>
  )
  if (onClick) {
    return (
      <button type="button" className="logo logo-button" onClick={onClick} aria-label="Magic Screen, go home">
        {content}
      </button>
    )
  }
  return (
    <span className="logo" role="img" aria-label="Magic Screen">
      {content}
    </span>
  )
}
