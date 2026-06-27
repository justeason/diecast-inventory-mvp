import Link from 'next/link'

const STATUS_OPTIONS = [
  { value: 'all', label: 'All statuses' },
  { value: 'draft', label: 'Draft' },
  { value: 'available', label: 'Available' },
  { value: 'reserved', label: 'Reserved' },
  { value: 'sold', label: 'Sold' },
  { value: 'not_for_sale', label: 'Not for Sale' },
]

const CONDITION_OPTIONS = [
  { value: 'all', label: 'All conditions' },
  { value: 'mint', label: 'Mint' },
  { value: 'near_mint', label: 'Near Mint' },
  { value: 'good', label: 'Good' },
  { value: 'fair', label: 'Fair' },
  { value: 'poor', label: 'Poor' },
  { value: 'damaged', label: 'Damaged' },
]

const TYPE_OPTIONS = [
  { value: 'all', label: 'All types' },
  { value: 'carded', label: 'Carded' },
  { value: 'loose', label: 'Loose' },
]

const SORT_OPTIONS = [
  { value: 'sku', label: 'SKU' },
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'brand', label: 'Brand / Name' },
  { value: 'status', label: 'Status' },
]

type Props = {
  q: string
  status: string
  condition: string
  cardedOrLoose: string
  sort: string
}

export function ItemFilterBar({ q, status, condition, cardedOrLoose, sort }: Props) {
  const isActive =
    q !== '' || status !== '' || condition !== '' || cardedOrLoose !== '' || sort !== 'sku'
  const formKey = [q, status, condition, cardedOrLoose, sort].join('|')

  return (
    <form key={formKey} method="GET" action="/admin/items" className="flex flex-wrap items-end gap-3 mb-6">
      <div className="flex-1 min-w-48">
        <label htmlFor="item-q" className="block text-xs font-medium text-gray-600 mb-1">
          Search
        </label>
        <input
          id="item-q"
          name="q"
          type="text"
          defaultValue={q}
          placeholder="SKU, brand, name, series, color, year, location…"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
        />
      </div>
      <div>
        <label htmlFor="item-status" className="block text-xs font-medium text-gray-600 mb-1">
          Status
        </label>
        <select
          id="item-status"
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
        <label htmlFor="item-condition" className="block text-xs font-medium text-gray-600 mb-1">
          Condition
        </label>
        <select
          id="item-condition"
          name="condition"
          defaultValue={condition || 'all'}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
        >
          {CONDITION_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="item-type" className="block text-xs font-medium text-gray-600 mb-1">
          Type
        </label>
        <select
          id="item-type"
          name="type"
          defaultValue={cardedOrLoose || 'all'}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
        >
          {TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="item-sort" className="block text-xs font-medium text-gray-600 mb-1">
          Sort
        </label>
        <select
          id="item-sort"
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
        <Link href="/admin/items" className="text-sm text-gray-500 hover:text-gray-900">
          Clear
        </Link>
      )}
    </form>
  )
}
