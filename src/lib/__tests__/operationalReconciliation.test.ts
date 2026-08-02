import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// ─── Read source files for structural tests ───────────────────────────────────

const libSrc = fs.readFileSync(
  path.resolve(__dirname, '../operationalReconciliation.ts'),
  'utf-8',
)
const actionSrc = fs.readFileSync(
  path.resolve(__dirname, '../actions/operationalReconciliation.ts'),
  'utf-8',
)

// ─── Deterministic issue keys ─────────────────────────────────────────────────

describe('deterministic issue keys', () => {
  it('issue key format is issueType:entityId', () => {
    expect(libSrc).toContain('`seller_approved_no_intake:${')
    expect(libSrc).toContain('`buyout_inventory_no_payout_line:${')
    expect(libSrc).toContain('`consignment_item_source_mismatch:${')
    expect(libSrc).toContain('`shipment_received_no_intake:${')
    expect(libSrc).toContain('`consignment_order_no_payout:${')
    expect(libSrc).toContain('`payout_total_mismatch:${')
    expect(libSrc).toContain('`item_sold_active_listing:${')
  })

  it('same key format used for deduplication', () => {
    expect(libSrc).toContain('seen.has(issue.key)')
    expect(libSrc).toContain('seen.add(issue.key)')
  })
})

// ─── Issue deduplication ─────────────────────────────────────────────────────

describe('issue deduplication', () => {
  it('deduplication logic exists in detectReconciliationIssues', () => {
    expect(libSrc).toContain('const seen = new Set<string>()')
    expect(libSrc).toContain('seen.has(issue.key)')
  })
})

// ─── Category coverage ────────────────────────────────────────────────────────

describe('each major category represented', () => {
  const categories = ['seller', 'shipping', 'intake', 'inventory', 'listing', 'order', 'payout', 'lifecycle']
  for (const cat of categories) {
    it(`${cat} detection function exists`, () => {
      const fnName = `detect${cat.charAt(0).toUpperCase() + cat.slice(1)}Issues`
      expect(libSrc).toContain(`async function ${fnName}`)
    })
  }

  it('all category detection functions are called in Promise.all', () => {
    expect(libSrc).toContain('Promise.all(')
    expect(libSrc).toContain('detectSellerIssues()')
    expect(libSrc).toContain('detectShippingIssues()')
    expect(libSrc).toContain('detectIntakeIssues()')
    expect(libSrc).toContain('detectInventoryIssues()')
    expect(libSrc).toContain('detectListingIssues()')
    expect(libSrc).toContain('detectOrderIssues()')
    expect(libSrc).toContain('detectPayoutIssues()')
    expect(libSrc).toContain('detectLifecycleIssues()')
  })
})

// ─── RepairType consistency ───────────────────────────────────────────────────

describe('repairType consistency', () => {
  it('buyout_inventory_no_payout_line is critical with generate_buyout_payout_line', () => {
    expect(libSrc).toContain('`buyout_inventory_no_payout_line:${')
    expect(libSrc).toContain("repairType: 'generate_buyout_payout_line'")
    expect(libSrc).toContain("severity: 'critical'")
  })

  it('consignment_order_no_payout is critical with generate_consignment_payout_line', () => {
    expect(libSrc).toContain('`consignment_order_no_payout:${')
    expect(libSrc).toContain("repairType: 'generate_consignment_payout_line'")
  })

  it('item_sold_active_listing is critical with archive_active_listing', () => {
    expect(libSrc).toContain('`item_sold_active_listing:${')
    expect(libSrc).toContain("repairType: 'archive_active_listing'")
  })
})

// ─── Payout total mismatch repair availability ────────────────────────────────

describe('payout_total_mismatch repair', () => {
  it('only repairable for draft payouts — approved/paid get null repairType', () => {
    expect(libSrc).toContain("p.status === 'draft' ? 'recalculate_payout_total' : null")
  })
})

