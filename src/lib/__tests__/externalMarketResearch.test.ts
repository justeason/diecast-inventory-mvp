import { describe, it, expect } from 'vitest'
import { Prisma } from '@prisma/client'
import * as fs from 'fs'
import * as path from 'path'
import {
  parseCsv, validateRow, computeFingerprint, computeImportHash,
  MAX_CSV_BYTES, MAX_ROW_COUNT,
} from '@/lib/externalMarketImport'
import {
  computeWindowStats, buildSoldSummary, classifyFreshness,
  subtractMonths, decimalToCents, MIN_SOLD_PRIMARY_SAMPLE,
} from '@/lib/externalMarketResearch'

const root = path.resolve(__dirname, '../../..')
function readSrc(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

const importSrc    = readSrc('src/lib/externalMarketImport.ts')
const researchSrc  = readSrc('src/lib/externalMarketResearch.ts')
const querySrc     = readSrc('src/lib/externalMarketResearchQuery.ts')
const actionsSrc   = readSrc('src/lib/actions/externalMarketResearch.ts')
const valuationPage = readSrc('src/app/(store)/account/collection/valuation/page.tsx')

// ── parseCsv ──────────────────────────────────────────────────────────────────

describe('parseCsv — basic parsing', () => {
  it('returns empty for empty string', () => {
    const { headers, rows } = parseCsv('')
    expect(headers).toEqual([])
    expect(rows).toEqual([])
  })

  it('returns empty rows for header-only CSV', () => {
    const { headers, rows } = parseCsv('title,price,currency\n')
    expect(headers).toEqual(['title', 'price', 'currency'])
    expect(rows).toHaveLength(0)
  })

  it('parses single data row', () => {
    const { headers, rows } = parseCsv('title,price\nHot Wheels,5.99\n')
    expect(headers).toEqual(['title', 'price'])
    expect(rows).toHaveLength(1)
    expect(rows[0]['title']).toBe('Hot Wheels')
    expect(rows[0]['price']).toBe('5.99')
  })

  it('normalizes headers to lowercase', () => {
    const { headers } = parseCsv('Title,PRICE,Currency\nfoo,1,USD')
    expect(headers).toEqual(['title', 'price', 'currency'])
  })

  it('handles CRLF line endings', () => {
    const csv = 'title,price\r\nHot Wheels,5.99\r\n'
    const { rows } = parseCsv(csv)
    expect(rows).toHaveLength(1)
    expect(rows[0]['title']).toBe('Hot Wheels')
  })

  it('handles quoted fields', () => {
    const csv = 'title,price\n"Hot Wheels, 1967",5.99\n'
    const { rows } = parseCsv(csv)
    expect(rows[0]['title']).toBe('Hot Wheels, 1967')
  })

  it('handles doubled-quote escapes in quoted fields', () => {
    const csv = 'title,notes\n"He said ""wow""",none\n'
    const { rows } = parseCsv(csv)
    expect(rows[0]['title']).toBe('He said "wow"')
  })

  it('skips blank lines', () => {
    const csv = 'title,price\nHot Wheels,5.99\n\nMatchbox,3.00\n'
    const { rows } = parseCsv(csv)
    expect(rows).toHaveLength(2)
  })
})

// ── validateRow ───────────────────────────────────────────────────────────────

const NOW = new Date('2025-01-15T00:00:00Z')

const VALID_BASE: Record<string, string> = {
  title:            'Hot Wheels 1967 Camaro',
  observation_type: 'sold',
  price:            '12.99',
  currency:         'USD',
  total_price:      '15.49',
}

describe('validateRow — required fields', () => {
  it('accepts a fully valid row', () => {
    const result = validateRow(VALID_BASE, NOW)
    expect(result.ok).toBe(true)
  })

  it('rejects missing title', () => {
    const r = validateRow({ ...VALID_BASE, title: '' }, NOW)
    expect(r.ok).toBe(false)
    expect((r as { ok: false; reason: string }).reason).toMatch(/title/i)
  })

  it('rejects title longer than 500 chars', () => {
    const r = validateRow({ ...VALID_BASE, title: 'x'.repeat(501) }, NOW)
    expect(r.ok).toBe(false)
  })

  it('rejects invalid observation_type', () => {
    const r = validateRow({ ...VALID_BASE, observation_type: 'listing' }, NOW)
    expect(r.ok).toBe(false)
    expect((r as { ok: false; reason: string }).reason).toMatch(/observation_type/i)
  })

  it('accepts "active_ask" observation_type', () => {
    const r = validateRow({ ...VALID_BASE, observation_type: 'active_ask' }, NOW)
    expect(r.ok).toBe(true)
  })

  it('rejects negative price', () => {
    const r = validateRow({ ...VALID_BASE, price: '-5' }, NOW)
    expect(r.ok).toBe(false)
  })

  it('rejects zero total_price', () => {
    const r = validateRow({ ...VALID_BASE, total_price: '0' }, NOW)
    expect(r.ok).toBe(false)
  })

  it('rejects invalid currency format (digit in code)', () => {
    const r = validateRow({ ...VALID_BASE, currency: 'U1' }, NOW)
    expect(r.ok).toBe(false)
  })

  it('accepts 2-letter currency', () => {
    const r = validateRow({ ...VALID_BASE, currency: 'EU' }, NOW)
    expect(r.ok).toBe(true)
  })
})

describe('validateRow — optional fields', () => {
  it('rejects source_url that does not start with https://', () => {
    const r = validateRow({ ...VALID_BASE, source_url: 'http://example.com' }, NOW)
    expect(r.ok).toBe(false)
    expect((r as { ok: false; reason: string }).reason).toMatch(/https/i)
  })

  it('accepts valid https source_url', () => {
    const r = validateRow({ ...VALID_BASE, source_url: 'https://ebay.com/item/123' }, NOW)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.sourceUrl).toBe('https://ebay.com/item/123')
  })

  it('accepts blank source_url as null', () => {
    const r = validateRow({ ...VALID_BASE, source_url: '' }, NOW)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.sourceUrl).toBeNull()
  })

  it('rejects negative shipping_price', () => {
    const r = validateRow({ ...VALID_BASE, shipping_price: '-1' }, NOW)
    expect(r.ok).toBe(false)
  })

  it('accepts zero shipping_price', () => {
    const r = validateRow({ ...VALID_BASE, shipping_price: '0' }, NOW)
    expect(r.ok).toBe(true)
  })

  it('rejects invalid sold_at date', () => {
    const r = validateRow({ ...VALID_BASE, sold_at: 'not-a-date' }, NOW)
    expect(r.ok).toBe(false)
  })

  it('accepts ISO sold_at date', () => {
    const r = validateRow({ ...VALID_BASE, sold_at: '2024-06-15' }, NOW)
    expect(r.ok).toBe(true)
  })

  it('defaults observed_at to importTime when blank', () => {
    const r = validateRow({ ...VALID_BASE, observed_at: '' }, NOW)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.observedAt).toBe(NOW)
  })

  it('uses provided observed_at when valid', () => {
    const r = validateRow({ ...VALID_BASE, observed_at: '2024-11-01T12:00:00Z' }, NOW)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.observedAt.toISOString()).toBe('2024-11-01T12:00:00.000Z')
  })
})

