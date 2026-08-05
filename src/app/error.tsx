'use client'

import { useEffect } from 'react'

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // Log to console in development only — production uses structured server logging.
    if (process.env.NODE_ENV !== 'production') {
      console.error('[client-error]', error.message)
    }
  }, [error])

  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-4 px-4 text-center">
      <h2 className="text-lg font-semibold text-gray-900">Something went wrong</h2>
      <p className="text-sm text-gray-500 max-w-sm">
        An unexpected error occurred. Please try again, or contact support if the problem persists.
      </p>
      {error.digest && (
        <p className="text-xs font-mono text-gray-400">Reference: {error.digest}</p>
      )}
      <button
        onClick={() => reset()}
        className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 transition-colors"
      >
        Try again
      </button>
    </div>
  )
}
