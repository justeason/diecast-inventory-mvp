'use client'

import { useState, useEffect, useRef } from 'react'

type Location = { id: string; label: string }

type Props = {
  name?: string
  defaultId?: string | null
  defaultLabel?: string | null
  placeholder?: string
}

export function StorageLocationCombobox({
  name = 'storageLocationId',
  defaultId = null,
  defaultLabel = null,
  placeholder = 'Search locations…',
}: Props) {
  const [query, setQuery] = useState(defaultLabel ?? '')
  const [selectedId, setSelectedId] = useState(defaultId ?? '')
  const [results, setResults] = useState<Location[]>([])
  const [open, setOpen] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      if (!query.trim()) {
        setResults([])
        return
      }
      const res = await fetch(`/api/admin/storage-locations/search?q=${encodeURIComponent(query)}`)
      if (res.ok) setResults(await res.json())
    }, 250)
  }, [query])

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  function select(loc: Location) {
    setSelectedId(loc.id)
    setQuery(loc.label)
    setOpen(false)
  }

  return (
    <div ref={wrapperRef} className="relative">
      <input type="hidden" name={name} value={selectedId} />
      <input
        type="text"
        value={query}
        placeholder={placeholder}
        onChange={(e) => {
          setQuery(e.target.value)
          setSelectedId('')
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        className="w-full rounded-md border border-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        autoComplete="off"
      />
      {open && results.length > 0 && (
        <ul className="absolute z-10 mt-1 w-full rounded-md border border-gray-200 bg-white shadow-lg text-sm max-h-48 overflow-y-auto">
          {results.map((loc) => (
            <li
              key={loc.id}
              onMouseDown={() => select(loc)}
              className={`cursor-pointer px-3 py-2 hover:bg-blue-50 ${loc.id === selectedId ? 'bg-blue-50 font-medium' : ''}`}
            >
              {loc.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
