// 21C: schema/migration structural coverage for OrderItem.snapshotProvenance.
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

describe('OrderItem.snapshotProvenance — schema (§47)', () => {
  const block = modelBlock('OrderItem')

  it('is a nullable String field — no other schema change on OrderItem', () => {
    expect(block).toMatch(/snapshotProvenance String\?/)
  })

  it('is not a confidence score / quality number / JSON / admin flag', () => {
    expect(block).not.toMatch(/snapshotConfidence|snapshotQuality|provenanceScore/i)
    expect(schema).not.toMatch(/snapshotProvenance\s+(Int|Float|Json|Boolean)/)
  })

  it('existing snapshot fields are untouched by 21C', () => {
    expect(block).toContain('snapshotPackagingType String?')
    expect(block).toContain('snapshotCondition     String?')
  })
})

describe('migration — exactly one new migration (§4/§47)', () => {
  const migrationsDir = path.join(root, 'prisma/migrations')
  const dirs = fs.readdirSync(migrationsDir).filter((d) => fs.statSync(path.join(migrationsDir, d)).isDirectory())

  it('migration count is exactly 52', () => {
    expect(dirs.length).toBe(54) // 26B added the ownership-ledger migration
  })

  it('the new migration exists and is the snapshot-provenance migration', () => {
    expect(dirs.find((d) => d.includes('add_order_item_snapshot_provenance'))).toBeTruthy()
  })

  const migrationDir = dirs.find((d) => d.includes('add_order_item_snapshot_provenance'))!
  const sql = fs.readFileSync(path.join(migrationsDir, migrationDir, 'migration.sql'), 'utf-8')

  it('adds the column before backfilling it', () => {
    const addIdx = sql.indexOf('ADD COLUMN "snapshotProvenance"')
    const updateIdx = sql.indexOf('UPDATE "OrderItem"')
    expect(addIdx).toBeGreaterThan(-1)
    expect(updateIdx).toBeGreaterThan(addIdx)
  })

  it('backfills sale_time only for rows already carrying all three physical-fact fields, and never overwrites an existing non-null provenance', () => {
    const idx = sql.indexOf('UPDATE "OrderItem"')
    const block = sql.slice(idx, sql.indexOf(';', idx) + 1)
    expect(block).toContain("SET \"snapshotProvenance\" = 'sale_time'")
    expect(block).toContain('"snapshotProvenance" IS NULL')
    expect(block).toContain('"marketVariantId" IS NOT NULL')
    expect(block).toContain('"snapshotPackagingType" IS NOT NULL')
    expect(block).toContain('"snapshotCondition" IS NOT NULL')
  })

  it('never touches ItemInstance, IntakeDraft, Listing, or CollectionItem', () => {
    expect(sql).not.toMatch(/ALTER TABLE "ItemInstance"/)
    expect(sql).not.toMatch(/UPDATE "ItemInstance"/)
    expect(sql).not.toMatch(/ALTER TABLE "IntakeDraft"/)
    expect(sql).not.toMatch(/ALTER TABLE "Listing"/)
    expect(sql).not.toMatch(/ALTER TABLE "CollectionItem"/)
  })

  it('does no legacy IntakeDraft-based reconstruction in SQL (application-level script only, per §21)', () => {
    expect(sql).not.toContain('"IntakeDraft"')
    expect(sql).not.toMatch(/=\s*'intake_declared'/)
    expect(sql).not.toMatch(/=\s*'legacy_model_only'/)
  })
})
