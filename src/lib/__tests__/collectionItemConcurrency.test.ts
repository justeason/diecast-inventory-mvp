/**
 * 16F Final: concurrent Add-to-Collection integrity. A check-then-create pattern
 * alone cannot prevent two simultaneous requests from both creating a
 * CollectionItem row for the same (profileId, catalogId) — this proves the
 * authoritative DB-side @@unique constraint is what actually closes that race, and
 * that createCollectionItem handles the losing request cleanly (P2002) rather than
 * crashing or silently incrementing quantity. No real DB, no real network.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'

type Mock = ReturnType<typeof vi.fn>

const root = path.resolve(__dirname, '../../..')
function src(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf-8')
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    catalogModel: { findUnique: vi.fn() },
    collectionItem: { findFirst: vi.fn(), create: vi.fn() },
  },
}))
vi.mock('@/lib/buyerSession', () => ({ getBuyerSession: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: vi.fn(() => { throw new Error('NEXT_REDIRECT') }) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), updateTag: vi.fn() }))

import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { getBuyerSession } from '@/lib/buyerSession'
import { createCollectionItem } from '@/lib/actions/collectionItems'

beforeEach(() => vi.resetAllMocks())

function fd(catalogId: string): FormData {
  const f = new FormData()
  f.set('catalogId', catalogId)
  return f
}

// A P2002 error shaped like Prisma's real unique-constraint-violation error.
function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '5.22.0',
  })
}

describe('Schema: CollectionItem DB-enforced uniqueness', () => {
  it('has @@unique([profileId, catalogId]) — the authoritative constraint, not just an app-level pre-check', () => {
    const schema = src('prisma/schema.prisma')
    const idx = schema.indexOf('model CollectionItem {')
    const modelSrc = schema.slice(idx, schema.indexOf('\n}', idx))
    expect(modelSrc).toContain('@@unique([profileId, catalogId])')
  })

  it('a migration exists that creates the matching unique index', () => {
    const migrationDirs = fs.readdirSync(path.join(root, 'prisma/migrations'))
    const match = migrationDirs.find((d) => d.includes('collection_item_unique'))
    expect(match).toBeDefined()
    const sql = src(`prisma/migrations/${match}/migration.sql`)
    expect(sql).toContain('CREATE UNIQUE INDEX "CollectionItem_profileId_catalogId_key" ON "CollectionItem"("profileId", "catalogId")')
  })
})

describe('16F Final Persistence Integrity Pass: migration fails safely on historical duplicates, never auto-reconciles', () => {
  function migrationSql(): string {
    const migrationDirs = fs.readdirSync(path.join(root, 'prisma/migrations'))
    const match = migrationDirs.find((d) => d.includes('collection_item_unique'))!
    return src(`prisma/migrations/${match}/migration.sql`)
  }

  it('has an explicit precondition block that detects duplicate non-null (profileId, catalogId) pairs before creating the index', () => {
    const sql = migrationSql()
    const doIdx = sql.indexOf('DO $$')
    const indexIdx = sql.indexOf('CREATE UNIQUE INDEX')
    expect(doIdx).toBeGreaterThan(-1)
    expect(doIdx).toBeLessThan(indexIdx) // precondition runs BEFORE the index is created
    expect(sql).toContain('WHERE "catalogId" IS NOT NULL')
    expect(sql).toContain('GROUP BY "profileId", "catalogId"')
    expect(sql).toContain('HAVING count(*) > 1')
  })

  it('raises a clear, actionable error (not Postgres\'s opaque unique-index-violation message) when duplicates exist', () => {
    const sql = migrationSql()
    expect(sql).toContain('RAISE EXCEPTION')
    expect(sql).toMatch(/Migration blocked/)
    expect(sql).toMatch(/manually reconcile/i)
  })

  it('never deletes or merges duplicate rows automatically — no DELETE/UPDATE/mutation statement anywhere in the migration', () => {
    const sql = migrationSql()
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i)
    expect(sql).not.toMatch(/\bUPDATE\s+"CollectionItem"/i)
    expect(sql).not.toMatch(/\bMERGE\s+INTO\b/i)
  })

  it('the precondition only counts catalogId IS NOT NULL pairs — freeform (catalogId IS NULL) rows are explicitly excluded and remain unlimited', () => {
    const sql = migrationSql()
    const doIdx = sql.indexOf('DO $$')
    const endIdx = sql.indexOf('END $$;')
    const block = sql.slice(doIdx, endIdx)
    expect(block).toContain('"catalogId" IS NOT NULL')
    expect(block).not.toContain('"catalogId" IS NULL')
  })
})

describe('createCollectionItem: concurrent Add to Collection cannot create duplicate rows', () => {
  it('the losing request of a race (findFirst check passes for both, but create() hits the DB constraint) returns a friendly error, not a crash', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue({ id: 'cat1' })
    // Simulates the race: the pre-check sees no existing row (the other concurrent
    // request hasn't committed yet either) ...
    ;(prisma.collectionItem.findFirst as Mock).mockResolvedValue(null)
    // ... but the DB-side unique constraint rejects the actual create.
    ;(prisma.collectionItem.create as Mock).mockRejectedValue(p2002())

    const result = await createCollectionItem(null, fd('cat1'))

    expect(result?.errors.catalogId?.[0]).toContain('You already have this model in your collection')
  })

  it('the P2002 catch never falls through to update/increment an existing row — quantity is never silently changed', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue({ id: 'cat1' })
    ;(prisma.collectionItem.findFirst as Mock).mockResolvedValue(null)
    ;(prisma.collectionItem.create as Mock).mockRejectedValue(p2002())

    await createCollectionItem(null, fd('cat1'))

    const src_ = fs.readFileSync(path.join(root, 'src/lib/actions/collectionItems.ts'), 'utf-8')
    const fnIdx = src_.indexOf('export async function createCollectionItem')
    const fnEnd = src_.indexOf('export async function updateCollectionItem')
    const fnSrc = src_.slice(fnIdx, fnEnd)
    expect(fnSrc).not.toContain('collectionItem.update')
    expect(fnSrc).not.toContain('collectionItem.upsert')
  })

  it('a non-P2002 error is rethrown, not swallowed as a fake duplicate-model error', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue({ id: 'cat1' })
    ;(prisma.collectionItem.findFirst as Mock).mockResolvedValue(null)
    ;(prisma.collectionItem.create as Mock).mockRejectedValue(new Error('connection reset'))

    await expect(createCollectionItem(null, fd('cat1'))).rejects.toThrow('connection reset')
  })

  it('the winning request (no conflict) still creates with quantity defaulting to 1 and redirects to the new item', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue({ id: 'cat1' })
    ;(prisma.collectionItem.findFirst as Mock).mockResolvedValue(null)
    ;(prisma.collectionItem.create as Mock).mockResolvedValue({ id: 'new-item-1' })

    await expect(createCollectionItem(null, fd('cat1'))).rejects.toThrow() // redirect() throws in test env

    const createCall = (prisma.collectionItem.create as Mock).mock.calls[0][0]
    expect(createCall.data.quantity).toBe(1)
    expect(createCall.data.catalogId).toBe('cat1')
  })

  it('the pre-check (findFirst) still returns the friendly error in the common non-racy case, without ever hitting create()', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue({ id: 'cat1' })
    ;(prisma.collectionItem.findFirst as Mock).mockResolvedValue({ id: 'existing' })

    const result = await createCollectionItem(null, fd('cat1'))

    expect(result?.errors.catalogId?.[0]).toContain('You already have this model in your collection')
    expect(prisma.collectionItem.create).not.toHaveBeenCalled()
  })
})

describe('createCollectionItem: freeform (catalogId=null) rows remain unlimited — Postgres NULL-distinct semantics', () => {
  it('freeform submissions (no catalogId) skip the duplicate check and constraint entirely, as before', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
    ;(prisma.collectionItem.create as Mock).mockResolvedValue({ id: 'freeform-1' })

    const f = new FormData()
    f.set('brand', 'Generic Brand')
    f.set('name', 'Some Car')

    await expect(createCollectionItem(null, f)).rejects.toThrow()

    expect(prisma.catalogModel.findUnique).not.toHaveBeenCalled()
    expect(prisma.collectionItem.findFirst).not.toHaveBeenCalled()
    const createCall = (prisma.collectionItem.create as Mock).mock.calls[0][0]
    expect(createCall.data.catalogId).toBeUndefined()
  })
})
