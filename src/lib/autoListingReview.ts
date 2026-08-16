// 15K (execution-snapshot pass, Part 6/11): the ONE authoritative definition of
// "Auto-Listing Needs Manual Review" — shared by /admin/auto-listing's review list
// and /admin/inventory's exact review count. Never implemented twice.
//
// An item is currently in the review queue iff:
//   1. its LATEST attempt with outcome IN ('review_required', 'denied') exists, AND
//   2. the item does not currently have an active or sold Listing.
//
// This is deliberately NOT "count every historical review_required row" (Part 5) —
// that grows forever and never reflects resolution. It is also not merely "no
// Listing row at all" — an item whose only Listing is `archived` (the
// listingPath='reactivate' case, out of automation's scope per Part F) still
// legitimately needs manual attention, exactly mirroring 15J's own `already_listed`
// blocker definition (status !== null && status !== 'archived' — see readyToList.ts).
//
// Resolution requires NO extra bookkeeping/mutation: a later successful auto-list
// (Part 7) or a later successful MANUAL listing (Part 8) both create a real Listing
// row (status active), which the NOT EXISTS below picks up immediately — the old
// AutoListingAttempt row is never rewritten or deleted (Part 13, immutable audit).
// `stale`/`failed` attempts are excluded from the actionable definition entirely
// (Part 10) — they are operational/retry noise, not a human-actionable judgment
// call, and never supersede an earlier genuine review_required/denied verdict; they
// simply don't affect this predicate at all (a stale hiccup on the latest run does
// not erase a still-unresolved review reason from an earlier run).
//
// Implemented as one raw SQL query (Postgres DISTINCT ON) rather than loading
// attempt history into JS — see prisma/migrations/..._auto_listing_attempt_item_
// created_index for the supporting (itemId, createdAt) index. No buyer PII: only
// item/attempt columns are selected.
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'

const REVIEW_QUEUE_BASE = Prisma.sql`
  SELECT DISTINCT ON (a."itemId")
    a.id, a."itemId", a."runId", a.outcome, a."reasonCode", a."proposedPriceCents", a."createdAt"
  FROM "AutoListingAttempt" a
  WHERE a.outcome IN ('review_required', 'denied')
    AND NOT EXISTS (
      SELECT 1 FROM "Listing" l WHERE l."itemId" = a."itemId" AND l.status IN ('active', 'sold')
    )
  ORDER BY a."itemId", a."createdAt" DESC, a.id DESC
`

// Exact DB-side count — cheap enough for a nav/hub badge, never a fake/derived
// number (Part 11: must match the list population exactly, since both are built
// from REVIEW_QUEUE_BASE).
export async function getNeedsManualReviewCount(): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>(
    Prisma.sql`SELECT COUNT(*)::bigint AS count FROM (${REVIEW_QUEUE_BASE}) latest`,
  )
  return Number(rows[0]?.count ?? 0n)
}

export type ReviewQueueRow = {
  id: string; itemId: string; runId: string; outcome: string; reasonCode: string
  proposedPriceCents: number | null; createdAt: Date
  item: { sku: string; brand: string; name: string } | null
}

// Bounded, deterministically ordered (most recently flagged first), keyset
// paginated — never a full attempt-history load, never OFFSET.
export async function listNeedsManualReview(cursor: string | null = null, pageSize = 25): Promise<{ items: ReviewQueueRow[]; nextCursor: string | null }> {
  let cursorFilter = Prisma.sql``
  if (cursor) {
    const [msPart, idPart] = cursor.split('_')
    const ms = Number(msPart)
    if (Number.isFinite(ms) && idPart) {
      const cursorDate = new Date(ms)
      cursorFilter = Prisma.sql`WHERE (latest."createdAt" < ${cursorDate}) OR (latest."createdAt" = ${cursorDate} AND latest.id < ${idPart})`
    }
  }

  const rows = await prisma.$queryRaw<{
    id: string; itemId: string; runId: string; outcome: string; reasonCode: string
    proposedPriceCents: number | null; createdAt: Date
  }[]>(Prisma.sql`
    SELECT * FROM (${REVIEW_QUEUE_BASE}) latest
    ${cursorFilter}
    ORDER BY latest."createdAt" DESC, latest.id DESC
    LIMIT ${pageSize + 1}
  `)

  const hasMore = rows.length > pageSize
  const page = hasMore ? rows.slice(0, pageSize) : rows

  // Batch-hydrate item display fields — one query regardless of page size, never N+1.
  const itemIds = [...new Set(page.map((r) => r.itemId))]
  const items = itemIds.length > 0
    ? await prisma.itemInstance.findMany({ where: { id: { in: itemIds } }, select: { id: true, sku: true, catalog: { select: { brand: true, name: true } } } })
    : []
  const itemById = new Map(items.map((i) => [i.id, { sku: i.sku, brand: i.catalog.brand, name: i.catalog.name }]))

  const last = page[page.length - 1]
  return {
    items: page.map((r) => ({ ...r, item: itemById.get(r.itemId) ?? null })),
    nextCursor: hasMore && last ? `${last.createdAt.getTime()}_${last.id}` : null,
  }
}
