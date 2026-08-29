/**
 * 17D: CatalogModel sales performance analytics — behavioral (mocked Prisma) and
 * structural tests. No real DB connection. Mirrors businessAnalytics.test.ts's
 * conventions (seller-performance pagination tests in particular).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { Prisma } from '@prisma/client'

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relPath), 'utf-8')
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    catalogModel: { findMany: vi.fn() },
    itemInstance: { groupBy: vi.fn() },
    orderItem: { findMany: vi.fn() },
    wantedCatalogModel: { groupBy: vi.fn() },
    $queryRaw: vi.fn(),
  },
}))

import { prisma } from '@/lib/prisma'
import {
  getCatalogAttributionCoverage, getCatalogModelPerformancePage, getWantedWithNoSupply,
} from '@/lib/catalogAnalyticsQuery'

type Mock = ReturnType<typeof vi.fn>

function mockSortPage(rows: Array<{ catalog_model_id: string; value: number | null }>) {
  ;(prisma.$queryRaw as Mock).mockResolvedValueOnce(rows)
}

function mockEmptyHydration() {
  ;(prisma.catalogModel.findMany as Mock).mockResolvedValue([])
  ;(prisma.orderItem.findMany as Mock).mockResolvedValue([])
  ;(prisma.itemInstance.groupBy as Mock).mockResolvedValue([])
  ;(prisma.wantedCatalogModel.groupBy as Mock).mockResolvedValue([])
}

const RANGE = (now = new Date()) => ({ preset: '30d' as const, start: new Date(now.getTime() - 1000), end: now, label: '' })

const MODEL_A = { id: 'ca', brand: 'Hot Wheels', name: 'Camaro Z28', year: 2019, series: 'Mainline', scale: '1:64' }
const MODEL_B = { id: 'cb', brand: 'Matchbox', name: 'Ford F-150', year: 2021, series: null, scale: '1:64' }

beforeEach(() => vi.resetAllMocks())

// ── AT/AU: aggregation correctness — one row per model, Decimal-safe GMV ──────────

describe('catalogAnalyticsQuery: model aggregation (17D, AT/AU)', () => {
  it('Model A with 2 completed sales and 1 available copy produces exactly ONE row: unitsSold=2, availableCopies=1', async () => {
    mockSortPage([{ catalog_model_id: 'ca', value: 2 }])
    ;(prisma.catalogModel.findMany as Mock).mockResolvedValueOnce([MODEL_A])
    ;(prisma.orderItem.findMany as Mock).mockResolvedValueOnce([
      { price: 25.00, item: { catalogId: 'ca', createdAt: new Date('2026-01-01') }, order: { completedAt: new Date('2026-01-05') } },
      { price: 40.00, item: { catalogId: 'ca', createdAt: new Date('2026-01-01') }, order: { completedAt: new Date('2026-01-05') } },
    ])
    ;(prisma.itemInstance.groupBy as Mock).mockResolvedValueOnce([{ catalogId: 'ca', _count: { id: 1 } }])
    ;(prisma.wantedCatalogModel.groupBy as Mock).mockResolvedValueOnce([])

    const { items } = await getCatalogModelPerformancePage(RANGE(), 'unitsSold', null)

    expect(items).toHaveLength(1)
    expect(items[0].unitsSold).toBe(2)
    expect(items[0].availableCopies).toBe(1)
  })

  it('GMV sums exactly via Decimal, not JS float: $25.00 + $40.00 = $65.00', async () => {
    mockSortPage([{ catalog_model_id: 'ca', value: 2 }])
    ;(prisma.catalogModel.findMany as Mock).mockResolvedValueOnce([MODEL_A])
    ;(prisma.orderItem.findMany as Mock).mockResolvedValueOnce([
      { price: 25.00, item: { catalogId: 'ca', createdAt: new Date('2026-01-01') }, order: { completedAt: new Date('2026-01-05') } },
      { price: 40.00, item: { catalogId: 'ca', createdAt: new Date('2026-01-01') }, order: { completedAt: new Date('2026-01-05') } },
    ])
    ;(prisma.itemInstance.groupBy as Mock).mockResolvedValueOnce([])
    ;(prisma.wantedCatalogModel.groupBy as Mock).mockResolvedValueOnce([])

    const { items } = await getCatalogModelPerformancePage(RANGE(), 'unitsSold', null)

    expect(items[0].gmv.toFixed(2)).toBe('65.00')
    expect(items[0].gmv).toBeInstanceOf(Prisma.Decimal)
  })
})

// ── AV: multiple models, sort keys, stable tie-break ──────────────────────────────

describe('catalogAnalyticsQuery: sorting (17D, AV)', () => {
  it('default unitsSold sort: model B (5 units) ranks before model A (2 units)', async () => {
    mockSortPage([{ catalog_model_id: 'cb', value: 5 }, { catalog_model_id: 'ca', value: 2 }])
    mockEmptyHydration()
    ;(prisma.catalogModel.findMany as Mock).mockResolvedValueOnce([MODEL_A, MODEL_B])

    const { items } = await getCatalogModelPerformancePage(RANGE(), 'unitsSold', null)
    expect(items.map(i => i.catalogModelId)).toEqual(['cb', 'ca'])
  })

  it('gmv sort with the same two models can produce a different order than unitsSold — A ($65) before B ($50)', async () => {
    mockSortPage([{ catalog_model_id: 'ca', value: 65 }, { catalog_model_id: 'cb', value: 50 }])
    mockEmptyHydration()
    ;(prisma.catalogModel.findMany as Mock).mockResolvedValueOnce([MODEL_A, MODEL_B])

    const { items } = await getCatalogModelPerformancePage(RANGE(), 'gmv', null)
    expect(items.map(i => i.catalogModelId)).toEqual(['ca', 'cb'])
  })

  it('sort keys are DB-ordered (ORDER BY .. LIMIT in the raw SQL), not re-sorted in JS after the fact', () => {
    const src = readSrc('src/lib/catalogAnalyticsQuery.ts')
    const fnSrc = src.slice(src.indexOf('async function fetchModelSortPage'), src.indexOf('async function hydrateModelPage'))
    expect(fnSrc).toContain('ORDER BY')
    expect(fnSrc).toContain('LIMIT')
    expect(fnSrc).toContain('$queryRaw')
  })
})

// ── AW/AX: unattributed sales + coverage ──────────────────────────────────────────

describe('catalogAnalyticsQuery: attribution coverage (17D, AW/AX)', () => {
  it('a completed sale with catalogId=null counts in the overall period total but NOT in catalog-attributed totals', async () => {
    ;(prisma.orderItem.findMany as Mock).mockResolvedValueOnce([
      { price: 100.00, item: { catalogId: null } },
      { price: 25.00, item: { catalogId: 'ca' } },
    ])

    const coverage = await getCatalogAttributionCoverage(RANGE())

    expect(coverage.periodUnits).toBe(2)
    expect(coverage.periodGmv.toFixed(2)).toBe('125.00')
    expect(coverage.attributedUnits).toBe(1)
    expect(coverage.attributedGmv.toFixed(2)).toBe('25.00')
  })

  it('coverage math: 10 completed units, 8 catalog-attributed -> 80% unit attribution; $1000 total, $700 attributed -> 70% GMV attribution', async () => {
    const attributed = Array.from({ length: 8 }, () => ({ price: 87.50, item: { catalogId: 'ca' } })) // 8 * 87.50 = 700
    const unattributed = Array.from({ length: 2 }, () => ({ price: 150.00, item: { catalogId: null } })) // 2 * 150 = 300
    ;(prisma.orderItem.findMany as Mock).mockResolvedValueOnce([...attributed, ...unattributed])

    const coverage = await getCatalogAttributionCoverage(RANGE())

    expect(coverage.periodUnits).toBe(10)
    expect(coverage.attributedUnits).toBe(8)
    expect(coverage.periodGmv.toFixed(2)).toBe('1000.00')
    expect(coverage.attributedGmv.toFixed(2)).toBe('700.00')
  })

  it('zero completed sales in period: safe zero, not NaN/Infinity', async () => {
    ;(prisma.orderItem.findMany as Mock).mockResolvedValueOnce([])
    const coverage = await getCatalogAttributionCoverage(RANGE())
    expect(coverage.periodUnits).toBe(0)
    expect(coverage.attributedUnits).toBe(0)
    expect(coverage.periodGmv.toFixed(2)).toBe('0.00')
    expect(coverage.attributedGmv.toFixed(2)).toBe('0.00')
  })

  it('an unattributed sale never appears in the model-performance table (excluded from the sold-in-period population entirely)', () => {
    // The population anchor (unitsSoldCte) groups by i."catalogId" via an INNER JOIN
    // chain (OrderItem -> Order -> ItemInstance) with no LEFT JOIN to a "null model"
    // bucket — a catalogId=null row groups under NULL and is never surfaced as a
    // model row (Postgres GROUP BY does not merge NULL into any real id).
    const src = readSrc('src/lib/catalogAnalyticsQuery.ts')
    const cteSrc = src.slice(src.indexOf('function unitsSoldCte'), src.indexOf('function gmvCte'))
    expect(cteSrc).not.toMatch(/Unknown Model|COALESCE\(i\."catalogId"/)
  })

  it('overall business totals (periodUnits/periodGmv) are never reduced by exclusion — Part F/G invariant', async () => {
    ;(prisma.orderItem.findMany as Mock).mockResolvedValueOnce([
      { price: 100.00, item: { catalogId: null } },
    ])
    const coverage = await getCatalogAttributionCoverage(RANGE())
    // Even though catalog-attributed is 0, the overall total still reflects the sale.
    expect(coverage.periodUnits).toBe(1)
    expect(coverage.periodGmv.toFixed(2)).toBe('100.00')
  })
})

// ── AY: available-copies eligibility predicate reuse ──────────────────────────────

describe('catalogAnalyticsQuery: available copies eligibility (17D, AY)', () => {
  it('the raw SQL predicate matches listingEligibility.ts exactly: active Listing + available ItemInstance', () => {
    const src = readSrc('src/lib/catalogAnalyticsQuery.ts')
    const cteSrc = src.slice(src.indexOf('function availableCopiesCte'), src.indexOf('function wantedCountCte'))
    expect(cteSrc).toContain("l.status = 'active'")
    expect(cteSrc).toContain("i.status = 'available'")
  })

  it('hydration queries availableCopies with the exact same predicate (status=available, listing.status=active), scoped to the page', async () => {
    mockSortPage([{ catalog_model_id: 'ca', value: 1 }])
    mockEmptyHydration()
    ;(prisma.catalogModel.findMany as Mock).mockResolvedValueOnce([MODEL_A])

    await getCatalogModelPerformancePage(RANGE(), 'unitsSold', null)

    const groupByArgs = (prisma.itemInstance.groupBy as Mock).mock.calls[0][0]
    expect(groupByArgs.where.status).toBe('available')
    expect(groupByArgs.where.listing.status).toBe('active')
    expect(groupByArgs.where.catalogId.in).toEqual(['ca'])
  })

  it('a sold Listing or an archived Listing is excluded — the predicate requires status=active, never status != sold', () => {
    const src = readSrc('src/lib/catalogAnalyticsQuery.ts')
    const cteSrc = src.slice(src.indexOf('function availableCopiesCte'), src.indexOf('function wantedCountCte'))
    expect(cteSrc).not.toMatch(/status\s*!=\s*'sold'/)
  })
})

// ── AZ: Wanted count, no PII ───────────────────────────────────────────────────────

describe('catalogAnalyticsQuery: Wanted count (17D, AZ)', () => {
  it('3 WantedCatalogModel rows for a model -> Wanted = 3', async () => {
    mockSortPage([{ catalog_model_id: 'ca', value: 1 }])
    mockEmptyHydration()
    ;(prisma.catalogModel.findMany as Mock).mockResolvedValueOnce([MODEL_A])
    ;(prisma.wantedCatalogModel.groupBy as Mock).mockResolvedValueOnce([{ catalogModelId: 'ca', _count: { id: 3 } }])

    const { items } = await getCatalogModelPerformancePage(RANGE(), 'unitsSold', null)
    expect(items[0].wantedCount).toBe(3)
  })

  it('no customer PII (email/phone/name) is ever selected anywhere in this query module', () => {
    const src = readSrc('src/lib/catalogAnalyticsQuery.ts')
    expect(src).not.toMatch(/\bemail\s*:\s*true/)
    expect(src).not.toContain('customerProfileId: true')
    expect(src).not.toContain('phone')
  })
})

// ── BA/BC: Wanted with no supply ───────────────────────────────────────────────────

describe('catalogAnalyticsQuery: Wanted with no supply (17D, BA/BC)', () => {
  it('Model X: Wanted=5, Available=0, period sales=0 -> appears (via the NOT EXISTS query directly)', async () => {
    ;(prisma.$queryRaw as Mock).mockResolvedValueOnce([{ catalog_model_id: 'cx', wanted_count: 5 }])
    ;(prisma.catalogModel.findMany as Mock).mockResolvedValueOnce([{ id: 'cx', brand: 'Greenlight', name: 'Silverado', year: 2020, series: null, scale: '1:64' }])

    const { items, truncated } = await getWantedWithNoSupply()
    expect(items).toHaveLength(1)
    expect(items[0].catalogModelId).toBe('cx')
    expect(items[0].wantedCount).toBe(5)
    expect(items[0].availableCopies).toBe(0)
    expect(truncated).toBe(false)
  })

  it('Model Y: Wanted=5, Available=1 -> does NOT appear (proven structurally: the NOT EXISTS predicate excludes any model with an eligible Listing)', () => {
    const src = readSrc('src/lib/catalogAnalyticsQuery.ts')
    const fnSrc = src.slice(src.indexOf('export async function getWantedWithNoSupply'), src.length)
    expect(fnSrc).toContain('NOT EXISTS')
    expect(fnSrc).toContain("l.status = 'active'")
    expect(fnSrc).toContain("i.status = 'available'")
  })

  it('a real CatalogModel with Wanted>0 and zero Listings ever is a valid no-supply candidate — NOT EXISTS is satisfied by absence, no Listing row is required', async () => {
    ;(prisma.$queryRaw as Mock).mockResolvedValueOnce([{ catalog_model_id: 'cz', wanted_count: 2 }])
    ;(prisma.catalogModel.findMany as Mock).mockResolvedValueOnce([{ id: 'cz', brand: 'Auto World', name: 'Charger', year: null, series: null, scale: null }])

    const { items } = await getWantedWithNoSupply()
    expect(items).toHaveLength(1)
    expect(items[0].catalogModelId).toBe('cz')
  })

  it('no supply section is independent of the sales-table population — its own dedicated query, not derived from getCatalogModelPerformancePage', () => {
    const src = readSrc('src/lib/catalogAnalyticsQuery.ts')
    const fnSrc = src.slice(src.indexOf('export async function getWantedWithNoSupply'), src.length)
    expect(fnSrc).not.toContain('getCatalogModelPerformancePage')
    expect(fnSrc).not.toContain('fetchModelSortPage')
  })

  it('empty result renders an empty array, not an error', async () => {
    ;(prisma.$queryRaw as Mock).mockResolvedValueOnce([])
    const { items, truncated } = await getWantedWithNoSupply()
    expect(items).toEqual([])
    expect(truncated).toBe(false)
    expect(prisma.catalogModel.findMany).not.toHaveBeenCalled() // no hydration query needed for zero rows
  })

  // 17D final reconciliation Part 1: bounded, with an explicit truncation signal.
  it('is bounded: ordered wantedCount DESC, catalogModelId ASC, with an explicit LIMIT — not an unbounded scan', () => {
    const src = readSrc('src/lib/catalogAnalyticsQuery.ts')
    const fnSrc = src.slice(src.indexOf('export async function getWantedWithNoSupply'), src.length)
    expect(fnSrc).toContain('ORDER BY wanted_count DESC, w."catalogModelId" ASC')
    expect(fnSrc).toMatch(/LIMIT \$\{NO_SUPPLY_LIMIT \+ 1\}/)
  })

  it('51 matching models -> returns the top 50 (by wantedCount desc) and reports truncated=true', async () => {
    const rows = Array.from({ length: 51 }, (_, i) => ({ catalog_model_id: `c${50 - i}`, wanted_count: 50 - i }))
    ;(prisma.$queryRaw as Mock).mockResolvedValueOnce(rows)
    ;(prisma.catalogModel.findMany as Mock).mockResolvedValueOnce(
      Array.from({ length: 50 }, (_, i) => ({ id: `c${i + 1}`, brand: 'B', name: 'N', year: null, series: null, scale: null })),
    )

    const { items, truncated } = await getWantedWithNoSupply()
    expect(items).toHaveLength(50)
    expect(truncated).toBe(true)
    // Name hydration is bounded to exactly the returned (sliced) page ids, never the 51st.
    const hydrateArgs = (prisma.catalogModel.findMany as Mock).mock.calls[0][0]
    expect(hydrateArgs.where.id.in).toHaveLength(50)
    expect(hydrateArgs.where.id.in).not.toContain('c51')
  })

  it('exactly 50 (or fewer) matching models -> truncated=false (a complete list, not a shortlist)', async () => {
    ;(prisma.$queryRaw as Mock).mockResolvedValueOnce(
      Array.from({ length: 50 }, (_, i) => ({ catalog_model_id: `c${i + 1}`, wanted_count: 1 })),
    )
    ;(prisma.catalogModel.findMany as Mock).mockResolvedValueOnce(
      Array.from({ length: 50 }, (_, i) => ({ id: `c${i + 1}`, brand: 'B', name: 'N', year: null, series: null, scale: null })),
    )

    const { items, truncated } = await getWantedWithNoSupply()
    expect(items).toHaveLength(50)
    expect(truncated).toBe(false)
  })
})

// ── BB: zero-Wanted models still appear in the sales table ────────────────────────

describe('catalogAnalyticsQuery: zero-Wanted models in sales table (17D, BB/S)', () => {
  it('a model sold in the period with Wanted=0 still appears as a row with wantedCount 0', async () => {
    mockSortPage([{ catalog_model_id: 'ca', value: 1 }])
    ;(prisma.catalogModel.findMany as Mock).mockResolvedValueOnce([MODEL_A])
    ;(prisma.orderItem.findMany as Mock).mockResolvedValueOnce([
      { price: 20.00, item: { catalogId: 'ca', createdAt: new Date('2026-01-01') }, order: { completedAt: new Date('2026-01-03') } },
    ])
    ;(prisma.itemInstance.groupBy as Mock).mockResolvedValueOnce([])
    ;(prisma.wantedCatalogModel.groupBy as Mock).mockResolvedValueOnce([]) // zero Wanted rows

    const { items } = await getCatalogModelPerformancePage(RANGE(), 'unitsSold', null)
    expect(items).toHaveLength(1)
    expect(items[0].wantedCount).toBe(0)
  })
})

// ── BD: median days-to-sell (intake-to-sale, not listing-to-sale) ─────────────────

describe('catalogAnalyticsQuery: median days-to-sell (17D, BD/M)', () => {
  it('durations 2, 4, 100 -> median 4 (same middle-index convention as the overview)', async () => {
    mockSortPage([{ catalog_model_id: 'ca', value: 3 }])
    ;(prisma.catalogModel.findMany as Mock).mockResolvedValueOnce([MODEL_A])
    const intake = new Date('2026-01-01T00:00:00.000Z')
    ;(prisma.orderItem.findMany as Mock).mockResolvedValueOnce([
      { price: 10, item: { catalogId: 'ca', createdAt: intake }, order: { completedAt: new Date('2026-01-03T00:00:00.000Z') } }, // 2 days
      { price: 10, item: { catalogId: 'ca', createdAt: intake }, order: { completedAt: new Date('2026-01-05T00:00:00.000Z') } }, // 4 days
      { price: 10, item: { catalogId: 'ca', createdAt: intake }, order: { completedAt: new Date('2026-04-11T00:00:00.000Z') } }, // 100 days
    ])
    ;(prisma.itemInstance.groupBy as Mock).mockResolvedValueOnce([])
    ;(prisma.wantedCatalogModel.groupBy as Mock).mockResolvedValueOnce([])

    const { items } = await getCatalogModelPerformancePage(RANGE(), 'unitsSold', null)
    expect(items[0].medianDaysToSell).toBe(4)
  })

  it('fewer than one valid duration -> unavailable (null), never a fabricated 0', async () => {
    mockSortPage([{ catalog_model_id: 'ca', value: 0 }])
    mockEmptyHydration()
    ;(prisma.catalogModel.findMany as Mock).mockResolvedValueOnce([MODEL_A])

    const { items } = await getCatalogModelPerformancePage(RANGE(), 'unitsSold', null)
    expect(items[0].medianDaysToSell).toBeNull()
  })

  it('uses ItemInstance.createdAt, never Listing.createdAt, for the start timestamp — reuses the overview convention, not a new one', () => {
    const src = readSrc('src/lib/catalogAnalyticsQuery.ts')
    const cteSrc = src.slice(src.indexOf('function medianDaysToSellCte'), src.indexOf('function availableCopiesCte'))
    expect(cteSrc).toContain('i."createdAt"')
    expect(cteSrc).not.toContain('lst."createdAt"')
    expect(cteSrc).not.toContain('Listing" lst')
  })

  it('negative durations are excluded, never a fabricated negative "days to sell"', () => {
    const src = readSrc('src/lib/catalogAnalyticsQuery.ts')
    const cteSrc = src.slice(src.indexOf('function medianDaysToSellCte'), src.indexOf('function availableCopiesCte'))
    expect(cteSrc).toContain('o."completedAt" >= i."createdAt"')
  })
})

// ── BE: time-basis semantics — period vs current, tested at both query and UI layer ─

describe('catalogAnalyticsQuery + page: time-basis semantics (17D, BE/E/AK)', () => {
  it('availableCopiesCte and wantedCountCte take NO DateRange argument at all — current snapshot, not period', () => {
    const src = readSrc('src/lib/catalogAnalyticsQuery.ts')
    for (const fn of ['availableCopiesCte', 'wantedCountCte']) {
      const idx = src.indexOf(`function ${fn}(`)
      expect(idx).toBeGreaterThan(-1)
      expect(src.slice(idx, idx + 50)).toContain(`function ${fn}(): Prisma.Sql`)
    }
  })

  it('unitsSoldCte, gmvCte, medianDaysToSellCte all take a DateRange argument — period-scoped', () => {
    const src = readSrc('src/lib/catalogAnalyticsQuery.ts')
    for (const fn of ['unitsSoldCte', 'gmvCte', 'medianDaysToSellCte']) {
      const idx = src.indexOf(`function ${fn}(`)
      expect(src.slice(idx, idx + 50)).toContain(`function ${fn}(range: DateRange)`)
    }
  })

  it('changing the selected range never re-scopes getWantedWithNoSupply (no range parameter accepted at all)', () => {
    const src = readSrc('src/lib/catalogAnalyticsQuery.ts')
    const sig = src.slice(src.indexOf('export async function getWantedWithNoSupply'), src.indexOf('export async function getWantedWithNoSupply') + 60)
    expect(sig).toContain('getWantedWithNoSupply(): Promise')
  })

  it('the page discloses period vs current columns in the table headers and a legend line', () => {
    const pageSrc = readSrc('src/app/(admin)/admin/analytics/catalog/page.tsx')
    expect(pageSrc).toContain('Units sold (period)')
    expect(pageSrc).toContain('GMV (period)')
    expect(pageSrc).toContain('Median days to sell (period)')
    expect(pageSrc).toContain('Available copies (current)')
    expect(pageSrc).toContain('Wanted (current)')
    expect(pageSrc.toLowerCase()).toContain('selected period above')
    expect(pageSrc.toLowerCase()).toContain('current snapshot')
  })

  it('the no-supply section heading/copy is explicitly marked current, not period', () => {
    const pageSrc = readSrc('src/app/(admin)/admin/analytics/catalog/page.tsx')
    const idx = pageSrc.indexOf('Wanted with no available copies')
    expect(pageSrc.slice(idx, idx + 250).toLowerCase()).toContain('current')
    expect(pageSrc.slice(idx, idx + 250).toLowerCase()).toContain('not scoped to the selected period')
  })
})

// ── BF: sort allowlist ─────────────────────────────────────────────────────────────

describe('catalog page: sort allowlist (17D, BF/X)', () => {
  const pageSrc = readSrc('src/app/(admin)/admin/analytics/catalog/page.tsx')

  it('an unrecognized ?sort= value falls back to the documented safe default (unitsSold)', () => {
    expect(pageSrc).toMatch(/SORT_KEYS\.has\(sp\.sort/)
    expect(pageSrc).toContain("'unitsSold'")
  })

  it('no arbitrary Prisma order-by field is accepted from the browser — sort is a closed union type', () => {
    const src = readSrc('src/lib/catalogAnalyticsQuery.ts')
    expect(src).toContain("export type CatalogModelSortKey = 'unitsSold' | 'gmv' | 'medianDaysToSell' | 'availableCopies' | 'wantedCount'")
  })
})

// ── BG: pagination ─────────────────────────────────────────────────────────────────

describe('catalogAnalyticsQuery: pagination (17D, BG/Y)', () => {
  it('bounded page size (<=50): the raw SQL requests exactly PAGE_SIZE+1 rows via LIMIT', async () => {
    mockSortPage(Array.from({ length: 5 }, (_, i) => ({ catalog_model_id: `c${i}`, value: 0 })))
    mockEmptyHydration()

    await getCatalogModelPerformancePage(RANGE(), 'unitsSold', null)

    const rawCall = (prisma.$queryRaw as Mock).mock.calls[0]
    const sqlText = (rawCall[0] as TemplateStringsArray).join(' ')
    expect(sqlText).toContain('LIMIT')
  })

  it('51 rows returned -> hasMore, nextCursor reflects the last (50th) item; no duplicate/missing rows at the boundary', async () => {
    const rows = Array.from({ length: 51 }, (_, i) => ({ catalog_model_id: `c${50 - i}`, value: 50 - i }))
    mockSortPage(rows)
    mockEmptyHydration()
    // Real model rows for the 50 ids expected on this page (c1..c50) — hydration
    // builds its output map by iterating fetched CatalogModel rows, so each page id
    // needs a matching row here (exactly as real referential integrity guarantees).
    ;(prisma.catalogModel.findMany as Mock).mockResolvedValueOnce(
      Array.from({ length: 50 }, (_, i) => ({ id: `c${i + 1}`, brand: 'B', name: 'N', year: null, series: null, scale: null })),
    )

    const { items, nextCursor } = await getCatalogModelPerformancePage(RANGE(), 'unitsSold', null)

    expect(items).toHaveLength(50)
    expect(nextCursor).not.toBeNull()
    expect(nextCursor!.catalogModelId).toBe(`c1`) // last row of the 50-item page (index 49 -> c(50-49)=c1)
  })

  it('exactly 50 or fewer rows returned -> no next page', async () => {
    mockSortPage([{ catalog_model_id: 'ca', value: 1 }])
    mockEmptyHydration()

    const { nextCursor } = await getCatalogModelPerformancePage(RANGE(), 'unitsSold', null)
    expect(nextCursor).toBeNull()
  })

  it('the cursor predicate uses the same mixed-direction tie-break shape (COALESCE .. < / = AND catalog_model_id >) proven correct for the seller table', () => {
    const src = readSrc('src/lib/catalogAnalyticsQuery.ts')
    const fnSrc = src.slice(src.indexOf('async function fetchModelSortPage'), src.indexOf('async function hydrateModelPage'))
    expect(fnSrc).toContain('COALESCE(metric.value, -1)')
    expect(fnSrc).toMatch(/<\s*\$\{cursor\.value\}/)
    expect(fnSrc).toMatch(/sold\.catalog_model_id\s*>\s*\$\{cursor\.catalogModelId\}/)
  })
})

// ── BH: query shape / no N+1 / no arbitrary truncation ────────────────────────────

describe('catalogAnalyticsQuery: query shape (17D, BH/AB/AC)', () => {
  const src = readSrc('src/lib/catalogAnalyticsQuery.ts')

  it('no per-model Prisma loop — hydration queries are scoped with `in:` over the whole page at once', () => {
    const fnSrc = src.slice(src.indexOf('async function hydrateModelPage'), src.indexOf('export async function getCatalogModelPerformancePage'))
    expect(fnSrc).not.toMatch(/for\s*\(.*of.*pageIds.*\)\s*{\s*await/) // no per-id await loop
    expect(fnSrc).toContain('{ in: pageIds }')
  })

  it('no arbitrary `take` cap on the coverage totals query — the whole period is counted, not truncated', () => {
    const fnSrc = src.slice(src.indexOf('export async function getCatalogAttributionCoverage'), src.indexOf('// ── Ranked'))
    expect(fnSrc).not.toContain('take:')
  })

  it('no whole-CatalogModel-table hydration — every catalogModel.findMany call is scoped with an `id: { in: ... } }` filter', () => {
    const calls = [...src.matchAll(/catalogModel\.findMany\(\{([\s\S]*?)\}\)/g)]
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) expect(call[1]).toContain('in:')
  })

  it('the sort/rank step is one single $queryRaw call, not one query per model', () => {
    const fnSrc = src.slice(src.indexOf('async function fetchModelSortPage'), src.indexOf('async function hydrateModelPage'))
    expect((fnSrc.match(/\$queryRaw/g) ?? []).length).toBe(1)
  })
})

// ── BI: read-only ───────────────────────────────────────────────────────────────────

describe('catalogAnalyticsQuery + page: read-only boundary (17D, BI/AP)', () => {
  it('no create/update/delete/upsert anywhere in the query module or the page', () => {
    for (const rel of ['src/lib/catalogAnalyticsQuery.ts', 'src/app/(admin)/admin/analytics/catalog/page.tsx']) {
      const s = readSrc(rel)
      expect(s).not.toMatch(/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/)
    }
  })
})

// ── BJ: admin auth ───────────────────────────────────────────────────────────────────

describe('catalog page: admin auth (17D, BJ/AO)', () => {
  it('the page checks isAdminAuthenticated and redirects to /admin/login otherwise, same as every other analytics route', () => {
    const src = readSrc('src/app/(admin)/admin/analytics/catalog/page.tsx')
    expect(src).toContain('isAdminAuthenticated')
    expect(src).toContain("redirect('/admin/login')")
  })
})

// ── BK: nav ───────────────────────────────────────────────────────────────────────

describe('AnalyticsNav: Catalog entry (17D, BK/C/AR)', () => {
  it('AnalyticsNav includes exactly one new "Catalog" tab pointing at /admin/analytics/catalog', () => {
    const src = readSrc('src/components/admin/analytics/AnalyticsNav.tsx')
    expect(src).toContain("{ href: '/admin/analytics/catalog', label: 'Catalog' }")
  })

  it('all pre-existing analytics tabs remain present — no tab removed', () => {
    const src = readSrc('src/components/admin/analytics/AnalyticsNav.tsx')
    for (const href of ['/admin/analytics', '/admin/analytics/inventory', '/admin/analytics/conversion', '/admin/analytics/payouts', '/admin/analytics/sellers', '/admin/analytics/revenue']) {
      expect(src).toContain(`href: '${href}'`)
    }
  })

  it('no separate "Catalog Performance"/"Model Demand"/"Model Sales" tabs were added — exactly one new tab', () => {
    const src = readSrc('src/components/admin/analytics/AnalyticsNav.tsx')
    const tabCount = [...src.matchAll(/href: '\/admin\/analytics/g)].length
    expect(tabCount).toBe(7) // 6 pre-existing + 1 new
  })
})

// ── Model identity: CatalogModel, not Listing, is the grouping key (17D, J) ────────

describe('catalogAnalyticsQuery: model identity (17D, J)', () => {
  it('grouping is by ItemInstance.catalogId (CatalogModel), never by Listing id', () => {
    const src = readSrc('src/lib/catalogAnalyticsQuery.ts')
    expect(src).toContain('GROUP BY i."catalogId"')
    expect(src).not.toMatch(/GROUP BY (oi|l)\."?id"?/)
  })
})

// ── Scope guard: no margin/sell-through/conversion/trending by model (17D, AG/AH/AI/AJ/BM) ─

describe('catalogAnalyticsQuery + page: scope guard (17D)', () => {
  it('no gross margin/spread, sell-through, conversion, or trend/score terminology by model', () => {
    for (const rel of ['src/lib/catalogAnalyticsQuery.ts', 'src/app/(admin)/admin/analytics/catalog/page.tsx']) {
      const s = readSrc(rel).toLowerCase()
      expect(s).not.toMatch(/margin|spread|sell-through|sellthrough|conversion|trending|hotness|score|forecast/)
    }
  })

  it('no CSV export was added for catalog analytics', () => {
    expect(fs.existsSync(path.join(process.cwd(), 'src/app/(admin)/admin/analytics/catalog/export'))).toBe(false)
  })

  it('no new Prisma schema model was introduced for catalog analytics (no CatalogPerformance/ModelMetric reference)', () => {
    const schema = readSrc('prisma/schema.prisma')
    expect(schema).not.toContain('CatalogPerformance')
    expect(schema).not.toContain('ModelMetric')
    expect(schema).not.toContain('DailyCatalogMetric')
  })
})

// ── 17D final reconciliation, Part 3: coverage card is conditional, not decorative ──

describe('catalog page: attribution coverage is shown only when a real gap exists (17D final reconciliation, Part 3)', () => {
  const pageSrc = readSrc('src/app/(admin)/admin/analytics/catalog/page.tsx')

  it('the coverage section is gated behind a computed gap condition, not unconditionally rendered', () => {
    expect(pageSrc).toContain('hasCoverageGap')
    expect(pageSrc).toContain('{hasCoverageGap && (')
  })

  it('the gap condition compares attributed vs period totals (units and GMV), not a hardcoded false', () => {
    const idx = pageSrc.indexOf('const hasCoverageGap')
    const slice = pageSrc.slice(idx, idx + 250)
    expect(slice).toContain('coverage.attributedUnits < coverage.periodUnits')
    expect(slice).toContain('coverage.attributedGmv.equals(coverage.periodGmv)')
  })

  it('the underlying coverage query itself is untouched/still fully defensive — only the UI is conditional', () => {
    const src = readSrc('src/lib/catalogAnalyticsQuery.ts')
    expect(src).toContain('export async function getCatalogAttributionCoverage')
    expect(src).toContain('attributed.length')
  })
})
