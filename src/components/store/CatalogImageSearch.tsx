'use client'

import { useActionState, useState, useRef, useEffect } from 'react'
import type { ImageSearchState } from '@/lib/actions/catalogImageMatching'
import type { CatalogMatchCandidate } from '@/lib/catalogImageMatching'
import type { CatalogSearchResult } from '@/lib/catalogFormat'

type Props = {
  onSelect:     (model: CatalogSearchResult) => void
  searchAction: (prev: ImageSearchState, formData: FormData) => Promise<ImageSearchState>
  disabled?:    boolean
}

const CONFIDENCE_BADGE: Record<string, { label: string; cls: string }> = {
  exact:    { label: 'Exact',    cls: 'bg-green-100 text-green-800'  },
  strong:   { label: 'Strong',   cls: 'bg-blue-100  text-blue-800'   },
  possible: { label: 'Possible', cls: 'bg-yellow-100 text-yellow-800' },
}

export function CatalogImageSearch({ onSelect, searchAction, disabled }: Props) {
  const [state, formAction, isPending] = useActionState<ImageSearchState, FormData>(searchAction, null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const objectUrlRef = useRef<string | null>(null)

  // Revoke object URL on unmount to free browser memory
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

  function handleSelect(candidate: CatalogMatchCandidate) {
    onSelect({
      id:     candidate.catalogModelId,
      brand:  candidate.brand,
      name:   candidate.name,
      series: null,
      year:   candidate.year,
      color:  null,
      scale:  null,
    })
  }

  return (
    <div className="rounded-md border border-gray-200 bg-gray-50 p-3 space-y-2">
      <p className="text-xs font-medium text-gray-600">Search by photo</p>

      <form action={formAction} className="space-y-2">
        <input
          type="file"
          name="image"
          accept="image/jpeg,image/png,image/webp"
          capture="environment"
          onChange={handleFileChange}
          disabled={disabled}
          className="text-sm text-gray-600 file:mr-2 file:rounded file:border-0 file:bg-white file:px-2 file:py-1 file:text-xs file:font-medium file:text-gray-700 hover:file:bg-gray-100 cursor-pointer"
        />

        {previewUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={previewUrl}
            alt="Preview"
            className="max-h-24 max-w-[140px] rounded border border-gray-200 object-contain bg-white"
          />
        )}

        <button
          type="submit"
          disabled={isPending || !previewUrl || disabled}
          className="rounded border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-white disabled:opacity-40 transition-colors"
        >
          {isPending ? 'Searching…' : 'Find matching models'}
        </button>
      </form>

      {state?.error && (
        <p className="text-xs text-red-600">{state.error}</p>
      )}

      {state?.lowCoverage && !state?.error && state?.coverageReason === 'small_index' && (
        <p className="text-xs text-amber-700">Catalog image coverage is limited — add more reference photos to improve matching.</p>
      )}

      {state?.lowCoverage && !state?.error && state?.coverageReason === 'no_band_candidates' && (state?.results?.length ?? 0) === 0 && (
        <p className="text-xs text-gray-400">No indexed candidates were found; text search may still help.</p>
      )}

      {state?.results && state.results.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs text-gray-500 font-medium">Photo matches</p>
          <div className="max-h-64 overflow-y-auto space-y-1">
            {state.results.map(c => {
              const badge = CONFIDENCE_BADGE[c.confidence]
              return (
                <div
                  key={c.catalogModelId}
                  className="flex items-center gap-2 rounded bg-white border border-gray-200 px-2 py-1.5"
                >
                  {c.photo?.url && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={c.photo.url}
                      alt={c.photo.altText ?? `${c.brand} ${c.name}`}
                      className="w-8 h-8 rounded object-contain bg-gray-50 shrink-0"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-gray-900 truncate">
                      {c.brand} {c.name}
                      {c.year && <span className="ml-1 text-gray-400">({c.year})</span>}
                    </p>
                    <div className="flex items-center gap-1 mt-0.5">
                      {badge && (
                        <span className={`rounded px-1 py-0.5 text-xs font-medium ${badge.cls}`}>
                          {badge.label}
                        </span>
                      )}
                      <span className="text-xs text-gray-300">d={c.bestDistance}</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleSelect(c)}
                    className="shrink-0 rounded bg-gray-900 px-2 py-1 text-xs font-medium text-white hover:bg-gray-700 transition-colors"
                  >
                    Select
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
