/**
 * ONE-TIME OWNERSHIP LEDGER BACKFILL (26B)
 *
 * Creates exactly one legacy AcquisitionLot per existing CollectionItem
 * (catalog-backed AND freeform — catalogId is never required, §5), preserving
 * the item's current quantity as the lot's quantityAcquired/remainingQuantity
 * without re-deriving or inventing anything:
 *
 *   quantity=1 + valid purchasePrice  -> unitRecordedCostCents known
 *   quantity>1 + valid purchasePrice  -> legacyRecordedPriceCents preserved
 *                                        raw, costKnowledge='ambiguous_legacy',
 *                                        NEVER divided/multiplied, NEVER used
 *                                        in cost/gain math
 *   purchasePrice null/invalid        -> unitRecordedCostCents=unknown
 *
 * ledgerEffectiveAt is max(cutover, item.createdAt) — ONE fixed cutover
 * timestamp for the entire run (this migration's own finished_at, read from
 * _prisma_migrations — never a fresh `new Date()` per row, never hardcoded),
 * EXCEPT when the CollectionItem itself was created after that cutover (a
 * real gap: the backfill runs as a separate manual step, sometime after the
 * migration, so items can legitimately be created in between) — ownership
 * must never be projected as ledger-known before the CollectionItem existed,
 * so that row's own createdAt is used instead. acquiredAt is the item's
 * existing purchaseDate verbatim, or null — never fabricated.
 *
 * Idempotent: each lot's sourceKey is 'legacy-backfill:<collectionItemId>'
 * (unique) — a second run performs zero additional writes. Never touches
 * CollectionItem.quantity (already correct from years of pre-ledger writes;
 * syncCollectionItemQuantity:false on the founding lot avoids double-counting).
 * Never mutates CollectionItem.purchasePrice/purchaseDate — those remain as
 * legacy/edit-compatibility fields (26B §72).
 *
 * Usage:
 *   npx tsx scripts/backfillOwnershipLedger.ts             # dry run (default)
 *   npx tsx scripts/backfillOwnershipLedger.ts --dry-run    # explicit dry run
 *   npx tsx scripts/backfillOwnershipLedger.ts --apply      # perform writes
 *
 * Not wired into build/deploy/prisma migrate/app startup — run manually, once,
 * by an operator.
 */

import { PrismaClient } from '@prisma/client'
import { resolveLegacyCostKnowledge, resolveLedgerEffectiveAt, createAcquisitionLot } from '../src/lib/ownershipLedger'

export const LEDGER_MIGRATION_NAME = '20260914000000_add_ownership_ledger'

const prisma = new PrismaClient()
const PAGE_SIZE = 200
const apply = process.argv.includes('--apply')

type Counts = {
  scanned: number
  alreadyLedgered: number
  skippedInvalidQuantity: number
  knownCost: number
  ambiguousLegacyCost: number
  unknownCost: number
  backfilled: number
}

function emptyCounts(): Counts {
  return {
    scanned: 0, alreadyLedgered: 0, skippedInvalidQuantity: 0,
    knownCost: 0, ambiguousLegacyCost: 0, unknownCost: 0, backfilled: 0,
  }
}

async function resolveCutover(): Promise<Date> {
  const rows = await prisma.$queryRawUnsafe<Array<{ finished_at: Date | null }>>(
    `SELECT finished_at FROM "_prisma_migrations" WHERE migration_name = $1`,
    LEDGER_MIGRATION_NAME,
  )
  const row = rows[0]
  if (!row || !row.finished_at) {
    throw new Error(
      `Cannot resolve ledger cutover: migration "${LEDGER_MIGRATION_NAME}" not found (or has no finished_at) in _prisma_migrations. Refusing to guess a wall-clock boundary — aborting.`,
    )
  }
  return row.finished_at
}

async function main() {
  console.log(`Mode: ${apply ? 'APPLY (writes enabled)' : 'DRY RUN (no writes)'}`)

  const cutover = await resolveCutover()
  console.log(`Ledger cutover (26B migration finished_at): ${cutover.toISOString()}`)

  const counts = emptyCounts()

  let cursor: string | undefined
  for (;;) {
    const page = await prisma.collectionItem.findMany({
      select: { id: true, quantity: true, purchasePrice: true, purchaseDate: true, createdAt: true },
      orderBy: { id: 'asc' },
      take: PAGE_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    })
    if (page.length === 0) break
    cursor = page[page.length - 1].id

    for (const item of page) {
      counts.scanned++
      const sourceKey = `legacy-backfill:${item.id}`

      const existing = await prisma.acquisitionLot.findUnique({ where: { sourceKey }, select: { id: true } })
      if (existing) {
        counts.alreadyLedgered++
        continue
      }

      if (!Number.isInteger(item.quantity) || item.quantity < 1) {
        // Never invent a plausible quantity for corrupt/legacy-invalid data.
        counts.skippedInvalidQuantity++
        continue
      }

      const resolution = resolveLegacyCostKnowledge(item.quantity, item.purchasePrice)
      if (resolution.costKnowledge === 'known') counts.knownCost++
      else if (resolution.costKnowledge === 'ambiguous_legacy') counts.ambiguousLegacyCost++
      else counts.unknownCost++

      const ledgerEffectiveAt = resolveLedgerEffectiveAt(cutover, item.createdAt)

      if (apply) {
        await prisma.$transaction((tx) =>
          createAcquisitionLot(tx, {
            collectionItemId: item.id,
            quantityAcquired: item.quantity,
            unitRecordedCostCents: resolution.unitRecordedCostCents,
            legacyRecordedPriceCents: resolution.legacyRecordedPriceCents,
            costKnowledge: resolution.costKnowledge,
            acquiredAt: item.purchaseDate,
            ledgerEffectiveAt,
            source: 'legacy_backfill',
            sourceKey,
            syncCollectionItemQuantity: false,
          }),
        )
        counts.backfilled++
      }
    }
  }

  console.log('\n── Coverage report ─────────────────────────────')
  for (const [key, value] of Object.entries(counts)) console.log(`  ${key}: ${value}`)
  if (!apply) console.log('\nDry run only — no rows were written. Re-run with --apply to write.')
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