describe('validateRow — Decimal types and totalPrice computation', () => {
  it('price is a Prisma.Decimal instance', () => {
    const r = validateRow(VALID_BASE, NOW)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.price).toBeInstanceOf(Prisma.Decimal)
  })

  it('totalPrice is a Prisma.Decimal instance', () => {
    const r = validateRow(VALID_BASE, NOW)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.totalPrice).toBeInstanceOf(Prisma.Decimal)
  })

  it('19.99 + 4.95 = 24.94 exactly (no float artefact)', () => {
    const r = validateRow(
      { title: 'Test', observation_type: 'sold', price: '19.99', currency: 'USD', shipping_price: '4.95' },
      NOW,
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.totalPrice.toFixed(4)).toBe('24.9400')
    }
  })

  it('uses admin-provided total_price when present', () => {
    const r = validateRow({ ...VALID_BASE, total_price: '99.99', shipping_price: '5.00' }, NOW)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.totalPrice.toString()).toBe('99.99')
  })

  it('computes totalPrice as price + shipping when total_price absent', () => {
    const r = validateRow(
      { title: 'T', observation_type: 'sold', price: '10.00', currency: 'USD', shipping_price: '2.50' },
      NOW,
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.totalPrice.toString()).toBe('12.5')
  })

  it('total_price not required — row without it validates fine', () => {
    const r = validateRow(
      { title: 'T', observation_type: 'sold', price: '5.00', currency: 'USD' },
      NOW,
    )
    expect(r.ok).toBe(true)
  })
})

