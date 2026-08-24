import Link from 'next/link'

type Props = {
  q?: string
  brand?: string
  year?: string
  brands: string[]
}

// 16J: mirrors SearchFilterBar's (/browse) established GET-form pattern — URL is
// authoritative, no client-side filter state. Deliberately fewer fields than
// /browse's own bar: Series/Scale are CatalogModel identity, but their cardinality
// wasn't verifiable (empty dev dataset) and Series is flagged by spec as a likely
// high-cardinality risk, so both are text-searchable via `q` only, not dropdowns.
export function CatalogSearchBar({ q, brand, year, brands }: Props) {
  const isActive = !!(q || brand || year)
  const formKey = [q, brand, year].join('|')

  return (
    <form key={formKey} method="GET" action="/catalog" className="flex flex-wrap items-end gap-3 mb-8">
      <div className="w-full sm:w-auto sm:flex-1 sm:min-w-[16rem]">
        <label htmlFor="catalog-q" className="block text-xs font-medium text-gray-600 mb-1">
          Search
        </label>
        <input
          id="catalog-q"
          type="text"
          name="q"
          placeholder="Brand, model, series, color, year…"
          defaultValue={q ?? ''}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
        />
      </div>

      {brands.length > 0 && (
        <div>
          <label htmlFor="catalog-brand" className="block text-xs font-medium text-gray-600 mb-1">
            Brand
          </label>
          <select
            id="catalog-brand"
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

      <div>
        <label htmlFor="catalog-year" className="block text-xs font-medium text-gray-600 mb-1">
          Year
        </label>
        <input
          id="catalog-year"
          type="text"
          name="year"
          inputMode="numeric"
          placeholder="Any"
          defaultValue={year ?? ''}
          className="w-24 rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
        />
      </div>

      <button
        type="submit"
        className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 transition-colors"
      >
        Search
      </button>

      {isActive && (
        <Link href="/catalog" className="py-2 text-sm text-gray-500 hover:text-gray-900 underline">
          Clear
        </Link>
      )}
    </form>
  )
}
