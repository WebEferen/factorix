'use client'

/** The last resort, when the root layout itself fails. It replaces the whole document, so it carries its own styles. */
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <body
        style={{ margin: 0, display: 'grid', placeItems: 'center', minHeight: '100dvh', fontFamily: 'system-ui, sans-serif', textAlign: 'center' }}
      >
        <div>
          <h1 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Factorix hit a problem</h1>
          <p style={{ fontSize: 14, margin: '8px 0 16px' }}>Reloading usually fixes it.</p>
          <button type="button" onClick={reset} style={{ font: 'inherit', fontSize: 14, padding: '6px 12px', cursor: 'pointer' }}>
            Try again
          </button>
        </div>
      </body>
    </html>
  )
}
