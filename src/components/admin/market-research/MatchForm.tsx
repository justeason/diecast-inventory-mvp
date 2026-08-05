'use client'

import { useActionState, useState, useRef } from 'react'
import { matchObservationToCatalog, type MatchActionState } from '@/lib/actions/externalMarketResearch'

type CatalogResult = { id: string; brand: string; name: string; series: string | null; year: number | null }

export function MatchForm({ observationId, updatedAt }: { observationId: string; updatedAt: string }) {
  const action = matchObservationToCatalog.bind(null, observationId)
  const [state, formAction, isPending] = useActionState<MatchActionState, FormData>(action, null)

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<CatalogResult[]>([])
  const [selected, setSelected] = useState<CatalogResult | null>(null)
  const [searching, setSearching] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function handleQueryChange(q: string) {
    setQuery(q)
    setSelected(null)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (q.trim().length < 2) { setResults([]); return }
    debounceRef.current = setTimeout(async () => {
      setSearching(true)
      try {
        const res = await fetch(`/api/catalog/search?q=${encodeURIComponent(q.trim())}`)
        if (res.ok) setResults(await res.json())
      } catch { /* ignore */ } finally {
        setSearching(false)
      }
    }, 300)
  }

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="catalogModelId" value={selected?.id ?? ''} />
      <input type="hidden" name="updatedAt" value={updatedAt} />

      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">Search catalog</label>
        <input
          type="text"
          value={query}
          onChange={e => handleQueryChange(e.target.value)}
          placeholder="Type brand or model name…"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
          autoComplete="off"
        />
      </div>

      {searching && <p className="text-xs text-gray-400">Searching…</p>}

      {!selected && results.length > 0 && (
        <div className="rounded-md border border-gray-200 bg-white divide-y divide-gray-100 max-h-48 overflow-y-auto">
          {results.map(r => (
            <button
              key={r.id}
              type="button"
              onClick={() => { setSelected(r); setResults([]); setQuery(`${r.brand} ${r.name}`) }}
              className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 transition-colors"
            >
              <span className="font-medium">{r.brand} {r.name}</span>
              {(r.series || r.year) && (
                <span className="ml-2 text-xs text-gray-400">
                  {[r.series, r.year].filter(Boolean).join(' · ')}
                </span>
              )}
              <span className="ml-2 text-xs text-gray-300">{r.id}</span>
            </button>
          ))}
        </div>
      )}

      {selected && (
        <p className="text-xs text-gray-600">
          Selected: <span className="font-medium">{selected.brand} {selected.name}</span>{' '}
          <button type="button" className="text-gray-400 hover:text-gray-600 underline" onClick={() => { setSelected(null); setQuery(''); setResults([]) }}>clear</button>
        </p>
      )}

      {state?.errors?.['catalogModelId']?.map(e => (
        <p key={e} className="text-xs text-red-600">{e}</p>
      ))}
      {state?.errors?.['form']?.map(e => (
        <p key={e} className="text-xs text-red-600">{e}</p>
      ))}

      <button
        type="submit"
        disabled={isPending || !selected}
        className="rounded-md bg-blue-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50 transition-colors"
      >
        {isPending ? 'Matching…' : 'Confirm match'}
      </button>
    </form>
  )
}
