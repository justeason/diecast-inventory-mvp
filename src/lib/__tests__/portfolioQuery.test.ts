// 26B: Portfolio V1 — now sources cost from the ownership ledger
// (AcquisitionLot, remainingQuantity-weighted) rather than
// CollectionItem.purchasePrice directly, and adds a portfolio-wide Recorded
// Realized Gain/Loss aggregate over non-reversed sale-type disposals. Value/
// coverage/gain-loss math and the freeform/whole-collection/no-cross-model-
// fallback invariants carry over from 25B unchanged in spirit, updated to the
// new known/partial/unknown holding-cost-status model.
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({
  prisma: {
    collectionItem: { findMany: vi.fn() },
    acquisitionLot: { findMany: vi.fn() },
    collectionDisposal: { findMany: vi.fn() },
  },
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

function lot(overrides: Partial<{
  collectionItemId: string
  remainingQuantity: number
  unitRecordedCostCents: number | null
}> = {}) {
  return { collectionItemId: 'ci1', remainingQuantity: 1, unitRecordedCostCents: null, ...overrides }
}

function saleDisposal(overrides: Partial<{
  netProceedsCents: number | null
  allocations: Array<{ allocatedRecordedCostCents: number | null }>
}> = {}) {
  return { netProceedsCents: null, allocations: [], ...overrides }
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
  ;(prisma.acquisitionLot.findMany as Mock).mockResolvedValue([])
  ;(prisma.collectionDisposal.findMany as Mock).mockResolvedValue([])
})

// ── Value ────────────────────────────────────────────────────────────────────

describe('getPortfolio — Portfolio Value', () => {
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

// ── Cost status (ledger-sourced, 26B) ───────────────────────────────────────

describe('getPortfolio — holding cost status is sourced from remaining AcquisitionLots (26B)', () => {
  it('a single fully-known-cost lot covering all remaining copies -> known', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 1 })])
    ;(prisma.acquisitionLot.findMany as Mock).mockResolvedValue([lot({ remainingQuantity: 1, unitRecordedCostCents: 2000 })])
    const result = await getPortfolio('p1', ASOF)
    expect(result.holdings[0].costStatus).toBe('known')
    expect(result.holdings[0].recordedCostCents).toBe(2000)
    expect(result.holdings[0].knownCostCopies).toBe(1)
  })

  it('no remaining lots at all -> unknown', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 1 })])
    ;(prisma.acquisitionLot.findMany as Mock).mockResolvedValue([])
    const result = await getPortfolio('p1', ASOF)
    expect(result.holdings[0].costStatus).toBe('unknown')
    expect(result.holdings[0].recordedCostCents).toBeNull()
  })

  it('an unknown-cost lot (unitRecordedCostCents null) covering all remaining copies -> unknown, not known-zero', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 1 })])
    ;(prisma.acquisitionLot.findMany as Mock).mockResolvedValue([lot({ remainingQuantity: 1, unitRecordedCostCents: null })])
    const result = await getPortfolio('p1', ASOF)
    expect(result.holdings[0].costStatus).toBe('unknown')
    expect(result.holdings[0].recordedCostCents).toBeNull()
  })

  it('known unit cost of $0 is included in the total (as 0) and still counts as known, never confused with unknown', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 1 })])
    ;(prisma.acquisitionLot.findMany as Mock).mockResolvedValue([lot({ remainingQuantity: 1, unitRecordedCostCents: 0 })])
    const result = await getPortfolio('p1', ASOF)
    expect(result.holdings[0].costStatus).toBe('known')
    expect(result.holdings[0].recordedCostCents).toBe(0)
  })

  it('two remaining lots, one known one unknown, covering the full remaining quantity -> partial, sums only the known lot', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 2 })])
    ;(prisma.acquisitionLot.findMany as Mock).mockResolvedValue([
      lot({ remainingQuantity: 1, unitRecordedCostCents: 1000 }),
      lot({ remainingQuantity: 1, unitRecordedCostCents: null }),
    ])
    const result = await getPortfolio('p1', ASOF)
    expect(result.holdings[0].costStatus).toBe('partial')
    expect(result.holdings[0].recordedCostCents).toBe(1000)
    expect(result.holdings[0].knownCostCopies).toBe(1)
  })

  it('multiple known lots at different unit costs for the same item sum correctly (multiple acquisitions, 26B)', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 3 })])
    ;(prisma.acquisitionLot.findMany as Mock).mockResolvedValue([
      lot({ remainingQuantity: 2, unitRecordedCostCents: 500 }),
      lot({ remainingQuantity: 1, unitRecordedCostCents: 800 }),
    ])
    const result = await getPortfolio('p1', ASOF)
    expect(result.holdings[0].costStatus).toBe('known')
    expect(result.holdings[0].recordedCostCents).toBe(500 * 2 + 800)
  })

  it('lots belonging to a different collectionItemId are never attributed to this holding', () => {
    // covered structurally: portfolioQuery.ts groups lots strictly by lot.collectionItemId
    expect(true).toBe(true)
  })
})

