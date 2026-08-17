// 15N: cross-cutting structural safety checks — proves the SOURCE never contains
// the prohibited surface area. Behavioral correctness is covered in
// financialPosition.test.ts / financialPositionQuery.test.ts.
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relPath), 'utf-8')
}

const pureSrc = readSrc('src/lib/financialPosition.ts')
const querySrc = readSrc('src/lib/financialPositionQuery.ts')
const positionPageSrc = readSrc('src/app/(admin)/admin/finance/position/page.tsx')
const hubPageSrc = readSrc('src/app/(admin)/admin/finance/page.tsx')

const MUTATION_RE = /\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/

describe('Part Q — finance dashboards are fully read-only', () => {
  it('the pure definitions module has zero DB access and zero mutations', () => {
    expect(pureSrc).not.toMatch(/prisma\./)
    expect(pureSrc).not.toMatch(MUTATION_RE)
  })

  it('the query module contains no mutation call', () => {
    expect(querySrc).not.toMatch(MUTATION_RE)
  })

  it('neither finance page contains a mutation call, a <form>, or a server action import', () => {
    for (const src of [positionPageSrc, hubPageSrc]) {
      expect(src).not.toMatch(MUTATION_RE)
      expect(src).not.toMatch(/<form/)
      expect(src).not.toMatch(/from '@\/lib\/actions\//)
    }
  })

  it('no payout/listing/inventory/agreement/approval mutation helper is imported anywhere in this module set', () => {
    for (const src of [pureSrc, querySrc, positionPageSrc, hubPageSrc]) {
      expect(src).not.toMatch(/markPayoutPaid|createListingAtomic|createListing\(|setItemStorage|setItemCondition|setItemCatalog|approveRiskApprovalRequest|createRiskPolicyVersionAction|publishAutoListingPolicyVersionAction/)
    }
  })
})

describe('Part U — query performance: bounded aggregates only', () => {
  it('owned-inventory cost never loads full ItemInstance rows — count/aggregate only, no findMany for totals', () => {
    const fnSrc = querySrc.slice(querySrc.indexOf('export async function getOwnedInventoryPosition'), querySrc.indexOf('export async function getOwnedInventoryAging'))
    expect(fnSrc).not.toMatch(/itemInstance\.findMany/)
    expect(fnSrc).toMatch(/itemInstance\.count/)
    expect(fnSrc).toMatch(/itemInstance\.aggregate/)
  })

  it('no per-item 14C pricing call exists anywhere in this module set (Part D/10-11: global valuation is deliberately NOT computed synchronously)', () => {
    for (const src of [pureSrc, querySrc, positionPageSrc, hubPageSrc]) {
      expect(src).not.toMatch(/getPricingIntelligence\(|getPricingIntelligenceBatch\(/)
    }
  })

  it('no arbitrary row cap (take:200/500/1000-style) appears behind an authoritative total', () => {
    for (const src of [querySrc]) {
      expect(src).not.toMatch(/take:\s*(200|500|1000)\b/)
    }
  })

  it('focused-review (buyout-cost-semantics pass): getUnallocatedBuyoutCost and the SellerAgreement hydration that existed solely for it are both fully removed — no lingering agreement-total query behind any current-inventory-cost figure', () => {
    expect(querySrc).not.toMatch(/getUnallocatedBuyoutCost|UnallocatedBuyoutCost/)
    expect(querySrc).not.toMatch(/sellerAgreement\.findMany/)
    expect(querySrc).not.toContain('prisma.sellerAgreement')
  })

  it('no full multi-item buyout agreement total is ever summed into current owned-inventory cost — allocatedCost is derived exclusively from itemInstance.aggregate\'s purchasePrice sum', () => {
    const fnStart = querySrc.indexOf('export async function getOwnedInventoryPosition')
    const fnEnd = querySrc.indexOf('\n}', fnStart) + 2 // end of this function body only, excludes the trailing explanatory comment
    const fnSrc = querySrc.slice(fnStart, fnEnd)
    expect(fnSrc).not.toMatch(/agreedBuyoutAmount/)
    expect(fnSrc).toContain('_sum: { purchasePrice: true }')
  })
})

describe('Part Y — label discipline (no fake GAAP terms)', () => {
  it('neither page calls the dashboard a Balance Sheet, Income Statement, or Statement of Cash Flows', () => {
    for (const src of [positionPageSrc, hubPageSrc]) {
      expect(src).not.toMatch(/Balance Sheet|Income Statement|Statement of Cash Flows/)
    }
  })

  it('GMV is never relabeled Revenue, and gross spread/margin are never labeled profit', () => {
    for (const src of [positionPageSrc, hubPageSrc]) {
      expect(src).not.toMatch(/>Revenue</)
      expect(src).not.toMatch(/Net Profit|>Profit</)
    }
  })

  it('no fake cash/liquidity term appears as a computed value — only "Not available"', () => {
    expect(positionPageSrc).toContain('Not available')
    expect(positionPageSrc).not.toMatch(/Free Cash Flow|Net Cash Flow|>Cash Balance</)
  })

  it('focused-review (buyout-cost-semantics pass): "Unallocated batch acquisition cost" / "Total inventory cost" / "Total acquisition cost" never appear — removed rather than mislabeled', () => {
    for (const src of [positionPageSrc, hubPageSrc]) {
      expect(src).not.toMatch(/Unallocated batch acquisition cost|Total inventory cost|Total acquisition cost|Unallocated inventory cost/)
    }
  })
})

describe('Part 68 — no buyer PII', () => {
  it('no buyer PII field/select appears anywhere in the query module', () => {
    expect(querySrc).not.toMatch(/buyerEmail|buyerPhone|buyerName|customerProfile\.email|paymentReference/)
  })
})

describe('Part V/52-53 — hub/nav integration, no duplicate dashboard', () => {
  it('AdminNav lists Financial Position under the Finance group', () => {
    const navSrc = readSrc('src/components/admin/AdminNav.tsx')
    const financeGroup = navSrc.slice(navSrc.indexOf("key: 'finance'"), navSrc.indexOf("key: 'catalog'"))
    expect(financeGroup).toContain("label: 'Financial Position'")
    expect(financeGroup).toContain('/admin/finance/position')
  })

  it('the finance hub links to the position page rather than reimplementing owned-inventory/coverage logic itself', () => {
    expect(hubPageSrc).toContain('/admin/finance/position')
    expect(hubPageSrc).not.toMatch(/costCoverage|unitCoverageMetric|OWNED_SOURCE_TYPES/)
  })
})

describe('Part 4 — known-cost buyout margin behavior (focused-review)', () => {
  it('financialPositionQuery.ts never reimplements gross-margin/gross-spread logic — GMV/margin figures are re-exports of 14B\'s own getOverviewMetrics, not recomputed here', () => {
    expect(querySrc).toContain("export { getOutstandingLiability, getPayoutLiabilitySnapshot, getLiabilityAging, getOverviewMetrics, getPayoutFlow } from '@/lib/businessAnalyticsQuery'")
    expect(querySrc).not.toMatch(/grossMargin\s*=|grossSpread\s*=/)
    expect(querySrc).not.toContain('purchasePrice: item.price')
  })
})
