import Link from 'next/link'

const STATUS_OPTIONS = [
  { value: 'all', label: 'All statuses' },
  { value: 'pending', label: 'Pending' },
  { value: 'paid', label: 'Paid' },
  { value: 'picking', label: 'Picking' },
  { value: 'shipped', label: 'Shipped' },
  { value: 'complete', label: 'Complete' },
  { value: 'cancelled', label: 'Cancelled' },
]

const SORT_OPTIONS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'status', label: 'Status' },
  { value: 'total_desc', label: 'Total: High to Low' },
  { value: 'total_asc', label: 'Total: Low to High' },
]

type Props = {
  q: string
  status: string
  sort: string
}

export function OrderFilterBar({ q, status, sort }: Props) {
  const isActive = q !== '' || status !== '' || sort !== 'newest'
  const formKey = [q, status, sort].join('|')

  return (
    <form key={formKey} method="GET" action="/admin/orders" className="flex flex-wrap items-end gap-3 mb-6">
      <div className="flex-1 min-w-48">
        <label htmlFor="order-q" className="block text-xs font-medium text-gray-600 mb-1">
          Search
        </label>
        <input
          id="order-q"
          name="q"
          type="text"
          defaultValue={q}
          placeholder="Buyer name, email, notes, SKU, listing title…"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
        />
      </div>
      <div>
        <label htmlFor="order-status" className="block text-xs font-medium text-gray-600 mb-1">
          Status
        </label>
        <select
          id="order-status"
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
        <label htmlFor="order-sort" className="block text-xs font-medium text-gray-600 mb-1">
          Sort
        </label>
        <select
          id="order-sort"
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
        <Link href="/admin/orders" className="text-sm text-gray-500 hover:text-gray-900">
          Clear
        </Link>
      )}
    </form>
  )
}