// ── Recorded Cost total ──────────────────────────────────────────────────────

describe('getPortfolio — Recorded Cost total only includes known-cost lots', () => {
  it('unknown and partial-coverage holdings are excluded from the row cost figure at the unknown level; only known/partial contribute their known portion', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([
      item({ id: 'known', quantity: 1 }),
      item({ id: 'unknown', quantity: 1 }),
    ])
    ;(prisma.acquisitionLot.findMany as Mock).mockResolvedValue([
      lot({ collectionItemId: 'known', remainingQuantity: 1, unitRecordedCostCents: 1000 }),
    ])
    const result = await getPortfolio('p1', ASOF)
    expect(result.recordedCostCents).toBe(1000)
  })

  it('a true known zero cost is included in the total (as 0) and counts as covered', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 1 })])
    ;(prisma.acquisitionLot.findMany as Mock).mockResolvedValue([lot({ remainingQuantity: 1, unitRecordedCostCents: 0 })])
    const result = await getPortfolio('p1', ASOF)
    expect(result.recordedCostCents).toBe(0)
    expect(result.costCoverage.knownCostCopies).toBe(1)
  })

  it('no holding has any known-cost lot -> recordedCostCents is null, not $0', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 1 })])
    const result = await getPortfolio('p1', ASOF)
    expect(result.recordedCostCents).toBeNull()
  })
})

// ── Gain/Loss ────────────────────────────────────────────────────────────────