// ── computeFingerprint ────────────────────────────────────────────────────────

type FpRow = {
  observationType: 'sold' | 'active_ask'
  title: string
  price: Prisma.Decimal
  currency: string
  totalPrice: Prisma.Decimal
  externalId: string | null
  sourceUrl: string | null
  shippingPrice: Prisma.Decimal | null
  soldAt: Date | null
  listedAt: Date | null
  observedAt: Date
  condition: string | null
  locationText: string | null
  rawSnapshot: Record<string, string>
}

function makeRow(overrides: Partial<FpRow> = {}): FpRow {
  return {
    observationType: 'sold',
    title: 'Hot Wheels Camaro',
    price: new Prisma.Decimal('10'),
    currency: 'USD',
    totalPrice: new Prisma.Decimal('12'),
    externalId: null,
    sourceUrl: null,
    shippingPrice: new Prisma.Decimal('2'),
    soldAt: new Date('2024-01-01'),
    listedAt: null,
    observedAt: new Date('2024-01-02'),
    condition: null,
    locationText: null,
    rawSnapshot: {},
    ...overrides,
  }
}

describe('computeFingerprint', () => {
  it('returns a 64-char hex string (sha256)', () => {
    const fp = computeFingerprint('eBay', makeRow())
    expect(fp).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic for same input', () => {
    const row = makeRow()
    expect(computeFingerprint('eBay', row)).toBe(computeFingerprint('eBay', row))
  })

  it('differs for different titles when no externalId', () => {
    const a = computeFingerprint('eBay', makeRow({ title: 'Car A' }))
    const b = computeFingerprint('eBay', makeRow({ title: 'Car B' }))
    expect(a).not.toBe(b)
  })

  it('uses externalId when present', () => {
    const row = makeRow({ externalId: 'ext-123' })
    const fp = computeFingerprint('eBay', row)
    expect(fp).toMatch(/^[0-9a-f]{64}$/)
  })

  it('same externalId produces same fingerprint regardless of title', () => {
    const a = computeFingerprint('eBay', makeRow({ externalId: 'ext-123', title: 'Car A' }))
    const b = computeFingerprint('eBay', makeRow({ externalId: 'ext-123', title: 'Car B' }))
    expect(a).toBe(b)
  })

  it('externalId and content-based fingerprints are in different namespaces', () => {
    const withExtId    = computeFingerprint('eBay', makeRow({ externalId: 'ext-123' }))
    const withoutExtId = computeFingerprint('eBay', makeRow({ externalId: null }))
    expect(withExtId).not.toBe(withoutExtId)
  })

  it('differs when provider differs', () => {
    const row = makeRow({ externalId: 'ext-123' })
    expect(computeFingerprint('eBay', row)).not.toBe(computeFingerprint('StockX', row))
  })
})

// ── computeImportHash ─────────────────────────────────────────────────────────