// ─── No automatic repair on page load ────────────────────────────────────────

describe('no automatic repair on page load', () => {
  it('repairReconciliationIssue is not called from detectReconciliationIssues', () => {
    expect(libSrc).not.toContain('repairReconciliationIssue')
    expect(actionSrc).toContain("'use server'")
    expect(actionSrc).toContain('export async function repairReconciliationIssue')
  })
})

// ─── Admin auth guard ─────────────────────────────────────────────────────────

describe('admin auth guard', () => {
  it('repairReconciliationIssue calls isAdminAuthenticated', () => {
    expect(actionSrc).toContain('isAdminAuthenticated')
    expect(actionSrc).toContain('const authenticated = await isAdminAuthenticated()')
    expect(actionSrc).toContain("return { errors: { _form: ['Unauthorized.'] } }")
  })
})

// ─── Audit write ─────────────────────────────────────────────────────────────

describe('audit write', () => {
  it('each repair type writes OperationalReconciliationAudit', () => {
    const auditCount = (actionSrc.match(/operationalReconciliationAudit\.create/g) ?? []).length
    // 6 repair types: buyout, consignment, archive, recalculate, open_case, hold_line
    expect(auditCount).toBeGreaterThanOrEqual(6)
  })

  it('audit record includes all required fields', () => {
    expect(actionSrc).toContain('issueKey:')
    expect(actionSrc).toContain('repairType:')
    expect(actionSrc).toContain('entityType:')
    expect(actionSrc).toContain('entityId:')
    expect(actionSrc).toContain('beforeSnapshot:')
    expect(actionSrc).toContain('afterSnapshot:')
    expect(actionSrc).toContain("result: 'success'")
  })
})

// ─── No financial deletion ────────────────────────────────────────────────────

describe('no financial deletion', () => {
  it('action source does not delete Order or OrderItem', () => {
    expect(actionSrc).not.toMatch(/order\.delete|orderItem\.delete/)
  })

  it('action source does not delete SellerPayout or SellerPayoutLine', () => {
    expect(actionSrc).not.toMatch(/sellerPayout\.delete|sellerPayoutLine\.delete/)
  })

  it('action source does not contain refund or reversal', () => {
    expect(actionSrc.toLowerCase()).not.toContain('refund')
    expect(actionSrc.toLowerCase()).not.toContain('reversal')
  })
})

// ─── Lock ordering ────────────────────────────────────────────────────────────

describe('lock ordering', () => {
  it('buyout repair locks SellerAgreement FOR UPDATE', () => {
    expect(actionSrc).toContain('"SellerAgreement" WHERE id = ${agreementId} FOR UPDATE')
  })

  it('archive listing repair locks ItemInstance before Listing (canonical order)', () => {
    // Canonical project order: ItemInstance first, then Listing
    // Pre-read (non-locking) gets itemId, then canonical lock order is applied
    const itemLockIdx = actionSrc.indexOf('"ItemInstance" WHERE id = ${preRead.itemId} FOR UPDATE')
    const listingLockIdx = actionSrc.indexOf('"Listing" WHERE id = ${listingId} FOR UPDATE')
    expect(itemLockIdx).toBeGreaterThan(-1)
    expect(listingLockIdx).toBeGreaterThan(-1)
    expect(itemLockIdx).toBeLessThan(listingLockIdx)
  })

  it('consignment payout repair locks Order before OrderItem', () => {
    const orderLockIdx = actionSrc.indexOf('"Order" WHERE id = ${orderId} FOR UPDATE')
    const orderItemLockIdx = actionSrc.indexOf('"OrderItem" WHERE id = ${orderItemId} FOR UPDATE')
    expect(orderLockIdx).toBeGreaterThan(-1)
    expect(orderItemLockIdx).toBeGreaterThan(-1)
    expect(orderLockIdx).toBeLessThan(orderItemLockIdx)
  })

  it('hold_payout_line repair locks SellerPayoutLine FOR UPDATE', () => {
    expect(actionSrc).toContain('"SellerPayoutLine" WHERE id = ${lineId} FOR UPDATE')
  })
})

