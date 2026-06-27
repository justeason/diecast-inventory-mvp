import Link from 'next/link'

const STATUS_OPTIONS = [
  { value: 'all', label: 'All statuses' },
  { value: 'draft', label: 'Draft' },
  { value: 'reviewed', label: 'Reviewed' },
  { value: 'converted', label: 'Converted' },
  { value: 'rejected', label: 'Rejected' },
]

const SORT_OPTIONS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'status', label: 'Status' },
  { value: 'brand', label: 'Brand / Name' },
]

type Props = {
  q: string
  status: string
  sort: string
}

export function IntakeFilterBar({ q, status, sort }: Props) {
  const isActive = q !== '' || status !== '' || sort !== 'newest'

  return (
    <form method="GET" action="/admin/intake" className="flex flex-wrap items-end gap-3 mb-6">
      <div className="flex-1 min-w-48">
        <label htmlFor="intake-q" className="block text-xs font-medium text-gray-600 mb-1">
          Search
        </label>
        <input
          id="intake-q"
          name="q"
          type="text"
          defaultValue={q}
          placeholder="Brand, name, series, color, year, SKU…"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
        />
      </div>
      <div>
        <label htmlFor="intake-status" className="block text-xs font-medium text-gray-600 mb-1">
          Status
        </label>
        <select
          id="intake-status"
          name="status"
          defaultValue={status || 'all'}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="intake-sort" className="block text-xs font-medium text-gray-600 mb-1">
          Sort
        </label>
        <select
          id="intake-sort"
          name="sort"
          defaultValue={sort}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <button
        type="submit"
        className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 transition-colors"
      >
        Apply
      </button>
      {isActive && (
        <Link href="/admin/intake" className="text-sm text-gray-500 hover:text-gray-900">
          Clear
        </Link>
      )}
    </form>
  )
}
