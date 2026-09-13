// 21B: unit coverage for the shared packaging-MarketVariant helper module.
// PACKAGING_TYPES/isValidPackagingType are pure; the rest go through a mocked
// tx, matching this codebase's established convention for DB-boundary helpers.
import { describe, it, expect, vi } from 'vitest'
import {
  PACKAGING_TYPES,
  isValidPackagingType,
  ensurePackagingMarketVariants,
  findPackagingMarketVariant,
  resolvePackagingMarketVariant,
  computeMarketVariantId,
} from '@/lib/marketVariant'

describe('PACKAGING_TYPES / isValidPackagingType', () => {
  it('is exactly [carded, loose] — never a third value', () => {
    expect(PACKAGING_TYPES).toEqual(['carded', 'loose'])
  })

  it('accepts only carded/loose', () => {
    expect(isValidPackagingType('carded')).toBe(true)
    expect(isValidPackagingType('loose')).toBe(true)
  })

  it('rejects anything else, including null/undefined/empty/chase-taxonomy guesses', () => {
    expect(isValidPackagingType(null)).toBe(false)
    expect(isValidPackagingType(undefined)).toBe(false)
    expect(isValidPackagingType('')).toBe(false)
    expect(isValidPackagingType('unspecified')).toBe(false)
    expect(isValidPackagingType('treasure_hunt')).toBe(false)
    expect(isValidPackagingType('CARDED')).toBe(false) // case-sensitive, no normalization
  })
})

describe('ensurePackagingMarketVariants', () => {
  it('creates both carded and loose when neither exists', async () => {
    const findUnique = vi.fn().mockResolvedValue(null)
    const create = vi.fn().mockResolvedValue({ id: 'new' })
    const tx = { marketVariant: { findUnique, create } } as never
    await ensurePackagingMarketVariants(tx, 'cat1')
    expect(create).toHaveBeenCalledTimes(2)
    expect(create).toHaveBeenCalledWith({ data: { catalogModelId: 'cat1', packagingType: 'carded' } })
    expect(create).toHaveBeenCalledWith({ data: { catalogModelId: 'cat1', packagingType: 'loose' } })
  })

  it('is idempotent — creates nothing when both already exist', async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: 'existing' })
    const create = vi.fn()
    const tx = { marketVariant: { findUnique, create } } as never
    await ensurePackagingMarketVariants(tx, 'cat1')
    expect(create).not.toHaveBeenCalled()
  })

  it('only creates the missing one when exactly one already exists', async () => {
    const findUnique = vi.fn().mockImplementation(({ where }: { where: { catalogModelId_packagingType: { packagingType: string } } }) =>
      Promise.resolve(where.catalogModelId_packagingType.packagingType === 'carded' ? { id: 'existing' } : null))
    const create = vi.fn().mockResolvedValue({ id: 'new' })
    const tx = { marketVariant: { findUnique, create } } as never
    await ensurePackagingMarketVariants(tx, 'cat1')
    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith({ data: { catalogModelId: 'cat1', packagingType: 'loose' } })
  })

  it('swallows a P2002 (lost create race to a concurrent call) — the row existing is the desired end state', async () => {
    const findUnique = vi.fn().mockResolvedValue(null)
    const p2002 = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
    const create = vi.fn().mockRejectedValue(p2002)
    const tx = { marketVariant: { findUnique, create } } as never
    await expect(ensurePackagingMarketVariants(tx, 'cat1')).resolves.toBeUndefined()
  })

  it('re-throws a non-P2002 error', async () => {
    const findUnique = vi.fn().mockResolvedValue(null)
    const create = vi.fn().mockRejectedValue(new Error('connection lost'))
    const tx = { marketVariant: { findUnique, create } } as never
    await expect(ensurePackagingMarketVariants(tx, 'cat1')).rejects.toThrow('connection lost')
  })
})

describe('findPackagingMarketVariant', () => {
  it('returns null for an invalid packagingType without ever querying the DB', async () => {
    const findUnique = vi.fn()
    const tx = { marketVariant: { findUnique } } as never
    const result = await findPackagingMarketVariant(tx, 'cat1', 'unspecified')
    expect(result).toBeNull()
    expect(findUnique).not.toHaveBeenCalled()
  })

  it('resolves via the composite unique key, no lock', async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: 'v1' })
    const tx = { marketVariant: { findUnique } } as never
    const result = await findPackagingMarketVariant(tx, 'cat1', 'carded')
    expect(result).toEqual({ id: 'v1' })
    expect(findUnique).toHaveBeenCalledWith({
      where: { catalogModelId_packagingType: { catalogModelId: 'cat1', packagingType: 'carded' } },
      select: { id: true },
    })
  })
})

describe('resolvePackagingMarketVariant', () => {
  it('returns the variant id when found', async () => {
    const tx = { marketVariant: { findUnique: vi.fn().mockResolvedValue({ id: 'v1' }) } } as never
    await expect(resolvePackagingMarketVariant(tx, 'cat1', 'loose')).resolves.toBe('v1')
  })

  it('throws a defensive error when not found — every CatalogModel is guaranteed to already have both variants', async () => {
    const tx = { marketVariant: { findUnique: vi.fn().mockResolvedValue(null) } } as never
    await expect(resolvePackagingMarketVariant(tx, 'cat1', 'carded')).rejects.toThrow('MARKET_VARIANT_NOT_FOUND')
  })
})

describe('computeMarketVariantId — for nullable IntakeDraft/ExternalMarketObservation targets', () => {
  it('returns null (never throws) when catalogModelId is missing', async () => {
    const tx = { marketVariant: { findUnique: vi.fn() } } as never
    await expect(computeMarketVariantId(tx, null, 'carded')).resolves.toBeNull()
    await expect(computeMarketVariantId(tx, undefined, 'carded')).resolves.toBeNull()
  })

  it('returns null (never throws) when cardedOrLoose is missing or invalid — unknown is not a price-comparable bucket', async () => {
    const tx = { marketVariant: { findUnique: vi.fn() } } as never
    await expect(computeMarketVariantId(tx, 'cat1', null)).resolves.toBeNull()
    await expect(computeMarketVariantId(tx, 'cat1', 'unspecified')).resolves.toBeNull()
  })

  it('resolves normally when both are known and valid', async () => {
    const tx = { marketVariant: { findUnique: vi.fn().mockResolvedValue({ id: 'v1' }) } } as never
    await expect(computeMarketVariantId(tx, 'cat1', 'carded')).resolves.toBe('v1')
  })
})