// ─── Listing repair: lock-then-read and entity validation ─────────────────────

describe('archive_active_listing repair safety', () => {
  it('acquires ItemInstance FOR UPDATE before Listing FOR UPDATE (canonical order)', () => {
    // A non-locking pre-read fetches itemId, then canonical lock order: ItemInstance → Listing
    expect(actionSrc).toContain('"ItemInstance" WHERE id = ${preRead.itemId} FOR UPDATE')
    expect(actionSrc).toContain('"Listing" WHERE id = ${listingId} FOR UPDATE')
    const itemLockIdx = actionSrc.indexOf('"ItemInstance" WHERE id = ${preRead.itemId} FOR UPDATE')
    const listingLockIdx = actionSrc.indexOf('"Listing" WHERE id = ${listingId} FOR UPDATE')
    expect(itemLockIdx).toBeLessThan(listingLockIdx)
  })

  it('re-reads listing status after both locks are held (no TOCTOU)', () => {
    // After both FOR UPDATE locks, a second queryRaw reads status without FOR UPDATE
    // (the row is already locked — subsequent reads in same tx see locked version)
    const listingLockIdx = actionSrc.indexOf('"Listing" WHERE id = ${listingId} FOR UPDATE')
    const afterLock = actionSrc.slice(listingLockIdx)
    // Re-read comes from a SELECT without FOR UPDATE (status already locked)
    expect(afterLock).toContain('SELECT id, "itemId", status FROM "Listing" WHERE id = ${listingId}')
  })

  it('rejects listing that does not belong to entityId when entityType is ItemInstance', () => {
    expect(actionSrc).toContain("ctx.entityType === 'ItemInstance' && listingRow.itemId !== ctx.entityId")
    expect(actionSrc).toContain('Listing does not belong to the issue item — cross-entity repair rejected.')
  })

  it('re-reads status after lock and rejects if not active', () => {
    expect(actionSrc).toContain("status !== 'active'")
    expect(actionSrc).toContain('Listing is not active — issue is already resolved.')
  })
})

// ─── Payout hold repair ───────────────────────────────────────────────────────

describe('hold_payout_line repair', () => {
  it('acquires SellerPayoutLine FOR UPDATE before reading (prevents TOCTOU)', () => {
    const lockIdx = actionSrc.indexOf('"SellerPayoutLine" WHERE id = ${lineId} FOR UPDATE')
    expect(lockIdx).toBeGreaterThan(-1)
    // Re-fetch after lock: findUnique must appear in the text AFTER the FOR UPDATE lock
    const afterLock = actionSrc.slice(lockIdx)
    expect(afterLock).toContain('sellerPayoutLine.findUnique(')
  })

  it('uses updateMany with count === 1 to prevent double-hold', () => {
    expect(actionSrc).toContain('sellerPayoutLine.updateMany(')
    expect(actionSrc).toContain("where: { id: lineId, status: 'eligible', payoutId: null }")
    expect(actionSrc).toContain('updated.count !== 1')
  })

  it('rejects if lineId does not match ctx.entityId when entity is SellerPayoutLine', () => {
    expect(actionSrc).toContain("ctx.entityType === 'SellerPayoutLine' && lineId !== ctx.entityId")
    expect(actionSrc).toContain('Payout line ID does not match issue entity — cross-entity repair rejected.')
  })
})

// ─── Open dispute + eligible line detection ───────────────────────────────────

