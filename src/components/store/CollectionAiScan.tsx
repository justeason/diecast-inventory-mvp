'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import Link from 'next/link'
import {
  extractCollectionItemFields,
  type CollectionAiActionState,
} from '@/lib/actions/collectionAi'

type Props = {
  itemId: string
  hasPhotos: boolean
  aiExtractionConfidence: number | null
  aiExtractionNotes: string | null
  aiExtractedAt: Date | null
}

function ScanButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
    >
      {pending ? 'Scanning…' : 'Scan photos with AI'}
    </button>
  )
}

export function CollectionAiScan({
  itemId,
  hasPhotos,
  aiExtractionConfidence,
  aiExtractionNotes,
  aiExtractedAt,
}: Props) {
  const action = extractCollectionItemFields.bind(null, itemId)
  const [state, formAction] = useActionState<CollectionAiActionState, FormData>(action, null)

  return (
    <div className="rounded-md border border-gray-200 bg-gray-50 p-4 mb-6">
      <h2 className="text-sm font-semibold text-gray-900 mb-1">AI Photo Scan</h2>

      {!hasPhotos ? (
        <p className="text-sm text-gray-500">Upload a photo first to use AI scan.</p>
      ) : (
        <>
          <p className="text-xs text-gray-500 mb-3">
            AI will suggest missing item details from your photo. It will not overwrite fields you
            already entered.
          </p>

          <form action={formAction}>
            {'error' in (state ?? {}) && (
              <p className="text-sm text-red-600 mb-2">
                {(state as { error: string }).error}
              </p>
            )}
            <ScanButton />
          </form>

          {aiExtractedAt && (
            <div className="mt-3 pt-3 border-t border-gray-200 space-y-1 text-xs text-gray-500">
              {aiExtractionConfidence != null && aiExtractionConfidence < 0.5 && (
                <p className="text-amber-600 font-medium">
                  AI is uncertain. Please review the details before relying on them.
                </p>
              )}
              {aiExtractionConfidence != null && (
                <p>Confidence: {Math.round(aiExtractionConfidence * 100)}%</p>
              )}
              {aiExtractionNotes && <p>AI notes: {aiExtractionNotes}</p>}
              <p>Last scanned: {new Date(aiExtractedAt).toLocaleString()}</p>
              <Link
                href={`/account/collection/${itemId}/edit`}
                className="inline-block text-gray-700 underline hover:text-gray-900"
              >
                Review or edit details
              </Link>
            </div>
          )}
        </>
      )}
    </div>
  )
}
