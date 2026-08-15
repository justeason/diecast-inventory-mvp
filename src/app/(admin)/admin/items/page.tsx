import Link from 'next/link'
import { ItemFilterBar } from '@/components/admin/ItemFilterBar'
import { ItemBulkTable } from '@/components/admin/ItemBulkTable'
import { searchItemsPage } from '@/lib/itemLifecycleQuery'
import type { ItemSearchFilter } from '@/lib/itemLifecycleQuery'

export const dynamic = 'force-dynamic'

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
        // 15I: `key` forces a clean remount (and cleared selection) whenever the
        // filter/cursor combination changes (Part M section 32) — a stale selection
        // can never silently carry over to a different, invisible set of rows.
        <ItemBulkTable key={`${q}|${status}|${condition}|${cardedOrLoose}|${sort}|${cursor ?? ''}`} items={items} />
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
