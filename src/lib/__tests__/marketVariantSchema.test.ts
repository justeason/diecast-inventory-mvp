// 21B: schema/migration structural coverage for the packaging MarketVariant
// foundation. Matches this codebase's established convention (source-inspection,
// no live DB) for pinning down schema shape and migration ordering.
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const root = path.resolve(__dirname, '../../..')
function readSrc(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf-8')
}

const schema = readSrc('prisma/schema.prisma')

function modelBlock(name: string): string {
  const start = schema.indexOf(`model ${name} {`)
  expect(start).toBeGreaterThan(-1)
  const end = schema.indexOf('\nmodel ', start + 1)
  return schema.slice(start, end === -1 ? undefined : end)
}

describe('MarketVariant model — V1 packaging-only scope', () => {
  const block = modelBlock('MarketVariant')

  it('has exactly the packaging-only fields — no chase/label/attributes/Json metadata', () => {
    expect(block).toContain('catalogModelId')
    expect(block).toContain('packagingType  String')
    expect(block).not.toMatch(/variantKind|label\s|attributes\s+Json|chase|treasureHunt/i)
  })

  it('is unique on [catalogModelId, packagingType] — the only DB-enforced identity rule', () => {
    expect(block).toContain('@@unique([catalogModelId, packagingType])')
  })

  it('cascades from CatalogModel — deleting a model deletes its own variant rows', () => {
    expect(block).toContain('onDelete: Cascade')
  })

  it('exposes exactly the four documented child relations', () => {
    expect(block).toContain('items          ItemInstance[]')
    expect(block).toContain('intakeDrafts   IntakeDraft[]')
    expect(block).toContain('observations   ExternalMarketObservation[]')
    expect(block).toContain('orderItems     OrderItem[]')
  })
})

describe('CatalogModel — gains marketVariants relation only', () => {
  const block = modelBlock('CatalogModel')
  it('has the new marketVariants and orderItems relations', () => {
    expect(block).toContain('marketVariants       MarketVariant[]')
    expect(block).toContain('orderItems           OrderItem[]')
  })
})

describe('ItemInstance.marketVariantId — required, indexed', () => {
  const block = modelBlock('ItemInstance')
  it('is a required (non-optional) field with a relation to MarketVariant', () => {
    expect(block).toMatch(/marketVariantId\s+String\s*\n/)
    expect(block).toContain('marketVariant           MarketVariant          @relation(fields: [marketVariantId], references: [id])')
  })
  it('has its own index', () => {
    expect(block).toContain('@@index([marketVariantId])')
  })
})

describe('IntakeDraft.marketVariantId — nullable, SetNull', () => {
  const block = modelBlock('IntakeDraft')
  it('is nullable and clears (never blocks) when the variant is deleted', () => {
    expect(block).toMatch(/marketVariantId String\?/)
    expect(block).toContain('marketVariant   MarketVariant? @relation(fields: [marketVariantId], references: [id], onDelete: SetNull)')
  })
})

describe('ExternalMarketObservation.marketVariantId — nullable, SetNull, admin-assigned', () => {
  const block = modelBlock('ExternalMarketObservation')
  it('is nullable and clears (never blocks) when the variant is deleted', () => {
    expect(block).toMatch(/marketVariantId String\?/)
    expect(block).toMatch(/marketVariant\s+MarketVariant\?\s+@relation\(fields: \[marketVariantId\], references: \[id\], onDelete: SetNull\)/)
  })
  it('has its own index alongside the existing catalogModelId index', () => {
    expect(block).toContain('@@index([catalogModelId])')
    expect(block).toContain('@@index([marketVariantId])')
  })
})

describe('OrderItem — identity pointers + immutable sale-fact snapshot', () => {
  const block = modelBlock('OrderItem')

  it('gets nullable catalogModelId + marketVariantId identity pointers', () => {
    expect(block).toMatch(/catalogModelId\s+String\?/)
    expect(block).toMatch(/marketVariantId String\?/)
  })

  it('gets nullable snapshotPackagingType/snapshotCondition sale-fact fields — no re-snapshotted price, no generic Json, no variant label', () => {
    expect(block).toContain('snapshotPackagingType String?')
    expect(block).toContain('snapshotCondition     String?')
    expect(block).not.toMatch(/snapshotPrice|snapshotBrand|snapshotName|snapshotJson/i)
  })

  it('indexes both new identity pointers', () => {
    expect(block).toContain('@@index([catalogModelId])')
    expect(block).toContain('@@index([marketVariantId])')
  })
})

