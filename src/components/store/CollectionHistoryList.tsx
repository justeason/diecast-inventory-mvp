// 26C §17-32: private Sold/Removed history rows. Server-rendered, no client
// fetch. Reversed disposals stay visible (never hidden) but are visually
// muted and explicitly labeled — they never imply current-total inclusion.
import Link from 'next/link'
import { centsToDisplay } from '@/lib/marketModelPageDisplay'
import type { DisposalHistoryRow, DisposalHistoryCursor } from '@/lib/collectionDisposalHistoryQuery'
import type { DisposalType } from '@/lib/ownershipLedger'

const DISPOSAL_TYPE_LABELS: Record<DisposalType, string> = {
  platform_sale: 'Sold on CollectNTrades',
  external_sale: 'Sold elsewhere',
  gift: 'Gifted',
  trade: 'Traded',
  other_removal: 'Removed',
  correction: 'Quantity correction',
}

const SALE_TYPES = new Set<DisposalType>(['platform_sale', 'external_sale'])

export function historyHref(cursor: DisposalHistoryCursor | null): string {
  return cursor ? `/account/collection?view=history&hcursor=${cursor.disposedAtMs}_${cursor.id}` : '/account/collection?view=history'
}

export function CollectionHistoryList({
  rows,
  nextCursor,
  isPaginated,
}: {
  rows: DisposalHistoryRow[]
  nextCursor: DisposalHistoryCursor | null
  isPaginated: boolean
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-gray-400">No sold or removed items yet.</p>
  }

  return (
    <>
      <div className="space-y-3">
        {rows.map((row) => {
          const isSaleType = SALE_TYPES.has(row.disposalType)
          return (
            <div
              key={row.id}
              className={`rounded-md border px-4 py-3 ${row.reversedAt ? 'border-gray-200 bg-gray-50 opacity-75' : 'border-gray-200 bg-white'}`}
            >
              <div className="min-w-0">
                <Link
                  href={`/account/collection/${row.collectionItemId}`}
                  className="font-medium text-gray-900 hover:underline underline-offset-2 truncate block"
                >
                  {row.displayName}
                </Link>
                <div className="flex flex-wrap items-center gap-2 mt-1 text-xs text-gray-500">
                  <span>{row.disposedAt.toLocaleDateString()}</span>
                  <span>·</span>
                  <span>Qty {row.quantity}</span>
                  <span>·</span>
                  <span>{DISPOSAL_TYPE_LABELS[row.disposalType]}</span>
                  {row.reversedAt && (
                    <span className="inline-flex items-center rounded-full bg-gray-200 px-2 py-0.5 text-[11px] font-medium text-gray-600">
                      Reversed
                    </span>
                  )}
                </div>
              </div>

              {isSaleType && (
                <div className="mt-2 text-xs text-gray-700 space-y-0.5">
                  {row.grossProceedsCents !== null && (
                    <p>Gross Sale Price: <span className="font-medium">{centsToDisplay(row.grossProceedsCents)}</span></p>
                  )}
                  {row.netProceedsCents !== null && (
                    <p>Net Seller Proceeds: <span className="font-medium">{centsToDisplay(row.netProceedsCents)}</span></p>
                  )}
                  {row.allocatedRecordedCostCents !== null && (
                    <p>Recorded Cost: <span className="font-medium">{centsToDisplay(row.allocatedRecordedCostCents)}</span></p>
                  )}
                  {row.realizedStatus === 'calculable' ? (
                    <p>
                      Recorded Realized Gain/Loss: <span className="font-medium">{centsToDisplay(row.realizedGainLossCents!)}</span>
                      {row.reversedAt && <span className="ml-1 text-gray-400">(reversed — excluded from current totals)</span>}
                    </p>
                  ) : (
                    <p className="text-gray-400">Recorded Realized Gain/Loss: not available</p>
                  )}
                </div>
              )}

              {row.notes && <p className="mt-1.5 text-xs text-gray-400">{row.notes}</p>}
            </div>
          )
        })}
      </div>

      <div className="mt-6 flex gap-4">
        {isPaginated && (
          <Link href={historyHref(null)} className="text-sm text-gray-500 hover:text-gray-900 underline underline-offset-2">
            ← First page
          </Link>
        )}
        {nextCursor && (
          <Link href={historyHref(nextCursor)} className="text-sm text-gray-500 hover:text-gray-900 underline underline-offset-2">
            Next →
          </Link>
        )}
      </div>
    </>
  )
}
