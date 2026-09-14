// 25B: Portfolio V1 — value/cost/gain-loss/coverage math, cost-status policy,
// and the freeform/whole-collection/no-cross-model-fallback invariants.
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({
  prisma: { collectionItem: { findMany: vi.fn() } },
}))
vi.mock('@/lib/marketValuation', () => ({
  getValuationsBatch: vi.fn(),
}))

import { prisma } from '@/lib/prisma'
import { getValuationsBatch } from '@/lib/marketValuation'
import { getPortfolio } from '@/lib/portfolioQuery'
import type { ValuationResult } from '@/lib/marketValuation'

const ASOF = new Date('2026-06-01T00:00:00Z')

function item(overrides: Partial<{ id: string; catalogId: string | null; quantity: number; purchasePrice: number | null }> = {}) {
  return { id: 'ci1', catalogId: 'cat1', quantity: 1, purchasePrice: null, ...overrides }
}

function valued(overrides: Partial<Extract<ValuationResult, { status: 'valued' }>> = {}): ValuationResult {
  return {
    status: 'valued', catalogModelId: 'cat1', marketVariantId: null, condition: null,
    estimatedValueCents: 1000, marketRangeLowCents: null, marketRangeHighCents: null,
    confidence: 'medium', specificity: 'model', primarySpecificity: 'model',
    rawSampleCount: 3, usedSampleCount: 3, excludedOutlierCount: 0,
    internalSampleCount: 3, externalSampleCount: 0,
    asOf: ASOF, windowStart: new Date('2024-06-01'), extendedHistoryUsed: false, sampleTruncated: false,
    method: 'median_sales', outlierMethod: 'none', fallbackReason: null, latestSaleAt: ASOF,
    ...overrides,
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  ;(getValuationsBatch as Mock).mockResolvedValue(new Map())
})

// ── Value ────────────────────────────────────────────────────────────────────

describe('getPortfolio — Portfolio Value (§77)', () => {
  it('single valued holding: estimatedHoldingValueCents = unit * quantity', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 3 })])
    ;(getValuationsBatch as Mock).mockResolvedValue(new Map([['cat1', valued({ estimatedValueCents: 1000 })]]))
    const result = await getPortfolio('p1', ASOF)
    expect(result.holdings[0].estimatedHoldingValueCents).toBe(3000)
    expect(result.estimatedPortfolioValueCents).toBe(3000)
  })

  it('multiple valued holdings sum correctly', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([
      item({ id: 'ci1', catalogId: 'cat1', quantity: 2 }),
      item({ id: 'ci2', catalogId: 'cat2', quantity: 1 }),
    ])
    ;(getValuationsBatch as Mock).mockResolvedValue(
      new Map([
        ['cat1', valued({ catalogModelId: 'cat1', estimatedValueCents: 1000 })],
        ['cat2', valued({ catalogModelId: 'cat2', estimatedValueCents: 500 })],
      ]),
    )
    const result = await getPortfolio('p1', ASOF)
    expect(result.estimatedPortfolioValueCents).toBe(2000 + 500)
  })

  it('mixed valued/unvalued: unvalued excluded from total, not $0', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([
      item({ id: 'ci1', catalogId: 'cat1', quantity: 1 }),
      item({ id: 'ci2', catalogId: 'cat2', quantity: 1 }),
    ])
    ;(getValuationsBatch as Mock).mockResolvedValue(
      new Map([
        ['cat1', valued({ catalogModelId: 'cat1', estimatedValueCents: 1000 })],
        ['cat2', { status: 'insufficient_data', catalogModelId: 'cat2', marketVariantId: null, condition: null, asOf: ASOF, reason: 'no_sales' }],
      ]),
    )
    const result = await getPortfolio('p1', ASOF)
    expect(result.estimatedPortfolioValueCents).toBe(1000)
    expect(result.holdings[1].valuationStatus).toBe('insufficient_data')
    expect(result.holdings[1].estimatedHoldingValueCents).toBeNull()
  })

  it('freeform holding (catalogId null): no_catalog_match, no market value, still counts toward totalCopies', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ catalogId: null, quantity: 2 })])
    const result = await getPortfolio('p1', ASOF)
    expect(getValuationsBatch).not.toHaveBeenCalled()
    expect(result.holdings[0].valuationStatus).toBe('no_catalog_match')
    expect(result.marketValueCoverage.totalCopies).toBe(2)
    expect(result.marketValueCoverage.valuedCopies).toBe(0)
    expect(result.estimatedPortfolioValueCents).toBeNull()
  })

  it('no cross-model fallback: a model with insufficient_data never substitutes another model\'s value', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ catalogId: 'cat1', quantity: 1 })])
    ;(getValuationsBatch as Mock).mockResolvedValue(
      new Map([['cat1', { status: 'insufficient_data', catalogModelId: 'cat1', marketVariantId: null, condition: null, asOf: ASOF, reason: 'no_sales' }]]),
    )
    const result = await getPortfolio('p1', ASOF)
    expect(result.holdings[0].estimatedUnitValueCents).toBeNull()
    expect(result.estimatedPortfolioValueCents).toBeNull()
  })

  it('internal+external V1 valuation is reflected via getValuationsBatch (no separate portfolio math)', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ catalogId: 'cat1', quantity: 1 })])
    ;(getValuationsBatch as Mock).mockResolvedValue(
      new Map([['cat1', valued({ internalSampleCount: 2, externalSampleCount: 1, usedSampleCount: 3 })]]),
    )
    const result = await getPortfolio('p1', ASOF)
    expect(result.holdings[0].valuationStatus).toBe('valued')
  })
})