describe('Explicitly untouched models (21B scope discipline)', () => {
  it('CollectionItem has no marketVariantId/variant field at all', () => {
    expect(modelBlock('CollectionItem')).not.toMatch(/marketVariant/i)
  })
  it('SellerSubmission has no MarketVariant relation', () => {
    expect(modelBlock('SellerSubmission')).not.toMatch(/marketVariant/i)
  })
  it('Listing derives variant only via ItemInstance — no direct marketVariantId field', () => {
    expect(modelBlock('Listing')).not.toMatch(/marketVariantId/i)
  })
  it('GuestSellerItem and MobileCaptureItem remain CatalogModel-level only — no packaging/variant field', () => {
    expect(modelBlock('GuestSellerItem')).not.toMatch(/marketVariant/i)
    expect(modelBlock('MobileCaptureItem')).not.toMatch(/marketVariant/i)
  })
  it('WantedCatalogModel/BuyerAlertEvent/BuyerAlertFanout remain CatalogModel-level only', () => {
    expect(modelBlock('WantedCatalogModel')).not.toMatch(/marketVariant/i)
    expect(modelBlock('BuyerAlertEvent')).not.toMatch(/marketVariant/i)
    expect(modelBlock('BuyerAlertFanout')).not.toMatch(/marketVariant/i)
  })
})

describe('migration — exactly one new migration, ordered per spec', () => {
  const migrationsDir = path.join(root, 'prisma/migrations')
  const dirs = fs.readdirSync(migrationsDir).filter((d) => fs.statSync(path.join(migrationsDir, d)).isDirectory())

  it('migration count is at least 51 (21B) — exact current count is asserted in orderItemProvenanceSchema.test.ts (21C)', () => {
    expect(dirs.length).toBeGreaterThanOrEqual(51)
  })

  it('the new migration exists and is the packaging MarketVariant migration', () => {
    const match = dirs.find((d) => d.includes('add_market_variant_packaging'))
    expect(match).toBeTruthy()
  })

  const migrationDir = dirs.find((d) => d.includes('add_market_variant_packaging'))!
  const sql = fs.readFileSync(path.join(migrationsDir, migrationDir, 'migration.sql'), 'utf-8')

  it('creates MarketVariant before backfilling it', () => {
    const createIdx = sql.indexOf('CREATE TABLE "MarketVariant"')
    const insertIdx = sql.indexOf('INSERT INTO "MarketVariant"')
    expect(createIdx).toBeGreaterThan(-1)
    expect(insertIdx).toBeGreaterThan(createIdx)
  })

  it('backfills ItemInstance.marketVariantId BEFORE making it required, with a precondition guard against unrecognized cardedOrLoose values', () => {
    const guardIdx = sql.indexOf('cardedOrLoose" NOT IN')
    const addColIdx = sql.indexOf('ADD COLUMN "marketVariantId"')
    const backfillIdx = sql.indexOf('UPDATE "ItemInstance" ii')
    const notNullIdx = sql.indexOf('ALTER COLUMN "marketVariantId" SET NOT NULL')
    expect(guardIdx).toBeGreaterThan(-1)
    expect(guardIdx).toBeLessThan(addColIdx)
    expect(addColIdx).toBeLessThan(backfillIdx)
    expect(backfillIdx).toBeLessThan(notNullIdx)
  })

  it('never guesses — IntakeDraft backfill requires both catalogModelId and a valid cardedOrLoose', () => {
    const idx = sql.indexOf('UPDATE "IntakeDraft" idr')
    expect(idx).toBeGreaterThan(-1)
    const block = sql.slice(idx, idx + 500)
    expect(block).toContain('idr."catalogModelId" IS NOT NULL')
    expect(block).toContain(`idr."cardedOrLoose" IN ('carded', 'loose')`)
  })

  it('never backfills ExternalMarketObservation.marketVariantId — always null for pre-existing rows', () => {
    const idx = sql.indexOf('ExternalMarketObservation" ADD COLUMN "marketVariantId"')
    expect(idx).toBeGreaterThan(-1)
    expect(sql).not.toMatch(/UPDATE "ExternalMarketObservation"[\s\S]*?marketVariantId/)
  })

  it('conservatively backfills OrderItem.catalogModelId from the item relation, but never fabricates marketVariantId/snapshot fields for legacy rows', () => {
    const backfillIdx = sql.indexOf('UPDATE "OrderItem" oi')
    expect(backfillIdx).toBeGreaterThan(-1)
    const block = sql.slice(backfillIdx, sql.indexOf(';', backfillIdx) + 1)
    expect(block).toContain('SET "catalogModelId" = ii."catalogId"')
    expect(block).not.toContain('marketVariantId')
    expect(block).not.toContain('snapshotPackagingType')
    expect(block).not.toContain('snapshotCondition')
  })

  it('does not touch CatalogModel identity, ItemInstance.cardedOrLoose/condition, Listing, or CollectionItem', () => {
    expect(sql).not.toMatch(/ALTER TABLE "Listing"/)
    expect(sql).not.toMatch(/ALTER TABLE "CollectionItem"/)
    expect(sql).not.toMatch(/UPDATE "ItemInstance"[\s\S]{0,200}"cardedOrLoose" =/)
    expect(sql).not.toMatch(/UPDATE "ItemInstance"[\s\S]{0,200}"condition" =/)
  })
})