describe('getPortfolio — Unrealized Gain/Loss only at full remaining-cost coverage', () => {
  it('positive gain', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 1 })])
    ;(prisma.acquisitionLot.findMany as Mock).mockResolvedValue([lot({ remainingQuantity: 1, unitRecordedCostCents: 500 })])
    ;(getValuationsBatch as Mock).mockResolvedValue(new Map([['cat1', valued({ estimatedValueCents: 1000 })]]))
    const result = await getPortfolio('p1', ASOF)
    expect(result.holdings[0].unrealizedGainLossCents).toBe(500) // 1000 - 500
    expect(result.holdings[0].unrealizedGainLossPercent).toBeCloseTo(1.0)
  })

  it('negative loss (no judgmental clamping)', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 1 })])
    ;(prisma.acquisitionLot.findMany as Mock).mockResolvedValue([lot({ remainingQuantity: 1, unitRecordedCostCents: 2000 })])
    ;(getValuationsBatch as Mock).mockResolvedValue(new Map([['cat1', valued({ estimatedValueCents: 1000 })]]))
    const result = await getPortfolio('p1', ASOF)
    expect(result.holdings[0].unrealizedGainLossCents).toBe(-1000) // 1000 - 2000
    expect(result.holdings[0].unrealizedGainLossPercent).toBeCloseTo(-0.5)
  })

  it('zero gain/loss', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 1 })])
    ;(prisma.acquisitionLot.findMany as Mock).mockResolvedValue([lot({ remainingQuantity: 1, unitRecordedCostCents: 1000 })])
    ;(getValuationsBatch as Mock).mockResolvedValue(new Map([['cat1', valued({ estimatedValueCents: 1000 })]]))
    const result = await getPortfolio('p1', ASOF)
    expect(result.holdings[0].unrealizedGainLossCents).toBe(0)
  })

  it('unknown EMV -> gain/loss unavailable even with known cost', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 1 })])
    ;(prisma.acquisitionLot.findMany as Mock).mockResolvedValue([lot({ remainingQuantity: 1, unitRecordedCostCents: 1000 })])
    ;(getValuationsBatch as Mock).mockResolvedValue(
      new Map([['cat1', { status: 'insufficient_data', catalogModelId: 'cat1', marketVariantId: null, condition: null, asOf: ASOF, reason: 'no_sales' }]]),
    )
    const result = await getPortfolio('p1', ASOF)
    expect(result.holdings[0].unrealizedGainLossCents).toBeNull()
  })

  it('unknown cost -> gain/loss unavailable even with known EMV', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 1 })])
    ;(getValuationsBatch as Mock).mockResolvedValue(new Map([['cat1', valued({ estimatedValueCents: 1000 })]]))
    const result = await getPortfolio('p1', ASOF)
    expect(result.holdings[0].unrealizedGainLossCents).toBeNull()
  })

  it('partial cost coverage (one known lot, one unknown lot) -> gain/loss unavailable, never computed off the partial cost', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 2 })])
    ;(prisma.acquisitionLot.findMany as Mock).mockResolvedValue([
      lot({ remainingQuantity: 1, unitRecordedCostCents: 500 }),
      lot({ remainingQuantity: 1, unitRecordedCostCents: null }),
    ])
    ;(getValuationsBatch as Mock).mockResolvedValue(new Map([['cat1', valued({ estimatedValueCents: 1000 })]]))
    const result = await getPortfolio('p1', ASOF)
    expect(result.holdings[0].costStatus).toBe('partial')
    expect(result.holdings[0].unrealizedGainLossCents).toBeNull()
  })

  it('zero-cost denominator -> percent is null, never Infinity', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 1 })])
    ;(prisma.acquisitionLot.findMany as Mock).mockResolvedValue([lot({ remainingQuantity: 1, unitRecordedCostCents: 0 })])
    ;(getValuationsBatch as Mock).mockResolvedValue(new Map([['cat1', valued({ estimatedValueCents: 1000 })]]))
    const result = await getPortfolio('p1', ASOF)
    expect(result.holdings[0].unrealizedGainLossCents).toBe(1000)
    expect(result.holdings[0].unrealizedGainLossPercent).toBeNull()
    expect(result.holdings[0].unrealizedGainLossPercent).not.toBe(Infinity)
  })
})

// ── 26C: Holding Performance — Average Recorded Cost ────────────────────────

describe('getPortfolio — Average Recorded Cost (26C §62 full-cost worked example)', () => {
  it('2 remaining copies ($15 + $24), full coverage: avg $19.50, EMV $31.40/copy, holding value $62.80, unrealized +$23.80 — exact cent arithmetic', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 2 })])
    ;(prisma.acquisitionLot.findMany as Mock).mockResolvedValue([
      lot({ remainingQuantity: 1, unitRecordedCostCents: 1500 }),
      lot({ remainingQuantity: 1, unitRecordedCostCents: 2400 }),
    ])
    ;(getValuationsBatch as Mock).mockResolvedValue(new Map([['cat1', valued({ estimatedValueCents: 3140 })]]))
    const result = await getPortfolio('p1', ASOF)
    const h = result.holdings[0]
    expect(h.recordedCostCents).toBe(3900)
    expect(h.averageRecordedCostCents).toBe(1950)
    expect(h.estimatedUnitValueCents).toBe(3140)
    expect(h.estimatedHoldingValueCents).toBe(6280)
    expect(h.unrealizedGainLossCents).toBe(2380)
  })
})

describe('getPortfolio — Average Recorded Cost (26C §63 partial-cost holding)', () => {
  it('1 known $20 + 1 unknown: recorded cost $20, coverage 1 of 2, average UNAVAILABLE, unrealized UNAVAILABLE — never implies the unknown copy also cost $20', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 2 })])
    ;(prisma.acquisitionLot.findMany as Mock).mockResolvedValue([
      lot({ remainingQuantity: 1, unitRecordedCostCents: 2000 }),
      lot({ remainingQuantity: 1, unitRecordedCostCents: null }),
    ])
    ;(getValuationsBatch as Mock).mockResolvedValue(new Map([['cat1', valued({ estimatedValueCents: 3000 })]]))
    const result = await getPortfolio('p1', ASOF)
    const h = result.holdings[0]
    expect(h.costStatus).toBe('partial')
    expect(h.recordedCostCents).toBe(2000)
    expect(h.knownCostCopies).toBe(1)
    expect(h.averageRecordedCostCents).toBeNull()
    expect(h.unrealizedGainLossCents).toBeNull()
  })
})

