'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { type CatalogSearchResult, formatCatalogResult } from '@/lib/catalogFormat'

type Props = {
  name: string
  defaultValue?: string
  defaultLabel?: string
  initialQuery?: string
  onSelect?: (model: CatalogSearchResult | null) => void
  placeholder?: string
}

export function CatalogModelSearch({
  name,
  defaultValue = '',
  defaultLabel = '',
  initialQuery = '',
  onSelect,
  placeholder = 'Search by brand, name, year, color…',
}: Props) {
  const [query, setQuery] = useState(initialQuery)
  const [results, setResults] = useState<CatalogSearchResult[]>([])
  const [selectedId, setSelectedId] = useState(defaultValue)
  const [selectedLabel, setSelectedLabel] = useState(defaultLabel)
  const [isOpen, setIsOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [hasError, setHasError] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const doSearch = useCallback(async (q: string) => {
    const trimmed = q.trim()
    if (trimmed.length < 2) {
      setResults([])
      setIsOpen(false)
      setHasSearched(false)
      setHasError(false)
      return
    }
    setIsLoading(true)
    setHasError(false)
    try {
      const res = await fetch(`/api/catalog/search?q=${encodeURIComponent(trimmed)}`)
      if (!res.ok) throw new Error()
      const data: CatalogSearchResult[] = await res.json()
      setResults(data)
      setHasSearched(true)
      setIsOpen(true)
    } catch {
      setHasError(true)
      setResults([])
      setIsOpen(false)
    } finally {
      setIsLoading(false)
    }
  }, [])

  // Auto-search on mount when initialQuery is provided and no default selection.
  // Wrapped in setTimeout so setState calls happen in a callback, not synchronously
  // in the effect body (satisfies react-hooks/set-state-in-effect).
  useEffect(() => {
    if (initialQuery.trim().length >= 2 && !defaultValue) {
      const t = setTimeout(() => { void doSearch(initialQuery) }, 0)
      return () => clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  // Close dropdown on outside click
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [])

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value
    setQuery(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => doSearch(value), 300)
  }

  function handleSelect(model: CatalogSearchResult) {
    setSelectedId(model.id)
    setSelectedLabel(formatCatalogResult(model))
    setQuery('')
    setResults([])
    setIsOpen(false)
    setHasSearched(false)
    onSelect?.(model)
  }

  function handleClear() {
    setSelectedId('')
    setSelectedLabel('')
    setQuery('')
    setResults([])
    setIsOpen(false)
    setHasSearched(false)
    onSelect?.(null)
  }

  return (
    <div ref={containerRef} className="relative">
      <input type="hidden" name={name} value={selectedId} />

      {selectedId ? (
        <div className="flex items-center justify-between gap-2 rounded-md border border-gray-300 bg-gray-50 px-3 py-2">
          <span className="text-sm text-gray-900 truncate">{selectedLabel}</span>
          <button
            type="button"
            onClick={handleClear}
            className="shrink-0 text-xs text-gray-400 hover:text-gray-700 transition-colors"
          >
            Clear
          </button>
        </div>
      ) : (
        <>
          <div className="relative">
            <input
              type="text"
              value={query}
              onChange={handleInputChange}
              onFocus={() => { if (results.length > 0) setIsOpen(true) }}
              placeholder={placeholder}
              className="w-full rounded-md border border-gray-300 px-3 py-2 pr-24 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
              autoComplete="off"
            />
            {isLoading && (
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400 pointer-events-none">
                Searching…
              </span>
            )}
          </div>

          {isOpen && !isLoading && (
            <div className="absolute z-10 mt-1 w-full rounded-md border border-gray-200 bg-white shadow-lg">
              {results.length > 0 ? (
                <ul className="max-h-60 overflow-auto divide-y divide-gray-50">
                  {results.map((m) => (
                    <li key={m.id}>
                      <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => handleSelect(m)}
                        className="w-full px-3 py-2 text-left text-sm text-gray-900 hover:bg-gray-50 transition-colors"
                      >
                        {formatCatalogResult(m)}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                hasSearched && (
                  <p className="px-3 py-2.5 text-sm text-gray-500">
                    No match found.{' '}
                    <span className="text-xs text-gray-400">
                      Save this item first, then suggest a missing model from the item detail page.
                    </span>
                  </p>
                )
              )}
            </div>
          )}

          {hasError && (
            <p className="mt-1 text-xs text-gray-400">
              Search unavailable — fill in the fields below manually.
            </p>
          )}
        </>
      )}
    </div>
  )
}
