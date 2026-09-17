// 26C §17-30/§47: private Sold/Removed history — sourced EXCLUSIVELY from the
// 26B ledger (CollectionDisposal + CollectionDisposalAllocation +
// AcquisitionLot's contribution via allocation snapshots + CollectionItem
// identity). Never derived from Order/SellerSubmission directly, never from
// CollectionItem.quantity deltas. Reuses computeRealizedGain/
// computeAllocatedCostCents (26B/26C ownershipLedger.ts) — never
// reconstructs cost/gain from current (possibly since-edited) lot state.
import { prisma } from '@/lib/prisma'
import { computeAllocatedCostCents, computeRealizedGain, SALE_DISPOSAL_TYPES, type DisposalType } from '@/lib/ownershipLedger'

export type DisposalHistoryRow = {
  id: string
  collectionItemId: string
  displayName: string
  catalogId: string | null
  disposalType: DisposalType
  quantity: number
  disposedAt: Date
  reversedAt: Date | null
  reversalReason: string | null
  notes: string | null
  grossProceedsCents: number | null
  netProceedsCents: number | null
  // Null when this disposal type never carries cost/proceeds (gift/trade/
  // other_removal/correction) OR when allocated cost isn't fully known.
  allocatedRecordedCostCents: number | null
  // Only meaningful for platform_sale/external_sale — computed from the
  // SNAPSHOTTED allocation costs, never current lot cost (26C §26/§50).
  realizedGainLossCents: number | null
  realizedStatus: 'calculable' | 'unavailable' | 'not_applicable'
}

export type DisposalHistoryCursor = { disposedAtMs: number; id: string }

export type DisposalHistoryPage = {
  rows: DisposalHistoryRow[]
  nextCursor: DisposalHistoryCursor | null
}

const PAGE_SIZE = 20
const SALE_TYPES = SALE_DISPOSAL_TYPES as readonly string[]

function displayName(item: { brand: string | null; name: string | null; catalog: { brand: string; name: string } | null }): string {
  if (item.catalog) return `${item.catalog.brand} ${item.catalog.name}`
  const parts = [item.brand, item.name].filter(Boolean)
  return parts.length > 0 ? parts.join(' ') : 'Unnamed item'
}

// §20: disposedAt DESC, then id DESC as a stable tie-break — composite
// keyset pagination (never OFFSET, never an unbounded full history).
export async function getCollectionDisposalHistory(
  profileId: string,
  cursor?: DisposalHistoryCursor,
): Promise<DisposalHistoryPage> {
  const disposals = await prisma.collectionDisposal.findMany({
    where: {
      collectionItem: { profileId },
      ...(cursor
        ? {
            OR: [
              { disposedAt: { lt: new Date(cursor.disposedAtMs) } },
              { disposedAt: new Date(cursor.disposedAtMs), id: { lt: cursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ disposedAt: 'desc' }, { id: 'desc' }],
    take: PAGE_SIZE + 1,
    select: {
      id: true,
      collectionItemId: true,
      disposalType: true,
      quantity: true,
      disposedAt: true,
      reversedAt: true,
      reversalReason: true,
      notes: true,
      grossProceedsCents: true,
      netProceedsCents: true,
      collectionItem: { select: { brand: true, name: true, catalogId: true, catalog: { select: { brand: true, name: true } } } },
      allocations: { select: { allocatedRecordedCostCents: true } },
    },
  })

  const hasMore = disposals.length > PAGE_SIZE
  const page = hasMore ? disposals.slice(0, PAGE_SIZE) : disposals
  const last = page[page.length - 1]
  const nextCursor = hasMore && last ? { disposedAtMs: last.disposedAt.getTime(), id: last.id } : null

  const rows: DisposalHistoryRow[] = page.map((d) => {
    const isSaleType = SALE_TYPES.includes(d.disposalType)
    const allocatedRecordedCostCents = isSaleType ? computeAllocatedCostCents(d.allocations) : null

    let realizedGainLossCents: number | null = null
    let realizedStatus: DisposalHistoryRow['realizedStatus'] = 'not_applicable'
    if (isSaleType) {
      const realized = computeRealizedGain(d.netProceedsCents, d.allocations)
      if (realized.status === 'calculable') {
        realizedGainLossCents = realized.recordedRealizedGainLossCents
        realizedStatus = 'calculable'
      } else {
        realizedStatus = 'unavailable'
      }
    }

    return {
      id: d.id,
      collectionItemId: d.collectionItemId,
      displayName: displayName(d.collectionItem),
      catalogId: d.collectionItem.catalogId,
      disposalType: d.disposalType as DisposalType,
      quantity: d.quantity,
      disposedAt: d.disposedAt,
      reversedAt: d.reversedAt,
      reversalReason: d.reversalReason,
      notes: d.notes,
      grossProceedsCents: isSaleType ? d.grossProceedsCents : null,
      netProceedsCents: isSaleType ? d.netProceedsCents : null,
      allocatedRecordedCostCents,
      realizedGainLossCents,
      realizedStatus,
    }
  })

  return { rows, nextCursor }
}