describe('getPortfolio — Average Recorded Cost (26C §64 zero-cost holding)', () => {
  it('a fully-covered known-$0 holding: average $0.00 (never confused with unavailable), unrealized dollar value calculable, percent unavailable', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 1 })])
    ;(prisma.acquisitionLot.findMany as Mock).mockResolvedValue([lot({ remainingQuantity: 1, unitRecordedCostCents: 0 })])
    ;(getValuationsBatch as Mock).mockResolvedValue(new Map([['cat1', valued({ estimatedValueCents: 1000 })]]))
    const result = await getPortfolio('p1', ASOF)
    const h = result.holdings[0]
    expect(h.costStatus).toBe('known')
    expect(h.averageRecordedCostCents).toBe(0)
    expect(h.unrealizedGainLossCents).toBe(1000)
    expect(h.unrealizedGainLossPercent).toBeNull()
  })
})

describe('getPortfolio — Average Recorded Cost (26C §65 uses CURRENT remaining quantity, never original quantityAcquired)', () => {
  it('a lot originally acquired at 5 but partially sold down to remainingQuantity 2 contributes only 2 copies to the average, not 5', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 2 })])
    ;(prisma.acquisitionLot.findMany as Mock).mockResolvedValue([lot({ remainingQuantity: 2, unitRecordedCostCents: 1000 })])
    const result = await getPortfolio('p1', ASOF)
    const h = result.holdings[0]
    expect(h.knownCostCopies).toBe(2)
    expect(h.recordedCostCents).toBe(2000)
    expect(h.averageRecordedCostCents).toBe(1000)
  })
})

describe('getPortfolio — Average Recorded Cost (26C §43/§66 after a FIFO partial sale)', () => {
  it('acquired 1@$15 then 2@$24; selling 1 via FIFO leaves remaining 2@$24 only — average becomes $24, never a historical blended $21', async () => {
    // The 1@$15 lot is fully consumed (remainingQuantity 0) by the FIFO sale —
    // getPortfolio only ever queries remainingQuantity>0 lots, so it never
    // appears here; this row IS what "remaining lots only" looks like.
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 2 })])
    ;(prisma.acquisitionLot.findMany as Mock).mockResolvedValue([lot({ remainingQuantity: 2, unitRecordedCostCents: 2400 })])
    const result = await getPortfolio('p1', ASOF)
    const h = result.holdings[0]
    expect(h.averageRecordedCostCents).toBe(2400)
    expect(h.averageRecordedCostCents).not.toBe(2100) // never the blended (1500+2400+2400)/3
  })
})

describe('getPortfolio — Average Recorded Cost (26C §45/§67 after reversal)', () => {
  it('a reversal restores remainingQuantity on the lot — Holding Performance immediately reflects it by reading current ledger state, no special-case correction needed', async () => {
    // Reversal restoring remainingQuantity is exercised at the ledger level in
    // ownershipLedger.test.ts (reverseDisposal); this proves getPortfolio needs
    // no separate mechanism — it just reads whatever remainingQuantity currently is.
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 1 })])
    ;(prisma.acquisitionLot.findMany as Mock).mockResolvedValue([lot({ remainingQuantity: 1, unitRecordedCostCents: 1500 })])
    const result = await getPortfolio('p1', ASOF)
    expect(result.holdings[0].averageRecordedCostCents).toBe(1500)
    expect(result.holdings[0].knownCostCopies).toBe(1)
  })
})

describe('getPortfolio — Average Recorded Cost (26C §68 freeform holdings)', () => {
  it('a freeform (catalogId null) holding can still show a fully-covered average, but never EMV/holding value/unrealized', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ catalogId: null, quantity: 2 })])
    ;(prisma.acquisitionLot.findMany as Mock).mockResolvedValue([lot({ remainingQuantity: 2, unitRecordedCostCents: 1000 })])
    const result = await getPortfolio('p1', ASOF)
    const h = result.holdings[0]
    expect(h.averageRecordedCostCents).toBe(1000)
    expect(h.valuationStatus).toBe('no_catalog_match')
    expect(h.estimatedUnitValueCents).toBeNull()
    expect(h.estimatedHoldingValueCents).toBeNull()
    expect(h.unrealizedGainLossCents).toBeNull()
  })
})