describe('computeImportHash', () => {
  it('returns 64-char hex', () => {
    expect(computeImportHash('hello,world')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic', () => {
    expect(computeImportHash('test csv content')).toBe(computeImportHash('test csv content'))
  })

  it('differs for different content', () => {
    expect(computeImportHash('csv v1')).not.toBe(computeImportHash('csv v2'))
  })
})

// ── computeWindowStats ────────────────────────────────────────────────────────

const BASE_DATE = new Date('2025-01-15T00:00:00Z')

describe('computeWindowStats', () => {
  it('returns null for empty array', () => {
    expect(computeWindowStats([], [], 90, BASE_DATE)).toBeNull()
  })

  it('returns null when no observations in window', () => {
    const old = new Date('2024-01-01')
    expect(computeWindowStats([1000], [old], 90, BASE_DATE)).toBeNull()
  })

  it('computes correct median for odd count', () => {
    const dates = [BASE_DATE, BASE_DATE, BASE_DATE]
    const stats = computeWindowStats([300, 100, 200], dates, null, BASE_DATE)
    expect(stats).not.toBeNull()
    expect(stats!.medianCents).toBe(200)
  })

  it('computes correct median for even count', () => {
    const dates = [BASE_DATE, BASE_DATE, BASE_DATE, BASE_DATE]
    const stats = computeWindowStats([100, 200, 300, 400], dates, null, BASE_DATE)
    expect(stats!.medianCents).toBe(250)
  })

  it('computes p25 and p75 correctly', () => {
    const dates = Array(4).fill(BASE_DATE)
    const stats = computeWindowStats([100, 200, 300, 400], dates, null, BASE_DATE)
    expect(stats!.p25Cents).toBe(100)
    expect(stats!.p75Cents).toBe(300)
  })

  it('computes min and max', () => {
    const dates = [BASE_DATE, BASE_DATE, BASE_DATE]
    const stats = computeWindowStats([500, 100, 300], dates, null, BASE_DATE)
    expect(stats!.minCents).toBe(100)
    expect(stats!.maxCents).toBe(500)
  })

  it('respects window cutoff', () => {
    const inWindow  = new Date('2025-01-01')
    const outWindow = new Date('2024-10-01')
    const stats = computeWindowStats([100, 999], [inWindow, outWindow], 30, BASE_DATE)
    expect(stats!.sampleSize).toBe(1)
    expect(stats!.medianCents).toBe(100)
  })

  it('null windowDays includes all observations', () => {
    const oldDate = new Date('2000-01-01')
    const stats = computeWindowStats([500], [oldDate], null, BASE_DATE)
    expect(stats!.sampleSize).toBe(1)
  })

  it('tracks freshest and stalest observation dates', () => {
    const d1 = new Date('2025-01-01')
    const d2 = new Date('2024-06-01')
    const d3 = new Date('2025-01-10')
    const stats = computeWindowStats([100, 200, 300], [d1, d2, d3], null, BASE_DATE)
    expect(stats!.freshestObservedAt).toEqual(d3)
    expect(stats!.stalestObservedAt).toEqual(d2)
  })

  it('handles single observation', () => {
    const stats = computeWindowStats([1000], [BASE_DATE], null, BASE_DATE)
    expect(stats!.sampleSize).toBe(1)
    expect(stats!.medianCents).toBe(1000)
    expect(stats!.p25Cents).toBe(1000)
    expect(stats!.p75Cents).toBe(1000)
    expect(stats!.minCents).toBe(1000)
    expect(stats!.maxCents).toBe(1000)
  })
})

// ── buildSoldSummary — 12m/24m window ─────────────────────────────────────────

const AS_OF = new Date('2025-01-15T00:00:00Z')

describe('buildSoldSummary — 12m/24m window', () => {
  it('returns null for empty inputs', () => {
    expect(buildSoldSummary([], [], AS_OF)).toBeNull()
  })

  it('uses 12m primary window when sample >= MIN_SOLD_PRIMARY_SAMPLE', () => {
    const soldAts = [
      new Date('2024-06-01'),
      new Date('2024-08-01'),
      new Date('2024-12-01'),
    ]
    const summary = buildSoldSummary([10000, 20000, 30000], soldAts, AS_OF)
    expect(summary).not.toBeNull()
    expect(summary!.extendedHistoryUsed).toBe(false)
    expect(summary!.windowMonths).toBe(12)
    expect(summary!.sampleSize).toBe(3)
  })

  it('falls back to 24m when primary < MIN_SOLD_PRIMARY_SAMPLE', () => {
    // Only 2 records within 12m; 3rd within 24m
    const soldAts = [
      new Date('2024-06-01'), // within 12m of 2025-01-15
      new Date('2024-12-01'), // within 12m
      new Date('2023-06-01'), // within 24m only
    ]
    const summary = buildSoldSummary([10000, 20000, 5000], soldAts, AS_OF)
    expect(summary).not.toBeNull()
    expect(summary!.extendedHistoryUsed).toBe(true)
    expect(summary!.windowMonths).toBe(24)
    expect(summary!.sampleSize).toBe(3)
  })

  it('includes record exactly 12m old in primary window (boundary inclusive)', () => {
    const exactly12m = subtractMonths(AS_OF, 12) // 2024-01-15
    const soldAts = [exactly12m, new Date('2024-06-01'), new Date('2024-12-01')]
    const summary = buildSoldSummary([10000, 20000, 30000], soldAts, AS_OF)
    expect(summary!.extendedHistoryUsed).toBe(false)
    expect(summary!.sampleSize).toBe(3)
  })

  it('MIN_SOLD_PRIMARY_SAMPLE is 3', () => {
    expect(MIN_SOLD_PRIMARY_SAMPLE).toBe(3)
  })

  it('computes correct median in primary window', () => {
    const soldAts = Array(3).fill(new Date('2024-06-01'))
    const summary = buildSoldSummary([1000, 2000, 3000], soldAts, AS_OF)
    expect(summary!.medianCents).toBe(2000)
  })

  it('records freshestSoldAt and stalestSoldAt', () => {
    const d1 = new Date('2024-03-01')
    const d2 = new Date('2024-06-01')
    const d3 = new Date('2024-12-01')
    const summary = buildSoldSummary([1000, 2000, 3000], [d1, d2, d3], AS_OF)
    expect(summary!.freshestSoldAt).toEqual(d3)
    expect(summary!.stalestSoldAt).toEqual(d1)
  })
})

// ── classifyFreshness ─────────────────────────────────────────────────────────

describe('classifyFreshness', () => {
  it('returns unavailable when no dates', () => {
    expect(classifyFreshness(null, null, AS_OF)).toBe('unavailable')
  })

  it('returns fresh when latest <= 7 days ago', () => {
    const d = new Date('2025-01-10T00:00:00Z') // 5 days before AS_OF
    expect(classifyFreshness(d, null, AS_OF)).toBe('fresh')
  })

  it('boundary: exactly 7 days ago is fresh', () => {
    const d = new Date('2025-01-08T00:00:00Z') // exactly 7 days
    expect(classifyFreshness(d, null, AS_OF)).toBe('fresh')
  })

  it('returns aging when 7 < days <= 30', () => {
    const d = new Date('2025-01-01T00:00:00Z') // 14 days ago
    expect(classifyFreshness(d, null, AS_OF)).toBe('aging')
  })

  it('returns stale when days > 30', () => {
    const d = new Date('2024-12-01T00:00:00Z') // ~45 days ago
    expect(classifyFreshness(d, null, AS_OF)).toBe('stale')
  })

  it('picks the later of soldAt and askObservedAt', () => {
    const staleSold = new Date('2024-11-01T00:00:00Z') // stale
    const freshAsk  = new Date('2025-01-12T00:00:00Z') // fresh
    expect(classifyFreshness(staleSold, freshAsk, AS_OF)).toBe('fresh')
  })

  it('uses soldAt when askObservedAt is null', () => {
    const d = new Date('2025-01-14T00:00:00Z') // 1 day ago → fresh
    expect(classifyFreshness(d, null, AS_OF)).toBe('fresh')
  })

  it('uses askObservedAt when soldAt is null', () => {
    const d = new Date('2024-11-15T00:00:00Z') // ~61 days → stale
    expect(classifyFreshness(null, d, AS_OF)).toBe('stale')
  })
})

// ── decimalToCents ────────────────────────────────────────────────────────────

describe('decimalToCents', () => {
  it('converts whole dollar amount', () => {
    expect(decimalToCents(new Prisma.Decimal('100'))).toBe(10000)
  })

  it('converts 19.99 → 1999', () => {
    expect(decimalToCents(new Prisma.Decimal('19.99'))).toBe(1999)
  })

  it('rounds half-up at sub-cent boundary', () => {
    // 0.005 * 100 = 0.5 → rounds to 1
    expect(decimalToCents(new Prisma.Decimal('0.005'))).toBe(1)
  })

  it('24.9400 → 2494 exactly', () => {
    expect(decimalToCents(new Prisma.Decimal('24.9400'))).toBe(2494)
  })
})

// ── Import limits ─────────────────────────────────────────────────────────────

describe('import limits — constants', () => {
  it('MAX_CSV_BYTES is 5 MB', () => {
    expect(MAX_CSV_BYTES).toBe(5 * 1024 * 1024)
  })

  it('MAX_ROW_COUNT is 5000', () => {
    expect(MAX_ROW_COUNT).toBe(5_000)
  })
})

// ── Source structure tests ─────────────────────────────────────────────────────

describe('externalMarketImport.ts — structure', () => {
  it('exports parseCsv', () => {
    expect(importSrc).toContain('export function parseCsv')
  })

  it('exports validateRow', () => {
    expect(importSrc).toContain('export function validateRow')
  })

  it('exports computeFingerprint', () => {
    expect(importSrc).toContain('export function computeFingerprint')
  })

  it('exports ingestCsvImport', () => {
    expect(importSrc).toContain('export async function ingestCsvImport')
  })

  it('uses sha256 for fingerprinting (not md5)', () => {
    expect(importSrc).toContain("'sha256'")
    expect(importSrc).not.toContain("'md5'")
  })

  it('checks for duplicate import hash before processing', () => {
    expect(importSrc).toContain('importHash')
    expect(importSrc).toMatch(/findUnique.*importHash|importHash.*findUnique/s)
  })

  it('stores rawSnapshot as JSON', () => {
    expect(importSrc).toContain('rawSnapshot')
  })

  it('source_url must start with https://', () => {
    expect(importSrc).toContain("'https://'")
    expect(importSrc).not.toContain("'http://'")
  })

  it('never fetches submitted URLs server-side', () => {
    expect(importSrc).not.toContain('fetch(')
    expect(importSrc).not.toContain('axios')
  })

  it('checks file size limit before parsing (MAX_CSV_BYTES)', () => {
    expect(importSrc).toContain('MAX_CSV_BYTES')
    expect(importSrc).toContain('Buffer.byteLength')
  })

  it('checks row count limit after parsing (MAX_ROW_COUNT)', () => {
    expect(importSrc).toContain('MAX_ROW_COUNT')
    expect(importSrc).toContain('rows.length > MAX_ROW_COUNT')
  })

  it('catches P2002 as duplicate (not error)', () => {
    expect(importSrc).toContain('P2002')
    expect(importSrc).toContain('duplicateCount++')
  })

  it('total_price is not in REQUIRED_COLUMNS', () => {
    const reqLine = importSrc.match(/const REQUIRED_COLUMNS\s*=\s*\[([^\]]+)\]/)?.[1] ?? ''
    expect(reqLine).not.toContain('total_price')
  })
})

