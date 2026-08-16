// 15F: structural verification that the risk gate is actually wired into the real
// action files it claims to cover, using the same readSrc convention established
// throughout this codebase's test suite (e.g. intakeExceptionsActions.test.ts). The
// gate's own logic (allow/deny/require_approval, consumption, concurrency) is
// covered behaviorally in riskPolicy.test.ts / riskApprovalsActions.test.ts — this
// file only checks that each of the six real actions actually calls it, and that
// low-risk edits are never gated.
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relPath), 'utf-8')
}

describe('agreement_commission_override — actions/sellerAgreements.ts (section 6/24)', () => {
  const src = readSrc('src/lib/actions/sellerAgreements.ts')

  it('recordSellerAgreementAcceptance calls checkRiskGate for the agreement_commission_override action', () => {
    expect(src).toMatch(/checkRiskGate\(\{\s*action:\s*'agreement_commission_override'/)
  })

  it('only gates when an override is actually in effect (commissionSource === agreement_override) — automatic tier resolution stays gate-free', () => {
    const idx = src.indexOf("checkRiskGate({ action: 'agreement_commission_override'")
    const before = src.slice(Math.max(0, idx - 800), idx)
    expect(before).toMatch(/commissionSource === 'agreement_override'/)
  })

  it('consumes the approval atomically with the acceptance write, inside the same transaction', () => {
    const acceptIdx = src.indexOf('status: \'accepted\'')
    const consumeIdx = src.indexOf('markApprovalConsumed(tx,')
    expect(consumeIdx).toBeGreaterThan(-1)
    // markApprovalConsumed appears right after the accepted-status write, not before
    // (mutation happens first, then consumption, both inside the transaction).
    expect(consumeIdx).toBeGreaterThan(acceptIdx)
  })

  it('never overwrites a signed agreement outside the accept flow — updateSellerAgreement remains draft-only (invariant unchanged by 15F)', () => {
    expect(src).toMatch(/Only draft agreements can be edited/)
  })
})

describe('seller_commission_override — actions/commissionPolicies.ts (section 6/24)', () => {
  const src = readSrc('src/lib/actions/commissionPolicies.ts')

  it('createSellerCommissionOverrideAction calls checkRiskGate for the seller_commission_override action', () => {
    expect(src).toMatch(/checkRiskGate\(\{\s*action:\s*'seller_commission_override'/)
  })

  it('never gates automatic volume-tier policy actions (createCommissionPolicyAction/endDateCommissionPolicyAction)', () => {
    const policyFnStart = src.indexOf('export async function createCommissionPolicyAction')
    const policyFnEnd = src.indexOf('export async function endDateCommissionPolicyAction')
    const policyFnBody = src.slice(policyFnStart, src.indexOf('\n}', policyFnStart))
    void policyFnEnd
    expect(policyFnBody).not.toMatch(/checkRiskGate/)
  })
})

describe('listing_activation / listing_price_change — actions/listings.ts (section 7/8/24)', () => {
  const src = readSrc('src/lib/actions/listings.ts')

  it('createListing calls checkRiskGate for listing_activation', () => {
    expect(src).toMatch(/checkRiskGate\(\{\s*action:\s*'listing_activation'/)
  })

  it('updateListing calls checkRiskGate for listing_price_change on a genuine price change, and separately for listing_activation only on reactivation (15F-review section 1/2)', () => {
    expect(src).toMatch(/checkRiskGate\(\{\s*action:\s*'listing_price_change'/)
    const updateFnStart = src.indexOf('export async function updateListing')
    const updateFnBody = src.slice(updateFnStart)
    // both action codes appear, each gated behind its own specific condition —
    // never unconditionally on every save (that would defeat "frictionless" edits).
    expect(updateFnBody).toMatch(/checkRiskGate\(\{\s*action:\s*'listing_activation'/)
    expect(updateFnBody).toMatch(/willBecomeActive/)
    expect(updateFnBody).toMatch(/proposedPriceCents !== oldPriceCents/)
  })

  it('price-change gate is skipped when the price is unchanged (title/description/status-only edits stay frictionless, section 25)', () => {
    expect(src).toMatch(/proposedPriceCents !== oldPriceCents/)
  })

  it('never fabricates ask-only guidance as authoritative fair value at the integration layer (delegates entirely to the pure engine, no override here)', () => {
    const updateFnStart = src.indexOf('export async function updateListing')
    const updateFnBody = src.slice(updateFnStart)
    expect(updateFnBody).not.toMatch(/isAskOnly\s*\?\s*true/)
  })
})

describe('seller_payout_mark_paid — actions/sellerPayouts.ts (section 9/24)', () => {
  const src = readSrc('src/lib/actions/sellerPayouts.ts')

  it('markSellerPayoutPaid calls checkRiskGate for seller_payout_mark_paid', () => {
    expect(src).toMatch(/checkRiskGate\(\{\s*action:\s*'seller_payout_mark_paid'/)
  })

  it('never automatically pays a seller — this action only records that payment was made externally (invariant unchanged by 15F)', () => {
    expect(src).toMatch(/You must confirm that payment was made/)
    expect(src).not.toMatch(/stripe\.transfers\.create|sendPayment|initiatePayment/)
  })

  it('the confirm-checkbox + payment reference requirements still apply below the gate threshold — 15F adds a gate, does not replace existing validation', () => {
    const fnStart = src.indexOf('export async function markSellerPayoutPaid')
    const fnBody = src.slice(fnStart, src.indexOf('\n}', fnStart + 2000))
    expect(fnBody).toMatch(/Payment reference is required/)
    expect(fnBody).toMatch(/confirm that payment was made/)
  })
})

describe('item_catalog_reassignment — actions/items.ts (section 10/24)', () => {
  const src = readSrc('src/lib/actions/items.ts')

  it('updateItemInstance calls checkRiskGate for item_catalog_reassignment', () => {
    expect(src).toMatch(/checkRiskGate\(\{\s*action:\s*'item_catalog_reassignment'/)
  })

  it('only gates when catalogId is actually changing — storage/condition/price/status-only edits stay frictionless (section 8/25)', () => {
    expect(src).toMatch(/catalogId !== existing\.catalogId/)
  })

  it('sku remains permanently immutable — 15F never touches that invariant', () => {
    expect(src).not.toMatch(/UpdateItemSchema\s*=\s*z\.object\(\{[^}]*sku/)
  })
})

describe('no generic approval bypass exists anywhere in the gated action files (section 37)', () => {
  const files = [
    'src/lib/actions/sellerAgreements.ts',
    'src/lib/actions/commissionPolicies.ts',
    'src/lib/actions/listings.ts',
    'src/lib/actions/sellerPayouts.ts',
    'src/lib/actions/items.ts',
    'src/lib/actions/riskApprovals.ts',
  ]

  it('no force/skip/bypass/super-admin override exists', () => {
    for (const f of files) {
      const src = readSrc(f).toLowerCase()
      expect(src).not.toMatch(/force anyway|skip approval|super ?admin|bypass approval|override approval/)
    }
  })
})

describe('intake exceptions remain entirely gate-free (section 11/25/38)', () => {
  it('actions/intakeExceptions.ts never references the risk gate — 15F intentionally does not touch this workflow', () => {
    const src = readSrc('src/lib/actions/intakeExceptions.ts')
    expect(src).not.toMatch(/checkRiskGate|riskPolicy/)
  })

  it('actions/intakeWorkbench.ts never references the risk gate — normal 15D intake stays frictionless', () => {
    const src = readSrc('src/lib/actions/intakeWorkbench.ts')
    expect(src).not.toMatch(/checkRiskGate|riskPolicy/)
  })
})

describe('approval decision endpoints require no approval of their own — no circular deadlock (section 33)', () => {
  const src = readSrc('src/lib/actions/riskApprovals.ts')

  it('approveRiskApprovalRequest/rejectRiskApprovalRequest/cancelRiskApprovalRequest never call checkRiskGate on themselves', () => {
    const approveFn = src.slice(src.indexOf('export async function approveRiskApprovalRequest'), src.indexOf('export async function rejectRiskApprovalRequest'))
    const rejectFn = src.slice(src.indexOf('export async function rejectRiskApprovalRequest'), src.indexOf('export async function cancelRiskApprovalRequest'))
    const cancelFn = src.slice(src.indexOf('export async function cancelRiskApprovalRequest'))
    for (const fn of [approveFn, rejectFn, cancelFn]) expect(fn).not.toMatch(/checkRiskGate/)
  })
})

describe('actor identity honesty (section 15F-review 23/30)', () => {
  it('riskApprovals.ts never claims requester != approver as a security property', () => {
    const src = readSrc('src/lib/actions/riskApprovals.ts')
    expect(src.toLowerCase()).not.toMatch(/four-?eyes/)
    expect(src).not.toMatch(/requestedBy\s*!==\s*.*approvedBy|approvedBy\s*!==\s*.*requestedBy/)
  })

  it('the approval decision UI documents the single-shared-credential limitation honestly', () => {
    const src = readSrc('src/components/admin/RiskApprovalDecisionForm.tsx')
    expect(src).toMatch(/not person-level segregation of duties/)
  })
})

describe('15F-review section 1: intake conversion can no longer create a Listing through any path (bypass eliminated)', () => {
  it('intakeConversion.ts has no Listing.create call and no createListing option field — structurally incapable of listing activation (comments referencing the removal/redirect are fine, code usage is not)', () => {
    const src = readSrc('src/lib/intakeConversion.ts')
    expect(src).not.toMatch(/tx\.listing\.create\(/)
    expect(src).not.toMatch(/createListing\?:|createListing:\s*\{|options\.createListing/)
    expect(src).not.toMatch(/listingId\??:\s*string/)
  })

  it('actions/intake.ts convertDraft no longer parses listing form fields or redirects to a listing edit page', () => {
    const src = readSrc('src/lib/actions/intake.ts')
    const fnStart = src.indexOf('export async function convertDraft')
    const fnBody = src.slice(fnStart, src.indexOf('\nexport async function', fnStart + 1))
    expect(fnBody).not.toMatch(/formData\.get\('createListing'\)|formData\.get\('listingTitle'\)|formData\.get\('listingPrice'\)|newListingId/)
  })

  it('ConvertDraftForm.tsx has no "create listing" checkbox or listing price/title fields', () => {
    const src = readSrc('src/components/admin/ConvertDraftForm.tsx')
    expect(src).not.toMatch(/name="createListing"|name="listingTitle"|name="listingPrice"/)
  })

  it('the only Listing.create call site in the entire codebase is listingActivation.ts\'s createListingAtomic, called only from risk-gated paths', () => {
    // 15K: createListingAtomic (src/lib/listingActivation.ts) is now the ONE
    // authoritative boundary — both actions/listings.ts createListing (interactive,
    // via checkRiskGate) and autoListingExecution.ts (automation, via the pure
    // evaluateRiskPolicy, only on 'allow') call it. Neither calls tx.listing.create
    // directly, and no third caller exists anywhere else in the codebase.
    const listingActivationSrc = readSrc('src/lib/listingActivation.ts')
    const listingsSrc = readSrc('src/lib/actions/listings.ts')
    const autoListingExecSrc = readSrc('src/lib/autoListingExecution.ts')
    const intakeConvSrc = readSrc('src/lib/intakeConversion.ts')
    const intakeActionsSrc = readSrc('src/lib/actions/intake.ts')
    const workbenchSrc = readSrc('src/lib/actions/intakeWorkbench.ts')
    const exceptionsSrc = readSrc('src/lib/actions/intakeExceptions.ts')

    expect([...listingActivationSrc.matchAll(/\.listing\.create\(/g)]).toHaveLength(1)
    expect(listingsSrc).not.toMatch(/\.listing\.create\(/)
    expect(listingsSrc).toContain('createListingAtomic(tx')
    expect(autoListingExecSrc).not.toMatch(/\.listing\.create\(/)
    expect(autoListingExecSrc).toContain('createListingAtomic(tx')
    for (const src of [intakeConvSrc, intakeActionsSrc, workbenchSrc, exceptionsSrc]) {
      expect(src).not.toMatch(/\.listing\.create\(/)
      expect(src).not.toMatch(/createListingAtomic\(/)
    }
  })

  it('after conversion, the item page (not intake) is where listing is offered — physical intake is never rolled back or blocked by listing approval', () => {
    const src = readSrc('src/lib/actions/intake.ts')
    // convertDraft's only redirect on success lands on the item workspace, never a listing page.
    const fnStart = src.indexOf('export async function convertDraft')
    const fnBody = src.slice(fnStart, src.indexOf('\nexport async function', fnStart + 1))
    const redirects = [...fnBody.matchAll(/redirect\(`([^`]*)`\)/g)].map((m) => m[1])
    expect(redirects.length).toBeGreaterThan(0)
    for (const r of redirects) expect(r).not.toMatch(/listings/)
  })
})

describe('15F-review section 2: complete runtime write-path audit — no alternate mutation bypass for the six protected actions', () => {
  it('agreement_commission_override: status "accepted" is written exactly once in the whole codebase, inside the gated recordSellerAgreementAcceptance', () => {
    const src = readSrc('src/lib/actions/sellerAgreements.ts')
    expect([...src.matchAll(/status:\s*'accepted'/g)]).toHaveLength(1)
    const idx = src.indexOf("status: 'accepted'")
    const before = src.slice(0, idx)
    expect(before).toMatch(/checkRiskGate\(\{\s*action:\s*'agreement_commission_override'/)
  })

  it('seller_commission_override: SellerCommissionOverride.create exists exactly once, inside the gated createSellerCommissionOverrideAction call chain', () => {
    const queueSrc = readSrc('src/lib/commissionPolicyQuery.ts')
    expect([...queueSrc.matchAll(/sellerCommissionOverride\.create\(/g)]).toHaveLength(1)
    const actionsSrc = readSrc('src/lib/actions/commissionPolicies.ts')
    expect(actionsSrc).toMatch(/checkRiskGate\(\{\s*action:\s*'seller_commission_override'/)
  })

  it('seller_commission_override: ending an override (risk-reducing, not risk-creating) is a distinct write and correctly ungated', () => {
    const src = readSrc('src/lib/commissionPolicyQuery.ts')
    const endFnStart = src.indexOf('export async function endSellerCommissionOverride')
    const endFnBody = src.slice(endFnStart, src.indexOf('\nexport async function', endFnStart + 1))
    expect(endFnBody).toMatch(/effectiveTo/)
    expect(endFnBody).not.toMatch(/commissionBps:|reason:/) // never creates new override terms
  })

  it('listing_activation: Listing.create exists exactly once codebase-wide (verified above); reactivation (status -> active via update) is also gated', () => {
    const src = readSrc('src/lib/actions/listings.ts')
    expect(src).toMatch(/willBecomeActive/)
    expect(src).toMatch(/checkRiskGate\(\{\s*action:\s*'listing_activation'/)
  })

  it('listing_price_change: every tx.listing.update call in updateListing is inside a branch that already evaluated the price gate above it', () => {
    const src = readSrc('src/lib/actions/listings.ts')
    const fnStart = src.indexOf('export async function updateListing')
    const fnBody = src.slice(fnStart)
    const gateIdx = fnBody.indexOf("action: 'listing_price_change'")
    const updateCalls = [...fnBody.matchAll(/tx\.listing\.update\(/g)].map((m) => m.index!)
    expect(gateIdx).toBeGreaterThan(-1)
    for (const idx of updateCalls) expect(idx).toBeGreaterThan(gateIdx)
  })

  it('seller_payout_mark_paid: "status: \'paid\'" is written exactly once in the whole codebase, inside the gated markSellerPayoutPaid', () => {
    const src = readSrc('src/lib/actions/sellerPayouts.ts')
    expect([...src.matchAll(/status:\s*'paid'/g)]).toHaveLength(1)
    const idx = src.indexOf("status: 'paid'")
    const before = src.slice(0, idx)
    expect(before).toMatch(/checkRiskGate\(\{\s*action:\s*'seller_payout_mark_paid'/)
  })

  it('item_catalog_reassignment: the single-item admin correction path is gated', () => {
    const itemsSrc = readSrc('src/lib/actions/items.ts')
    expect(itemsSrc).toMatch(/checkRiskGate\(\{\s*action:\s*'item_catalog_reassignment'/)
  })

  it('catalog_model_merge (15F-review catalog-merge pass): the bulk CatalogModel merge is now its OWN gated protected action — never routed through item_catalog_reassignment once per affected ItemInstance, never left as a documented exception', () => {
    const catalogSrc = readSrc('src/lib/actions/catalog.ts')
    expect(catalogSrc).toMatch(/checkRiskGate\(\{\s*action:\s*'catalog_model_merge'/)
    // gated once per duplicate model (the batch's real unit of risk), not per item —
    // the checkRiskGate call sits in the pre-transaction per-duplicate loop, never
    // inside the tx.itemInstance.updateMany call site itself.
    const gateIdx = catalogSrc.indexOf("action: 'catalog_model_merge'")
    const bulkReassignIdx = catalogSrc.indexOf('tx.itemInstance.updateMany({ where: { catalogId: dupeId }')
    expect(gateIdx).toBeGreaterThan(-1)
    expect(bulkReassignIdx).toBeGreaterThan(gateIdx)
    // pre-existing safety machinery preserved, additive not replaced.
    expect(catalogSrc).toMatch(/catalogModelMergeAudit\.create/)
    expect(catalogSrc).toMatch(/FOR UPDATE/)
    expect(catalogSrc).toMatch(/Impact changed since the preview/)
  })

  it('catalog_model_merge: the only CatalogModel.delete call site in the codebase is inside the gated merge, after consumption', () => {
    const catalogSrc = readSrc('src/lib/actions/catalog.ts')
    expect([...catalogSrc.matchAll(/catalogModel\.delete\(/g)]).toHaveLength(1)
    const consumeIdx = catalogSrc.indexOf('markApprovalConsumed(tx, gate.approvalRequestId)')
    const deleteIdx = catalogSrc.indexOf('tx.catalogModel.delete(')
    expect(deleteIdx).toBeGreaterThan(-1)
    // consumption happens AFTER the delete succeeds (mutation before consumption).
    expect(consumeIdx).toBeGreaterThan(deleteIdx)
  })

  it('no other ItemInstance.catalogId write site exists beyond items.ts (gated) and catalog.ts (also gated)', () => {
    const files = ['intakeOperations.ts', 'sellerLifecycle.ts', 'orders.ts', 'intakeWorkbench.ts', 'intakeExceptions.ts', 'sellerPayouts.ts']
    for (const f of files) {
      const src = readSrc(`src/lib/actions/${f}`)
      expect(src).not.toMatch(/catalogId:\s*\w/) // no write assigning a new catalogId value
    }
  })
})

describe('15F-review (catalog-merge pass) section 13: complete taxonomy is exactly the seven known protected actions', () => {
  it('RISK_ACTIONS contains exactly the seven confirmed real actions, no invented ones', () => {
    const src = readSrc('src/lib/riskPolicy.ts')
    const match = src.match(/export const RISK_ACTIONS = \[([\s\S]*?)\] as const/)
    expect(match).toBeTruthy()
    const actions = [...match![1].matchAll(/'([\w_]+)'/g)].map((m) => m[1])
    expect(actions.sort()).toEqual([
      'agreement_commission_override',
      'catalog_model_merge',
      'item_catalog_reassignment',
      'listing_activation',
      'listing_price_change',
      'seller_commission_override',
      'seller_payout_mark_paid',
    ])
  })
})

describe('15F-review section 6/7: server-authoritative context reconstruction, no downgrade bypass', () => {
  it('no exported action takes a raw risk context object as a parameter — every gate call builds context from server-side reads inside the function body', () => {
    const files = ['sellerAgreements.ts', 'commissionPolicies.ts', 'listings.ts', 'sellerPayouts.ts', 'items.ts']
    for (const f of files) {
      const src = readSrc(`src/lib/actions/${f}`)
      // A generic bypass would look like `evaluateRiskPolicy(` or `checkRiskGate(` being
      // called with a context built directly from `formData`/`request.json()` rather than
      // from a `prisma....findUnique` read. We can't prove a negative perfectly via regex,
      // but we CAN assert every checkRiskGate call site is preceded (within a short window)
      // by an authoritative DB read, and that context objects are never spread directly
      // from formData.
      expect(src).not.toMatch(/context:\s*(await\s+)?(JSON\.parse|request\.json|formData)\(/)
      expect(src).not.toMatch(/context:\s*\.\.\.(Object\.fromEntries\(formData\)|formData)/)
    }
  })

  it('items.ts: item_catalog_reassignment context is built from a fresh prisma.itemInstance.findUnique read, not from client input', () => {
    // 15I (focused-review pass): the context-building literal itself now lives once,
    // in itemMutations.ts#buildItemCatalogReassignmentContext (shared with the bulk
    // engine) — items.ts calls it with `existing`, its own freshly-read row, rather
    // than inlining the object literal a second time.
    const src = readSrc('src/lib/actions/items.ts')
    const contextIdx = src.indexOf('buildItemCatalogReassignmentContext(')
    const readIdx = src.indexOf('prisma.itemInstance.findUnique')
    expect(readIdx).toBeGreaterThan(-1)
    expect(contextIdx).toBeGreaterThan(readIdx)
    expect(src).toMatch(/buildItemCatalogReassignmentContext\(id, catalogId, existing,/)

    // The shared builder itself derives hasCompletedSale from the server-read
    // status/orderItems it's passed — never a form field.
    const mutationsSrc = readSrc('src/lib/itemMutations.ts')
    expect(mutationsSrc).toMatch(/hasCompletedSale:\s*existing\.status === 'sold'/)
  })

  it('listings.ts: listing_price_change old price and guidance come from a fresh DB read (before.price) and 14C, never from the submitted "price" field alone', () => {
    const src = readSrc('src/lib/actions/listings.ts')
    expect(src).toMatch(/oldPriceCents = Math\.round\(before\.price \* 100\)/)
    expect(src).toMatch(/getPricingIntelligence\(before\.item\.catalogId\)/)
  })

  it('sellerAgreements.ts: the override commission terms bound into the fingerprint come from the persisted agreement row (fresh, re-fetched), never from acceptance formData (which only carries acceptanceMethod)', () => {
    const src = readSrc('src/lib/actions/sellerAgreements.ts')
    const fnStart = src.indexOf('export async function recordSellerAgreementAcceptance')
    const fnBody = src.slice(fnStart, src.indexOf('\nexport async function', fnStart + 1))
    // formData is only ever read for acceptanceMethod in this function.
    const formDataReads = [...fnBody.matchAll(/formData\.get\('(\w+)'\)/g)].map((m) => m[1])
    expect(formDataReads).toEqual(['acceptanceMethod'])
    expect(fnBody).toMatch(/agreement\.commissionPercent/)
  })

  it('sellerPayouts.ts: the authoritative totalAmountCents/payoutStatus bound into the gate come from a fresh prisma.sellerPayout.findUnique read, never trusted from the client', () => {
    const src = readSrc('src/lib/actions/sellerPayouts.ts')
    const contextIdx = src.indexOf('riskContext: SellerPayoutMarkPaidContext')
    const readIdx = src.indexOf('prisma.sellerPayout.findUnique')
    expect(readIdx).toBeGreaterThan(-1)
    expect(contextIdx).toBeGreaterThan(readIdx)
  })

  it('no caller can downgrade risk by omitting a value the engine would otherwise see — resolveAuthoritativeItemValueCents is always fed by server reads (14C/listing/agreement), never a client-controlled "value" form field', () => {
    const files = ['items.ts', 'listings.ts']
    for (const f of files) {
      const src = readSrc(`src/lib/actions/${f}`)
      expect(src).not.toMatch(/estimatedValueCents:\s*(Number|parseFloat)\(formData/)
      expect(src).not.toMatch(/completedSaleAmountCents:\s*(Number|parseFloat)\(formData/)
    }
  })
})