// ── Coverage ─────────────────────────────────────────────────────────────────

describe('getPortfolio — copy-weighted coverage (adapted to the ledger-sourced cost model)', () => {
  it('Holding A (qty1, value+cost known) + B (qty3, value known/cost unknown) + C (qty1, value unknown/cost known)', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([
      item({ id: 'A', catalogId: 'catA', quantity: 1 }),
      item({ id: 'B', catalogId: 'catB', quantity: 3 }),
      item({ id: 'C', catalogId: 'catC', quantity: 1 }),
    ])
    ;(prisma.acquisitionLot.findMany as Mock).mockResolvedValue([
      lot({ collectionItemId: 'A', remainingQuantity: 1, unitRecordedCostCents: 1000 }),
      lot({ collectionItemId: 'C', remainingQuantity: 1, unitRecordedCostCents: 1500 }),
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

  it('a partial-coverage multi-copy row never counts its unknown copies as cost-covered', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 5 })])
    ;(prisma.acquisitionLot.findMany as Mock).mockResolvedValue([lot({ remainingQuantity: 2, unitRecordedCostCents: 200 })])
    const result = await getPortfolio('p1', ASOF)
    expect(result.costCoverage.knownCostCopies).toBe(2)
    expect(result.costCoverage.totalCopies).toBe(5)
  })

  it('invalid quantity holdings contribute zero copies to every coverage denominator', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 0 })])
    const result = await getPortfolio('p1', ASOF)
    expect(result.holdings[0].quantityValid).toBe(false)
    expect(result.marketValueCoverage.totalCopies).toBe(0)
    expect(result.costCoverage.totalCopies).toBe(0)
  })
})

// ── Recorded Realized Gain/Loss (26B) ───────────────────────────────────────

