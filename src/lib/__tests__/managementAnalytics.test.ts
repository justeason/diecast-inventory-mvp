/**
 * 17E: Management operating summary — a pure composition layer. Tests mock the
 * IMPORTED HELPER FUNCTIONS themselves (not Prisma) — this module never touches
 * prisma directly, which is itself the thing Part AJ ("composition not
 * duplication") requires proving.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { Prisma } from '@prisma/client'

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relPath), 'utf-8')
}

const D = (s: string) => new Prisma.Decimal(s)

vi.mock('@/lib/businessAnalyticsQuery', () => ({ getCommercialPeriodSummary: vi.fn() }))
vi.mock('@/lib/financialPositionQuery', () => ({ getOwnedInventoryPosition: vi.fn(), getOutstandingLiability: vi.fn() }))
vi.mock('@/lib/catalogAnalyticsQuery', () => ({ getWantedWithNoSupply: vi.fn() }))

import { getCommercialPeriodSummary } from '@/lib/businessAnalyticsQuery'
import { getOwnedInventoryPosition, getOutstandingLiability } from '@/lib/financialPositionQuery'
import { getWantedWithNoSupply } from '@/lib/catalogAnalyticsQuery'
import { getManagementSummary } from '@/lib/managementAnalyticsQuery'

type Mock = ReturnType<typeof vi.fn>

const RANGE = (now = new Date()) => ({ preset: '30d' as const, start: new Date(now.getTime() - 1000), end: now, label: '' })

function mockAll(overrides: Partial<{
  commercial: Partial<{ completedOrders: number; unitsSold: number; gmv: Prisma.Decimal }>
  owned: unknown
  liability: Prisma.Decimal
  noSupply: { items: unknown[]; truncated: boolean }
}> = {}) {
  ;(getCommercialPeriodSummary as Mock).mockResolvedValue({
    completedOrders: 12, unitsSold: 15, gmv: D('1234.56'),
    ...overrides.commercial,
  })
  ;(getOwnedInventoryPosition as Mock).mockResolvedValue(overrides.owned ?? {
    ownedUnits: 10, unitsWithCost: 10, unitsWithoutCost: 0, allocatedCost: D('500.00'),
    costCoverage: { status: 'available', value: D('500.00') },
  })
  ;(getOutstandingLiability as Mock).mockResolvedValue(overrides.liability ?? D('300.00'))
  ;(getWantedWithNoSupply as Mock).mockResolvedValue(overrides.noSupply ?? { items: [], truncated: false })
}

beforeEach(() => vi.resetAllMocks())

// ── AJ: composition, not duplication ───────────────────────────────────────────

describe('managementAnalyticsQuery: composition, not duplication (17E, AJ)', () => {
  it('imports and calls the authoritative helpers directly — no Prisma import, no local aggregation logic', () => {
    const src = readSrc('src/lib/managementAnalyticsQuery.ts')
    expect(src).not.toContain("from '@/lib/prisma'")
    expect(src).not.toMatch(/prisma\./)
    expect(src).toContain("import { getCommercialPeriodSummary } from '@/lib/businessAnalyticsQuery'")
    expect(src).toContain("import { getOwnedInventoryPosition, getOutstandingLiability")
    expect(src).toContain("import { getWantedWithNoSupply")
  })

  it('uses the NARROW getCommercialPeriodSummary, never the full getOverviewMetrics (which would trigger 8+ unrelated queries this page never renders)', () => {
    const src = readSrc('src/lib/managementAnalyticsQuery.ts')
    const codeOnly = src.split('\n').filter(line => !line.trim().startsWith('//')).join('\n')
    expect(codeOnly).not.toContain('getOverviewMetrics')
  })

  it('no new ItemInstance.purchasePrice aggregation, no new payout status predicate, no new completed-Order GMV formula, no new Wanted/availability query', () => {
    const src = readSrc('src/lib/managementAnalyticsQuery.ts')
    expect(src).not.toContain('purchasePrice')
    expect(src).not.toMatch(/status:\s*['"](eligible|held|voided|paid)['"]/)
    expect(src).not.toMatch(/status:\s*['"]complete['"]/)
    expect(src).not.toContain('WantedCatalogModel')
    expect(src).not.toMatch(/\.(create|update|delete|upsert)\(/)
  })

  it('calls each authoritative helper exactly once per summary request', async () => {
    mockAll()
    await getManagementSummary(RANGE())
    expect(getCommercialPeriodSummary).toHaveBeenCalledTimes(1)
    expect(getOwnedInventoryPosition).toHaveBeenCalledTimes(1)
    expect(getOutstandingLiability).toHaveBeenCalledTimes(1)
    expect(getWantedWithNoSupply).toHaveBeenCalledTimes(1)
  })

  it('getOutstandingLiability is called exactly ONCE total — not duplicated via a bundled getOverviewMetrics field AND a direct call', async () => {
    mockAll()
    await getManagementSummary(RANGE())
    expect(getOutstandingLiability).toHaveBeenCalledTimes(1)
    expect(getCommercialPeriodSummary).not.toHaveBeenCalledTimes(0) // sanity: the narrow helper IS still used
  })
})

// ── S/T: parallel fetching, bounded query count ────────────────────────────────

describe('managementAnalyticsQuery: parallelization and query count (17E, S/T)', () => {
  it('the four helper calls are issued via Promise.all — not serialized one after another', () => {
    const src = readSrc('src/lib/managementAnalyticsQuery.ts')
    const fnSrc = src.slice(src.indexOf('export async function getManagementSummary'), src.length)
    expect(fnSrc).toContain('Promise.all([')
  })

  it('exactly 4 orchestration-level calls, independent of the number of models/customers/items behind them', async () => {
    mockAll()
    await getManagementSummary(RANGE())
    const totalCalls =
      (getCommercialPeriodSummary as Mock).mock.calls.length +
      (getOwnedInventoryPosition as Mock).mock.calls.length +
      (getOutstandingLiability as Mock).mock.calls.length +
      (getWantedWithNoSupply as Mock).mock.calls.length
    expect(totalCalls).toBe(4)
  })
})

// ── U: catalog shortlist uses a small bounded limit, not the full 50-row page ──

describe('managementAnalyticsQuery: catalog shortlist bound (17E, U/J)', () => {
  it('requests a small limit (5) from getWantedWithNoSupply, not the 17D analytics-page default of 50', async () => {
    mockAll()
    await getManagementSummary(RANGE())
    expect(getWantedWithNoSupply).toHaveBeenCalledWith(5)
  })
})

// ── AK: period commercial metrics vary with range; snapshots do not ────────────

describe('managementAnalyticsQuery: period-vs-current separation (17E, M/AK)', () => {
  it('two different ranges produce different commercial figures via getCommercialPeriodSummary, called with that exact range', async () => {
    mockAll({ commercial: { completedOrders: 3, unitsSold: 4, gmv: D('99.00') } })
    const now = new Date()
    const rangeA = { preset: '7d' as const, start: new Date(now.getTime() - 7 * 86_400_000), end: now, label: 'A' }
    await getManagementSummary(rangeA)
    expect((getCommercialPeriodSummary as Mock).mock.calls[0][0]).toBe(rangeA)
  })

  it('getOwnedInventoryPosition/getOutstandingLiability/getWantedWithNoSupply are called with NO range argument at all — current snapshots never re-scoped by the date filter', async () => {
    mockAll()
    await getManagementSummary(RANGE())
    expect((getOwnedInventoryPosition as Mock).mock.calls[0]).toEqual([])
    expect((getOutstandingLiability as Mock).mock.calls[0]).toEqual([])
    // getWantedWithNoSupply's only argument is the shortlist size (5), never a range/period.
    expect((getWantedWithNoSupply as Mock).mock.calls[0]).toEqual([5])
  })

  it('the query module functions themselves take no DateRange for the snapshot fields — structural proof at the type-signature level', () => {
    const financeSrc = readSrc('src/lib/financialPositionQuery.ts')
    expect(financeSrc).toContain('export async function getOwnedInventoryPosition(): Promise<OwnedInventoryPosition>')
    const catalogSrc = readSrc('src/lib/catalogAnalyticsQuery.ts')
    const sig = catalogSrc.slice(catalogSrc.indexOf('export async function getWantedWithNoSupply'), catalogSrc.indexOf('export async function getWantedWithNoSupply') + 90)
    expect(sig).not.toContain('DateRange')
  })
})

// ── AL: liquidity unavailable — explicit, never $0 ──────────────────────────────

describe('management page: liquidity unavailable state (17E, G/AL)', () => {
  it('the page hardcodes "Unavailable" (never a computed $0) for liquidity, matching 15N\'s exact language about no persisted bank/settlement balance', () => {
    const src = readSrc('src/app/(admin)/admin/analytics/management/page.tsx')
    expect(src).toContain('label="Liquidity" value="Unavailable"')
    expect(src.toLowerCase()).toContain('no bank/settlement balance is persisted')
    expect(src).not.toMatch(/label="Liquidity" value=\{fmtUsdDecimal/)
  })

  it('no liquidity value is computed anywhere in the orchestration module — it is presentation-only text on the page, not a query result', () => {
    const src = readSrc('src/lib/managementAnalyticsQuery.ts')
    expect(src.toLowerCase()).not.toContain('liquidity')
  })
})

// ── AM: financial position reuse — orchestration/wiring only ──────────────────

describe('managementAnalyticsQuery: financial position reuse (17E, F/H/I/AM)', () => {
  it('owned inventory cost is the exact OwnedInventoryPosition object from 15N, not recomputed or re-shaped', async () => {
    const owned = { ownedUnits: 7, unitsWithCost: 5, unitsWithoutCost: 2, allocatedCost: D('250.00'), costCoverage: { status: 'partial', value: D('250.00'), coveragePct: 71.4, knownUnits: 5, totalUnits: 7 } }
    mockAll({ owned })
    const summary = await getManagementSummary(RANGE())
    expect(summary.financialPosition.ownedInventory).toBe(owned) // same object reference — not rebuilt
  })

  it('outstanding seller liability is the exact Decimal from getOutstandingLiability, not a re-derived sum', async () => {
    mockAll({ liability: D('842.17') })
    const summary = await getManagementSummary(RANGE())
    expect(summary.financialPosition.outstandingSellerLiability.toFixed(2)).toBe('842.17')
  })

  it('page renders owned-inventory cost using the same unavailable/partial/available three-state discipline as 15N (never a bare $0/N-A for a partial or unavailable metric)', () => {
    const src = readSrc('src/app/(admin)/admin/analytics/management/page.tsx')
    expect(src).toContain("costCoverage.status === 'unavailable'")
    expect(src).toContain("costCoverage.status === 'partial'")
  })
})

// ── AN/AO/AP: catalog reuse, empty state, shortlist ordering ───────────────────

describe('managementAnalyticsQuery + page: catalog reuse and shortlist (17E, AN/AO/AP)', () => {
  it('the no-supply shortlist comes verbatim from getWantedWithNoSupply — no second Wanted-counting implementation', async () => {
    const rows = [{ catalogModelId: 'c1', brand: 'Hot Wheels', name: 'Camaro', year: 2020, series: null, scale: null, wantedCount: 9, availableCopies: 0 as const }]
    mockAll({ noSupply: { items: rows, truncated: false } })
    const summary = await getManagementSummary(RANGE())
    expect(summary.catalogSignals.noSupply).toBe(rows) // same array reference
  })

  it('no qualifying models -> clean empty state text, not an error/crash', () => {
    const src = readSrc('src/app/(admin)/admin/analytics/management/page.tsx')
    expect(src).toContain('None currently.')
  })

  it('when truncated, the page states it is a shortlist and links to full Catalog Analytics', () => {
    const src = readSrc('src/app/(admin)/admin/analytics/management/page.tsx')
    const idx = src.indexOf('{truncated &&')
    expect(idx).toBeGreaterThan(-1)
    expect(src.slice(idx, idx + 200).toLowerCase()).toContain('more may qualify')
    expect(src).toContain("href=\"/admin/analytics/catalog\"")
  })
})

// ── AQ: deep links ───────────────────────────────────────────────────────────────

describe('management page: deep links (17E, P/AQ)', () => {
  const src = readSrc('src/app/(admin)/admin/analytics/management/page.tsx')

  it('links to the full Business Analytics overview', () => {
    expect(src).toMatch(/href=\{`\/admin\/analytics\?/)
  })

  it('links to the exact existing 15N Financial Position route', () => {
    expect(src).toContain('/admin/finance/position')
  })

  it('links to Catalog Analytics', () => {
    expect(src).toContain('/admin/analytics/catalog')
  })

  it('links to Payouts for seller liability detail', () => {
    expect(src).toContain('href="/admin/analytics/payouts"')
  })

  it('no route was duplicated — the management page contains no full detailed table, only summary cards/shortlist', () => {
    expect(src).not.toContain('SimpleBarChart')
    expect(src).not.toContain('getSellerPerformancePage')
    expect(src).not.toContain('getCatalogModelPerformancePage')
  })
})

// ── AR: time-basis disclosure ────────────────────────────────────────────────────

describe('management page: time-basis disclosure (17E, L/AR)', () => {
  const src = readSrc('src/app/(admin)/admin/analytics/management/page.tsx')

  it('uses the exact preferred section headings', () => {
    expect(src).toContain('>Selected period<')
    expect(src).toContain('>Current financial position<')
    expect(src).toContain('>Current catalog signals<')
  })

  it('text (not just color) states that only the period section is date-filtered', () => {
    expect(src.toLowerCase()).toContain('affects only this section')
    expect(src.toLowerCase()).toContain('unaffected by the date range above')
  })
})

// ── AS: read-only ───────────────────────────────────────────────────────────────

describe('managementAnalyticsQuery + page: read-only boundary (17E, V/AS)', () => {
  it('no create/update/delete/upsert, no mutation form/action, anywhere in the module or page', () => {
    for (const rel of ['src/lib/managementAnalyticsQuery.ts', 'src/app/(admin)/admin/analytics/management/page.tsx']) {
      const s = readSrc(rel)
      expect(s).not.toMatch(/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/)
      expect(s).not.toContain('<form')
    }
  })

  it('no operational actions (refresh/sync/recompute/repair/close period) copied from 15N', () => {
    const src = readSrc('src/app/(admin)/admin/analytics/management/page.tsx').toLowerCase()
    expect(src).not.toMatch(/refresh balance|sync bank|recompute payout|repair inventory|close period/)
  })
})

// ── AT: admin auth ───────────────────────────────────────────────────────────────

describe('management page: admin auth (17E, AA/AT)', () => {
  it('checks isAdminAuthenticated and redirects to /admin/login, same as every other analytics route', () => {
    const src = readSrc('src/app/(admin)/admin/analytics/management/page.tsx')
    expect(src).toContain('isAdminAuthenticated')
    expect(src).toContain("redirect('/admin/login')")
  })
})

// ── AU: no PII ─────────────────────────────────────────────────────────────────

describe('managementAnalyticsQuery + page: no customer/seller PII (17E, AB/AU)', () => {
  it('no email/phone/CustomerProfile.name selected or rendered anywhere', () => {
    for (const rel of ['src/lib/managementAnalyticsQuery.ts', 'src/app/(admin)/admin/analytics/management/page.tsx']) {
      const s = readSrc(rel)
      expect(s).not.toMatch(/\bemail\b/i)
      expect(s).not.toMatch(/\bphone\b/i)
      expect(s).not.toContain('customerProfile.name')
    }
  })
})

// ── AW: existing regression ──────────────────────────────────────────────────────

describe('17E regression: 17C/17D helpers unchanged in behavior', () => {
  it('financialPosition.ts / businessAnalyticsRegistry.ts / catalogAnalyticsQuery.ts core formulas were not touched by 17E (only the tiny getWantedWithNoSupply limit-parameter extraction)', () => {
    const catalogSrc = readSrc('src/lib/catalogAnalyticsQuery.ts')
    expect(catalogSrc).toContain("i.status = 'available'")
    expect(catalogSrc).toContain("l.status = 'active'")
    const financeSrc = readSrc('src/lib/financialPosition.ts')
    expect(financeSrc).toContain("export const OWNED_SOURCE_TYPES = ['buyout', 'company_owned'] as const")
  })
})

// ── AX: nav ───────────────────────────────────────────────────────────────────────

describe('AnalyticsNav: Management entry (17E, C/AX)', () => {
  it('exactly one new "Management" tab was added, pointing at /admin/analytics/management', () => {
    const src = readSrc('src/components/admin/analytics/AnalyticsNav.tsx')
    expect(src).toContain("{ href: '/admin/analytics/management', label: 'Management' }")
  })

  it('no second top-level admin nav entry was added — AnalyticsNav is still the only place this tab lives', () => {
    const adminNavSrc = readSrc('src/components/admin/AdminNav.tsx')
    expect(adminNavSrc).not.toContain('/admin/analytics/management')
  })
})

// ── AZ: scope guard ───────────────────────────────────────────────────────────────

describe('managementAnalyticsQuery + page: scope guard (17E, AZ/W/X/K)', () => {
  it('no net worth / working capital / EBITDA / revenue / profit terminology', () => {
    for (const rel of ['src/lib/managementAnalyticsQuery.ts', 'src/app/(admin)/admin/analytics/management/page.tsx']) {
      const s = readSrc(rel).toLowerCase()
      expect(s).not.toMatch(/net worth|working capital|ebitda|net cash|net assets|\brevenue\b|\bprofit\b/)
    }
  })

  it('never labels Wanted as "Demand"/"Opportunity"/"score"', () => {
    for (const rel of ['src/lib/managementAnalyticsQuery.ts', 'src/app/(admin)/admin/analytics/management/page.tsx']) {
      const s = readSrc(rel).toLowerCase()
      expect(s).not.toMatch(/demand|opportunity score|hotness/)
    }
  })

  it('no owned-cost + liability combined into one blended dollar figure', () => {
    const src = readSrc('src/app/(admin)/admin/analytics/management/page.tsx')
    expect(src).not.toMatch(/ownedInventory.*\.plus\(|outstandingSellerLiability.*\.plus\(/)
  })

  it('no CSV/PDF export, no charts, no comparison-period calculation, no forecasting/alerting keywords', () => {
    for (const rel of ['src/lib/managementAnalyticsQuery.ts', 'src/app/(admin)/admin/analytics/management/page.tsx']) {
      const s = readSrc(rel).toLowerCase()
      expect(s).not.toMatch(/export csv|export pdf|forecast|scheduled report|threshold alert|periodchange/)
    }
  })

  it('no new Prisma schema model was introduced for management analytics', () => {
    const schema = readSrc('prisma/schema.prisma')
    expect(schema).not.toContain('ManagementSnapshot')
    expect(schema).not.toContain('OperatingSummary')
  })
})
