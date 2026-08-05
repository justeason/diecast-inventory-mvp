'use client'

import { useEffect } from 'react'

// Wraps the root layout — must include its own <html>/<body>.
export default function GlobalErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') {
      console.error('[global-error]', error.message)
    }
  }, [error])

  return (
    <html lang="en">
      <body>
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center font-sans">
          <h1 className="text-xl font-semibold text-gray-900">Something went wrong</h1>
          <p className="text-sm text-gray-500 max-w-sm">
            An unexpected error occurred. Please try again, or contact support if the problem persists.
          </p>
          {error.digest && (
            <p className="text-xs font-mono text-gray-400">Reference: {error.digest}</p>
          )}
          <button
            onClick={() => reset()}
            style={{ background: '#111827', color: '#fff', borderRadius: 6, padding: '8px 16px', fontSize: 14, cursor: 'pointer', border: 'none' }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  )
}