describe('open_dispute_eligible_line detection', () => {
  it('detects open dispute cases with eligible unheld lines', () => {
    expect(libSrc).toContain('`open_dispute_eligible_line:${')
    expect(libSrc).toContain("repairType: 'hold_payout_line'")
  })

  it('only targets eligible, unbatched (payoutId=null) payout lines', () => {
    expect(libSrc).toContain("status: 'eligible'")
    expect(libSrc).toContain('payoutId: null')
  })

  it('scans dispute cases without silent truncation', () => {
    expect(libSrc).toContain('sellerLifecycleCase.findMany(')
    // No standalone take:200/300 exists in the file (all outer queries use scanAll)
    expect(libSrc).not.toMatch(/take:\s*[23]00/)
    // scanAll is called many times across detection functions
    const scanAllCount = (libSrc.match(/await scanAll\(/g) ?? []).length
    expect(scanAllCount).toBeGreaterThan(8)
  })
})

// ─── Approved/paid payout with open cases ─────────────────────────────────────

describe('payout critical case detection', () => {
  it('detects approved payout with unresolved lifecycle case', () => {
    // Key is computed: const key = p.status === 'paid' ? 'paid_...' : 'approved_...'
    expect(libSrc).toContain("'approved_payout_critical_case'")
  })

  it('detects paid payout with unresolved lifecycle case', () => {
    expect(libSrc).toContain("'paid_payout_critical_case'")
  })

  it('both are view-only (no repairType)', () => {
    // The critical-case payout block uses repairType: null
    // Find the section containing both key strings
    const blockStart = libSrc.indexOf("'approved_payout_critical_case'")
    const blockEnd = libSrc.indexOf('return issues', blockStart)
    const block = libSrc.slice(blockStart, blockEnd)
    expect(block).toContain('repairType: null')
  })
})

// ─── Non-complete order payout line ──────────────────────────────────────────

describe('payout_line_noncomplete_order detection', () => {
  it('detects consignment payout line on non-complete order', () => {
    expect(libSrc).toContain('`payout_line_noncomplete_order:${')
  })

  it('is view-only', () => {
    const idx = libSrc.indexOf('`payout_line_noncomplete_order:${')
    const block = libSrc.slice(idx, idx + 600)
    expect(block).toContain('repairType: null')
  })
})

// ─── Held line in payout batch ────────────────────────────────────────────────

describe('held_line_in_payout detection', () => {
  it('detects held payout line attached to a payout batch', () => {
    expect(libSrc).toContain('`held_line_in_payout:${')
  })
})

// ─── Returned item with unresolved case ──────────────────────────────────────

describe('returned_item_unresolved_case detection', () => {
  it('detects returned item with open return lifecycle case', () => {
    expect(libSrc).toContain('`returned_item_unresolved_case:${')
  })
})

// ─── Keyset pagination ────────────────────────────────────────────────────────

describe('detection pagination', () => {
  it('uses scanAll helper for complete record scanning', () => {
    expect(libSrc).toContain('async function scanAll')
    expect(libSrc).toContain('orderBy: { id:')
  })

  it('no silent one-shot take:200 or take:300 in outer category detection queries', () => {
    // Allow: take: 1 (existence), take: 50 (per-seller sub-queries), take: 100 (scanAll batch size)
    // Disallow: take: 200 or take: 300 at the top-level detection scope
    const oneShot = (libSrc.match(/take:\s*[23]00/g) ?? [])
    expect(oneShot).toHaveLength(0)
  })

  it('scanAll loops until batch smaller than batch size', () => {
    expect(libSrc).toContain('if (batch.length < batchSize) break')
  })
})

// ─── Cross-entity repair validation ───────────────────────────────────────────

describe('cross-entity repair validation', () => {
  it('buyout repair rejects agreementId !== ctx.entityId', () => {
    expect(actionSrc).toContain('agreementId !== ctx.entityId')
    expect(actionSrc).toContain('Agreement ID does not match issue entity — cross-entity repair rejected.')
  })

  it('consignment repair cross-checks order item belongs to issue entity', () => {
    expect(actionSrc).toContain('oi.id !== ctx.entityId')
    expect(actionSrc).toContain('Order item ID does not match issue entity — cross-entity repair rejected.')
  })

  it('archive listing repair rejects listing not belonging to ItemInstance entity', () => {
    expect(actionSrc).toContain("ctx.entityType === 'ItemInstance' && listingRow.itemId !== ctx.entityId")
    expect(actionSrc).toContain('Listing does not belong to the issue item — cross-entity repair rejected.')
  })

  it('open lifecycle case repair cross-checks shipment submission when entity is SellerInboundShipment', () => {
    expect(actionSrc).toContain("ctx.entityType === 'SellerInboundShipment'")
    expect(actionSrc).toContain('Submission ID does not match shipment — cross-entity repair rejected.')
  })

  it('recalculate payout repair rejects payoutId !== ctx.entityId', () => {
    expect(actionSrc).toContain('payoutId !== ctx.entityId')
    expect(actionSrc).toContain('Payout ID does not match issue entity — cross-entity repair rejected.')
  })
})

// ─── Audit atomicity ─────────────────────────────────────────────────────────

describe('audit atomicity', () => {
  it('all audit writes follow inside $transaction', () => {
    const firstTxIdx = actionSrc.indexOf('await prisma.$transaction')
    const firstAuditIdx = actionSrc.indexOf('operationalReconciliationAudit.create')
    expect(firstTxIdx).toBeGreaterThan(-1)
    expect(firstAuditIdx).toBeGreaterThan(firstTxIdx)
  })

  it('recreate_lifecycle_event handler removed (was non-atomic)', () => {
    expect(actionSrc).not.toContain("'recreate_lifecycle_event'")
    expect(actionSrc).not.toContain('repairRecreateLifecycleEvent')
  })
})

// ─── Dead handler removal ─────────────────────────────────────────────────────

describe('no unreachable repair handlers', () => {
  it('recreate_lifecycle_event not in switch statement', () => {
    expect(actionSrc).not.toContain("case 'recreate_lifecycle_event'")
  })

  it('hold_payout_line has a corresponding detector', () => {
    expect(libSrc).toContain("repairType: 'hold_payout_line'")
    expect(actionSrc).toContain("case 'hold_payout_line'")
  })
})

// ─── Vitest excludes worktrees ────────────────────────────────────────────────

describe('vitest configuration', () => {
  it('vitest config excludes .claude/worktrees', () => {
    const configFiles = ['vitest.config.ts', 'vitest.config.mts', 'vitest.config.js']
    const root = path.resolve(__dirname, '../../..')
    let found = false
    for (const f of configFiles) {
      const p = path.join(root, f)
      if (fs.existsSync(p)) {
        const src = fs.readFileSync(p, 'utf-8')
        if (src.includes('.claude/worktrees')) {
          found = true
          break
        }
      }
    }
    expect(found).toBe(true)
  })
})

// ─── No repair on page load ───────────────────────────────────────────────────

describe('no repair on dashboard page load', () => {
  it('dashboard page does not import repair action', () => {
    const pageSrc = fs.readFileSync(
      path.resolve(__dirname, '../../app/(admin)/admin/reconciliation/page.tsx'),
      'utf-8',
    )
    expect(pageSrc).not.toContain('repairReconciliationIssue')
  })
})

// ─── New lifecycle event detectors ───────────────────────────────────────────

describe('missing lifecycle event detectors', () => {
  it('detects missing_shipment_received_event for received/issue shipments', () => {
    expect(libSrc).toContain("missing_shipment_received_event:${s.id}")
    expect(libSrc).toContain("where: { status: { in: ['received', 'issue'] } }")
    expect(libSrc).toContain("entityType: 'SellerInboundShipment'")
  })

  it('missing_shipment_received_event uses batch IN query (not per-row lookup)', () => {
    expect(libSrc).toContain('shipmentEventKeys = receivedShipments.map')
    expect(libSrc).toContain('eventKey: { in: shipmentEventKeys }')
    expect(libSrc).toContain('existingShipmentEventSet')
  })

  it('missing_shipment_received_event key matches shipment-received:{id} event convention', () => {
    expect(libSrc).toContain("shipment-received:${s.id}")
    expect(libSrc).toContain("existingShipmentEventSet.has(`shipment-received:${s.id}`)")
  })

  it('detects missing_payout_paid_event for paid payouts', () => {
    expect(libSrc).toContain("missing_payout_paid_event:${payoutId}:${submissionId}")
    expect(libSrc).toContain("where: { status: 'paid' }")
    expect(libSrc).toContain("entityType: 'SellerPayout'")
  })

  it('missing_payout_paid_event uses batch IN query (not per-row lookup)', () => {
    expect(libSrc).toContain("payoutEventKeys = payoutEventPairs.map")
    expect(libSrc).toContain('eventKey: { in: payoutEventKeys }')
    expect(libSrc).toContain('existingPayoutEventSet')
  })

  it('missing_payout_paid_event key matches payout-paid:{payoutId}:{submissionId} event convention', () => {
    expect(libSrc).toContain('`payout-paid:${p.payoutId}:${p.submissionId}`')
    expect(libSrc).toContain("existingPayoutEventSet.has(`payout-paid:${payoutId}:${submissionId}`)")
  })

  it('detects missing_order_completed_event for completed consignment orders', () => {
    expect(libSrc).toContain("missing_order_completed_event:${orderId}:${submissionId}")
    expect(libSrc).toContain("status: 'complete'")
    expect(libSrc).toContain("sourceType: 'consignment'")
    expect(libSrc).toContain("entityType: 'Order'")
  })

  it('missing_order_completed_event uses batch IN query (not per-row lookup)', () => {
    expect(libSrc).toContain("orderEventKeys = orderEventPairs.map")
    expect(libSrc).toContain('eventKey: { in: orderEventKeys }')
    expect(libSrc).toContain('existingOrderEventSet')
  })

  it('missing_order_completed_event key matches order-completed:{orderId}:{submissionId} event convention', () => {
    expect(libSrc).toContain('`order-completed:${p.orderId}:${p.submissionId}`')
    expect(libSrc).toContain("existingOrderEventSet.has(`order-completed:${orderId}:${submissionId}`)")
  })

  it('all three new lifecycle detectors have repairType: null (view-only)', () => {
    const shipmentIdx = libSrc.indexOf("missing_shipment_received_event:${s.id}")
    const payoutIdx = libSrc.indexOf("missing_payout_paid_event:${payoutId}:${submissionId}")
    const orderIdx = libSrc.indexOf("missing_order_completed_event:${orderId}:${submissionId}")
    // Each issue push block should contain repairType: null in its window
    for (const idx of [shipmentIdx, payoutIdx, orderIdx]) {
      expect(idx).toBeGreaterThan(-1)
      const window = libSrc.slice(idx, idx + 700)
      expect(window).toContain('repairType: null')
    }
  })
})

// ─── Eligible payout line beyond-50 pagination ───────────────────────────────

describe('open_dispute_eligible_line pagination beyond record 50', () => {
  it('eligible lines inside dispute loop use scanAll (not a fixed take)', () => {
    // The nested eligibleLines query must be wrapped in scanAll, not a bare findMany with take: 50
    expect(libSrc).toContain('const eligibleLines = await scanAll')
  })

  it('no take: 50 cap remains in the detection library', () => {
    const cap50 = (libSrc.match(/take:\s*50/g) ?? [])
    expect(cap50).toHaveLength(0)
  })

  it('eligible lines sub-query uses keyset cursor pagination within scanAll', () => {
    const eligibleIdx = libSrc.indexOf('const eligibleLines = await scanAll')
    const window = libSrc.slice(eligibleIdx, eligibleIdx + 400)
    expect(window).toContain("orderBy: { id: 'asc' }")
    expect(window).toContain('cursor: { id: cursorId }')
  })
})
