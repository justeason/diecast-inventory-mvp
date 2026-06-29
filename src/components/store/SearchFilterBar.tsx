import Link from 'next/link'

const CONDITION_OPTIONS = [
  { value: 'mint', label: 'Mint' },
  { value: 'near_mint', label: 'Near Mint' },
  { value: 'good', label: 'Good' },
  { value: 'fair', label: 'Fair' },
  { value: 'poor', label: 'Poor' },
  { value: 'damaged', label: 'Damaged' },
]

const SORT_OPTIONS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'price_low', label: 'Price: Low to High' },
  { value: 'price_high', label: 'Price: High to Low' },
  { value: 'brand_name', label: 'Brand / Name' },
]

type Props = {
  q?: string
  condition?: string
  type?: string
  brand?: string
  minPrice?: string
  maxPrice?: string
  sort: string
  brands: string[]
}

export function SearchFilterBar({ q, condition, type, brand, minPrice, maxPrice, sort, brands }: Props) {
  const isActive = !!(q || condition || type || brand || minPrice || maxPrice || sort !== 'newest')
  const formKey = [q, condition, type, brand, minPrice, maxPrice, sort].join('|')

  return (
    <form key={formKey} method="GET" action="/browse" className="flex flex-wrap items-end gap-3 mb-8">
      {/* Search — full-width row */}
      <div className="w-full">
        <label htmlFor="browse-q" className="block text-xs font-medium text-gray-600 mb-1">
          Search
        </label>
        <input
          id="browse-q"
          type="text"
          name="q"
          placeholder="Title, brand, model, series, color, year…"
          defaultValue={q ?? ''}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
        />
      </div>

      {/* Condition */}
      <div>
        <label htmlFor="browse-condition" className="block text-xs font-medium text-gray-600 mb-1">
          Condition
        </label>
        <select
          id="browse-condition"
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

      {/* Type */}
      <div>
        <label htmlFor="browse-type" className="block text-xs font-medium text-gray-600 mb-1">
          Type
        </label>
        <select
          id="browse-type"
          name="type"
          defaultValue={type ?? ''}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gray-900"
        >
          <option value="">Carded &amp; Loose</option>
          <option value="carded">Carded only</option>
          <option value="loose">Loose only</option>
        </select>
      </div>

      {/* Brand — only rendered when there are brands to show */}
      {brands.length > 0 && (
        <div>
          <label htmlFor="browse-brand" className="block text-xs font-medium text-gray-600 mb-1">
            Brand
          </label>
          <select
            id="browse-brand"
            name="brand"
            defaultValue={brand ?? ''}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gray-900"
          >
            <option value="">All brands</option>
            {brands.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Min price */}
      <div>
        <label htmlFor="browse-min" className="block text-xs font-medium text-gray-600 mb-1">
          Min $
        </label>
        <input
          id="browse-min"
          type="text"
          name="minPrice"
          inputMode="decimal"
          placeholder="0"
          defaultValue={minPrice ?? ''}
          className="w-24 rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
        />
      </div>

      {/* Max price */}
      <div>
        <label htmlFor="browse-max" className="block text-xs font-medium text-gray-600 mb-1">
          Max $
        </label>
        <input
          id="browse-max"
          type="text"
          name="maxPrice"
          inputMode="decimal"
          placeholder="Any"
          defaultValue={maxPrice ?? ''}
          className="w-24 rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
        />
      </div>

      {/* Sort */}
      <div>
        <label htmlFor="browse-sort" className="block text-xs font-medium text-gray-600 mb-1">
          Sort by
        </label>
        <select
          id="browse-sort"
          name="sort"
          defaultValue={sort}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gray-900"
        >
          {SORT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {/* Actions */}
      <button
        type="submit"
        className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 transition-colors"
      >
        Search
      </button>

      {isActive && (
        <Link href="/browse" className="py-2 text-sm text-gray-500 hover:text-gray-900 underline">
          Clear
        </Link>
      )}
    </form>
  )
}
