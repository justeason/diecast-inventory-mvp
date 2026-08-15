// 15J: cross-cutting structural safety checks — Part O (read-only), Part G (15F
// separation), Part N (no readiness-event history table), Part L/I (exact-count/
// fallback strategy on the 15H integration points). Behavioral correctness is
// covered in readyToList.test.ts / readyToListQuery.test.ts; this file proves the
// SOURCE never contains the prohibited surface area.
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relPath), 'utf-8')
}

const engineSrc = readSrc('src/lib/readyToList.ts')
const querySrc = readSrc('src/lib/readyToListQuery.ts')
const itemPageSrc = readSrc('src/app/(admin)/admin/items/[id]/page.tsx')
const itemsListSrc = readSrc('src/app/(admin)/admin/items/page.tsx')
const inventoryHubSrc = readSrc('src/app/(admin)/admin/inventory/page.tsx')
const adminOpsQuerySrc = readSrc('src/lib/adminOperationsQuery.ts')

describe('Part O — readiness evaluation is completely read-only', () => {
  it('the pure engine (readyToList.ts) contains no mutation calls at all', () => {
    expect(engineSrc).not.toMatch(/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/)
  })

  it('the query boundary (readyToListQuery.ts) contains no mutation calls', () => {
    expect(querySrc).not.toMatch(/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/)
  })

  it('no Listing/SellerAgreement/SellerPayout/RiskApprovalRequest/IntakeDraft write appears anywhere in either file', () => {
    for (const src of [engineSrc, querySrc]) {
      expect(src).not.toContain('listing.create')
      expect(src).not.toContain('listing.update')
      expect(src).not.toContain('sellerAgreement.update')
      expect(src).not.toMatch(/sellerPayout\w*\.(create|update|delete|upsert)/)
      expect(src).not.toContain('riskApprovalRequest.create')
      expect(src).not.toContain('intakeDraft.update')
    }
  })

  it('the item workspace readiness card issues no mutation of its own — every action is a Link to an existing authoritative page', () => {
    const cardStart = itemPageSrc.indexOf('function ReadyToListCard')
    const card = itemPageSrc.slice(cardStart)
    expect(card).not.toContain('useActionState')
    expect(card).not.toContain('<form')
    expect(card).not.toMatch(/\.(create|update|delete)\(/)
  })
})

describe('Part G — 15F separation', () => {
  it('the readiness engine never imports or calls checkRiskGate/consumeApprovedRiskGate', () => {
    for (const src of [engineSrc, querySrc]) {
      expect(src).not.toContain('checkRiskGate')
      expect(src).not.toContain('consumeApprovedRiskGate')
      expect(src).not.toContain('markApprovalConsumed')
    }
  })

  it('the readiness context type carries no risk/approval field — ready-ness cannot be defined in terms of an approval state', () => {
    expect(engineSrc).not.toMatch(/approvalRequestId|riskLevel|RiskDecision/)
  })

  it('15J never creates a RiskApprovalRequest — that stays exclusively 15F\'s (via the listing action), never this engine\'s', () => {
    expect(querySrc).not.toContain('riskApprovalRequest')
  })
})

describe('Part N — no readiness history/event table', () => {
  it('no "readiness evaluated" event or history write exists in either file', () => {
    for (const src of [engineSrc, querySrc]) {
      expect(src).not.toMatch(/readiness.*[Ee]vent/)
      expect(src).not.toContain('sellerLifecycleEvent.create')
    }
  })
})

describe('Part I/L — 15H integration: count-semantics correctness (focused-review section 1-4)', () => {
  it('there is no getReadyToListCount (or any other function) claiming to be an exact Ready-to-List total — that would require unbounded 14C evaluation', () => {
    expect(querySrc).not.toContain('getReadyToListCount')
    expect(querySrc).not.toMatch(/export async function \w*[Rr]eady\w*[Cc]ount/)
  })

  it('searchReadyToListPage never claims to be an aggregate total — it returns items + a resumable pagination cursor only', () => {
    const fnSrc = querySrc.slice(querySrc.indexOf('export async function searchReadyToListPage'))
    expect(fnSrc).toContain('nextCursor')
    expect(fnSrc).not.toMatch(/totalCount|grandTotal/)
  })

  it('no label anywhere in the command center or inventory hub pairs the word "Ready" with a plain DB count query — the only Ready/Review/Blocked entry points are links into searchReadyToListPage', () => {
    for (const src of [adminOpsQuerySrc, inventoryHubSrc]) {
      // The restored exact metric keeps its OWN honest name; nothing renames it to
      // "Ready to List" anywhere in these two files.
      expect(src).not.toMatch(/label="Ready to List"/)
      expect(src).not.toMatch(/label:\s*'Ready to List'/)
    }
  })

  it('the command center keeps "Available, Not Listed" under its original exact status=available/no-active-listing definition', () => {
    expect(adminOpsQuerySrc).toContain('availableNotListed')
    expect(adminOpsQuerySrc).toContain(`status: 'available'`)
    expect(adminOpsQuerySrc).toMatch(/listing:\s*\{\s*status:\s*\{\s*not:\s*'active'/)
  })

  it('the inventory hub restores the same exact "Available, Not Listed" DB-only count rather than a blockers-free (operationally-eligible) count', () => {
    expect(inventoryHubSrc).toContain('availableNotListedCount')
    expect(inventoryHubSrc).toContain(`status: 'available'`)
  })

  it('Ready/Review/Blocked appear in the inventory hub as links only, never as a rendered count/number', () => {
    const section = inventoryHubSrc.slice(inventoryHubSrc.indexOf('Listing Readiness'))
    // Every readiness link must go through Link (no StatCard, which renders a count).
    expect(section).not.toMatch(/StatCard label="Ready/)
    expect(section).not.toMatch(/StatCard label="Review/)
    expect(section).not.toMatch(/StatCard label="Blocked/)
  })
})

describe('15J composable-filters focused review — readiness is an additional filter dimension, not a second search mode', () => {
  it('readyToListQuery.ts imports and reuses buildSearchWhere from itemLifecycleQuery.ts rather than re-deriving q/status/condition/type semantics', () => {
    expect(querySrc).toContain("buildSearchWhere")
    expect(querySrc).toMatch(/from '@\/lib\/itemLifecycleQuery'/)
  })

  it('the ordinary predicate and the readiness candidate predicate are combined with an explicit AND array, never a shallow spread that could clobber one side', () => {
    const fnSrc = querySrc.slice(querySrc.indexOf('export async function searchReadyToListPage'))
    expect(fnSrc).toMatch(/AND:\s*\[\s*ordinaryWhere/)
    // A spread like `{ ...ordinaryWhere, status: 'available' }` would silently let
    // one status constraint clobber the other — that pattern must not reappear.
    expect(fnSrc).not.toMatch(/\.\.\.ordinaryWhere/)
  })

  it('the Items list page runs readiness and non-readiness branches through the SAME filter object — no second, drifted filter-collection path', () => {
    expect(itemsListSrc).toContain('const filter: ItemSearchFilter')
    expect(itemsListSrc).toMatch(/searchReadyToListPage\(readiness, filter, cursor\)/)
    expect(itemsListSrc).toMatch(/searchItemsPage\(filter, cursor\)/)
  })

  it('the Items list page never hides the ordinary filter bar behind "no readiness selected" — it renders unconditionally so filters and readiness are always combinable in the UI', () => {
    expect(itemsListSrc).not.toMatch(/\{!readiness &&[\s\S]{0,40}<ItemFilterBar/)
    expect(itemsListSrc).toContain('<ItemFilterBar')
  })

  it('readiness tab links and the ordinary filter form both carry the OTHER dimension forward — tabs reuse baseQs (ordinary filters), and the filter bar accepts a readiness prop to preserve it as a hidden field', () => {
    expect(itemsListSrc).toContain('new URLSearchParams(baseQs)')
    const filterBarSrc = readSrc('src/components/admin/ItemFilterBar.tsx')
    expect(filterBarSrc).toContain('readiness')
    expect(filterBarSrc).toMatch(/type="hidden"\s+name="readiness"/)
  })
})

describe('Part Q — performance: no per-row 14C in the items list', () => {
  it('the items list page never calls getPricingIntelligence directly (only readyToListQuery\'s batch path may)', () => {
    expect(itemsListSrc).not.toContain('getPricingIntelligence')
  })

  it('the bulk table component (client) never imports pricing intelligence', () => {
    const bulkTableSrc = readSrc('src/components/admin/ItemBulkTable.tsx')
    expect(bulkTableSrc).not.toContain('PricingIntelligence')
  })
})