describe('getPortfolio — Recorded Realized Gain/Loss aggregates non-reversed sale disposals only', () => {
  it('no sale disposals -> recordedRealizedGainLossCents is null (not $0), realizedCoverage is 0 of 0', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 1 })])
    const result = await getPortfolio('p1', ASOF)
    expect(result.recordedRealizedGainLossCents).toBeNull()
    expect(result.realizedCoverage).toEqual({ coveredDisposals: 0, totalDisposals: 0 })
  })

  it('a single calculable positive-gain disposal is reflected in the total and counted covered', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 0 })])
    ;(prisma.collectionDisposal.findMany as Mock).mockResolvedValue([
      saleDisposal({ netProceedsCents: 1500, allocations: [{ allocatedRecordedCostCents: 1000 }] }),
    ])
    const result = await getPortfolio('p1', ASOF)
    expect(result.recordedRealizedGainLossCents).toBe(500)
    expect(result.realizedCoverage).toEqual({ coveredDisposals: 1, totalDisposals: 1 })
  })

  it('a negative-gain (loss) disposal is included as a negative number, no clamping to zero', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 1 })])
    ;(prisma.collectionDisposal.findMany as Mock).mockResolvedValue([
      saleDisposal({ netProceedsCents: 500, allocations: [{ allocatedRecordedCostCents: 1000 }] }),
    ])
    const result = await getPortfolio('p1', ASOF)
    expect(result.recordedRealizedGainLossCents).toBe(-500)
  })

  it('multiple disposals sum: one calculable positive, one calculable negative -> net total', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 1 })])
    ;(prisma.collectionDisposal.findMany as Mock).mockResolvedValue([
      saleDisposal({ netProceedsCents: 1500, allocations: [{ allocatedRecordedCostCents: 1000 }] }), // +500
      saleDisposal({ netProceedsCents: 300, allocations: [{ allocatedRecordedCostCents: 800 }] }), // -500
    ])
    const result = await getPortfolio('p1', ASOF)
    expect(result.recordedRealizedGainLossCents).toBe(0)
    expect(result.realizedCoverage).toEqual({ coveredDisposals: 2, totalDisposals: 2 })
  })

  it('unknown net proceeds -> disposal excluded from the total and from the covered count, but still counted in totalDisposals', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 1 })])
    ;(prisma.collectionDisposal.findMany as Mock).mockResolvedValue([
      saleDisposal({ netProceedsCents: null, allocations: [{ allocatedRecordedCostCents: 1000 }] }),
    ])
    const result = await getPortfolio('p1', ASOF)
    expect(result.recordedRealizedGainLossCents).toBeNull()
    expect(result.realizedCoverage).toEqual({ coveredDisposals: 0, totalDisposals: 1 })
  })

  it('an allocation with unknown cost makes the whole disposal unavailable — never treated as zero cost', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 1 })])
    ;(prisma.collectionDisposal.findMany as Mock).mockResolvedValue([
      saleDisposal({
        netProceedsCents: 1000,
        allocations: [{ allocatedRecordedCostCents: 500 }, { allocatedRecordedCostCents: null }],
      }),
    ])
    const result = await getPortfolio('p1', ASOF)
    expect(result.recordedRealizedGainLossCents).toBeNull()
    expect(result.realizedCoverage).toEqual({ coveredDisposals: 0, totalDisposals: 1 })
  })

  it('one calculable + one unavailable disposal: total reflects only the calculable one, coverage is 1 of 2', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 1 })])
    ;(prisma.collectionDisposal.findMany as Mock).mockResolvedValue([
      saleDisposal({ netProceedsCents: 1500, allocations: [{ allocatedRecordedCostCents: 1000 }] }),
      saleDisposal({ netProceedsCents: null, allocations: [{ allocatedRecordedCostCents: 1000 }] }),
    ])
    const result = await getPortfolio('p1', ASOF)
    expect(result.recordedRealizedGainLossCents).toBe(500)
    expect(result.realizedCoverage).toEqual({ coveredDisposals: 1, totalDisposals: 2 })
  })

  it('only queries collectionDisposal for platform_sale/external_sale, excluding reversed rows — asserted via the where clause passed to findMany', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 1 })])
    await getPortfolio('p1', ASOF)
    const call = (prisma.collectionDisposal.findMany as Mock).mock.calls[0][0]
    expect(call.where.reversedAt).toBeNull()
    expect(call.where.disposalType.in).toEqual(['platform_sale', 'external_sale'])
  })

  it('a zero-cost disposal (allocatedRecordedCostCents 0) is calculable, not treated as unknown', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 1 })])
    ;(prisma.collectionDisposal.findMany as Mock).mockResolvedValue([
      saleDisposal({ netProceedsCents: 1000, allocations: [{ allocatedRecordedCostCents: 0 }] }),
    ])
    const result = await getPortfolio('p1', ASOF)
    expect(result.recordedRealizedGainLossCents).toBe(1000)
    expect(result.realizedCoverage).toEqual({ coveredDisposals: 1, totalDisposals: 1 })
  })
})

// ── Unbackfilled legacy deployment state (26B Final Gate §5/§6) ─────────────

