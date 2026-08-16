// 15K: cross-cutting structural safety checks — proves the SOURCE never contains the
// prohibited surface area. Behavioral correctness is covered in autoListing.test.ts /
// autoListingExecution.test.ts / listingActivation.test.ts.
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relPath), 'utf-8')
}

const policySrc = readSrc('src/lib/autoListingPolicy.ts')
const pureSrc = readSrc('src/lib/autoListing.ts')
const execSrc = readSrc('src/lib/autoListingExecution.ts')
const policyQuerySrc = readSrc('src/lib/autoListingPolicyQuery.ts')
const listingActivationSrc = readSrc('src/lib/listingActivation.ts')
const actionSrc = readSrc('src/lib/actions/autoListing.ts')
const policyActionSrc = readSrc('src/lib/actions/autoListingPolicy.ts')
const pageSrc = readSrc('src/app/(admin)/admin/auto-listing/page.tsx')
const runPanelSrc = readSrc('src/components/admin/AutoListingRunPanel.tsx')

describe('Part T — no auto-approval, ever', () => {
  it('the pure decision module has zero DB access and zero risk-approval surface', () => {
    expect(pureSrc).not.toMatch(/prisma\./)
    expect(pureSrc).not.toMatch(/checkRiskGate|consumeApprovedRiskGate|markApprovalConsumed|RiskApprovalRequest/)
  })

  it('the execution engine NEVER imports or calls checkRiskGate/consumeApprovedRiskGate/markApprovalConsumed — it only uses the PURE evaluateRiskPolicy + getEffectiveRiskPolicy', () => {
    // Checks actual invocation/import syntax, not the explanatory prose in this
    // file's own header comment (which names these functions specifically to
    // document that they are avoided).
    expect(execSrc).not.toMatch(/checkRiskGate\(|consumeApprovedRiskGate\(|markApprovalConsumed\(/)
    expect(execSrc).not.toMatch(/from '@\/lib\/actions\/riskApprovals'/)
    expect(execSrc).toContain('evaluateRiskPolicy(')
    expect(execSrc).toContain('getEffectiveRiskPolicy(')
  })

  it('the execution engine never creates, approves, or updates a RiskApprovalRequest', () => {
    expect(execSrc).not.toMatch(/riskApprovalRequest\.(create|update|updateMany)/)
  })

  it('the admin actions layer for auto-listing never touches RiskApprovalRequest', () => {
    for (const src of [actionSrc, policyActionSrc]) {
      expect(src).not.toMatch(/RiskApprovalRequest|checkRiskGate|consumeApprovedRiskGate/)
    }
  })
})

describe('Part G — one authoritative listing-creation boundary', () => {
  it('the execution engine never calls tx.listing.create / prisma.listing.create directly — only createListingAtomic', () => {
    expect(execSrc).not.toMatch(/\.listing\.create\(/)
    expect(execSrc).toContain('createListingAtomic(tx')
  })

  it('createListingAtomic is the only tx.listing.create call site in listingActivation.ts', () => {
    expect([...listingActivationSrc.matchAll(/\.listing\.create\(/g)]).toHaveLength(1)
  })
})

describe('Part U — auto-listing may only write Listing/AutoListingRun/AutoListingAttempt (+ existing risk reads)', () => {
  const PROHIBITED_WRITES = [
    /sellerAgreement\.(create|update|updateMany|delete)\(/,
    /sellerPortfolio\.(create|update|updateMany|delete)\(/,
    /sellerPayout\w*\.(create|update|updateMany|delete)\(/,
    /order\.(create|update|updateMany|delete)\(/,
    /orderItem\.(create|update|updateMany|delete)\(/,
    /intakeDraft\.(create|update|updateMany|delete)\(/,
    /catalogModel\.(create|update|updateMany|delete)\(/,
    /storageLocation\.(create|update|updateMany|delete)\(/,
  ]

  it('the execution engine never mutates commercial/lineage/catalog/storage state', () => {
    for (const re of PROHIBITED_WRITES) expect(execSrc).not.toMatch(re)
  })

  it('the execution engine never writes ItemInstance — the row lock is read-only (SELECT ... FOR UPDATE), never itemInstance.update/create', () => {
    expect(execSrc).not.toMatch(/itemInstance\.(create|update|updateMany|delete)\(/)
    expect(execSrc).toMatch(/SELECT id FROM "ItemInstance" WHERE id = \$\{itemId\} FOR UPDATE/)
  })

  it('policy config mutation is confined to actions/autoListingPolicy.ts — the execution/query modules never write AutoListingPolicyConfig', () => {
    expect(execSrc).not.toMatch(/autoListingPolicyConfig\.(create|update|updateMany|delete)\(/)
    expect(policyQuerySrc).not.toMatch(/autoListingPolicyConfig\.(create|update|updateMany|delete)\(/)
  })

  it('policy publishing never mutates an existing version row — always a new create, never update', () => {
    expect(policyActionSrc).not.toMatch(/autoListingPolicyConfig\.(update|updateMany|delete)\(/)
    expect(policyActionSrc).toContain('autoListingPolicyConfig.create')
  })
})

describe('Part T/section 61 — no client-supplied risk/pricing bypass', () => {
  it('the run action takes only a cursor from the client — no price, confidence, range, or risk decision parameter', () => {
    const fnSrc = actionSrc.slice(actionSrc.indexOf('export async function runAutoListingBatchAction'))
    const signature = fnSrc.slice(0, fnSrc.indexOf(')') + 1)
    expect(signature).not.toMatch(/price|confidence|decision|risk/i)
  })

  it('per-item execution rebuilds the risk context server-side via buildListingActivationContext (now pure — no DB access of its own) — never accepts a caller-supplied ListingActivationContext', () => {
    expect(execSrc).toContain('buildListingActivationContext(')
    expect(execSrc).not.toMatch(/await buildListingActivationContext\(/) // no longer async — see listingActivation.ts
  })

  it('pricing is always re-fetched fresh via getPricingIntelligence INSIDE the SERIALIZABLE transaction, using that transaction\'s own client — never the plain global prisma client, never taken from the 15J preview outcome\'s reduced pricing summary (Part 1 execution-snapshot fix)', () => {
    const fnStart = execSrc.indexOf('async function processAutoListCandidate')
    const fnSrc = execSrc.slice(fnStart)
    expect(fnSrc).toContain('await getPricingIntelligence(item.catalogId, asOf, tx)')
    expect(fnSrc).toContain('Prisma.TransactionIsolationLevel.Serializable')
  })
})

describe('Part H — no scheduler, no listing from page load', () => {
  it('no cron/scheduler reference exists anywhere in the auto-listing module set', () => {
    for (const src of [pureSrc, execSrc, actionSrc, policyActionSrc, policySrc, policyQuerySrc]) {
      expect(src).not.toMatch(/node-cron|setInterval|setTimeout\(.*cron|CronJob|\/api\/cron/i)
    }
  })

  it('the auto-listing admin PAGE (server component) never calls runAutoListingBatch — only the client run panel does, via an explicit button click', () => {
    expect(pageSrc).not.toContain('runAutoListingBatch')
    expect(pageSrc).not.toMatch(/<form[^>]*action=\{?runAutoListingBatchAction/)
    expect(runPanelSrc).toContain('onClick')
    expect(runPanelSrc).toContain('runAutoListingBatchAction')
  })

  it('the preview action is separate from the run action — previewing never creates a run or a listing', () => {
    const previewFnSrc = execSrc.slice(execSrc.indexOf('export async function previewAutoListingCandidates'), execSrc.indexOf('export async function previewAutoListingCandidates') + 600)
    expect(previewFnSrc).not.toContain('autoListingRun.create')
    expect(previewFnSrc).not.toContain('createListingAtomic')
  })
})

describe('Part Y section 60/61 — buyer PII / N+1', () => {
  it('no buyer PII field appears in the execution engine or its persisted snapshots', () => {
    expect(execSrc).not.toMatch(/buyerEmail|buyerName|buyerPhone|customerProfile\.email/)
  })

  it('candidate discovery + per-item pricing/risk stay a fixed number of queries per item — no full-table scan construct', () => {
    expect(execSrc).not.toMatch(/findMany\(\{\s*\}\)/) // an unfiltered findMany would be a full-table read
  })
})

describe('Part V/section 45-46 — nav / inventory hub integration', () => {
  it('Auto-Listing appears under the Inventory nav group, not a new top-level domain', () => {
    const navSrc = readSrc('src/components/admin/AdminNav.tsx')
    const inventoryGroup = navSrc.slice(navSrc.indexOf("key: 'inventory'"), navSrc.indexOf("key: 'sellers'"))
    expect(inventoryGroup).toContain("label: 'Auto-Listing'")
  })

  it('the inventory hub shows Enabled/Disabled status and links to /admin/auto-listing, and its review count comes from the ONE shared authoritative predicate — never a raw historical outcome count', () => {
    const hubSrc = readSrc('src/app/(admin)/admin/inventory/page.tsx')
    expect(hubSrc).toContain('/admin/auto-listing')
    expect(hubSrc).toContain('getNeedsManualReviewCount')
    expect(hubSrc).not.toMatch(/autoListingAttempt\.count/)
  })

  it('the review predicate is defined exactly once (autoListingReview.ts) and reused by BOTH the review list page and the inventory hub count — never reimplemented', () => {
    const pageSrcLocal = readSrc('src/app/(admin)/admin/auto-listing/page.tsx')
    const hubSrc = readSrc('src/app/(admin)/admin/inventory/page.tsx')
    expect(pageSrcLocal).toMatch(/from '@\/lib\/autoListingReview'/)
    expect(hubSrc).toMatch(/from '@\/lib\/autoListingReview'/)
    const reviewSrc = readSrc('src/lib/autoListingReview.ts')
    // One shared SQL fragment constant, referenced by both the count and list
    // queries — never a second, independently-written DISTINCT ON query.
    expect([...reviewSrc.matchAll(/const REVIEW_QUEUE_BASE/g)]).toHaveLength(1)
    expect([...reviewSrc.matchAll(/REVIEW_QUEUE_BASE/g)]).toHaveLength(4) // 1 definition + 2 uses + 1 doc-comment mention
  })

  it('the command center (/admin) is unchanged by 15K — no new card was added there', () => {
    const opsQuerySrc = readSrc('src/lib/adminOperationsQuery.ts')
    expect(opsQuerySrc).not.toMatch(/autoListing/i)
  })
})
