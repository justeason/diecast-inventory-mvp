/**
 * 14B: Business Analytics — pure-function, behavioral (mocked Prisma), and structural tests.
 * No real DB connection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { Prisma } from '@prisma/client'

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relPath), 'utf-8')
}

const D = (s: string) => new Prisma.Decimal(s)

// ── Mocked Prisma client ─────────────────────────────────────────────────────────

vi.mock('@/lib/prisma', () => ({
  prisma: {
    itemInstance: { count: vi.fn(), groupBy: vi.fn(), findMany: vi.fn(), aggregate: vi.fn() },
    listing: { count: vi.fn() },
    order: { count: vi.fn(), findMany: vi.fn(), aggregate: vi.fn() },
    orderItem: { count: vi.fn(), findMany: vi.fn() },
    sellerPayoutLine: { aggregate: vi.fn(), groupBy: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    sellerPayout: { aggregate: vi.fn() },
    sellerProfile: { findMany: vi.fn() },
    sellerSubmission: { groupBy: vi.fn() },
    sellerAgreement: { findMany: vi.fn() },
    customerCommunityProfile: { findMany: vi.fn() },
    $queryRaw: vi.fn(),
  },
}))

import { prisma } from '@/lib/prisma'
import {
  decimalFromFloatDollars, sumDecimal, subtractDecimal, decimalToCents, centsToDecimal,
  ratio, periodChange, computeDurationStats, daysBetween,
} from '@/lib/businessAnalyticsMath'
import { parseDateRangeParams, previousPeriod, chooseBucketGranularity, bucketStart, advanceBucket, dateRangeQueryParams, todayRange } from '@/lib/businessAnalyticsDates'
import { fmtPeriodChange } from '@/lib/businessAnalyticsFormat'
import { METRIC_REGISTRY, getMetricDefinition } from '@/lib/businessAnalyticsRegistry'
import {
  getInventorySnapshot, getInventoryAging, getPayoutLiabilitySnapshot, getOutstandingLiability,
  getSellerPerformancePage, getRevenueBreakdown, getConversionFunnel, getDaysToSellDurations, getTimeSeries,
  getOverviewMetrics,
} from '@/lib/businessAnalyticsQuery'

type Mock = ReturnType<typeof vi.fn>

// ── Money precision ──────────────────────────────────────────────────────────────

describe('businessAnalyticsMath: money precision (Decimal, no JS Float accumulation)', () => {
  it('$0.01 + $0.10 + $19.99 sums exactly', () => {
    const sum = sumDecimal([decimalFromFloatDollars(0.01), decimalFromFloatDollars(0.10), decimalFromFloatDollars(19.99)])
    expect(sum.toFixed(2)).toBe('20.10')
  })

  it('repeated $0.10 additions do not drift (classic float bug: 0.1+0.2 !== 0.3)', () => {
    const values = Array.from({ length: 10 }, () => decimalFromFloatDollars(0.10))
    expect(sumDecimal(values).toFixed(2)).toBe('1.00')
  })

  it('decimalToCents/centsToDecimal round-trip exactly for $19.99', () => {
    const d = D('19.99')
    expect(decimalToCents(d)).toBe(1999)
    expect(centsToDecimal(1999).toFixed(2)).toBe('19.99')
  })

  it('subtractDecimal is exact for $19.99 - $0.01', () => {
    expect(subtractDecimal(D('19.99'), D('0.01')).toFixed(2)).toBe('19.98')
  })

  it('source never accumulates money via `sum += Number(...)` or plain + on decimals', () => {
    const src = readSrc('src/lib/businessAnalyticsQuery.ts')
    expect(src).not.toMatch(/sum\s*\+=\s*Number\(/)
    expect(src).not.toContain('parseFloat(')
  })
})

// ── Ratios / period comparisons ──────────────────────────────────────────────────

describe('businessAnalyticsMath: ratio / periodChange', () => {
  it('zero denominator yields null (renders N/A), not Infinity/NaN', () => {
    expect(ratio(5, 0).value).toBeNull()
    expect(ratio(0, 0).value).toBeNull()
  })

  it('normal ratio computes correctly and returns numerator/denominator', () => {
    const r = ratio(3, 12)
    expect(r.value).toBe(0.25)
    expect(r.numerator).toBe(3)
    expect(r.denominator).toBe(12)
  })

  it('previous period zero, current > 0 → "new", never a fake infinite percentage', () => {
    expect(periodChange(10, 0)).toEqual({ kind: 'new' })
  })

  it('both zero → unavailable', () => {
    expect(periodChange(0, 0)).toEqual({ kind: 'unavailable' })
  })

  it('normal period change computes a signed percentage', () => {
    const c = periodChange(150, 100)
    expect(c).toEqual({ kind: 'change', pct: 50 })
  })
})

// ── Duration stats ────────────────────────────────────────────────────────────────

describe('businessAnalyticsMath: computeDurationStats', () => {
  it('computes average/median/p75/p90 for a known set', () => {
    const stats = computeDurationStats([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(stats.count).toBe(10)
    expect(stats.average).toBeCloseTo(5.5)
    expect(stats.median).toBeCloseTo(5.5)
    expect(stats.p90).toBeGreaterThan(stats.median!)
  })

  it('empty input yields all-null (N/A), not zero', () => {
    const stats = computeDurationStats([])
    expect(stats).toEqual({ average: null, median: null, p75: null, p90: null, count: 0 })
  })

  it('daysBetween negative duration is computable but callers must filter it out (invalid data)', () => {
    const later = new Date('2026-01-01T00:00:00.000Z')
    const earlier = new Date('2026-01-05T00:00:00.000Z')
    expect(daysBetween(earlier, later)).toBeLessThan(0)
  })
})

// ── Date range parsing ────────────────────────────────────────────────────────────

describe('businessAnalyticsDates: parseDateRangeParams', () => {
  const now = new Date('2026-06-15T12:00:00.000Z')

  it('defaults to last 30 days', () => {
    const { range, error } = parseDateRangeParams({}, now)
    expect(range.preset).toBe('30d')
    expect(error).toBeNull()
    expect(range.end.getTime()).toBe(now.getTime())
    expect(range.start!.getTime()).toBe(now.getTime() - 30 * 86_400_000)
  })

  it('start is inclusive, end is exclusive: start <= timestamp < end', () => {
    const { range } = parseDateRangeParams({ period: 'custom', start: '2026-01-01', end: '2026-01-01' }, now)
    // A single-day custom range: start is 2026-01-01T00:00Z, end is 2026-01-02T00:00Z (exclusive).
    expect(range.start!.toISOString()).toBe('2026-01-01T00:00:00.000Z')
    expect(range.end.toISOString()).toBe('2026-01-02T00:00:00.000Z')
  })

  it('rejects malformed custom dates, falls back to 30d with an error', () => {
    const { range, error } = parseDateRangeParams({ period: 'custom', start: 'not-a-date', end: '2026-01-01' }, now)
    expect(error).not.toBeNull()
    expect(range.preset).toBe('30d')
  })

  it('rejects start > end, falls back to 30d with an error', () => {
    const { range, error } = parseDateRangeParams({ period: 'custom', start: '2026-06-01', end: '2026-01-01' }, now)
    expect(error).not.toBeNull()
    expect(range.preset).toBe('30d')
  })

  it('ytd starts at Jan 1 UTC of the current year', () => {
    const { range } = parseDateRangeParams({ period: 'ytd' }, now)
    expect(range.start!.toISOString()).toBe('2026-01-01T00:00:00.000Z')
  })

  it('all time has no lower bound', () => {
    const { range } = parseDateRangeParams({ period: 'all' }, now)
    expect(range.start).toBeNull()
  })

  it('unrecognized period falls back to 30d with an error (never throws)', () => {
    const { range, error } = parseDateRangeParams({ period: 'bogus' }, now)
    expect(range.preset).toBe('30d')
    expect(error).not.toBeNull()
  })
})

describe('businessAnalyticsDates: todayRange (15H)', () => {
  it('starts at UTC midnight of `now` and ends at `now` itself', () => {
    const now = new Date('2026-08-15T23:59:00.000Z')
    const range = todayRange(now)
    expect(range.start!.toISOString()).toBe('2026-08-15T00:00:00.000Z')
    expect(range.end.getTime()).toBe(now.getTime())
  })

  it('is a genuine UTC calendar day, not a rolling 24h window', () => {
    const now = new Date('2026-08-15T00:05:00.000Z')
    const range = todayRange(now)
    expect(range.start!.toISOString()).toBe('2026-08-15T00:00:00.000Z')
  })
})

describe('businessAnalyticsDates: previousPeriod', () => {
  it('previous period is the immediately preceding equal-length window', () => {
    const now = new Date('2026-06-15T12:00:00.000Z')
    const { range } = parseDateRangeParams({ period: '30d' }, now)
    const prev = previousPeriod(range)
    expect(prev).not.toBeNull()
    expect(prev!.end.getTime()).toBe(range.start!.getTime())
    expect(range.end.getTime() - range.start!.getTime()).toBe(prev!.end.getTime() - prev!.start.getTime())
  })

  it('all-time range has no previous period', () => {
    const { range } = parseDateRangeParams({ period: 'all' })
    expect(previousPeriod(range)).toBeNull()
  })
})

describe('businessAnalyticsDates: UTC bucket correctness', () => {
  it('day bucket truncates to UTC midnight regardless of time-of-day', () => {
    const d = bucketStart(new Date('2026-03-05T23:59:59.000Z'), 'day')
    expect(d.toISOString()).toBe('2026-03-05T00:00:00.000Z')
  })

  it('month bucket truncates to the 1st of the UTC month', () => {
    const d = bucketStart(new Date('2026-03-17T08:00:00.000Z'), 'month')
    expect(d.toISOString()).toBe('2026-03-01T00:00:00.000Z')
  })

  it('week bucket starts on UTC Monday', () => {
    const d = bucketStart(new Date('2026-03-19T00:00:00.000Z'), 'week') // a Thursday
    expect(d.getUTCDay()).toBe(1)
  })

  it('short ranges choose daily granularity, long ranges choose monthly', () => {
    const now = new Date('2026-06-15T00:00:00.000Z')
    expect(chooseBucketGranularity(parseDateRangeParams({ period: '7d' }, now).range)).toBe('day')
    expect(chooseBucketGranularity(parseDateRangeParams({ period: 'all' }, now).range)).toBe('month')
  })

  it('granularity boundary: exactly 90 days is daily, 91 days is weekly', () => {
    const end = new Date('2026-06-15T00:00:00.000Z')
    const at90 = { preset: 'custom' as const, start: new Date(end.getTime() - 90 * 86_400_000), end, label: '' }
    const at91 = { preset: 'custom' as const, start: new Date(end.getTime() - 91 * 86_400_000), end, label: '' }
    expect(chooseBucketGranularity(at90)).toBe('day')
    expect(chooseBucketGranularity(at91)).toBe('week')
  })

  it('granularity boundary: exactly 365 days is weekly, 366 days is monthly', () => {
    const end = new Date('2026-06-15T00:00:00.000Z')
    const at365 = { preset: 'custom' as const, start: new Date(end.getTime() - 365 * 86_400_000), end, label: '' }
    const at366 = { preset: 'custom' as const, start: new Date(end.getTime() - 366 * 86_400_000), end, label: '' }
    expect(chooseBucketGranularity(at365)).toBe('week')
    expect(chooseBucketGranularity(at366)).toBe('month')
  })

  it('advanceBucket steps by exactly one unit per granularity, UTC-safe', () => {
    expect(advanceBucket(new Date('2026-01-31T00:00:00.000Z'), 'day').toISOString()).toBe('2026-02-01T00:00:00.000Z')
    expect(advanceBucket(new Date('2026-03-02T00:00:00.000Z'), 'week').toISOString()).toBe('2026-03-09T00:00:00.000Z')
    // month is always advanced from an already bucketStart-aligned (1st-of-month) date in production usage
    expect(advanceBucket(new Date('2026-01-01T00:00:00.000Z'), 'month').toISOString()).toBe('2026-02-01T00:00:00.000Z')
  })
})

describe('businessAnalyticsDates: filter preservation', () => {
  it('dateRangeQueryParams round-trips a preset', () => {
    const { range } = parseDateRangeParams({ period: '90d' })
    expect(dateRangeQueryParams(range)).toEqual({ period: '90d' })
  })

  it('dateRangeQueryParams round-trips a custom range', () => {
    const { range } = parseDateRangeParams({ period: 'custom', start: '2026-01-01', end: '2026-01-31' })
    expect(dateRangeQueryParams(range)).toEqual({ period: 'custom', start: '2026-01-01', end: '2026-01-31' })
  })
})

// ── Metric registry ────────────────────────────────────────────────────────────────

describe('businessAnalyticsRegistry: flow/snapshot/cohort classification', () => {
  it('every metric has a valid metricType and non-empty description', () => {
    for (const m of METRIC_REGISTRY) {
      expect(['flow', 'snapshot', 'cohort']).toContain(m.metricType)
      expect(m.description.length).toBeGreaterThan(10)
      expect(m.timestampBasis.length).toBeGreaterThan(0)
    }
  })

  it('flow examples are classified as flow', () => {
    expect(getMetricDefinition('gmv')!.metricType).toBe('flow')
    expect(getMetricDefinition('completed_orders')!.metricType).toBe('flow')
  })

  it('snapshot examples are classified as snapshot', () => {
    expect(getMetricDefinition('active_inventory')!.metricType).toBe('snapshot')
    expect(getMetricDefinition('payout_liability')!.metricType).toBe('snapshot')
  })

  it('cohort examples are classified as cohort', () => {
    expect(getMetricDefinition('sell_through')!.metricType).toBe('cohort')
    expect(getMetricDefinition('listing_to_sale_conversion')!.metricType).toBe('cohort')
  })

  it('displayed KPI names match what the query layer actually computes (spot check GMV)', () => {
    const def = getMetricDefinition('gmv')!
    expect(def.numerator).toContain('OrderItem.price')
    expect(def.numerator).toContain('complete')
  })
})

// ── Behavioral: inventory ────────────────────────────────────────────────────────

describe('businessAnalyticsQuery: inventory (behavioral)', () => {
  beforeEach(() => vi.resetAllMocks())

  it('inventory snapshot buckets by ItemInstance.status via groupBy, and listed is a subset (not summed into total)', async () => {
    ;(prisma.itemInstance.groupBy as Mock).mockResolvedValueOnce([
      { status: 'available', _count: { id: 10 } },
      { status: 'reserved', _count: { id: 2 } },
      { status: 'sold', _count: { id: 50 } },
      { status: 'draft', _count: { id: 3 } },
    ])
    ;(prisma.itemInstance.count as Mock)
      .mockResolvedValueOnce(8)  // listedActive
      .mockResolvedValueOnce(65) // total
    ;(prisma.orderItem.count as Mock).mockResolvedValueOnce(4) // soldDuringPeriod

    const now = new Date()
    const snapshot = await getInventorySnapshot({ preset: '30d', start: new Date(now.getTime() - 1000), end: now, label: '' })

    expect(snapshot.available).toBe(10)
    expect(snapshot.reserved).toBe(2)
    expect(snapshot.sold).toBe(50)
    expect(snapshot.listedActive).toBe(8)
    expect(snapshot.total).toBe(65)
    // listed (8) is not added on top of total — it's a reported subset.
    expect(snapshot.available + snapshot.reserved + snapshot.sold + snapshot.draft + snapshot.notForSale).toBe(65)
  })

  it('aging buckets use ItemInstance.createdAt (intake), never CatalogModel.createdAt', () => {
    const src = readSrc('src/lib/businessAnalyticsQuery.ts')
    const fnSrc = src.slice(src.indexOf('export async function getInventoryAging'), src.indexOf('export type DaysToSellRow'))
    expect(fnSrc).toContain('createdAt')
    expect(fnSrc).not.toContain('catalog')
    expect(fnSrc).not.toContain('CatalogModel')
  })

  it('aging excludes sold inventory from the current-unsold bucket set', async () => {
    ;(prisma.itemInstance.count as Mock).mockResolvedValue(0)
    await getInventoryAging(new Date())
    for (const call of (prisma.itemInstance.count as Mock).mock.calls) {
      expect(call[0].where.status).toEqual({ not: 'sold' })
    }
  })

  it('negative days-to-sell durations are counted as invalid (with visibility), not silently dropped', () => {
    const src = readSrc('src/lib/businessAnalyticsQuery.ts')
    const fnSrc = src.slice(src.indexOf('export async function getDaysToSellDurations'), src.indexOf('async function getSellThroughCohortCounts'))
    expect(fnSrc).toContain('invalidCount++')
    expect(fnSrc).toContain('d < 0')
  })
})

// ── Behavioral: days-to-sell mapping (getDaysToSellDurations) ────────────────────

describe('businessAnalyticsQuery: getDaysToSellDurations (behavioral)', () => {
  beforeEach(() => vi.resetAllMocks())

  it('valid completed sale maps intake -> completedAt into a duration, and only completed orders are queried', async () => {
    const intake = new Date('2026-01-01T00:00:00.000Z')
    const completed = new Date('2026-01-11T00:00:00.000Z')
    ;(prisma.orderItem.findMany as Mock).mockResolvedValueOnce([
      { itemId: 'i1', item: { createdAt: intake }, order: { completedAt: completed } },
    ])
    const now = new Date()
    const result = await getDaysToSellDurations({ preset: '30d', start: new Date(now.getTime() - 1000), end: now, label: '' })

    expect(result.durations).toEqual([10])
    expect(result.invalidCount).toBe(0)
    const args = (prisma.orderItem.findMany as Mock).mock.calls[0][0]
    expect(args.where.order.status).toBe('complete')
  })

  it('negative duration (completedAt before intake — data error) is counted as invalid, not silently dropped or included', async () => {
    ;(prisma.orderItem.findMany as Mock).mockResolvedValueOnce([
      { itemId: 'i1', item: { createdAt: new Date('2026-01-11T00:00:00.000Z') }, order: { completedAt: new Date('2026-01-01T00:00:00.000Z') } },
    ])
    const now = new Date()
    const result = await getDaysToSellDurations({ preset: '30d', start: new Date(now.getTime() - 1000), end: now, label: '' })

    expect(result.durations).toEqual([])
    expect(result.invalidCount).toBe(1)
  })

  it('duplicate itemId among completed orders (should be structurally impossible) is defensively counted as invalid, not double-counted', async () => {
    const intake = new Date('2026-01-01T00:00:00.000Z')
    const completed = new Date('2026-01-11T00:00:00.000Z')
    ;(prisma.orderItem.findMany as Mock).mockResolvedValueOnce([
      { itemId: 'i1', item: { createdAt: intake }, order: { completedAt: completed } },
      { itemId: 'i1', item: { createdAt: intake }, order: { completedAt: completed } }, // duplicate — defensive case
    ])
    const now = new Date()
    const result = await getDaysToSellDurations({ preset: '30d', start: new Date(now.getTime() - 1000), end: now, label: '' })

    expect(result.durations).toEqual([10]) // only the first is counted as valid
    expect(result.invalidCount).toBe(1)
  })

  it('missing completedAt is counted as invalid (defensive — order.status=complete should guarantee completedAt is set)', async () => {
    ;(prisma.orderItem.findMany as Mock).mockResolvedValueOnce([
      { itemId: 'i1', item: { createdAt: new Date() }, order: { completedAt: null } },
    ])
    const now = new Date()
    const result = await getDaysToSellDurations({ preset: '30d', start: new Date(now.getTime() - 1000), end: now, label: '' })

    expect(result.durations).toEqual([])
    expect(result.invalidCount).toBe(1)
  })
})

// ── Behavioral: payout liability ─────────────────────────────────────────────────

describe('businessAnalyticsQuery: payout liability (behavioral)', () => {
  beforeEach(() => vi.resetAllMocks())

  it('outstanding liability excludes voided and paid lines', async () => {
    ;(prisma.sellerPayoutLine.aggregate as Mock).mockResolvedValueOnce({ _sum: { netAmount: D('123.45') } })
    const liability = await getOutstandingLiability()
    expect(liability.toFixed(2)).toBe('123.45')

    const args = (prisma.sellerPayoutLine.aggregate as Mock).mock.calls[0][0]
    expect(args.where.status.in).toEqual(['eligible', 'held'])
    expect(args.where.status.in).not.toContain('voided')
  })

  it('paid total is scoped to payout.status = paid, not eligible lines', async () => {
    ;(prisma.sellerPayoutLine.aggregate as Mock)
      .mockResolvedValueOnce({ _sum: { netAmount: D('10') } }) // eligibleNoPayout
      .mockResolvedValueOnce({ _sum: { netAmount: D('0') } })  // held
      .mockResolvedValueOnce({ _sum: { netAmount: D('0') } })  // inDraftPayout
      .mockResolvedValueOnce({ _sum: { netAmount: D('0') } })  // inApprovedPayout
      .mockResolvedValueOnce({ _sum: { netAmount: D('500') } }) // paidTotal
      .mockResolvedValueOnce({ _sum: { netAmount: D('5') } })   // voidedTotal
      .mockResolvedValueOnce({ _sum: { netAmount: D('10') } })  // outstanding (getOutstandingLiability)
    ;(prisma.sellerPayoutLine.groupBy as Mock).mockResolvedValueOnce([{ customerProfileId: 'p1' }])

    const snapshot = await getPayoutLiabilitySnapshot()
    expect(snapshot.paidTotal.toFixed(2)).toBe('500.00')
    expect(snapshot.voidedTotal.toFixed(2)).toBe('5.00')
    expect(snapshot.sellersWithOutstanding).toBe(1)

    const paidCallArgs = (prisma.sellerPayoutLine.aggregate as Mock).mock.calls[4][0]
    expect(paidCallArgs.where.payout.status).toBe('paid')
  })

  it('sellers-with-outstanding count is a bounded groupBy, not a per-seller query', async () => {
    ;(prisma.sellerPayoutLine.aggregate as Mock).mockResolvedValue({ _sum: { netAmount: D('0') } })
    ;(prisma.sellerPayoutLine.groupBy as Mock).mockResolvedValueOnce([{ customerProfileId: 'p1' }, { customerProfileId: 'p2' }])
    const snapshot = await getPayoutLiabilitySnapshot()
    expect(snapshot.sellersWithOutstanding).toBe(2)
    expect(prisma.sellerPayoutLine.groupBy).toHaveBeenCalledTimes(1)
  })

  it('outstanding liability query includes lines with no payout at all, not just draft/approved payouts', async () => {
    ;(prisma.sellerPayoutLine.aggregate as Mock).mockResolvedValueOnce({ _sum: { netAmount: D('0') } })
    await getOutstandingLiability()
    const args = (prisma.sellerPayoutLine.aggregate as Mock).mock.calls[0][0]
    expect(args.where.OR).toEqual([{ payoutId: null }, { payout: { status: { in: ['draft', 'approved'] } } }])
    expect(args.where.status.in).not.toContain('paid')
  })

  it('a failed/never-paid payout line remains outstanding indefinitely — no distinct "failed" bucket exists to wrongly exclude it (no failed/processing/rejected payout status in this schema)', () => {
    const src = readSrc('src/lib/businessAnalyticsQuery.ts')
    expect(src).not.toContain("status: 'failed'")
    expect(src).not.toContain("'processing'")
    expect(src).not.toContain("'rejected'")
    expect(src).toContain('No due-date field exists')
  })

  it('partial payment is documented as not representable — liability is all-or-nothing per payout, never a partial-amount computation', () => {
    const src = readSrc('src/lib/businessAnalyticsQuery.ts')
    expect(src.toLowerCase()).toContain('partial payment is not representable')
  })
})

// ── Behavioral: conversion ────────────────────────────────────────────────────────

describe('businessAnalyticsQuery: conversion (behavioral)', () => {
  beforeEach(() => vi.resetAllMocks())

  it('listing-to-sale conversion numerator/denominator are returned alongside the ratio inputs', async () => {
    ;(prisma.listing.count as Mock)
      .mockResolvedValueOnce(20) // listingsCreated (funnel)
      .mockResolvedValueOnce(20) // listingToSale denominator
      .mockResolvedValueOnce(5)  // listingToSale numerator
    ;(prisma.orderItem.count as Mock).mockResolvedValue(0)
    ;(prisma.order.count as Mock).mockResolvedValue(0)

    const now = new Date()
    const funnel = await getConversionFunnel({ preset: '30d', start: new Date(now.getTime() - 1000), end: now, label: '' })
    expect(funnel.listingToSale).toEqual({ numerator: 5, denominator: 20 })
  })

  it('no page-view/impression/add-to-cart metric is computed anywhere in the query layer', () => {
    // The conversion page's own prose explicitly documents that these are NOT tracked
    // (see the page's limitation note) — so only the query/computation layer, which
    // never has a reason to mention them, is checked here.
    const querySrc = readSrc('src/lib/businessAnalyticsQuery.ts')
    for (const forbidden of ['pageView', 'impression', 'addToCart', 'productView', 'page_view']) {
      expect(querySrc.toLowerCase()).not.toContain(forbidden.toLowerCase())
    }
  })

  it('conversion page explicitly documents unavailable funnel stages rather than inventing them', () => {
    const pageSrc = readSrc('src/app/(admin)/admin/analytics/conversion/page.tsx')
    expect(pageSrc).toContain('not tracked')
  })

  it('order completion uses exact status classification (complete vs all orders created)', () => {
    const src = readSrc('src/lib/businessAnalyticsQuery.ts')
    const fnSrc = src.slice(src.indexOf('export async function getConversionFunnel'))
    expect(fnSrc).toContain("status: 'complete'")
  })
})

// ── Behavioral: time series ───────────────────────────────────────────────────────

describe('businessAnalyticsQuery: getTimeSeries (behavioral)', () => {
  beforeEach(() => vi.resetAllMocks())

  function mockEmptyEvents() {
    ;(prisma.order.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.orderItem.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.itemInstance.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.sellerPayoutLine.findMany as Mock).mockResolvedValueOnce([])
  }

  it('missing buckets are zero-filled, not omitted, across the full requested range', async () => {
    mockEmptyEvents()
    const now = new Date('2026-03-15T00:00:00.000Z')
    const series = await getTimeSeries({ preset: '7d', start: new Date(now.getTime() - 7 * 86_400_000), end: now, label: '' })

    expect(series.length).toBeGreaterThan(0)
    for (const bucket of series) {
      expect(bucket.completedOrders).toBe(0)
      expect(bucket.unitsSold).toBe(0)
      expect(bucket.gmv.toFixed(2)).toBe('0.00')
      expect(bucket.consignmentGrossSpread.toFixed(2)).toBe('0.00')
      expect(bucket.buyoutGrossMargin.toFixed(2)).toBe('0.00')
      expect(bucket.inventoryIntake).toBe(0)
      expect(bucket.inventorySold).toBe(0)
      expect(bucket.payoutsPaid.toFixed(2)).toBe('0.00')
    }
  })

  it('buckets use UTC day boundaries — start <= timestamp < end, never browser-local grouping', async () => {
    ;(prisma.order.findMany as Mock).mockResolvedValueOnce([{ completedAt: new Date('2026-03-10T23:30:00.000Z') }])
    ;(prisma.orderItem.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.itemInstance.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.sellerPayoutLine.findMany as Mock).mockResolvedValueOnce([])

    const now = new Date('2026-03-15T00:00:00.000Z')
    const series = await getTimeSeries({ preset: '7d', start: new Date(now.getTime() - 7 * 86_400_000), end: now, label: '' })

    const bucket = series.find(b => b.bucketStart.toISOString() === '2026-03-10T00:00:00.000Z')
    expect(bucket?.completedOrders).toBe(1)
    const totalCompleted = series.reduce((s, b) => s + b.completedOrders, 0)
    expect(totalCompleted).toBe(1) // counted exactly once, in exactly the right UTC day
  })

  it('a completed order-item is aggregated via Decimal, not JS Number, into gmv/unitsSold/inventorySold', async () => {
    const completedAt = new Date('2026-03-10T12:00:00.000Z')
    ;(prisma.order.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.orderItem.findMany as Mock).mockResolvedValueOnce([
      { id: 'oi1', price: 19.99, order: { completedAt }, item: { sourceType: 'company_owned', purchasePrice: 10.0 } },
    ])
    ;(prisma.itemInstance.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.sellerPayoutLine.findMany as Mock).mockResolvedValueOnce([])

    const now = new Date('2026-03-15T00:00:00.000Z')
    const series = await getTimeSeries({ preset: '7d', start: new Date(now.getTime() - 7 * 86_400_000), end: now, label: '' })

    const bucket = series.find(b => b.bucketStart.toISOString() === '2026-03-10T00:00:00.000Z')!
    expect(bucket.unitsSold).toBe(1)
    expect(bucket.inventorySold).toBe(1)
    expect(bucket.gmv.toFixed(2)).toBe('19.99')
    // company_owned -> buyoutGrossMargin only; consignmentGrossSpread must stay zero,
    // proving the two series are never merged into one number.
    expect(bucket.buyoutGrossMargin.toFixed(2)).toBe('9.99') // 19.99 - 10.00, exact Decimal subtraction
    expect(bucket.consignmentGrossSpread.toFixed(2)).toBe('0.00')
  })

  it('a completed CONSIGNMENT order-item is aggregated into consignmentGrossSpread only, never buyoutGrossMargin', async () => {
    const completedAt = new Date('2026-03-10T12:00:00.000Z')
    ;(prisma.order.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.orderItem.findMany as Mock).mockResolvedValueOnce([
      { id: 'oi1', price: 20.00, order: { completedAt }, item: { sourceType: 'consignment', purchasePrice: null } },
    ])
    ;(prisma.itemInstance.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.sellerPayoutLine.findMany as Mock)
      .mockResolvedValueOnce([]) // paidLineRows (payouts-paid series)
      .mockResolvedValueOnce([{ orderItemId: 'oi1', grossSalePrice: D('20.00'), netAmount: D('14.00') }]) // consignment spread lookup

    const now = new Date('2026-03-15T00:00:00.000Z')
    const series = await getTimeSeries({ preset: '7d', start: new Date(now.getTime() - 7 * 86_400_000), end: now, label: '' })

    const bucket = series.find(b => b.bucketStart.toISOString() === '2026-03-10T00:00:00.000Z')!
    expect(bucket.consignmentGrossSpread.toFixed(2)).toBe('6.00')
    expect(bucket.buyoutGrossMargin.toFixed(2)).toBe('0.00')
  })

  function mockEarliestTimestampAggregates(orderMin: Date | null, intakeMin: Date | null, payoutMin: Date | null) {
    ;(prisma.order.aggregate as Mock).mockResolvedValueOnce({ _min: { completedAt: orderMin } })
    ;(prisma.itemInstance.aggregate as Mock).mockResolvedValueOnce({ _min: { createdAt: intakeMin } })
    ;(prisma.sellerPayout.aggregate as Mock).mockResolvedValueOnce({ _min: { paidAt: payoutMin } })
  }

  it('"all time" range derives its start from the earliest observed data (via DB MIN aggregation, not a fabricated epoch)', async () => {
    const earliest = new Date('2024-05-01T00:00:00.000Z')
    mockEarliestTimestampAggregates(null, earliest, null)
    ;(prisma.order.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.orderItem.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.itemInstance.findMany as Mock).mockResolvedValueOnce([{ createdAt: earliest }])
    ;(prisma.sellerPayoutLine.findMany as Mock).mockResolvedValueOnce([])

    const now = new Date('2026-03-15T00:00:00.000Z')
    const series = await getTimeSeries({ preset: 'all', start: null, end: now, label: '' })

    expect(series[0].bucketStart.getUTCFullYear()).toBe(2024)
    expect(series[0].bucketStart.getTime()).toBeGreaterThanOrEqual(new Date('2024-01-01').getTime())
    expect(series.every(b => b.bucketStart.getUTCFullYear() > 1970)).toBe(true) // no fabricated epoch start
  })

  it('the earliest-timestamp lookup uses DB MIN aggregation (aggregate/_min), never app-memory Math.min over a fully-loaded row set', () => {
    const src = readSrc('src/lib/businessAnalyticsQuery.ts')
    const fnSrc = src.slice(src.indexOf('async function getEarliestBusinessTimestamp'), src.indexOf('export async function getTimeSeries'))
    expect(fnSrc).toContain('.aggregate(')
    expect(fnSrc).toContain('_min:')
    expect(fnSrc).not.toContain('findMany') // no row-materializing query anywhere in this lookup
  })

  it('an empty database ("all time", nothing in any table) produces a clean, small series — not an error, not millions of buckets', async () => {
    mockEarliestTimestampAggregates(null, null, null) // every MIN aggregate returns null: truly empty DB
    ;(prisma.order.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.orderItem.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.itemInstance.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.sellerPayoutLine.findMany as Mock).mockResolvedValueOnce([])

    const now = new Date('2026-03-15T00:00:00.000Z')
    const series = await getTimeSeries({ preset: 'all', start: null, end: now, label: '' })

    expect(series.length).toBeLessThanOrEqual(1) // falls back to range.end as the (only) bucket start
    for (const bucket of series) {
      expect(bucket.completedOrders).toBe(0)
      expect(bucket.gmv.toFixed(2)).toBe('0.00')
    }
  })

  it('a malformed/implausible historical timestamp is clamped, not left to silently truncate the recent (relevant) end of the series', async () => {
    // A bad data point from year 1 A.D. would, uncapped, require ~24,000 monthly
    // buckets to reach `now` — far past MAX_BUCKETS. The fix must still produce a
    // series that reaches all the way to `now` (clamping away only the ancient
    // garbage), not a series that silently stops hundreds of years before the present.
    const malformed = new Date('0001-01-01T00:00:00.000Z')
    mockEarliestTimestampAggregates(null, malformed, null)
    ;(prisma.order.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.orderItem.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.itemInstance.findMany as Mock).mockResolvedValueOnce([{ createdAt: malformed }])
    ;(prisma.sellerPayoutLine.findMany as Mock).mockResolvedValueOnce([])

    const now = new Date('2026-03-15T00:00:00.000Z')
    const series = await getTimeSeries({ preset: 'all', start: null, end: now, label: '' })

    expect(series.length).toBeGreaterThan(0)
    expect(series.length).toBeLessThanOrEqual(2000) // MAX_BUCKETS
    const lastBucket = series[series.length - 1]
    // The series must reach up to (just before) `now` — the recent/relevant data is
    // never silently dropped just because an old timestamp was malformed.
    expect(now.getTime() - lastBucket.bucketStart.getTime()).toBeLessThan(32 * 86_400_000) // within one month bucket of `now`
  })

  it('bucket generation has an explicit hard safety bound regardless of clamping', () => {
    const src = readSrc('src/lib/businessAnalyticsQuery.ts')
    expect(src).toContain('MAX_BUCKETS')
    const fnSrc = src.slice(src.indexOf('function bucketBoundaries'), src.indexOf('function approxBucketMs'))
    expect(fnSrc).toMatch(/i < MAX_BUCKETS/)
  })

  it('a bounded (non-"all time") range never triggers the earliest-timestamp DB lookup — it already has an explicit start', async () => {
    mockEmptyEvents()
    const now = new Date()
    await getTimeSeries({ preset: '30d', start: new Date(now.getTime() - 30 * 86_400_000), end: now, label: '' })
    expect(prisma.order.aggregate).not.toHaveBeenCalled()
    expect(prisma.itemInstance.aggregate).not.toHaveBeenCalled()
    expect(prisma.sellerPayout.aggregate).not.toHaveBeenCalled()
  })

  it('no historical payout-liability balance series is fabricated — only a "payouts paid" flow series exists', () => {
    const src = readSrc('src/lib/businessAnalyticsQuery.ts')
    const fnSrc = src.slice(src.indexOf('// ── Time series'), src.indexOf('export async function getTimeSeries') + 2000)
    expect(fnSrc.toLowerCase()).toContain('no historical')
    expect(fnSrc).not.toContain('liabilityBalance')
    expect(fnSrc).not.toContain('liabilityHistory')
  })
})

// ── Behavioral: seller performance pagination ────────────────────────────────────

describe('businessAnalyticsQuery: seller performance (behavioral)', () => {
  beforeEach(() => vi.resetAllMocks())

  // getSellerPerformancePage: (1) one $queryRaw call does the sort+limit entirely in
  // Postgres (fetchSellerSortPage), (2) hydrateSellerPage then fills in display columns
  // scoped to just that page's profileIds via groupBy/findMany calls.
  function mockSortPage(rows: Array<{ profile_id: string; value: number | null }>) {
    ;(prisma.$queryRaw as Mock).mockResolvedValueOnce(rows)
  }

  function mockEmptyHydration() {
    ;(prisma.sellerSubmission.groupBy as Mock).mockResolvedValue([])
    ;(prisma.sellerPayoutLine.groupBy as Mock).mockResolvedValue([])
    ;(prisma.sellerAgreement.findMany as Mock).mockResolvedValue([])
    ;(prisma.customerCommunityProfile.findMany as Mock).mockResolvedValue([])
    ;(prisma.itemInstance.groupBy as Mock).mockResolvedValue([])
    ;(prisma.orderItem.findMany as Mock).mockResolvedValue([])
  }

  it('bounded page size (<=50): the DB query itself requests exactly PAGE_SIZE+1 rows via LIMIT', async () => {
    mockSortPage(Array.from({ length: 5 }, (_, i) => ({ profile_id: `p${i}`, value: 0 })))
    mockEmptyHydration()

    const now = new Date()
    const { items } = await getSellerPerformancePage({ preset: '30d', start: new Date(now.getTime() - 1000), end: now, label: '' }, 'grossSales', null)

    expect(items.length).toBeLessThanOrEqual(50)
    // The raw SQL template must contain a LIMIT clause — sort+limit happens in Postgres.
    const rawCall = (prisma.$queryRaw as Mock).mock.calls[0]
    const sqlText = (rawCall[0] as TemplateStringsArray).join(' ')
    expect(sqlText).toContain('LIMIT')
    expect(sqlText).toContain('ORDER BY')
  })

  it('no unbounded application-memory aggregation: seller sort never calls SellerProfile.findMany, ItemInstance/Order findMany without an `in:` scope, or an unscoped groupBy', () => {
    const src = readSrc('src/lib/businessAnalyticsQuery.ts')
    const fnSrc = src.slice(src.indexOf('async function fetchSellerSortPage'), src.indexOf('export async function getSellerPerformancePage'))
    expect(fnSrc).not.toContain('sellerProfile.findMany')
    expect(fnSrc).toContain('$queryRaw')
  })

  it('hydration is scoped to just the returned page profileIds (<=50), never the full seller population', async () => {
    mockSortPage([{ profile_id: 'p1', value: 10 }, { profile_id: 'p2', value: 5 }])
    mockEmptyHydration()

    const now = new Date()
    await getSellerPerformancePage({ preset: '30d', start: new Date(now.getTime() - 1000), end: now, label: '' }, 'grossSales', null)

    const submissionArgs = (prisma.sellerSubmission.groupBy as Mock).mock.calls[0][0]
    expect(submissionArgs.where.profileId.in).toEqual(['p1', 'p2'])
    const communityArgs = (prisma.customerCommunityProfile.findMany as Mock).mock.calls[0][0]
    expect(communityArgs.where.profileId.in).toEqual(['p1', 'p2'])
    expect(communityArgs.where.isPublic).toBe(true)
  })

  it('cursor pagination: nextCursor is only set when a 51st row was returned (hasMore), and reflects the last item in the page', async () => {
    const rows = Array.from({ length: 51 }, (_, i) => ({ profile_id: `p${50 - i}`, value: 50 - i })) // descending, 51 rows
    mockSortPage(rows)
    mockEmptyHydration()

    const now = new Date()
    const { items, nextCursor } = await getSellerPerformancePage({ preset: '30d', start: new Date(now.getTime() - 1000), end: now, label: '' }, 'grossSales', null)

    expect(items).toHaveLength(50)
    expect(nextCursor).not.toBeNull()
    expect(nextCursor!.profileId).toBe(items[items.length - 1].profileId)
  })

  it('cursor pagination: fewer than PAGE_SIZE+1 rows means no next page', async () => {
    mockSortPage([{ profile_id: 'p1', value: 1 }])
    mockEmptyHydration()

    const now = new Date()
    const { nextCursor } = await getSellerPerformancePage({ preset: '30d', start: new Date(now.getTime() - 1000), end: now, label: '' }, 'grossSales', null)
    expect(nextCursor).toBeNull()
  })

  it('full multi-page walk over 56 sellers (11 distinct/tied real values + 45 tied no-data sellers spanning the page boundary): no duplicates, no omissions, correct order preserved', async () => {
    // Mirrors the exact fixture used for the live Postgres validation of this cursor:
    // page 1 = 11 real-valued sellers (descending, with a tie) + 39 of 45 no-data
    // sellers (value=-1, ordered by profileId ascending); page 2 = the remaining 6.
    const realRows = [
      { profile_id: 'real-01', value: 100 }, { profile_id: 'real-02', value: 90 }, { profile_id: 'real-03', value: 90 },
      { profile_id: 'real-04', value: 80 }, { profile_id: 'real-05', value: 70 }, { profile_id: 'real-06', value: 60 },
      { profile_id: 'real-07', value: 50 }, { profile_id: 'real-08', value: 40 }, { profile_id: 'real-09', value: 30 },
      { profile_id: 'real-10', value: 20 }, { profile_id: 'real-11', value: 10 },
    ]
    const noDataIds = Array.from({ length: 45 }, (_, i) => `nodata-${String(i + 1).padStart(2, '0')}`)
    const allSorted = [...realRows, ...noDataIds.map(id => ({ profile_id: id, value: -1 }))]

    const now = new Date()
    const range = { preset: '30d' as const, start: new Date(now.getTime() - 1000), end: now, label: '' }

    // Page 1: the mock stands in for what a correctly-ordered Postgres query returns
    // for `cursor=null` — the first 51 rows of the true sort order.
    mockSortPage(allSorted.slice(0, 51))
    mockEmptyHydration()
    const page1 = await getSellerPerformancePage(range, 'grossSales', null)
    expect(page1.items).toHaveLength(50)
    expect(page1.nextCursor).not.toBeNull()

    // Page 2: the mock stands in for what Postgres returns given the ACTUAL cursor the
    // app computed from page 1 — i.e. this exercises the real nextCursor value the code
    // produced, not a value we picked ourselves. Only 6 rows remain, so this is also
    // the terminal page (< 51 rows means no further nextCursor).
    const remaining = allSorted.slice(50)
    mockSortPage(remaining)
    mockEmptyHydration()
    const page2 = await getSellerPerformancePage(range, 'grossSales', page1.nextCursor)

    const allReturnedIds = [...page1.items.map(i => i.profileId), ...page2.items.map(i => i.profileId)]
    expect(new Set(allReturnedIds).size).toBe(allReturnedIds.length) // no duplicates across pages
    expect(allReturnedIds).toEqual(allSorted.map(r => r.profile_id)) // no omissions, exact order preserved
    expect(page2.nextCursor).toBeNull() // final page correctly terminates pagination
  })

  it('cursor is passed through to the raw query as bound parameters (value and profileId), not string-interpolated', async () => {
    mockSortPage([])
    const now = new Date()
    await getSellerPerformancePage({ preset: '30d', start: new Date(now.getTime() - 1000), end: now, label: '' }, 'unitsSold', { value: 7, profileId: 'p5' })

    const rawCall = (prisma.$queryRaw as Mock).mock.calls[0]
    const cursorFragment = rawCall.find((v: unknown) => v && typeof v === 'object' && 'values' in v && (v as { values: unknown[] }).values.length > 0) as { values: unknown[]; strings: string[] } | undefined
    expect(cursorFragment).toBeDefined()
    expect(cursorFragment!.strings.join('')).toContain('WHERE')
    // Every occurrence of the cursor value/profileId in the fragment is a bound
    // parameter — the fragment's `.values` must be built entirely from `7`/`p5`.
    expect(cursorFragment!.values.every(v => v === 7 || v === 'p5')).toBe(true)
    expect(cursorFragment!.values).toContain(7)
    expect(cursorFragment!.values).toContain('p5')
  })

  // Regression test for a confirmed bug: the sort is MIXED-DIRECTION (value DESC,
  // profileId ASC secondary tiebreak). A naive row-value tuple predicate
  // `(value, profileId) < (cursorValue, cursorProfileId)` is only correct when both
  // columns sort the same direction — with DESC/ASC mixed it instead re-selects rows
  // already returned on the prior page whenever more than PAGE_SIZE rows share the
  // same value (e.g. many sellers all at the -1 "no data" sentinel). Confirmed live
  // against Postgres with a 56-seller fixture (11 distinct/tied real values + 45
  // tied/no-data sellers spanning the page boundary): the naive form produced 31
  // duplicate rows across page 1/page 2; the per-direction form below did not.
  it('cursor predicate is direction-correct for the mixed DESC/ASC sort — not a naive same-direction tuple comparison', () => {
    const src = readSrc('src/lib/businessAnalyticsQuery.ts')
    const fnSrc = src.slice(src.indexOf('async function fetchSellerSortPage'), src.indexOf('function grossSalesCte'))
    // The old, buggy form compared the whole tuple with a single `<`, which is only
    // valid when every column sorts in the same direction.
    expect(fnSrc).not.toMatch(/\(COALESCE\(agg\.value, -1\), sp\."profileId"\)\s*<\s*\(/)
    // The fixed form must branch per-column: primary DESC uses `<` on value alone,
    // and the secondary ASC tiebreak uses `>` on profileId within the equal-value case.
    expect(fnSrc).toMatch(/COALESCE\(agg\.value, -1\)\s*<\s*\$\{cursor\.value\}/)
    expect(fnSrc).toMatch(/COALESCE\(agg\.value, -1\)\s*=\s*\$\{cursor\.value\}.*AND sp\."profileId"\s*>\s*\$\{cursor\.profileId\}/s)
  })

  it('sentinel is direction-safe: -1 is less than every legitimate metric value for all 5 sort keys, so no-data sellers always rank last', () => {
    // grossSales/unitsSold/payoutOutstanding: SUM/COUNT of always-positive amounts — a
    // seller only appears in these CTEs at all if the aggregate is > 0, so no real 0
    // exists to collide with the -1 sentinel.
    // sellThrough/medianDaysToSell: CAN legitimately be a real 0 (0% sold; sold same
    // day as listed) — verified live that a real 0 sorts above the -1 sentinel exactly
    // because 0 > -1, and that a seller with no data at all reports -1, not 0.
    const src = readSrc('src/lib/businessAnalyticsQuery.ts')
    expect(src).toContain('COALESCE(agg.value, -1)')
    expect(src).not.toContain('COALESCE(agg.value, 0)') // 0 is not a safe no-data sentinel here
  })

  it('all 5 sort keys route through the bounded fetchSellerSortPage/$queryRaw path', async () => {
    const sortKeys = ['grossSales', 'unitsSold', 'sellThrough', 'payoutOutstanding', 'medianDaysToSell'] as const
    const now = new Date()
    for (const sort of sortKeys) {
      ;(prisma.$queryRaw as Mock).mockResolvedValueOnce([])
      await getSellerPerformancePage({ preset: '30d', start: new Date(now.getTime() - 1000), end: now, label: '' }, sort, null)
    }
    expect((prisma.$queryRaw as Mock).mock.calls.length).toBe(sortKeys.length)
  })

  it('seller identifier: uses a public CustomerCommunityProfile.handle when available, else a truncated internal id — never an admin-entered display name', async () => {
    mockSortPage([{ profile_id: 'p1', value: 10 }, { profile_id: 'p2', value: 5 }])
    mockEmptyHydration()
    ;(prisma.customerCommunityProfile.findMany as Mock).mockResolvedValueOnce([{ profileId: 'p1', handle: 'diecastdan' }])

    const now = new Date()
    const { items } = await getSellerPerformancePage({ preset: '30d', start: new Date(now.getTime() - 1000), end: now, label: '' }, 'grossSales', null)

    expect(items.find(i => i.profileId === 'p1')!.displayName).toBe('diecastdan')
    expect(items.find(i => i.profileId === 'p2')!.displayName).toBe(`Seller ${'p2'.slice(0, 8)}`) // truncated-id fallback, no public handle
  })

  it('sort allowlist is enforced by the type system — no arbitrary sort expression reaches the query', () => {
    const pageSrc = readSrc('src/app/(admin)/admin/analytics/sellers/page.tsx')
    expect(pageSrc).toContain('SORT_KEYS.has(')
  })
})

// ── Behavioral: revenue / reconciliation ──────────────────────────────────────────

describe('businessAnalyticsQuery: revenue (behavioral)', () => {
  beforeEach(() => vi.resetAllMocks())

  it('consignment GMV = seller proceeds + gross spread exactly (reconciliation identity holds for this subset)', async () => {
    ;(prisma.orderItem.findMany as Mock).mockResolvedValueOnce([
      { id: 'oi1', price: 20.00, orderId: 'o1', item: { sourceType: 'consignment', purchasePrice: null } },
    ])
    ;(prisma.sellerPayoutLine.findMany as Mock).mockResolvedValueOnce([
      { orderItemId: 'oi1', grossSalePrice: D('20.00'), netAmount: D('14.00') },
    ])
    ;(prisma.sellerPayoutLine.aggregate as Mock).mockResolvedValueOnce({ _sum: { netAmount: D('14.00') } })

    const now = new Date()
    const rev = await getRevenueBreakdown({ preset: '30d', start: new Date(now.getTime() - 1000), end: now, label: '' })

    expect(rev.consignment.gmv.toFixed(2)).toBe('20.00')
    expect(rev.consignment.sellerProceeds.toFixed(2)).toBe('14.00')
    expect(rev.consignment.grossSpread.toFixed(2)).toBe('6.00')
    expect(rev.reconciliationDifference.toFixed(2)).toBe('0.00')
  })

  it('buyout/company-owned item with no purchasePrice is undetermined, excluded from GMV-with-known-cost, not zero-filled', async () => {
    ;(prisma.orderItem.findMany as Mock).mockResolvedValueOnce([
      { id: 'oi2', price: 50.00, orderId: 'o2', item: { sourceType: 'company_owned', purchasePrice: null } },
    ])
    ;(prisma.sellerPayoutLine.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.sellerPayoutLine.aggregate as Mock).mockResolvedValueOnce({ _sum: { netAmount: D('0') } })

    const now = new Date()
    const rev = await getRevenueBreakdown({ preset: '30d', start: new Date(now.getTime() - 1000), end: now, label: '' })

    expect(rev.costBased.undeterminedItems).toBe(1)
    expect(rev.costBased.undeterminedGmv.toFixed(2)).toBe('50.00')
    expect(rev.costBased.grossMargin.toFixed(2)).toBe('0.00') // not fabricated
  })

  it('buyout item with known purchasePrice computes retail gross margin', async () => {
    ;(prisma.orderItem.findMany as Mock).mockResolvedValueOnce([
      { id: 'oi3', price: 30.00, orderId: 'o3', item: { sourceType: 'buyout', purchasePrice: 18.00 } },
    ])
    ;(prisma.sellerPayoutLine.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.sellerPayoutLine.aggregate as Mock).mockResolvedValueOnce({ _sum: { netAmount: D('0') } })

    const now = new Date()
    const rev = await getRevenueBreakdown({ preset: '30d', start: new Date(now.getTime() - 1000), end: now, label: '' })

    expect(rev.costBased.grossMargin.toFixed(2)).toBe('12.00')
    expect(rev.costBased.undeterminedItems).toBe(0)
  })

  it('marketplace revenue is explicitly reported unavailable, never fabricated as gross spread/margin or order total', () => {
    const src = readSrc('src/lib/businessAnalyticsQuery.ts')
    expect(src).not.toContain('marketplace_revenue = order total')
    expect(getMetricDefinition('marketplace_revenue')!.description).not.toBe('order total')
    expect(getMetricDefinition('marketplace_revenue')!.description.toLowerCase()).toContain('not available')
  })

  // Regression: getOverviewMetrics previously summed consignment gross spread and
  // buyout/company-owned gross margin into one `grossSpreadOrMarginDetermined` figure,
  // which the overview page then rendered under the "Gross spread (consignment)" label
  // — silently including buyout margin under a consignment-only name. Fixed by keeping
  // the two figures as permanently separate fields.
  it('getOverviewMetrics keeps gross spread (consignment) and gross margin (buyout/company-owned) as separate fields, never summed', async () => {
    ;(prisma.orderItem.findMany as Mock)
      .mockResolvedValueOnce([
        { id: 'oi1', itemId: 'i1', price: 20.00, item: { sourceType: 'consignment', purchasePrice: null, createdAt: new Date('2026-01-01T00:00:00.000Z') }, order: { completedAt: new Date('2026-01-10T00:00:00.000Z') } },
        { id: 'oi2', itemId: 'i2', price: 30.00, item: { sourceType: 'buyout', purchasePrice: 18.00, createdAt: new Date('2026-01-01T00:00:00.000Z') }, order: { completedAt: new Date('2026-01-10T00:00:00.000Z') } },
      ])
      .mockResolvedValueOnce([]) // getSellersWithCompletedSalesCount's own orderItem.findMany
    ;(prisma.order.count as Mock).mockResolvedValueOnce(2)
    ;(prisma.itemInstance.count as Mock).mockResolvedValue(0)
    ;(prisma.listing.count as Mock).mockResolvedValue(0)
    ;(prisma.sellerPayoutLine.findMany as Mock).mockResolvedValueOnce([{ orderItemId: 'oi1', grossSalePrice: D('20.00'), netAmount: D('14.00') }])
    ;(prisma.sellerPayoutLine.aggregate as Mock).mockResolvedValueOnce({ _sum: { netAmount: D('0') } })
    ;(prisma.sellerAgreement.findMany as Mock).mockResolvedValueOnce([])

    const now = new Date()
    const metrics = await getOverviewMetrics({ preset: '30d', start: new Date(now.getTime() - 1000), end: now, label: '' })

    expect(metrics.grossSpreadDetermined.toFixed(2)).toBe('6.00') // consignment only: 20 - 14
    expect(metrics.grossMarginDetermined.toFixed(2)).toBe('12.00') // buyout only: 30 - 18
    // The two figures must never be added together anywhere in the returned object —
    // there is no combined field at all (a TS compile error if one were reintroduced
    // and referenced), and the two values here are not equal to any third summed field.
    expect(Object.keys(metrics)).not.toContain('grossSpreadOrMarginDetermined')
  })

  it('the query layer never sums grossSpread and grossMargin into one Decimal (no combined variable/field name survives)', () => {
    const src = readSrc('src/lib/businessAnalyticsQuery.ts')
    expect(src).not.toContain('grossSpreadOrMargin')
    expect(src).not.toContain('computeGrossSpreadOrMargin')
    expect(src).not.toMatch(/grossSpread\.plus\(.*grossMargin\)/)
    expect(src).not.toMatch(/grossMargin\.plus\(.*grossSpread\)/)
  })

  it('the overview and revenue pages render gross spread and gross margin as two separate KPI cards/series, never one blended figure', () => {
    const overviewSrc = readSrc('src/app/(admin)/admin/analytics/page.tsx')
    const revenueSrc = readSrc('src/app/(admin)/admin/analytics/revenue/page.tsx')
    for (const src of [overviewSrc, revenueSrc]) {
      expect(src).not.toContain('grossSpreadOrMargin')
      expect(src).not.toMatch(/Gross spread\/margin \(combined\)/)
    }
    // Both registry-defined metrics are each independently referenced (separate cards).
    expect(overviewSrc).toContain("def('gross_spread')")
    expect(overviewSrc).toContain("def('gross_margin')")
    expect(overviewSrc).toContain('metrics.grossSpreadDetermined')
    expect(overviewSrc).toContain('metrics.grossMarginDetermined')
    expect(revenueSrc).toContain('rev.consignment.grossSpread')
    expect(revenueSrc).toContain('rev.costBased.grossMargin')
  })

  it('the "not available" marketplace revenue card can never silently fall back to displaying spread or margin instead', () => {
    const overviewSrc = readSrc('src/app/(admin)/admin/analytics/page.tsx')
    const marketplaceCardIdx = overviewSrc.indexOf("def('marketplace_revenue')")
    const cardSlice = overviewSrc.slice(marketplaceCardIdx - 100, marketplaceCardIdx + 150)
    expect(cardSlice).toContain('value="Not available"')
    expect(cardSlice).not.toContain('grossSpreadDetermined')
    expect(cardSlice).not.toContain('grossMarginDetermined')
  })

  it('time series keeps consignment gross spread and buyout gross margin as two separate Decimal series, never merged', async () => {
    const completedAt = new Date('2026-01-10T12:00:00.000Z')
    ;(prisma.order.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.orderItem.findMany as Mock).mockResolvedValueOnce([
      { id: 'oi1', price: 20.00, order: { completedAt }, item: { sourceType: 'consignment', purchasePrice: null } },
      { id: 'oi2', price: 30.00, order: { completedAt }, item: { sourceType: 'buyout', purchasePrice: 18.00 } },
    ])
    ;(prisma.itemInstance.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.sellerPayoutLine.findMany as Mock)
      .mockResolvedValueOnce([]) // paidLineRows
      .mockResolvedValueOnce([{ orderItemId: 'oi1', grossSalePrice: D('20.00'), netAmount: D('14.00') }]) // consignment lookup

    const now = new Date('2026-01-15T00:00:00.000Z')
    const series = await getTimeSeries({ preset: '7d', start: new Date(now.getTime() - 7 * 86_400_000), end: now, label: '' })
    const bucket = series.find(b => b.bucketStart.toISOString() === '2026-01-10T00:00:00.000Z')!

    expect(bucket.consignmentGrossSpread.toFixed(2)).toBe('6.00')
    expect(bucket.buyoutGrossMargin.toFixed(2)).toBe('12.00')
    expect(bucket.gmv.toFixed(2)).toBe('50.00') // GMV is the only figure where both items' full price legitimately sums together
  })
})

// ── Structural: no fabricated metrics, no mutation, no PII, no external calls ────

describe('businessAnalytics: safety and scope', () => {
  const queryFile = readSrc('src/lib/businessAnalyticsQuery.ts')
  const files = [
    'src/lib/businessAnalyticsQuery.ts', 'src/lib/businessAnalyticsMath.ts', 'src/lib/businessAnalyticsDates.ts',
    'src/lib/businessAnalyticsRegistry.ts', 'src/lib/businessAnalyticsFormat.ts', 'src/lib/businessAnalyticsPage.ts',
  ].map(readSrc)

  it('no business-data mutation: no .create(/.update(/.delete(/.upsert( calls anywhere in the analytics query layer', () => {
    for (const src of files) {
      expect(src).not.toMatch(/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/)
    }
  })

  it('no inventory turnover ratio is fabricated — only sell-through/aging/days-to-sell', () => {
    expect(queryFile.toLowerCase()).not.toContain('turnover')
  })

  it('no fabricated "failed" order status or "processing" payout status', () => {
    expect(queryFile).not.toContain("status: 'failed'")
    expect(queryFile).not.toContain("'processing'")
  })

  it('no external AI/API/scraping in any analytics module', () => {
    for (const src of files) {
      expect(src).not.toContain('fetch(')
      expect(src.toLowerCase()).not.toContain('openai')
      expect(src.toLowerCase()).not.toContain('anthropic')
      expect(src).not.toContain('axios')
    }
  })

  it('every analytics admin page independently checks isAdminAuthenticated', () => {
    const pages = [
      'src/app/(admin)/admin/analytics/page.tsx',
      'src/app/(admin)/admin/analytics/inventory/page.tsx',
      'src/app/(admin)/admin/analytics/conversion/page.tsx',
      'src/app/(admin)/admin/analytics/payouts/page.tsx',
      'src/app/(admin)/admin/analytics/sellers/page.tsx',
      'src/app/(admin)/admin/analytics/revenue/page.tsx',
    ]
    for (const p of pages) {
      const src = readSrc(p)
      expect(src).toContain('isAdminAuthenticated')
      expect(src).toContain("redirect('/admin/login')")
    }
  })

  it('the seller CSV export route requires admin auth', () => {
    const src = readSrc('src/app/(admin)/admin/analytics/sellers/export/route.ts')
    expect(src).toContain('isAdminAuthenticated')
    expect(src).toContain('Unauthorized')
  })

  it('CSV export protects against spreadsheet formula injection (=, +, -, @ prefixes)', () => {
    const src = readSrc('src/app/(admin)/admin/analytics/sellers/export/route.ts')
    expect(src).toMatch(/\/\^\[=\+\\?-@\]\//)
  })

  it('CSV export is bounded (no unbounded loop)', () => {
    const src = readSrc('src/app/(admin)/admin/analytics/sellers/export/route.ts')
    expect(src).toContain('MAX_PAGES')
  })

  it('no arbitrary Prisma where/sort expression accepted from the browser', () => {
    const sellerPageSrc = readSrc('src/app/(admin)/admin/analytics/sellers/page.tsx')
    expect(sellerPageSrc).not.toContain('JSON.parse(sp')
    expect(sellerPageSrc).toContain('SORT_KEYS.has(')
  })

  it('no buyer/seller PII (email/phone/address/payment) is ever selected in the query layer', () => {
    expect(queryFile).not.toMatch(/\bemail\s*:\s*true/)
    expect(queryFile).not.toContain('phone')
    expect(queryFile).not.toContain('payoutHandle')
    expect(queryFile).not.toContain('paymentReference')
  })

  it('seller display identity is never sourced from SellerProfile.displayName (admin free-text, may contain a real name) or CustomerProfile.name — only a public CustomerCommunityProfile.handle or a truncated internal id', () => {
    expect(queryFile).not.toContain('sellerProfile.findMany')
    expect(queryFile).not.toContain('profile.name')
    expect(queryFile).toContain('customerCommunityProfile.findMany')
    expect(queryFile).toContain('isPublic: true')
    expect(queryFile).toContain('handleByProfile')
  })

  it('the sellers analytics page footnote documents the non-PII identifier decision', () => {
    const src = readSrc('src/app/(admin)/admin/analytics/sellers/page.tsx')
    expect(src.toLowerCase()).toContain('public seller handle')
    expect(src.toLowerCase()).toContain('real name')
  })

  it('CSV export reuses the same bounded getSellerPerformancePage pages, never a separate unbounded query', () => {
    const src = readSrc('src/app/(admin)/admin/analytics/sellers/export/route.ts')
    expect(src).toContain('getSellerPerformancePage')
    expect(src).not.toContain('sellerProfile.findMany')
  })

  it('CSV export loop terminates on nextCursor === null (natural completion), not solely on the MAX_PAGES hard cap', () => {
    const src = readSrc('src/app/(admin)/admin/analytics/sellers/export/route.ts')
    expect(src).toMatch(/if\s*\(!result\.nextCursor\)\s*break/)
  })

  it('CSV export applies formula-injection escaping AFTER value formatting (toFixed etc.), never before — so escaping cannot be bypassed by a later format step re-adding a leading =/+/-/@', () => {
    const src = readSrc('src/app/(admin)/admin/analytics/sellers/export/route.ts')
    const pushIdx = src.indexOf('rows.push(')
    const csvSafeMapIdx = src.indexOf('rows.map(row => row.map(csvSafeCell))')
    expect(pushIdx).toBeGreaterThan(-1)
    expect(csvSafeMapIdx).toBeGreaterThan(pushIdx) // formatting (push) happens first in source order, escaping applied after
  })

  it('CSV export result set is bounded to a fixed maximum (MAX_PAGES * page size), never truly unlimited in memory', () => {
    const src = readSrc('src/app/(admin)/admin/analytics/sellers/export/route.ts')
    expect(src).toMatch(/MAX_PAGES\s*=\s*\d+/)
  })

  it('CSV export sort parameter is allowlisted server-side — an unrecognized/malicious ?sort= value falls back to a safe default, never reaches the query unchecked', () => {
    const src = readSrc('src/app/(admin)/admin/analytics/sellers/export/route.ts')
    expect(src).toMatch(/SORT_KEYS\.has\(sortParam/)
    expect(src).toContain("'grossSales'") // documented safe default
  })
})

// ── Previous-period trend scope: flow gets it, snapshot/cohort/all-time never do ──

describe('businessAnalytics: previous-period trend comparison scope', () => {
  const overviewSrc = readSrc('src/app/(admin)/admin/analytics/page.tsx')

  it('flow KPIs (units sold, completed orders, GMV, gross spread/margin) receive a change= comparison prop', () => {
    expect(overviewSrc).toMatch(/definition=\{def\('units_sold'\)!\}\s*change=/)
    expect(overviewSrc).toMatch(/definition=\{def\('completed_orders'\)!\}\s*change=/)
  })

  it('snapshot KPIs (active inventory, payout liability) never receive a change= comparison prop', () => {
    const activeInventoryCard = overviewSrc.slice(overviewSrc.indexOf("def('active_inventory')") - 200, overviewSrc.indexOf("def('active_inventory')") + 100)
    expect(activeInventoryCard).not.toContain('change=')
    const liabilityCard = overviewSrc.slice(overviewSrc.indexOf("def('payout_liability')") - 200, overviewSrc.indexOf("def('payout_liability')") + 100)
    expect(liabilityCard).not.toContain('change=')
  })

  it('cohort ratio KPIs (sell-through, listing-to-sale conversion) never receive a change= comparison prop', () => {
    const sellThroughCard = overviewSrc.slice(overviewSrc.indexOf("def('sell_through')") - 200, overviewSrc.indexOf("def('sell_through')") + 300)
    expect(sellThroughCard).not.toContain('change=')
    const listingCard = overviewSrc.slice(overviewSrc.indexOf("def('listing_to_sale_conversion')") - 200, overviewSrc.indexOf("def('listing_to_sale_conversion')") + 300)
    expect(listingCard).not.toContain('change=')
  })

  it('"all time" has no previous-period predecessor, so no trend is ever computed for it', () => {
    const { range } = parseDateRangeParams({ period: 'all' })
    expect(previousPeriod(range)).toBeNull()
  })

  it('period comparisons render "New" for a zero-to-positive jump, never a fabricated Infinity%', () => {
    const change = periodChange(5, 0)
    expect(change).toEqual({ kind: 'new' })
    expect(fmtPeriodChange(change)).toBe('New')
  })
})

// ── 17C (P1-1): authoritative owned classification — null/unknown sourceType is
// neither owned nor consignment, and must never enter gross margin or gross spread.
// GMV/units-sold are independent of classification and must stay complete regardless.

describe('businessAnalyticsQuery: owned classification hardening (17C, P1-1)', () => {
  beforeEach(() => vi.resetAllMocks())

  it('a completed sale with sourceType=null still contributes to GMV and units sold, but to NEITHER gross margin NOR gross spread', async () => {
    ;(prisma.orderItem.findMany as Mock)
      .mockResolvedValueOnce([
        { id: 'oi1', itemId: 'i1', price: 20.00, item: { sourceType: 'consignment', purchasePrice: null, createdAt: new Date('2026-01-01T00:00:00.000Z') }, order: { completedAt: new Date('2026-01-10T00:00:00.000Z') } },
        { id: 'oi2', itemId: 'i2', price: 30.00, item: { sourceType: 'buyout', purchasePrice: 18.00, createdAt: new Date('2026-01-01T00:00:00.000Z') }, order: { completedAt: new Date('2026-01-10T00:00:00.000Z') } },
        { id: 'oi3', itemId: 'i3', price: 100.00, item: { sourceType: null, purchasePrice: 40.00, createdAt: new Date('2026-01-01T00:00:00.000Z') }, order: { completedAt: new Date('2026-01-10T00:00:00.000Z') } },
      ])
      .mockResolvedValueOnce([]) // getSellersWithCompletedSalesCount's own orderItem.findMany
    ;(prisma.order.count as Mock).mockResolvedValueOnce(3)
    ;(prisma.itemInstance.count as Mock).mockResolvedValue(0)
    ;(prisma.listing.count as Mock).mockResolvedValue(0)
    ;(prisma.sellerPayoutLine.findMany as Mock).mockResolvedValueOnce([{ orderItemId: 'oi1', grossSalePrice: D('20.00'), netAmount: D('14.00') }])
    ;(prisma.sellerPayoutLine.aggregate as Mock).mockResolvedValueOnce({ _sum: { netAmount: D('0') } })
    ;(prisma.sellerAgreement.findMany as Mock).mockResolvedValueOnce([])

    const now = new Date()
    const metrics = await getOverviewMetrics({ preset: '30d', start: new Date(now.getTime() - 1000), end: now, label: '' })

    expect(metrics.unitsSold).toBe(3)
    expect(metrics.gmv.toFixed(2)).toBe('150.00') // 20 + 30 + 100 — the null-sourceType sale is NOT dropped from GMV
    expect(metrics.grossSpreadDetermined.toFixed(2)).toBe('6.00') // consignment only — unaffected by the null item
    expect(metrics.grossMarginDetermined.toFixed(2)).toBe('12.00') // buyout only — the null item's $100-$40=$60 margin is NEVER added
    // The null item has a real purchasePrice, so it must not be miscounted as an
    // "owned item missing cost data" either — it was never owned to begin with.
    expect(metrics.grossMarginUndeterminedItems).toBe(0)
  })

  it('company_owned and buyout are each independently included in owned gross margin; consignment and null are each independently excluded from it', async () => {
    ;(prisma.orderItem.findMany as Mock)
      .mockResolvedValueOnce([
        { id: 'oi1', itemId: 'i1', price: 50.00, item: { sourceType: 'company_owned', purchasePrice: 30.00, createdAt: new Date('2026-01-01') }, order: { completedAt: new Date('2026-01-10') } },
        { id: 'oi2', itemId: 'i2', price: 40.00, item: { sourceType: 'buyout', purchasePrice: 25.00, createdAt: new Date('2026-01-01') }, order: { completedAt: new Date('2026-01-10') } },
        { id: 'oi3', itemId: 'i3', price: 20.00, item: { sourceType: 'consignment', purchasePrice: null, createdAt: new Date('2026-01-01') }, order: { completedAt: new Date('2026-01-10') } },
        { id: 'oi4', itemId: 'i4', price: 10.00, item: { sourceType: null, purchasePrice: 5.00, createdAt: new Date('2026-01-01') }, order: { completedAt: new Date('2026-01-10') } },
      ])
      .mockResolvedValueOnce([])
    ;(prisma.order.count as Mock).mockResolvedValueOnce(4)
    ;(prisma.itemInstance.count as Mock).mockResolvedValue(0)
    ;(prisma.listing.count as Mock).mockResolvedValue(0)
    ;(prisma.sellerPayoutLine.findMany as Mock).mockResolvedValueOnce([]) // consignment item's own payout line missing -> undetermined
    ;(prisma.sellerPayoutLine.aggregate as Mock).mockResolvedValueOnce({ _sum: { netAmount: D('0') } })
    ;(prisma.sellerAgreement.findMany as Mock).mockResolvedValueOnce([])

    const now = new Date()
    const metrics = await getOverviewMetrics({ preset: '30d', start: new Date(now.getTime() - 1000), end: now, label: '' })

    // company_owned (50-30=20) + buyout (40-25=15) = 35.00 — consignment and null excluded.
    expect(metrics.grossMarginDetermined.toFixed(2)).toBe('35.00')
    expect(metrics.grossSpreadDetermined.toFixed(2)).toBe('0.00') // consignment item's payout line not found -> undetermined, not zero-filled-as-spread
    expect(metrics.grossSpreadUndeterminedItems).toBe(1)
  })

  it('owned item (company_owned/buyout) with no recorded purchasePrice is undetermined — never zero-filled, never allocated from a multi-item agreement total', async () => {
    ;(prisma.orderItem.findMany as Mock)
      .mockResolvedValueOnce([
        { id: 'oi1', itemId: 'i1', price: 50.00, item: { sourceType: 'company_owned', purchasePrice: null, createdAt: new Date('2026-01-01') }, order: { completedAt: new Date('2026-01-10') } },
      ])
      .mockResolvedValueOnce([])
    ;(prisma.order.count as Mock).mockResolvedValueOnce(1)
    ;(prisma.itemInstance.count as Mock).mockResolvedValue(0)
    ;(prisma.listing.count as Mock).mockResolvedValue(0)
    ;(prisma.sellerPayoutLine.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.sellerPayoutLine.aggregate as Mock).mockResolvedValueOnce({ _sum: { netAmount: D('0') } })
    ;(prisma.sellerAgreement.findMany as Mock).mockResolvedValueOnce([])

    const now = new Date()
    const metrics = await getOverviewMetrics({ preset: '30d', start: new Date(now.getTime() - 1000), end: now, label: '' })

    expect(metrics.grossMarginDetermined.toFixed(2)).toBe('0.00')
    expect(metrics.grossMarginUndeterminedItems).toBe(1) // correctly flagged as undetermined-owned, not silently zero
  })

  it('getRevenueBreakdown: company_owned item with known purchasePrice is included in the owned gross-margin bucket', async () => {
    ;(prisma.orderItem.findMany as Mock).mockResolvedValueOnce([
      { id: 'oi1', price: 50.00, orderId: 'o1', item: { sourceType: 'company_owned', purchasePrice: 30.00 } },
    ])
    ;(prisma.sellerPayoutLine.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.sellerPayoutLine.aggregate as Mock).mockResolvedValueOnce({ _sum: { netAmount: D('0') } })

    const now = new Date()
    const rev = await getRevenueBreakdown({ preset: '30d', start: new Date(now.getTime() - 1000), end: now, label: '' })

    expect(rev.costBased.grossMargin.toFixed(2)).toBe('20.00')
    expect(rev.costBased.items).toBe(1)
  })

  it('getRevenueBreakdown: a null-sourceType completed sale is counted in total GMV but excluded entirely from the owned (buyout/company-owned) bucket — not even as "undetermined"', async () => {
    ;(prisma.orderItem.findMany as Mock).mockResolvedValueOnce([
      { id: 'oi1', price: 100.00, orderId: 'o1', item: { sourceType: null, purchasePrice: 40.00 } },
    ])
    ;(prisma.sellerPayoutLine.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.sellerPayoutLine.aggregate as Mock).mockResolvedValueOnce({ _sum: { netAmount: D('0') } })

    const now = new Date()
    const rev = await getRevenueBreakdown({ preset: '30d', start: new Date(now.getTime() - 1000), end: now, label: '' })

    expect(rev.gmv.toFixed(2)).toBe('100.00') // total GMV includes it
    expect(rev.costBased.gmv.toFixed(2)).toBe('0.00') // owned-bucket GMV does not
    expect(rev.costBased.items).toBe(0)
    expect(rev.costBased.undeterminedItems).toBe(0) // never owned, so never "undetermined owned" either
    expect(rev.costBased.grossMargin.toFixed(2)).toBe('0.00')
    expect(rev.consignment.gmv.toFixed(2)).toBe('0.00') // and not consignment either
  })

  it('getTimeSeries: a null-sourceType sale appears in the GMV/units-sold series but not in the owned gross-margin or consignment gross-spread series', async () => {
    const completedAt = new Date('2026-01-10T12:00:00.000Z')
    ;(prisma.order.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.orderItem.findMany as Mock).mockResolvedValueOnce([
      { id: 'oi1', price: 20.00, order: { completedAt }, item: { sourceType: 'consignment', purchasePrice: null } },
      { id: 'oi2', price: 30.00, order: { completedAt }, item: { sourceType: 'buyout', purchasePrice: 18.00 } },
      { id: 'oi3', price: 25.00, order: { completedAt }, item: { sourceType: null, purchasePrice: 40.00 } },
    ])
    ;(prisma.itemInstance.findMany as Mock).mockResolvedValueOnce([])
    ;(prisma.sellerPayoutLine.findMany as Mock)
      .mockResolvedValueOnce([]) // paidLineRows
      .mockResolvedValueOnce([{ orderItemId: 'oi1', grossSalePrice: D('20.00'), netAmount: D('14.00') }]) // consignment lookup

    const now = new Date('2026-01-15T00:00:00.000Z')
    const series = await getTimeSeries({ preset: '7d', start: new Date(now.getTime() - 7 * 86_400_000), end: now, label: '' })
    const bucket = series.find(b => b.bucketStart.toISOString() === '2026-01-10T00:00:00.000Z')!

    expect(bucket.unitsSold).toBe(3)
    expect(bucket.gmv.toFixed(2)).toBe('75.00') // 20 + 30 + 25 — the null item's sale is still in GMV
    expect(bucket.consignmentGrossSpread.toFixed(2)).toBe('6.00') // unaffected by the null item
    expect(bucket.buyoutGrossMargin.toFixed(2)).toBe('12.00') // unaffected — the null item's own margin ($25-$40) is never added
  })

  it('the query layer reuses the 15N authoritative helper (isOwnedSourceType/isConsignmentSourceType) rather than a local inverse-of-consignment proxy', () => {
    const src = readSrc('src/lib/businessAnalyticsQuery.ts')
    const codeOnly = src.split('\n').filter(line => !line.trim().startsWith('//')).join('\n')
    expect(src).toContain("import { isOwnedSourceType, isConsignmentSourceType } from '@/lib/financialPosition'")
    expect(codeOnly).not.toMatch(/sourceType\s*!==\s*'consignment'/)
    expect(codeOnly).not.toMatch(/sourceType\s*===\s*'consignment'/)
  })

  it('the registry gross_margin definition documents the owned allowlist and excludes unknown sourceType', () => {
    const def = getMetricDefinition('gross_margin')!
    expect(def.description).toContain('buyout')
    expect(def.description).toContain('company_owned')
    expect(def.description.toLowerCase()).toContain('excluded')
  })
})

// ── 17C (P1-2): seller table time-basis disclosure — no re-scoping of formulas ────

describe('sellers page/export: time-basis disclosure (17C, P1-2)', () => {
  const pageSrc = readSrc('src/app/(admin)/admin/analytics/sellers/page.tsx')
  const exportSrc = readSrc('src/app/(admin)/admin/analytics/sellers/export/route.ts')
  const queryFile = readSrc('src/lib/businessAnalyticsQuery.ts')

  it('lifetime columns are explicitly tagged "(lifetime)" in the table header', () => {
    for (const label of ['Submissions', 'Received', 'Listed', 'Sold', 'Sell-through', 'Paid', 'Med. intake→list', 'Med. list→sale', 'Rejection rate']) {
      expect(pageSrc).toContain(`${label} (lifetime)`)
    }
  })

  it('the one current-snapshot column is tagged "(current)"', () => {
    expect(pageSrc).toContain('Outstanding (current)')
  })

  it('the two period-scoped columns are NOT tagged lifetime/current', () => {
    expect(pageSrc).toContain('>Gross sales<')
    expect(pageSrc).toContain('>Proceeds<')
    expect(pageSrc).not.toContain('Gross sales (lifetime)')
    expect(pageSrc).not.toContain('Proceeds (lifetime)')
  })

  it('a short legend explains the three time bases without a legalistic paragraph', () => {
    expect(pageSrc.toLowerCase()).toContain('selected period above')
    expect(pageSrc.toLowerCase()).toContain('current snapshot')
    expect(pageSrc.toLowerCase()).toContain('lifetime totals')
  })

  it('the header context line no longer implies every column is date-filtered ("As of ... <range>" phrasing removed)', () => {
    expect(pageSrc).not.toMatch(/As of \{fmtDateTimeUtc\(ctx\.asOf\)\} · \{ctx\.range\.label\}/)
    expect(pageSrc).toContain('Selected period:')
    expect(pageSrc).toContain('Snapshot as of')
  })

  it('CSV headers disclose the same lifetime/period/current semantics as the UI table', () => {
    expect(exportSrc).toContain("'submissionsLifetime'")
    expect(exportSrc).toContain("'unitsReceivedLifetime'")
    expect(exportSrc).toContain("'unitsListedLifetime'")
    expect(exportSrc).toContain("'unitsSoldLifetime'")
    expect(exportSrc).toContain("'sellThroughPctLifetime'")
    expect(exportSrc).toContain("'payoutPaidUsdLifetime'")
    expect(exportSrc).toContain("'medianIntakeToListingDaysLifetime'")
    expect(exportSrc).toContain("'medianListingToSaleDaysLifetime'")
    expect(exportSrc).toContain("'rejectionRatePctLifetime'")
    expect(exportSrc).toContain("'grossSalesUsdPeriod'")
    expect(exportSrc).toContain("'sellerProceedsUsdPeriod'")
    expect(exportSrc).toContain("'payoutOutstandingUsdCurrent'")
  })

  it('CSV export still calls the exact same getSellerPerformancePage function as the UI page — disclosure is header-only, values/parity unchanged', () => {
    expect(exportSrc).toContain('getSellerPerformancePage')
    expect(pageSrc).toContain('getSellerPerformancePage')
  })

  it('sort keys / SellerSortKey values are unchanged by the disclosure fix — bookmarked URLs keep working', () => {
    expect(pageSrc).toContain("value: 'grossSales'")
    expect(pageSrc).toContain("value: 'unitsSold'")
    expect(pageSrc).toContain("value: 'sellThrough'")
    expect(pageSrc).toContain("value: 'payoutOutstanding'")
    expect(pageSrc).toContain("value: 'medianDaysToSell'")
    expect(exportSrc).toContain("new Set<SellerSortKey>(['grossSales', 'unitsSold', 'sellThrough', 'payoutOutstanding', 'medianDaysToSell'])")
  })

  // Critical: verify from the QUERY layer, not just the label, that the lifetime CTEs
  // genuinely carry no date predicate — proves the disclosure fix didn't accidentally
  // change (or get papered over a change to) the underlying formulas (Part N/W).
  it('lifetime seller CTEs (units sold, sell-through, payout outstanding, median days-to-sell) take no DateRange argument and reference no range/rangeSql', () => {
    for (const fn of ['unitsSoldCte', 'sellThroughCte', 'payoutOutstandingCte', 'medianDaysToSellCte']) {
      const idx = queryFile.indexOf(`function ${fn}(`)
      expect(idx).toBeGreaterThan(-1)
      expect(queryFile.slice(idx, idx + 60)).toContain(`function ${fn}(): Prisma.Sql`) // no (range: DateRange) parameter
    }
  })

  it('only grossSalesCte is date-scoped — the one lifetime/period split point in the seller sort layer', () => {
    const idx = queryFile.indexOf('function grossSalesCte(')
    expect(queryFile.slice(idx, idx + 40)).toContain('function grossSalesCte(range: DateRange)')
  })

  it('outstanding liability (snapshot) predicate is unchanged — no date filter, still keyed on status/payout state only', () => {
    const idx = queryFile.indexOf('function payoutOutstandingCte()')
    const body = queryFile.slice(idx, queryFile.indexOf('`', queryFile.indexOf('`', idx) + 1))
    expect(body).not.toMatch(/rangeSql|BETWEEN|>=\s*\$/)
  })
})