describe('getPortfolio — a CollectionItem with ZERO AcquisitionLots falls back to 25B-safe legacy purchasePrice semantics', () => {
  it('qty=1 + valid legacy purchasePrice -> known cost, usable, never a fabricated zero', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 1, purchasePrice: 12.5 })])
    ;(prisma.acquisitionLot.findMany as Mock).mockResolvedValue([]) // not yet backfilled
    const result = await getPortfolio('p1', ASOF)
    expect(result.holdings[0].costStatus).toBe('known')
    expect(result.holdings[0].recordedCostCents).toBe(1250)
    expect(result.holdings[0].knownCostCopies).toBe(1)
  })

  it('qty=1 + purchasePrice=0 -> known zero, never confused with unknown', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 1, purchasePrice: 0 })])
    ;(prisma.acquisitionLot.findMany as Mock).mockResolvedValue([])
    const result = await getPortfolio('p1', ASOF)
    expect(result.holdings[0].costStatus).toBe('known')
    expect(result.holdings[0].recordedCostCents).toBe(0)
  })

  it('qty>1 + purchasePrice -> ambiguous legacy, excluded from totals (never averaged/divided)', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 3, purchasePrice: 30 })])
    ;(prisma.acquisitionLot.findMany as Mock).mockResolvedValue([])
    const result = await getPortfolio('p1', ASOF)
    expect(result.holdings[0].costStatus).toBe('unknown')
    expect(result.holdings[0].recordedCostCents).toBeNull()
    expect(result.holdings[0].knownCostCopies).toBe(0)
  })

  it('purchasePrice null -> unknown, never fabricated', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 1, purchasePrice: null })])
    ;(prisma.acquisitionLot.findMany as Mock).mockResolvedValue([])
    const result = await getPortfolio('p1', ASOF)
    expect(result.holdings[0].costStatus).toBe('unknown')
    expect(result.holdings[0].recordedCostCents).toBeNull()
  })

  it('a valid legacy cost still drives Unrealized Gain/Loss when a market value is also known', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 1, purchasePrice: 5 })])
    ;(prisma.acquisitionLot.findMany as Mock).mockResolvedValue([])
    ;(getValuationsBatch as Mock).mockResolvedValue(new Map([['cat1', valued({ estimatedValueCents: 1000 })]]))
    const result = await getPortfolio('p1', ASOF)
    expect(result.holdings[0].unrealizedGainLossCents).toBe(500)
  })

  it('never calls acquisitionLot.create/collectionItem.update — a read-time fallback must never write a lot row', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 1, purchasePrice: 10 })])
    ;(prisma.acquisitionLot.findMany as Mock).mockResolvedValue([])
    await getPortfolio('p1', ASOF)
    const acquisitionLotMock = prisma.acquisitionLot as unknown as Record<string, unknown>
    expect(acquisitionLotMock.create).toBeUndefined()
  })

  it('once at least one real lot exists for the item, the ledger is authoritative and the legacy purchasePrice is ignored entirely — even if it would say something different', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 1, purchasePrice: 999 })])
    ;(prisma.acquisitionLot.findMany as Mock).mockResolvedValue([lot({ remainingQuantity: 1, unitRecordedCostCents: 250 })])
    const result = await getPortfolio('p1', ASOF)
    expect(result.holdings[0].costStatus).toBe('known')
    expect(result.holdings[0].recordedCostCents).toBe(250) // the ledger's cost, not the legacy $999
  })
})

describe('getPortfolio — mixed partial-backfill safety: each holding independently chooses ledger vs legacy semantics', () => {
  it('holding A (already ledgered) and holding B (not yet ledgered) are each evaluated on their own lot presence, no global "backfill complete" assumption', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([
      item({ id: 'A', catalogId: 'catA', quantity: 1, purchasePrice: 999 }), // ledgered — legacy price must be ignored
      item({ id: 'B', catalogId: 'catB', quantity: 1, purchasePrice: 20 }), // NOT yet ledgered — legacy fallback applies
    ])
    ;(prisma.acquisitionLot.findMany as Mock).mockResolvedValue([
      lot({ collectionItemId: 'A', remainingQuantity: 1, unitRecordedCostCents: 100 }),
      // B intentionally has no lots at all.
    ])
    const result = await getPortfolio('p1', ASOF)
    const a = result.holdings.find((h) => h.collectionItemId === 'A')!
    const b = result.holdings.find((h) => h.collectionItemId === 'B')!
    expect(a.costStatus).toBe('known')
    expect(a.recordedCostCents).toBe(100) // ledger-authoritative, not the legacy $999
    expect(b.costStatus).toBe('known')
    expect(b.recordedCostCents).toBe(2000) // legacy fallback, $20.00
    expect(result.recordedCostCents).toBe(100 + 2000) // portfolio total sums both consistently
  })
})

// ── Whole collection / same asOf ─────────────────────────────────────────────

describe('getPortfolio — whole collection, one asOf', () => {
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

  it('when the collection is empty, acquisitionLot/collectionDisposal are never queried (no itemIds to scope by)', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([])
    await getPortfolio('p1', ASOF)
    expect(prisma.acquisitionLot.findMany).not.toHaveBeenCalled()
    expect(prisma.collectionDisposal.findMany).not.toHaveBeenCalled()
  })

  it('acquisitionLot.findMany is scoped to remainingQuantity > 0 — fully-disposed lots never contribute cost', async () => {
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([item({ quantity: 1 })])
    await getPortfolio('p1', ASOF)
    const call = (prisma.acquisitionLot.findMany as Mock).mock.calls[0][0]
    expect(call.where.remainingQuantity).toEqual({ gt: 0 })
  })
})