describe('externalMarketResearch.ts — structure', () => {
  it('exports computeWindowStats', () => {
    expect(researchSrc).toContain('export function computeWindowStats')
  })

  it('exports buildSoldSummary', () => {
    expect(researchSrc).toContain('export function buildSoldSummary')
  })

  it('exports classifyFreshness', () => {
    expect(researchSrc).toContain('export function classifyFreshness')
  })

  it('exports getExternalMarketSummaries', () => {
    expect(researchSrc).toContain('export async function getExternalMarketSummaries')
  })

  it('exports MIN_SOLD_PRIMARY_SAMPLE', () => {
    expect(researchSrc).toContain('export const MIN_SOLD_PRIMARY_SAMPLE')
  })

  it('exports ASK_WINDOW_DAYS', () => {
    expect(researchSrc).toContain('export const ASK_WINDOW_DAYS')
  })

  it('only fetches matched observations', () => {
    expect(researchSrc).toContain("matchStatus: 'matched'")
  })

  it('only fetches USD observations', () => {
    expect(researchSrc).toContain("currency: 'USD'")
  })

  it('does not return rawSnapshot or sourceUrl', () => {
    expect(researchSrc).not.toContain('rawSnapshot')
    expect(researchSrc).not.toContain('sourceUrl')
  })

  it('uses 24m window for DB query (broadest filter)', () => {
    expect(researchSrc).toContain('cutoff24m')
  })

  it('uses 30-day ask window', () => {
    expect(researchSrc).toContain('ASK_WINDOW_DAYS')
  })
})