// ── Cost status ──────────────────────────────────────────────────────────────

describe('getPortfolio — cost status policy (§19/§20/§21/§78)', () => {
  it('quantity=1 + valid price -> known', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 1, purchasePrice: 20 })])
    const result = await getPortfolio('p1', ASOF)
    expect(result.holdings[0].costStatus).toBe('known')
    expect(result.holdings[0].recordedCostCents).toBe(2000)
  })

  it('quantity=1 + null price -> unknown', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 1, purchasePrice: null })])
    const result = await getPortfolio('p1', ASOF)
    expect(result.holdings[0].costStatus).toBe('unknown')
    expect(result.holdings[0].recordedCostCents).toBeNull()
  })

  it('quantity=1 + price=0 -> known zero (never confused with unknown)', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 1, purchasePrice: 0 })])
    const result = await getPortfolio('p1', ASOF)
    expect(result.holdings[0].costStatus).toBe('known')
    expect(result.holdings[0].recordedCostCents).toBe(0)
  })

  it('quantity>1 + price present -> ambiguous_quantity, excluded from totals', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 3, purchasePrice: 20 })])
    const result = await getPortfolio('p1', ASOF)
    expect(result.holdings[0].costStatus).toBe('ambiguous_quantity')
    expect(result.holdings[0].recordedCostCents).toBeNull()
    expect(result.recordedCostCents).toBeNull()
    expect(result.costCoverage.knownCostCopies).toBe(0)
  })

  it('negative legacy price -> invalid, excluded', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 1, purchasePrice: -5 })])
    const result = await getPortfolio('p1', ASOF)
    expect(result.holdings[0].costStatus).toBe('invalid')
    expect(result.holdings[0].recordedCostCents).toBeNull()
  })

  it('non-finite legacy price -> invalid, excluded', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 1, purchasePrice: NaN })])
    const result = await getPortfolio('p1', ASOF)
    expect(result.holdings[0].costStatus).toBe('invalid')
  })
})

// ── Recorded Cost total ──────────────────────────────────────────────────────

describe('getPortfolio — Recorded Cost total only includes safe known costs (§24/§79)', () => {
  it('unknown, ambiguous, and invalid costs are all excluded; only known costs sum', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([
      item({ id: 'known', quantity: 1, purchasePrice: 10 }),
      item({ id: 'unknown', quantity: 1, purchasePrice: null }),
      item({ id: 'ambiguous', quantity: 2, purchasePrice: 10 }),
      item({ id: 'invalid', quantity: 1, purchasePrice: -1 }),
    ])
    const result = await getPortfolio('p1', ASOF)
    expect(result.recordedCostCents).toBe(1000) // only the $10 known row
  })

  it('a true known zero cost is included in the total (as 0) and counts as covered', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 1, purchasePrice: 0 })])
    const result = await getPortfolio('p1', ASOF)
    expect(result.recordedCostCents).toBe(0)
    expect(result.costCoverage.knownCostCopies).toBe(1)
  })

  it('no holding has usable cost -> recordedCostCents is null, not $0', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 1, purchasePrice: null })])
    const result = await getPortfolio('p1', ASOF)
    expect(result.recordedCostCents).toBeNull()
  })
})

// ── Gain/Loss ────────────────────────────────────────────────────────────────

