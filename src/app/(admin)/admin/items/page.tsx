import Link from 'next/link'
import { PhotoThumbnail } from '@/components/shared/PhotoThumbnail'
import { ItemFilterBar } from '@/components/admin/ItemFilterBar'
import { searchItemsPage } from '@/lib/itemLifecycleQuery'
import type { ItemSearchFilter } from '@/lib/itemLifecycleQuery'

export const dynamic = 'force-dynamic'

const CONDITION_LABELS: Record<string, string> = {
  mint: 'Mint', near_mint: 'Near Mint', good: 'Good', fair: 'Fair', poor: 'Poor', damaged: 'Damaged',
}

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft', available: 'Available', reserved: 'Reserved', sold: 'Sold', not_for_sale: 'Not for Sale',
}

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-600',
  available: 'bg-green-100 text-green-700',
  reserved: 'bg-yellow-100 text-yellow-700',
  sold: 'bg-blue-100 text-blue-700',
  not_for_sale: 'bg-red-100 text-red-700',
}

const LISTING_STATUS_COLORS: Record<string, string> = {
  active: 'bg-green-100 text-green-700',
  sold: 'bg-blue-100 text-blue-700',
  archived: 'bg-gray-100 text-gray-600',
}

const LISTING_STATUS_LABELS: Record<string, string> = {
  active: 'Active', sold: 'Sold', archived: 'Archived',
}

const VALID_STATUSES = new Set(['draft', 'available', 'reserved', 'sold', 'not_for_sale'])
const VALID_CONDITIONS = new Set(['mint', 'near_mint', 'good', 'fair', 'poor', 'damaged'])
const VALID_TYPES = new Set(['carded', 'loose'])
const VALID_SORTS = new Set(['sku', 'newest', 'oldest', 'brand', 'status'])

export default async function AdminItemsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; condition?: string; type?: string; sort?: string; cursor?: string }>
}) {
  const { q: rawQ, status: rawStatus, condition: rawCondition, type: rawType, sort: rawSort, cursor: rawCursor } =
    await searchParams

  const q = rawQ?.trim() ?? ''
  const status = rawStatus && VALID_STATUSES.has(rawStatus) ? rawStatus : ''
  const condition = rawCondition && VALID_CONDITIONS.has(rawCondition) ? rawCondition : ''
  const cardedOrLoose = rawType && VALID_TYPES.has(rawType) ? rawType : ''
  const sort = (rawSort && VALID_SORTS.has(rawSort) ? rawSort : 'sku') as ItemSearchFilter['sort']
  const cursor = rawCursor?.trim() || null

  const { items, nextCursor } = await searchItemsPage({ q, status, condition, cardedOrLoose, sort }, cursor)

  const qs = new URLSearchParams()
  if (q) qs.set('q', q)
  if (status) qs.set('status', status)
  if (condition) qs.set('condition', condition)
  if (cardedOrLoose) qs.set('type', cardedOrLoose)
  if (sort !== 'sku') qs.set('sort', sort)
  const nextQs = new URLSearchParams(qs)
  if (nextCursor) nextQs.set('cursor', nextCursor)

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Item Instances</h1>
        <Link
          href="/admin/items/new"
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
        >
          New Item
        </Link>
      </div>

      <ItemFilterBar q={q} status={status} condition={condition} cardedOrLoose={cardedOrLoose} sort={sort} />

      {items.length === 0 ? (
        <p className="text-sm text-gray-500">
          {q || status || condition || cardedOrLoose ? 'No items match the current filters.' : 'No items yet.'}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-gray-200">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr className="text-left text-gray-500">
                <th className="px-4 py-3 font-medium w-14"></th>
                <th className="px-4 py-3 font-medium">SKU</th>
                <th className="px-4 py-3 font-medium">Catalog</th>
                <th className="px-4 py-3 font-medium">Location</th>
                <th className="px-4 py-3 font-medium">Condition</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">List Price</th>
                <th className="px-4 py-3 font-medium">Listing</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {items.map((item) => (
                <tr key={item.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <PhotoThumbnail photoUrl={item.photoUrl} alt={item.sku} size="sm" />
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">
                    <Link href={`/admin/items/${item.id}`} className="hover:underline">{item.sku}</Link>
                  </td>
                  <td className="px-4 py-3">{item.brand} – {item.name}</td>
                  <td className="px-4 py-3 text-gray-500">{item.locationLabel ?? '—'}</td>
                  <td className="px-4 py-3 text-gray-500">{CONDITION_LABELS[item.condition] ?? item.condition}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[item.status] ?? 'bg-gray-100 text-gray-600'}`}>
                      {STATUS_LABELS[item.status] ?? item.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500">{item.listPrice != null ? `$${item.listPrice.toFixed(2)}` : '—'}</td>
                  <td className="px-4 py-3">
                    {item.listingStatus ? (
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${LISTING_STATUS_COLORS[item.listingStatus] ?? 'bg-gray-100 text-gray-600'}`}>
                        {LISTING_STATUS_LABELS[item.listingStatus] ?? item.listingStatus}
                      </span>
                    ) : item.status === 'available' ? (
                      <Link href={`/admin/listings/new?itemId=${item.id}`} className="text-blue-600 hover:underline text-sm">List →</Link>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link href={`/admin/items/${item.id}`} className="text-blue-600 hover:underline text-sm">View</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-6 flex justify-end">
        {nextCursor && (
          <Link
            href={`/admin/items?${nextQs.toString()}`}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
          >
            Next →
          </Link>
        )}
      </div>
    </>
  )
}