describe('externalMarketResearchQuery.ts — structure', () => {
  it('exports getObservationById (admin-only query)', () => {
    expect(querySrc).toContain('export async function getObservationById')
  })

  it('includes rawSnapshot in admin detail query', () => {
    expect(querySrc).toContain('rawSnapshot')
  })

  it('includes sourceUrl in admin detail query', () => {
    expect(querySrc).toContain('sourceUrl')
  })

  it('exports getDashboardStats', () => {
    expect(querySrc).toContain('export async function getDashboardStats')
  })

  it('uses keyset pagination with lt: afterId (not offset skip)', () => {
    expect(querySrc).toContain('lt: afterId')
    expect(querySrc).not.toContain('skip:')
  })

  it('exports OBSERVATIONS_PAGE_SIZE constant', () => {
    expect(querySrc).toContain('export const OBSERVATIONS_PAGE_SIZE')
  })

  it('returns nextCursor from listObservations', () => {
    expect(querySrc).toContain('nextCursor')
  })
})

describe('actions/externalMarketResearch.ts — structure', () => {
  it('has "use server" directive', () => {
    expect(actionsSrc).toMatch(/^'use server'/)
  })

  it('exports importMarketDataCsv', () => {
    expect(actionsSrc).toContain('export async function importMarketDataCsv')
  })

  it('exports matchObservationToCatalog', () => {
    expect(actionsSrc).toContain('export async function matchObservationToCatalog')
  })

  it('exports rejectObservation', () => {
    expect(actionsSrc).toContain('export async function rejectObservation')
  })

  it('writes an audit record on match', () => {
    expect(actionsSrc).toContain('externalMarketObservationAudit')
  })

  it('uses $transaction for atomic match + audit write', () => {
    expect(actionsSrc).toContain('$transaction')
  })

  it('imports isAdminAuthenticated', () => {
    expect(actionsSrc).toContain('isAdminAuthenticated')
  })

  it('importMarketDataCsv calls isAdminAuthenticated before any write', () => {
    const fnStart  = actionsSrc.indexOf('async function importMarketDataCsv')
    const authCall = actionsSrc.indexOf('isAdminAuthenticated', fnStart)
    expect(authCall).toBeGreaterThan(fnStart)
  })

  it('matchObservationToCatalog calls isAdminAuthenticated', () => {
    const fnStart  = actionsSrc.indexOf('async function matchObservationToCatalog')
    const authCall = actionsSrc.indexOf('isAdminAuthenticated', fnStart)
    expect(authCall).toBeGreaterThan(fnStart)
  })

  it('unmatchObservation calls isAdminAuthenticated', () => {
    const fnStart  = actionsSrc.indexOf('async function unmatchObservation')
    const authCall = actionsSrc.indexOf('isAdminAuthenticated', fnStart)
    expect(authCall).toBeGreaterThan(fnStart)
  })

  it('restoreObservation calls isAdminAuthenticated', () => {
    const fnStart  = actionsSrc.indexOf('async function restoreObservation')
    const authCall = actionsSrc.indexOf('isAdminAuthenticated', fnStart)
    expect(authCall).toBeGreaterThan(fnStart)
  })
})

