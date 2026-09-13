/**
 * ONE-TIME HISTORICAL SALE NORMALIZATION (21C)
 *
 * Populates OrderItem.snapshotProvenance (and, where provable, marketVariantId /
 * snapshotPackagingType / snapshotCondition) for legacy completed OrderItems that
 * predate the 21B snapshot fields.
 *
 * The ONLY source used for automatic recovery of historical physical facts is the
 * converted IntakeDraft directly linked to the sold ItemInstance
 * (IntakeDraft.convertedItemId = OrderItem.itemId), which is structurally frozen
 * after conversion. Current (mutable) ItemInstance.cardedOrLoose/condition are
 * NEVER used as historical evidence — they have always remained editable even for
 * sold items. SellerSubmission and Listing are never used as evidence either.
 *
 * Legacy boundary: OrderItem.createdAt <= the 21B migration's finished_at
 * (read from _prisma_migrations — never hardcoded). Rows created AFTER that
 * boundary that still lack a snapshotProvenance are reported as
 * "post-cutover malformed" and are NEVER auto-repaired — that would hide a
 * broken post-21B write path.
 *
 * Writes are strictly conditional: never overwrites an existing non-null
 * snapshotProvenance/marketVariantId/snapshotPackagingType/snapshotCondition.
 * Never mutates ItemInstance or IntakeDraft. Idempotent — a second run against
 * an unchanged DB performs zero writes. See src/lib/historicalSaleNormalization.ts
 * for the (unit-tested) pure classification logic this script applies per row.
 *
 * Usage:
 *   npx tsx scripts/normalizeHistoricalSales.ts             # dry run (default)
 *   npx tsx scripts/normalizeHistoricalSales.ts --dry-run    # explicit dry run
 *   npx tsx scripts/normalizeHistoricalSales.ts --apply      # perform writes
 *
 * Not wired into build/deploy/prisma migrate/app startup — run manually, once,
 * by an operator.
 */

import { PrismaClient } from '@prisma/client'
import { PACKAGING_TYPES } from '../src/lib/marketVariant'
import { classifyLegacyOrderItem, NORMALIZATION_MIGRATION_NAME, type LegacyCandidateRow, type Classification, type MalformedBucket } from '../src/lib/historicalSaleNormalization'

function isMalformed(c: Classification): c is { bucket: MalformedBucket } {
  return (
    c.bucket === 'postCutoverMalformed' ||
    c.bucket === 'writeConflictExistingPartialState' ||
    c.bucket === 'malformedMissingCatalog' ||
    c.bucket === 'malformedMissingCompletedAt' ||
    c.bucket === 'malformedNonPositivePrice'
  )
}

const prisma = new PrismaClient()
const PAGE_SIZE = 200
const apply = process.argv.includes('--apply')

type Counts = {
  scanned: number
  alreadySaleTime: number
  recoveredFull: number
  recoveredPackagingOnly: number
  recoveredConditionOnly: number
  modelOnly: number
  postCutoverMalformed: number
  malformedMissingCatalog: number
  malformedMissingCompletedAt: number
  malformedNonPositivePrice: number
  variantResolutionErrors: number
  writeConflicts: number
  updated: number
}

function emptyCounts(): Counts {
  return {
    scanned: 0, alreadySaleTime: 0, recoveredFull: 0, recoveredPackagingOnly: 0,
    recoveredConditionOnly: 0, modelOnly: 0, postCutoverMalformed: 0,
    malformedMissingCatalog: 0, malformedMissingCompletedAt: 0, malformedNonPositivePrice: 0,
    variantResolutionErrors: 0, writeConflicts: 0, updated: 0,
  }
}

// Small, bounded sample id lists for debugging malformed/conflict groups — no PII.
const MAX_SAMPLE_IDS = 10
function pushSample(bucket: string[], id: string) {
  if (bucket.length < MAX_SAMPLE_IDS) bucket.push(id)
}

async function resolveCutover(): Promise<Date> {
  const rows = await prisma.$queryRawUnsafe<Array<{ finished_at: Date | null }>>(
    `SELECT finished_at FROM "_prisma_migrations" WHERE migration_name = $1`,
    NORMALIZATION_MIGRATION_NAME,
  )
  const row = rows[0]
  if (!row || !row.finished_at) {
    throw new Error(
      `Cannot resolve legacy cutover: migration "${NORMALIZATION_MIGRATION_NAME}" not found (or has no finished_at) in _prisma_migrations. Refusing to guess a wall-clock boundary — aborting.`,
    )
  }
  return row.finished_at
}

