'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { searchAdminAction } from '@/lib/actions/adminSearch'
import { MIN_QUERY_LENGTH, type AdminSearchResults } from '@/lib/adminSearchQuery'

const DEBOUNCE_MS = 250

// 15H Part H — lightweight header search. Debounced, bounded (server side caps each
// group), grouped dropdown; navigates via existing authoritative pages only. No
// business logic here — a pure client shell around searchAdminAction.
export function AdminSearchBox() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<AdminSearchResults>([])
  const [open, setOpen] = useState(false)
  const [isPending, startTransition] = useTransition()
  const containerRef = useRef<HTMLDivElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const router = useRouter()

  const trimmedLength = query.trim().length

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (trimmedLength < MIN_QUERY_LENGTH) return
    debounceRef.current = setTimeout(() => {
      startTransition(async () => {
        const r = await searchAdminAction(query)
        setResults(r)
        setOpen(true)
      })
    }, DEBOUNCE_MS)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query, trimmedLength])

  // Derived, not stored — avoids a synchronous setState in the effect above for the
  // "query got too short" case, and guarantees stale results never render under a
  // now-too-short query.
  const visibleResults = trimmedLength < MIN_QUERY_LENGTH ? [] : results

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [])

  function go(href: string) {
    setOpen(false)
    setQuery('')
    setResults([])
    router.push(href)
  }

  return (
    <div ref={containerRef} className="relative w-64">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => trimmedLength >= MIN_QUERY_LENGTH && setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false)
        }}
        placeholder="Search items, sellers, orders…"
        className="w-full rounded-md border border-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-80 max-h-96 overflow-y-auto rounded-md border border-gray-200 bg-white shadow-lg">
          {isPending && <p className="px-3 py-2 text-xs text-gray-400">Searching…</p>}
          {!isPending && visibleResults.length === 0 && trimmedLength >= MIN_QUERY_LENGTH && (
            <p className="px-3 py-2 text-sm text-gray-500">No matches.</p>
          )}
          {!isPending && visibleResults.map((group) => (
            <div key={group.group} className="border-b border-gray-100 last:border-0">
              <p className="px-3 pt-2 text-xs font-semibold text-gray-400 uppercase tracking-wide">{group.groupLabel}</p>
              {group.results.map((r) => (
                <button
                  key={`${r.group}-${r.id}`}
                  type="button"
                  onClick={() => go(r.href)}
                  className="block w-full text-left px-3 py-2 text-sm hover:bg-gray-50"
                >
                  <span className="text-gray-900">{r.label}</span>
                  {r.sublabel && <span className="ml-2 text-xs text-gray-400">{r.sublabel}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