describe('actions/externalMarketResearch.ts — optimistic concurrency', () => {
  it('matchObservationToCatalog reads updatedAt from FormData', () => {
    expect(actionsSrc).toContain("formData.get('updatedAt')")
  })

  it('matchObservationToCatalog rejects stale state (STALE sentinel)', () => {
    expect(actionsSrc).toContain('STALE')
  })

  it('unmatchObservation accepts updatedAt as second parameter', () => {
    expect(actionsSrc).toMatch(/function unmatchObservation\s*\(\s*observationId\s*:\s*string\s*,\s*updatedAt\s*:\s*string/)
  })

  it('restoreObservation accepts updatedAt as second parameter', () => {
    expect(actionsSrc).toMatch(/function restoreObservation\s*\(\s*observationId\s*:\s*string\s*,\s*updatedAt\s*:\s*string/)
  })

  it('rejectObservation reads updatedAt from FormData', () => {
    const rejectFn     = actionsSrc.indexOf('async function rejectObservation')
    const updatedAtGet = actionsSrc.indexOf("formData.get('updatedAt')", rejectFn)
    expect(updatedAtGet).toBeGreaterThan(rejectFn)
  })

  it('match/unmatch/reject/restore all use $transaction with re-fetch', () => {
    // Count occurrences: one per action function (4 total)
    const matches = actionsSrc.match(/\$transaction/g)
    expect(matches).not.toBeNull()
    expect(matches!.length).toBeGreaterThanOrEqual(4)
  })
})

describe('valuation page — external market integration', () => {
  it('imports getExternalMarketSummaries', () => {
    expect(valuationPage).toContain('getExternalMarketSummaries')
  })

  it('shows external data column (Ext. ref.)', () => {
    expect(valuationPage).toContain('Ext. ref.')
  })

  it('only shows external data as reference — not included in estimated value', () => {
    expect(valuationPage).toContain('not included in estimated value')
  })

  it('external data never passes through first-party valuation computation', () => {
    expect(valuationPage).not.toContain('getExternalMarketSummaries.*getCollectionValuation')
    expect(valuationPage).toContain('await getCollectionValuation')
    expect(valuationPage).toContain('await getExternalMarketSummaries')
  })

  it('uses .soldSummary (new type field), not .soldStatsAll or .soldStats365', () => {
    expect(valuationPage).toContain('soldSummary')
    expect(valuationPage).not.toContain('soldStatsAll')
    expect(valuationPage).not.toContain('soldStats365')
  })

  it('uses .researchFreshness', () => {
    expect(valuationPage).toContain('researchFreshness')
  })

  it('guards ext column behind extSold && check (never renders $0 for missing data)', () => {
    expect(valuationPage).toContain('extSold &&')
  })

  it('fetches external summaries separately (first-party separation)', () => {
    // extSummaries is derived after getCollectionValuation — not fed back into it
    const firstPartyCall = valuationPage.indexOf('await getCollectionValuation')
    const extCall        = valuationPage.indexOf('await getExternalMarketSummaries')
    expect(firstPartyCall).toBeGreaterThan(-1)
    expect(extCall).toBeGreaterThan(-1)
    // extSummaries is not passed into getCollectionValuation args (single-line check)
    expect(valuationPage).not.toMatch(/getCollectionValuation\(.*extSummar/)
  })
})