async function main() {
  console.log(`Mode: ${apply ? 'APPLY (writes enabled)' : 'DRY RUN (no writes)'}`)

  const cutover = await resolveCutover()
  console.log(`Legacy cutover (21B migration finished_at): ${cutover.toISOString()}`)

  const counts = emptyCounts()
  const samples = {
    postCutoverMalformed: [] as string[],
    malformedMissingCatalog: [] as string[],
    malformedMissingCompletedAt: [] as string[],
    malformedNonPositivePrice: [] as string[],
    variantResolutionErrors: [] as string[],
    writeConflicts: [] as string[],
  }

  counts.alreadySaleTime = await prisma.orderItem.count({
    where: { order: { status: 'complete' }, snapshotProvenance: { not: null } },
  })

  let cursor: string | undefined
  for (;;) {
    const page = await prisma.orderItem.findMany({
      where: { order: { status: 'complete' }, snapshotProvenance: null },
      select: {
        id: true, itemId: true, catalogModelId: true, marketVariantId: true,
        snapshotPackagingType: true, snapshotCondition: true, price: true, createdAt: true,
        order: { select: { completedAt: true } },
      },
      orderBy: { id: 'asc' },
      take: PAGE_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    })

    if (page.length === 0) break
    cursor = page[page.length - 1].id

    // ── Batch-fetch evidence for this page only — never per-row. ──────────────
    const itemIds = page.map((r) => r.itemId)
    const drafts = await prisma.intakeDraft.findMany({
      where: { convertedItemId: { in: itemIds }, status: 'converted' },
      select: { convertedItemId: true, cardedOrLoose: true, condition: true },
    })
    const draftByItemId = new Map(drafts.map((d) => [d.convertedItemId as string, d]))

    const catalogModelIdsNeedingVariant = new Set<string>()
    for (const row of page) {
      const draft = draftByItemId.get(row.itemId)
      if (row.catalogModelId && draft?.cardedOrLoose) catalogModelIdsNeedingVariant.add(row.catalogModelId)
    }
    const variants = catalogModelIdsNeedingVariant.size
      ? await prisma.marketVariant.findMany({
          where: { catalogModelId: { in: [...catalogModelIdsNeedingVariant] }, packagingType: { in: [...PACKAGING_TYPES] } },
          select: { catalogModelId: true, packagingType: true, id: true },
        })
      : []
    const variantByKey = new Map(variants.map((v) => [`${v.catalogModelId}:${v.packagingType}`, v.id]))
    const resolveVariantId = (catalogModelId: string, packagingType: string) =>
      variantByKey.get(`${catalogModelId}:${packagingType}`) ?? null

    for (const row of page) {
      counts.scanned++

      const candidate: LegacyCandidateRow = {
        id: row.id, itemId: row.itemId, catalogModelId: row.catalogModelId,
        marketVariantId: row.marketVariantId, snapshotPackagingType: row.snapshotPackagingType,
        snapshotCondition: row.snapshotCondition, price: row.price, createdAt: row.createdAt,
        completedAt: row.order.completedAt,
      }
      const classification = classifyLegacyOrderItem(candidate, cutover, draftByItemId.get(row.itemId), resolveVariantId)

      if (isMalformed(classification)) {
        const sampleKey = classification.bucket === 'writeConflictExistingPartialState' ? 'writeConflicts' : classification.bucket
        counts[sampleKey]++
        pushSample(samples[sampleKey], row.id)
        continue
      }

      if (classification.variantResolutionError) { counts.variantResolutionErrors++; pushSample(samples.variantResolutionErrors, row.id) }
      counts[classification.bucket]++

      if (apply) {
        const result = await prisma.orderItem.updateMany({
          where: { id: row.id, snapshotProvenance: null, marketVariantId: null, snapshotPackagingType: null, snapshotCondition: null },
          data: {
            snapshotProvenance: classification.provenance,
            ...(classification.marketVariantId ? { marketVariantId: classification.marketVariantId } : {}),
            ...(classification.snapshotPackagingType ? { snapshotPackagingType: classification.snapshotPackagingType } : {}),
            ...(classification.snapshotCondition ? { snapshotCondition: classification.snapshotCondition } : {}),
          },
        })
        if (result.count === 1) counts.updated++
        else { counts.writeConflicts++; pushSample(samples.writeConflicts, row.id) }
      }
    }
  }

  console.log('\n── Coverage report ─────────────────────────────')
  for (const [key, value] of Object.entries(counts)) console.log(`  ${key}: ${value}`)
  console.log('\n── Sample ids (bounded, no PII) ────────────────')
  for (const [key, ids] of Object.entries(samples)) if (ids.length) console.log(`  ${key}: ${ids.join(', ')}`)
  if (!apply) console.log('\nDry run only — no rows were written. Re-run with --apply to write.')
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
