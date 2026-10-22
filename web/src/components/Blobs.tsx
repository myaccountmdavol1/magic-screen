/** The three fixed, blurred color blobs behind everything (Talkline background warmth). */
export function Blobs() {
  return (
    <div aria-hidden="true">
      <div className="blob blob-sun" />
      <div className="blob blob-sky" />
      <div className="blob blob-pink" />
    </div>
  )
}
