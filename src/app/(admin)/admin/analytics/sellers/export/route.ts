export const dynamic = 'force-dynamic'

import { isAdminAuthenticated } from '@/lib/adminAuth'
import { getSellerPerformancePage, type SellerSortKey } from '@/lib/businessAnalyticsQuery'
import { buildAnalyticsContext } from '@/lib/businessAnalyticsPage'
import { toCsv } from '@/lib/csv'

const SORT_KEYS = new Set<SellerSortKey>(['grossSales', 'unitsSold', 'sellThrough', 'payoutOutstanding', 'medianDaysToSell'])
const MAX_PAGES = 200 // bounded — 200 * 50 = 10,000 sellers, well beyond this business's scale

// Spreadsheet formula-injection protection: a leading =, +, -, or @ makes some
// spreadsheet apps evaluate the cell as a formula. Prefix with a single quote (a
// standard CSV/Excel-safe neutralizer) so the value is always treated as text.
function csvSafeCell(val: unknown): string {
  if (val == null) return ''
  const str = String(val)
  return /^[=+\-@]/.test(str) ? `'${str}` : str
}

export async function GET(req: Request) {
  if (!await isAdminAuthenticated()) {
    return new Response('Unauthorized', { status: 401 })
  }

  const url = new URL(req.url)
  const sortParam = url.searchParams.get('sort')
  const sort: SellerSortKey = SORT_KEYS.has(sortParam as SellerSortKey) ? (sortParam as SellerSortKey) : 'grossSales'
  const ctx = buildAnalyticsContext({
    period: url.searchParams.get('period') ?? undefined,
    start: url.searchParams.get('start') ?? undefined,
    end: url.searchParams.get('end') ?? undefined,
  })

  // 17C (P1-2): header names disclose time basis — lifetime (not scoped to the
  // selected period), period (scoped to `period`/`start`/`end` above), or current
  // (as-of-now snapshot) — matching the seller UI table's column tags exactly.
  // Underlying values/query are unchanged; only the header labels changed.
  const headers = [
    'seller', 'submissionsLifetime', 'unitsReceivedLifetime', 'unitsListedLifetime', 'unitsSoldLifetime', 'sellThroughPctLifetime',
    'grossSalesUsdPeriod', 'sellerProceedsUsdPeriod', 'payoutPaidUsdLifetime', 'payoutOutstandingUsdCurrent',
    'medianIntakeToListingDaysLifetime', 'medianListingToSaleDaysLifetime', 'rejectionRatePctLifetime',
  ]
  const rows: unknown[][] = []
  let cursor: { value: number; profileId: string } | null = null

  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await getSellerPerformancePage(ctx.range, sort, cursor)
    for (const r of result.items) {
      rows.push([
        r.displayName, r.submissions, r.unitsReceived, r.unitsListed, r.unitsSold,
        r.sellThrough === null ? '' : r.sellThrough.toFixed(1),
        r.grossSales.toFixed(2), r.sellerProceeds.toFixed(2), r.payoutPaid.toFixed(2), r.payoutOutstanding.toFixed(2),
        r.medianIntakeToListingDays ?? '', r.medianListingToSaleDays ?? '', r.rejectionRate === null ? '' : r.rejectionRate.toFixed(1),
      ])
    }
    if (!result.nextCursor) break
    cursor = result.nextCursor
  }

  const csv = toCsv(headers, rows.map(row => row.map(csvSafeCell)))
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="seller-performance-${ctx.range.preset}.csv"`,
    },
  })
}
