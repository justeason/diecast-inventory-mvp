import Link from 'next/link'

const CONDITION_OPTIONS = [
  { value: 'mint', label: 'Mint' },
  { value: 'near_mint', label: 'Near Mint' },
  { value: 'good', label: 'Good' },
  { value: 'fair', label: 'Fair' },
  { value: 'poor', label: 'Poor' },
  { value: 'damaged', label: 'Damaged' },
]

type Props = {
  q?: string
  condition?: string
  type?: string
}

export function SearchFilterBar({ q, condition, type }: Props) {
  const hasFilters = q || condition || type

  return (
    <form method="GET" action="/browse" className="mb-8">
      <div className="flex flex-wrap gap-3 items-end">
        <div className="flex-1 min-w-48">
          <label htmlFor="q" className="block text-xs font-medium text-gray-600 mb-1">
            Search
          </label>
          <input
            id="q"
            type="search"
            name="q"
            placeholder="Title, brand, model, series, color…"
            defaultValue={q ?? ''}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
          />
        </div>

        <div>
          <label htmlFor="condition" className="block text-xs font-medium text-gray-600 mb-1">
            Condition
          </label>
          <select
            id="condition"
            name="condition"
            defaultValue={condition ?? ''}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gray-900"
          >
            <option value="">All conditions</option>
            {CONDITION_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="type" className="block text-xs font-medium text-gray-600 mb-1">
            Type
          </label>
          <select
            id="type"
            name="type"
            defaultValue={type ?? ''}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gray-900"
          >
            <option value="">Carded &amp; Loose</option>
            <option value="carded">Carded only</option>
            <option value="loose">Loose only</option>
          </select>
        </div>

        <button
          type="submit"
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
        >
          Search
        </button>

        {hasFilters && (
          <Link href="/browse" className="text-sm text-gray-500 hover:text-gray-900 underline py-2">
            Clear filters
          </Link>
        )}
      </div>
    </form>
  )
}
