'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { DUPLICATE_SCORE_THRESHOLD, formatCandidateLabel } from '@/lib/catalogMatching'
import type { CatalogMatchResult } from '@/lib/catalogMatching'

type Props = {
  name: string
  defaultValue?: string
  defaultLabel?: string
  initialQuery?: string
  onSelect?: (model: CatalogMatchResult | null) => void
  placeholder?: string
  showCreateOption?: boolean
  onCreateNew?: () => void
}

const SCORE_COLORS: Record<string, string> = {
  high: 'text-green-700',
  medium: 'text-blue-700',
  low: 'text-gray-500',
}

function scoreLabel(score: number): { text: string; color: string } {
  if (score >= 90) return { text: 'Strong', color: SCORE_COLORS.high }
  if (score >= 70) return { text: 'Good', color: SCORE_COLORS.medium }
  return { text: 'Partial', color: SCORE_COLORS.low }
}

export function CatalogModelCombobox({
  name,
  defaultValue = '',
  defaultLabel = '',
  initialQuery = '',
  onSelect,
  placeholder = 'Search catalog by brand, name, year, series…',
  showCreateOption = false,
  onCreateNew,
}: Props) {
  const [query, setQuery] = useState(initialQuery)
  const [results, setResults] = useState<CatalogMatchResult[]>([])
  const [selectedId, setSelectedId] = useState(defaultValue)
  const [selectedLabel, setSelectedLabel] = useState(defaultLabel)
  const [isOpen, setIsOpen] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [hasError, setHasError] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const totalOptions = results.length + (showCreateOption ? 1 : 0)

  const doSearch = useCallback(async (q: string) => {
    const trimmed = q.trim()
    if (trimmed.length < 2) {
      setResults([])
      setIsOpen(false)
      setHasSearched(false)
      setHasError(false)
      setActiveIndex(-1)
      return
    }
    setIsLoading(true)
    setHasError(false)
    try {
      const res = await fetch(`/api/catalog/search?q=${encodeURIComponent(trimmed)}`)
      if (!res.ok) throw new Error()
      const data: CatalogMatchResult[] = await res.json()
      setResults(data)
      setHasSearched(true)
      setIsOpen(true)
      setActiveIndex(-1)
    } catch {
      setHasError(true)
      setResults([])
      setIsOpen(false)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (initialQuery.trim().length >= 2 && !defaultValue) {
      const t = setTimeout(() => { void doSearch(initialQuery) }, 0)
      return () => clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [])

  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false)
        setActiveIndex(-1)
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [])

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value
    setQuery(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => { void doSearch(value) }, 300)
  }

  function handleSelect(model: CatalogMatchResult) {
    setSelectedId(model.id)
    setSelectedLabel(formatCandidateLabel(model))
    setQuery('')
    setResults([])
    setIsOpen(false)
    setHasSearched(false)
    setActiveIndex(-1)
    onSelect?.(model)
  }

  function handleClear() {
    setSelectedId('')
    setSelectedLabel('')
    setQuery('')
    setResults([])
    setIsOpen(false)
    setHasSearched(false)
    setActiveIndex(-1)
    onSelect?.(null)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!isOpen && !hasSearched) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => Math.min(i + 1, totalOptions - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (activeIndex >= 0 && activeIndex < results.length) {
        handleSelect(results[activeIndex])
      } else if (showCreateOption && activeIndex === results.length) {
        onCreateNew?.()
      }
    } else if (e.key === 'Escape') {
      setIsOpen(false)
      setActiveIndex(-1)
    }
  }

  const topScore = results[0]?.score ?? 0
  const hasDuplicateWarning = showCreateOption && hasSearched && topScore >= DUPLICATE_SCORE_THRESHOLD

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
            Change
          </button>
        </div>
      ) : (
        <>
          <div className="relative">
            <input
              type="text"
              value={query}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onFocus={() => { if (results.length > 0 || (showCreateOption && hasSearched)) setIsOpen(true) }}
              placeholder={placeholder}
              className="w-full rounded-md border border-gray-300 px-3 py-2 pr-24 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
              autoComplete="off"
              role="combobox"
              aria-expanded={isOpen}
              aria-haspopup="listbox"
            />
            {isLoading && (
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400 pointer-events-none">
                Searching…
              </span>
            )}
          </div>

          {hasDuplicateWarning && (
            <p className="mt-1 text-xs text-amber-700 rounded-md border border-amber-200 bg-amber-50 px-2 py-1">
              Potential duplicate found (score {topScore}/100). Review matches below before creating.
            </p>
          )}

          {isOpen && !isLoading && (
            <div className="absolute z-20 mt-1 w-full rounded-md border border-gray-200 bg-white shadow-lg">
              <ul
                ref={listRef}
                role="listbox"
                className="max-h-72 overflow-auto divide-y divide-gray-50"
              >
                {results.map((m, i) => {
                  const sl = scoreLabel(m.score)
                  return (
                    <li key={m.id} role="option" aria-selected={i === activeIndex}>
                      <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => handleSelect(m)}
                        onMouseEnter={() => setActiveIndex(i)}
                        className={`w-full px-3 py-2 text-left text-sm transition-colors ${
                          i === activeIndex ? 'bg-gray-100' : 'hover:bg-gray-50'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-gray-900 truncate">
                            {m.brand} {m.name}
                          </span>
                          <span className={`shrink-0 text-xs font-medium ${sl.color}`}>
                            {sl.text}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
                          {m.year && <span className="text-xs text-gray-500">{m.year}</span>}
                          {m.color && <span className="text-xs text-gray-400">· {m.color}</span>}
                          {m.series && <span className="text-xs text-gray-400">· {m.series}</span>}
                          {m.scale && <span className="text-xs text-gray-400">· {m.scale}</span>}
                        </div>
                        {m.matchReasons.length > 0 && (
                          <p className="text-xs text-gray-400 mt-0.5">
                            {m.matchReasons.join(' · ')}
                          </p>
                        )}
                      </button>
                    </li>
                  )
                })}
                {showCreateOption && (
                  <li role="option" aria-selected={activeIndex === results.length}>
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => onCreateNew?.()}
                      onMouseEnter={() => setActiveIndex(results.length)}
                      className={`w-full px-3 py-2 text-left text-sm transition-colors ${
                        activeIndex === results.length ? 'bg-gray-100' : 'hover:bg-gray-50'
                      }`}
                    >
                      <span className="text-gray-500 italic">+ Create new catalog model</span>
                    </button>
                  </li>
                )}
                {results.length === 0 && hasSearched && !showCreateOption && (
                  <li className="px-3 py-2.5 text-sm text-gray-500">
                    No matching catalog model found.
                  </li>
                )}
                {results.length === 0 && hasSearched && showCreateOption && (
                  <li className="px-3 py-1.5 text-xs text-gray-400">
                    No existing matches.
                  </li>
                )}
              </ul>
            </div>
          )}

          {hasError && (
            <p className="mt-1 text-xs text-gray-400">Search unavailable. Try again.</p>
          )}
        </>
      )}
    </div>
  )
}
