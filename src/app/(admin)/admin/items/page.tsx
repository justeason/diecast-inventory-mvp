import Link from 'next/link'
import { ItemFilterBar } from '@/components/admin/ItemFilterBar'
import { ItemBulkTable, type ItemBulkRow } from '@/components/admin/ItemBulkTable'
import { searchItemsPage } from '@/lib/itemLifecycleQuery'
import type { ItemSearchFilter } from '@/lib/itemLifecycleQuery'
import { searchReadyToListPage, type ReadinessFilterValue } from '@/lib/readyToListQuery'

export const dynamic = 'force-dynamic'

const VALID_STATUSES = new Set(['draft', 'available', 'reserved', 'sold', 'not_for_sale'])
const VALID_CONDITIONS = new Set(['mint', 'near_mint', 'good', 'fair', 'poor', 'damaged'])
const VALID_TYPES = new Set(['carded', 'loose'])
const VALID_SORTS = new Set(['sku', 'newest', 'oldest', 'brand', 'status'])
const VALID_READINESS = new Set(['ready', 'review_required', 'blocked'])

const READINESS_TABS: { value: ReadinessFilterValue | ''; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'ready', label: 'Ready' },
  { value: 'review_required', label: 'Review Required' },
  { value: 'blocked', label: 'Blocked' },
]

export default async function AdminItemsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; condition?: string; type?: string; sort?: string; cursor?: string; readiness?: string }>
}) {
  const { q: rawQ, status: rawStatus, condition: rawCondition, type: rawType, sort: rawSort, cursor: rawCursor, readiness: rawReadiness } =
    await searchParams

  const q = rawQ?.trim() ?? ''
  const status = rawStatus && VALID_STATUSES.has(rawStatus) ? rawStatus : ''
  const condition = rawCondition && VALID_CONDITIONS.has(rawCondition) ? rawCondition : ''
  const cardedOrLoose = rawType && VALID_TYPES.has(rawType) ? rawType : ''
  const sort = (rawSort && VALID_SORTS.has(rawSort) ? rawSort : 'sku') as ItemSearchFilter['sort']
  const cursor = rawCursor?.trim() || null
  const readiness = rawReadiness && VALID_READINESS.has(rawReadiness) ? (rawReadiness as ReadinessFilterValue) : null

  const filter: ItemSearchFilter = { q, status, condition, cardedOrLoose, sort }

  // 15J (composable-filters pass): readiness is an ADDITIONAL filter dimension, not
  // a separate search mode. Both branches run the exact same ordinary-filter
  // predicate (buildSearchWhere, shared via itemLifecycleQuery.ts) — the readiness
  // branch just also ANDs the safe candidate predicate and runs every candidate
  // through evaluateReadyToList (readyToListQuery.ts is the only place that engine
  // is called; no policy is duplicated here).
  let items: ItemBulkRow[]
  let nextCursor: string | null

  if (readiness) {
    const result = await searchReadyToListPage(readiness, filter, cursor)
    items = result.items.map((r) => ({
      id: r.id, sku: r.sku, brand: r.brand, name: r.name, status: r.status,
      readiness: { status: r.outcome.status, firstReason: r.outcome.blockers[0]?.message ?? r.outcome.reviewReasons[0]?.message ?? null },
    }))
    nextCursor = result.nextCursor
  } else {
    const result = await searchItemsPage(filter, cursor)
    items = result.items
    nextCursor = result.nextCursor
  }

  // Base params shared by every link on this page (readiness tabs, pagination) —
  // built once so ordinary filters are never dropped when readiness changes, and
  // vice versa (section 6). `baseQs` deliberately excludes `readiness` so each
  // readiness tab link can append its own value (or omit it for "All").
  const baseQs = new URLSearchParams()
  if (q) baseQs.set('q', q)
  if (status) baseQs.set('status', status)
  if (condition) baseQs.set('condition', condition)
  if (cardedOrLoose) baseQs.set('type', cardedOrLoose)
  if (sort !== 'sku') baseQs.set('sort', sort)

  const qs = new URLSearchParams(baseQs)
  if (readiness) qs.set('readiness', readiness)
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

      <div className="flex flex-wrap gap-2 mb-4">
        {READINESS_TABS.map((tab) => {
          // 15J (composable-filters pass): every tab carries the current ordinary
          // filters forward (baseQs) — only `readiness` itself changes between tabs,
          // so switching tabs narrows/widens readiness without discarding q/status/
          // condition/type/sort (section 6).
          const tabQs = new URLSearchParams(baseQs)
          if (tab.value) tabQs.set('readiness', tab.value)
          const qsString = tabQs.toString()
          const href = qsString ? `/admin/items?${qsString}` : '/admin/items'
          const active = (readiness ?? '') === tab.value
          return (
            <Link
              key={tab.value || 'all'}
              href={href}
              className={`px-3 py-1.5 rounded-md text-sm border ${active ? 'border-gray-900 text-gray-900 font-medium' : 'border-gray-200 text-gray-500 hover:text-gray-900'}`}
            >
              {tab.label}
            </Link>
          )
        })}
      </div>

      <ItemFilterBar q={q} status={status} condition={condition} cardedOrLoose={cardedOrLoose} sort={sort} readiness={readiness ?? ''} />

      {items.length === 0 ? (
        <p className="text-sm text-gray-500">
          {readiness || q || status || condition || cardedOrLoose ? 'No items match the current filters.' : 'No items yet.'}
        </p>
      ) : (
        // 15I: `key` forces a clean remount (and cleared selection) whenever the
        // filter/cursor combination changes (Part M section 32) — a stale selection
        // can never silently carry over to a different, invisible set of rows.
        <ItemBulkTable key={`${readiness ?? ''}|${q}|${status}|${condition}|${cardedOrLoose}|${sort}|${cursor ?? ''}`} items={items} />
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