describe('getPortfolio — Unrealized Gain/Loss (§27/§28/§29/§80)', () => {
  it('positive gain', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 1, purchasePrice: 5 })])
    ;(getValuationsBatch as Mock).mockResolvedValue(new Map([['cat1', valued({ estimatedValueCents: 1000 })]]))
    const result = await getPortfolio('p1', ASOF)
    expect(result.holdings[0].unrealizedGainLossCents).toBe(500) // 1000 - 500
    expect(result.holdings[0].unrealizedGainLossPercent).toBeCloseTo(1.0)
  })

  it('negative loss (no judgmental clamping)', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 1, purchasePrice: 20 })])
    ;(getValuationsBatch as Mock).mockResolvedValue(new Map([['cat1', valued({ estimatedValueCents: 1000 })]]))
    const result = await getPortfolio('p1', ASOF)
    expect(result.holdings[0].unrealizedGainLossCents).toBe(-1000) // 1000 - 2000
    expect(result.holdings[0].unrealizedGainLossPercent).toBeCloseTo(-0.5)
  })

  it('zero gain/loss', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 1, purchasePrice: 10 })])
    ;(getValuationsBatch as Mock).mockResolvedValue(new Map([['cat1', valued({ estimatedValueCents: 1000 })]]))
    const result = await getPortfolio('p1', ASOF)
    expect(result.holdings[0].unrealizedGainLossCents).toBe(0)
  })

  it('unknown EMV -> gain/loss unavailable even with known cost', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 1, purchasePrice: 10 })])
    ;(getValuationsBatch as Mock).mockResolvedValue(
      new Map([['cat1', { status: 'insufficient_data', catalogModelId: 'cat1', marketVariantId: null, condition: null, asOf: ASOF, reason: 'no_sales' }]]),
    )
    const result = await getPortfolio('p1', ASOF)
    expect(result.holdings[0].unrealizedGainLossCents).toBeNull()
  })

  it('unknown cost -> gain/loss unavailable even with known EMV', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 1, purchasePrice: null })])
    ;(getValuationsBatch as Mock).mockResolvedValue(new Map([['cat1', valued({ estimatedValueCents: 1000 })]]))
    const result = await getPortfolio('p1', ASOF)
    expect(result.holdings[0].unrealizedGainLossCents).toBeNull()
  })

  it('ambiguous multi-copy cost -> gain/loss unavailable', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 4, purchasePrice: 10 })])
    ;(getValuationsBatch as Mock).mockResolvedValue(new Map([['cat1', valued({ estimatedValueCents: 1000 })]]))
    const result = await getPortfolio('p1', ASOF)
    expect(result.holdings[0].unrealizedGainLossCents).toBeNull()
  })

  it('zero-cost denominator -> percent is null, never Infinity', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 1, purchasePrice: 0 })])
    ;(getValuationsBatch as Mock).mockResolvedValue(new Map([['cat1', valued({ estimatedValueCents: 1000 })]]))
    const result = await getPortfolio('p1', ASOF)
    expect(result.holdings[0].unrealizedGainLossCents).toBe(1000)
    expect(result.holdings[0].unrealizedGainLossPercent).toBeNull()
    expect(result.holdings[0].unrealizedGainLossPercent).not.toBe(Infinity)
  })
})

// ── Coverage ─────────────────────────────────────────────────────────────────

describe('getPortfolio — copy-weighted coverage (25A worked example, §81/§94, adapted to the qty===1 safe-cost policy)', () => {
  it('Holding A (qty1, value+cost known) + B (qty3, value known/cost unknown) + C (qty1, value unknown/cost known)', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([
      item({ id: 'A', catalogId: 'catA', quantity: 1, purchasePrice: 10 }),
      item({ id: 'B', catalogId: 'catB', quantity: 3, purchasePrice: null }),
      item({ id: 'C', catalogId: 'catC', quantity: 1, purchasePrice: 15 }),
    ])
    ;(getValuationsBatch as Mock).mockResolvedValue(
      new Map([
        ['catA', valued({ catalogModelId: 'catA', estimatedValueCents: 1000 })],
        ['catB', valued({ catalogModelId: 'catB', estimatedValueCents: 500 })],
        ['catC', { status: 'insufficient_data', catalogModelId: 'catC', marketVariantId: null, condition: null, asOf: ASOF, reason: 'no_sales' }],
      ]),
    )
    const result = await getPortfolio('p1', ASOF)

    // total copies = A(1) + B(3) + C(1) = 5
    expect(result.marketValueCoverage).toEqual({ valuedCopies: 4, totalCopies: 5 }) // A(1)+B(3) valued
    expect(result.costCoverage).toEqual({ knownCostCopies: 2, totalCopies: 5 }) // A(1)+C(1) known
    expect(result.gainLossCoverage).toEqual({ comparableCopies: 1, totalCopies: 5 }) // only A has both
  })

  it('an ambiguous multi-copy row never counts as cost-covered', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 5, purchasePrice: 20 })])
    const result = await getPortfolio('p1', ASOF)
    expect(result.costCoverage.knownCostCopies).toBe(0)
    expect(result.costCoverage.totalCopies).toBe(5)
  })

  it('invalid quantity holdings contribute zero copies to every coverage denominator', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 0, purchasePrice: 10 })])
    const result = await getPortfolio('p1', ASOF)
    expect(result.holdings[0].quantityValid).toBe(false)
    expect(result.marketValueCoverage.totalCopies).toBe(0)
    expect(result.costCoverage.totalCopies).toBe(0)
  })
})

// ── Whole collection / same asOf ─────────────────────────────────────────────

describe('getPortfolio — whole collection, one asOf (§14/§51/§82/§83)', () => {
  it('fetches the entire profile collection with no take/cursor limit', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([])
    await getPortfolio('p1', ASOF)
    const call = (prisma.collectionItem.findMany as Mock).mock.calls[0][0]
    expect(call.where).toEqual({ profileId: 'p1' })
    expect(call.take).toBeUndefined()
    expect(call.cursor).toBeUndefined()
  })

  it('passes the exact same asOf through to getValuationsBatch', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ catalogId: 'cat1' })])
    ;(getValuationsBatch as Mock).mockResolvedValue(new Map())
    await getPortfolio('p1', ASOF)
    expect((getValuationsBatch as Mock).mock.calls[0][0].asOf).toBe(ASOF)
  })
})
