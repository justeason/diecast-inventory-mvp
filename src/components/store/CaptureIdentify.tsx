'use client'

import { useActionState, useState, useRef, useEffect } from 'react'
import Link from 'next/link'
import { identifyModelFromPhoto, type IdentifyResultState, type IdentifyCandidate } from '@/lib/actions/captureIdentify'
import { PhotoThumbnail } from '@/components/shared/PhotoThumbnail'

const CONFIDENCE_LABELS: Record<IdentifyCandidate['confidence'], string> = {
  exact: 'Likely match',
  strong: 'Likely match',
  possible: 'Possible match',
}

function availabilityLabel(c: IdentifyCandidate): string {
  if (c.availableCount === 0) return 'No copies currently available'
  return `${c.availableCount} ${c.availableCount === 1 ? 'copy' : 'copies'} available`
}

// 16K: public, anonymous-friendly Quick Capture identification. Distinct from
// CatalogImageSearch.tsx (the compact authenticated picker embedded in
// CaptureWizard/CollectionItemForm/WantedListAddForm, left untouched) — this is a
// full-page identify-first result view with "View Model" links to /catalog/[id]
// only. No Want/Own/Sell here: those stay on the model hub (CatalogModelActions),
// per the explicit "keep result CTA to View Model" decision — adding relationship
// actions here would require a private per-candidate relationship query on a
// route that must otherwise stay fully public/anonymous-fast.
export function CaptureIdentify() {
  const [state, formAction, isPending] = useActionState<IdentifyResultState, FormData>(identifyModelFromPhoto, null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const objectUrlRef = useRef<string | null>(null)

  useEffect(() => () => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
  }, [])

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = null
    }
    const file = e.target.files?.[0]
    if (file) {
      const url = URL.createObjectURL(file)
      objectUrlRef.current = url
      setPreviewUrl(url)
    } else {
      setPreviewUrl(null)
    }
  }

  const candidates = state?.candidates ?? null
  const isSingleConfident =
    candidates !== null &&
    candidates.length === 1 &&
    (candidates[0].confidence === 'exact' || candidates[0].confidence === 'strong')

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Identify a Model</h1>
        <p className="mt-1 text-sm text-gray-500">
          Take or upload a photo and we&apos;ll try to match it to a model in our catalog.
        </p>
      </div>

      <form action={formAction} className="flex flex-col gap-3">
        <label htmlFor="capture-image" className="block text-sm font-medium text-gray-700">
          Photo
        </label>
        <input
          id="capture-image"
          type="file"
          name="image"
          accept="image/jpeg,image/png,image/webp"
          capture="environment"
          onChange={handleFileChange}
          disabled={isPending}
          className="text-sm text-gray-600 file:mr-3 file:rounded-md file:border-0 file:bg-gray-900 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-gray-700 cursor-pointer"
        />

        {previewUrl && (
          <div className="w-40 h-40 rounded-md overflow-hidden border border-gray-200 bg-gray-50 relative">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={previewUrl} alt="Selected photo preview" className="w-full h-full object-contain" />
          </div>
        )}

        <button
          type="submit"
          disabled={isPending || !previewUrl}
          className="self-start rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-40 transition-colors"
        >
          {isPending ? 'Analyzing…' : 'Identify'}
        </button>
      </form>

      {state?.error && (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      )}

      {candidates && candidates.length === 0 && !state?.error && (
        <div className="rounded-md border border-dashed border-gray-300 px-6 py-8 text-center space-y-2">
          <p className="text-sm text-gray-700">We couldn&apos;t confidently identify this model.</p>
          {state?.lowCoverage && (
            <p className="text-xs text-gray-400">We&apos;re still building our photo index, so results may be limited.</p>
          )}
          <div className="pt-1">
            <Link href="/catalog" className="text-sm text-gray-700 underline underline-offset-2">
              Search Models
            </Link>
          </div>
        </div>
      )}

      {candidates && candidates.length > 0 && (
        <section aria-labelledby="capture-results-heading">
          <h2 id="capture-results-heading" className="text-sm font-semibold text-gray-900 mb-3">
            {isSingleConfident ? 'Likely Match' : 'Possible Matches'}
          </h2>
          <ul className="space-y-3">
            {candidates.map((c) => (
              <li key={c.catalogModelId} className="rounded-lg border border-gray-200 bg-white p-4 flex items-center gap-4">
                <div className="w-16 h-16 shrink-0 rounded overflow-hidden border border-gray-100 bg-gray-50 relative">
                  <PhotoThumbnail photoUrl={c.photoUrl} alt={`${c.brand} ${c.name}`} size="fill" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-gray-900 truncate">
                    {c.brand} {c.name}
                    {c.year && <span className="text-gray-500 font-normal"> ({c.year})</span>}
                  </p>
                  {(c.series || c.color || c.scale) && (
                    <p className="text-xs text-gray-500 truncate">{[c.series, c.color, c.scale].filter(Boolean).join(' · ')}</p>
                  )}
                  <p className="text-xs text-gray-500 mt-1">
                    {CONFIDENCE_LABELS[c.confidence]} <span aria-hidden="true">·</span> {availabilityLabel(c)}
                  </p>
                </div>
                <Link
                  href={`/catalog/${c.catalogModelId}`}
                  className="shrink-0 rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  View Model
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
