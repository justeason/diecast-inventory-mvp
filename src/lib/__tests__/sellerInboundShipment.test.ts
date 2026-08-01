import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import {
  deriveShipmentWarnings,
  deriveShipmentTotals,
  SHIPMENT_WARNING_LABELS,
  type ShipmentWarningInput,
  type ShipmentSummary,
  type IntakeDraftSummary,
} from '../sellerShipmentWarnings'

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeShipment(overrides: Partial<ShipmentSummary> = {}): ShipmentSummary {
  return {
    id: 'ship_1',
    status: 'shipped',
    trackingNumber: 'TRACK123',
    expectedQuantity: 2,
    receivedQuantity: null,
    receivedAt: null,
    shippedAt: new Date('2026-07-01'),
    conditionStatus: null,
    intakeDraftId: null,
    ...overrides,
  }
}

function makeDraft(overrides: Partial<IntakeDraftSummary> = {}): IntakeDraftSummary {
  return {
    id: 'draft_1',
    status: 'draft',
    receivedAt: null,
    receivedQuantity: null,
    ...overrides,
  }
}

function makeInput(overrides: Partial<ShipmentWarningInput> = {}): ShipmentWarningInput {
  return {
    hasAcceptedAgreement: true,
    agreementAcceptedAt: new Date('2026-07-20'),
    shipments: [],
    intakeDrafts: [],
    openCaseTypes: [],
    now: new Date('2026-07-26'),
    ...overrides,
  }
}

// ── deriveShipmentWarnings ────────────────────────────────────────────────────

describe('deriveShipmentWarnings', () => {
  describe('no_shipment_after_agreement', () => {
    it('fires when agreement accepted >3d ago with no active shipments or drafts', () => {
      const warnings = deriveShipmentWarnings(makeInput({
        agreementAcceptedAt: new Date('2026-07-20'),
        now: new Date('2026-07-26'),
      }))
      expect(warnings).toContain('no_shipment_after_agreement')
    })

    it('does not fire when agreement accepted <3d ago', () => {
      const warnings = deriveShipmentWarnings(makeInput({
        agreementAcceptedAt: new Date('2026-07-25'),
        now: new Date('2026-07-26'),
      }))
      expect(warnings).not.toContain('no_shipment_after_agreement')
    })

    it('does not fire when there is an active shipment', () => {
      const warnings = deriveShipmentWarnings(makeInput({
        shipments: [makeShipment()],
      }))
      expect(warnings).not.toContain('no_shipment_after_agreement')
    })

    it('does not fire when there is a non-rejected intake draft', () => {
      const warnings = deriveShipmentWarnings(makeInput({
        intakeDrafts: [makeDraft({ status: 'draft' })],
      }))
      expect(warnings).not.toContain('no_shipment_after_agreement')
    })
  })

  describe('shipped_not_received', () => {
    it('fires when a shipment has been shipped >14d without receipt', () => {
      const warnings = deriveShipmentWarnings(makeInput({
        shipments: [makeShipment({ shippedAt: new Date('2026-07-01') })],
        now: new Date('2026-07-26'),
      }))
      expect(warnings).toContain('shipped_not_received')
    })

    it('does not fire when shipped <14d ago', () => {
      const warnings = deriveShipmentWarnings(makeInput({
        shipments: [makeShipment({ shippedAt: new Date('2026-07-20') })],
        now: new Date('2026-07-26'),
      }))
      expect(warnings).not.toContain('shipped_not_received')
    })

    it('does not fire for cancelled shipments', () => {
      const warnings = deriveShipmentWarnings(makeInput({
        shipments: [makeShipment({ status: 'cancelled', shippedAt: new Date('2026-07-01') })],
        now: new Date('2026-07-26'),
      }))
      expect(warnings).not.toContain('shipped_not_received')
    })
  })

  describe('received_no_intake', () => {
    it('fires when a received shipment has no linked intake draft', () => {
      const warnings = deriveShipmentWarnings(makeInput({
        shipments: [makeShipment({ status: 'received', receivedQuantity: 2, receivedAt: new Date(), intakeDraftId: null })],
      }))
      expect(warnings).toContain('received_no_intake')
    })

    it('does not fire when intake is linked', () => {
      const warnings = deriveShipmentWarnings(makeInput({
        shipments: [makeShipment({ status: 'received', receivedQuantity: 2, receivedAt: new Date(), intakeDraftId: 'draft_1' })],
      }))
      expect(warnings).not.toContain('received_no_intake')
    })
  })

  describe('quantity_mismatch', () => {
    it('fires when shipment received qty differs from intake received qty', () => {
      const warnings = deriveShipmentWarnings(makeInput({
        shipments: [makeShipment({ status: 'received', receivedQuantity: 3, receivedAt: new Date(), intakeDraftId: 'draft_1' })],
        intakeDrafts: [makeDraft({ receivedAt: new Date(), receivedQuantity: 2 })],
      }))
      expect(warnings).toContain('quantity_mismatch')
    })

    it('does not fire when quantities match', () => {
      const warnings = deriveShipmentWarnings(makeInput({
        shipments: [makeShipment({ status: 'received', receivedQuantity: 2, receivedAt: new Date(), intakeDraftId: 'draft_1' })],
        intakeDrafts: [makeDraft({ receivedAt: new Date(), receivedQuantity: 2 })],
      }))
      expect(warnings).not.toContain('quantity_mismatch')
    })
  })

  describe('duplicate_tracking', () => {
    it('fires when two active shipments share the same tracking number', () => {
      const warnings = deriveShipmentWarnings(makeInput({
        shipments: [
          makeShipment({ id: 'ship_1', trackingNumber: 'TRACK123' }),
          makeShipment({ id: 'ship_2', trackingNumber: 'track123' }),
        ],
      }))
      expect(warnings).toContain('duplicate_tracking')
    })

    it('does not fire for cancelled shipments with same tracking', () => {
      const warnings = deriveShipmentWarnings(makeInput({
        shipments: [
          makeShipment({ id: 'ship_1', trackingNumber: 'TRACK123' }),
          makeShipment({ id: 'ship_2', status: 'cancelled', trackingNumber: 'TRACK123' }),
        ],
      }))
      expect(warnings).not.toContain('duplicate_tracking')
    })
  })

  describe('issue_no_case', () => {
    it('fires when there is an issue shipment with no open case', () => {
      const warnings = deriveShipmentWarnings(makeInput({
        shipments: [makeShipment({ status: 'issue', receivedQuantity: 1, receivedAt: new Date() })],
        openCaseTypes: [],
      }))
      expect(warnings).toContain('issue_no_case')
    })

    it('does not fire when lost_or_damaged case is open', () => {
      const warnings = deriveShipmentWarnings(makeInput({
        shipments: [makeShipment({ status: 'issue', receivedQuantity: 1, receivedAt: new Date() })],
        openCaseTypes: ['lost_or_damaged'],
      }))
      expect(warnings).not.toContain('issue_no_case')
    })

    it('does not fire when other case is open', () => {
      const warnings = deriveShipmentWarnings(makeInput({
        shipments: [makeShipment({ status: 'issue', receivedQuantity: 1, receivedAt: new Date() })],
        openCaseTypes: ['other'],
      }))
      expect(warnings).not.toContain('issue_no_case')
    })
  })

  describe('cancelled_linked_receipt', () => {
    it('fires when a cancelled shipment is linked to a received intake', () => {
      const warnings = deriveShipmentWarnings(makeInput({
        shipments: [makeShipment({ status: 'cancelled', intakeDraftId: 'draft_1' })],
        intakeDrafts: [makeDraft({ receivedAt: new Date(), receivedQuantity: 2 })],
      }))
      expect(warnings).toContain('cancelled_linked_receipt')
    })

    it('does not fire when cancelled shipment intake has no receipt', () => {
      const warnings = deriveShipmentWarnings(makeInput({
        shipments: [makeShipment({ status: 'cancelled', intakeDraftId: 'draft_1' })],
        intakeDrafts: [makeDraft({ receivedAt: null })],
      }))
      expect(warnings).not.toContain('cancelled_linked_receipt')
    })
  })

  describe('received_missing_receivedAt', () => {
    it('fires when a received shipment is missing receivedAt', () => {
      const warnings = deriveShipmentWarnings(makeInput({
        shipments: [makeShipment({ status: 'received', receivedQuantity: 2, receivedAt: null })],
      }))
      expect(warnings).toContain('received_missing_receivedAt')
    })

    it('does not fire when receivedAt is set', () => {
      const warnings = deriveShipmentWarnings(makeInput({
        shipments: [makeShipment({ status: 'received', receivedQuantity: 2, receivedAt: new Date() })],
      }))
      expect(warnings).not.toContain('received_missing_receivedAt')
    })
  })

  describe('intake_received_no_shipment', () => {
    it('fires when intake has a receipt but no active shipments and agreement is accepted', () => {
      const warnings = deriveShipmentWarnings(makeInput({
        shipments: [],
        intakeDrafts: [makeDraft({ receivedAt: new Date(), receivedQuantity: 2 })],
      }))
      expect(warnings).toContain('intake_received_no_shipment')
    })

    it('does not fire when there is an active shipment', () => {
      const warnings = deriveShipmentWarnings(makeInput({
        shipments: [makeShipment({ status: 'received', receivedQuantity: 2, receivedAt: new Date() })],
        intakeDrafts: [makeDraft({ receivedAt: new Date(), receivedQuantity: 2 })],
      }))
      expect(warnings).not.toContain('intake_received_no_shipment')
    })

    it('does not fire when no agreement accepted', () => {
      const warnings = deriveShipmentWarnings(makeInput({
        hasAcceptedAgreement: false,
        shipments: [],
        intakeDrafts: [makeDraft({ receivedAt: new Date(), receivedQuantity: 2 })],
      }))
      expect(warnings).not.toContain('intake_received_no_shipment')
    })
  })

  describe('multiple packages allowed', () => {
    it('allows multiple active shipments for the same submission', () => {
      const warnings = deriveShipmentWarnings(makeInput({
        shipments: [
          makeShipment({ id: 'ship_1', trackingNumber: 'TRACK_A' }),
          makeShipment({ id: 'ship_2', trackingNumber: 'TRACK_B' }),
        ],
      }))
      expect(warnings).not.toContain('duplicate_tracking')
    })
  })

  describe('cancellation history preserved', () => {
    it('cancelled shipments are still evaluated for linked receipt warnings', () => {
      const warnings = deriveShipmentWarnings(makeInput({
        shipments: [makeShipment({ status: 'cancelled', intakeDraftId: 'draft_1' })],
        intakeDrafts: [makeDraft({ receivedAt: new Date(), receivedQuantity: 2 })],
      }))
      expect(warnings).toContain('cancelled_linked_receipt')
    })
  })
})

// ── deriveShipmentTotals ──────────────────────────────────────────────────────

describe('deriveShipmentTotals', () => {
  it('returns zero totals for empty array', () => {
    const totals = deriveShipmentTotals([])
    expect(totals.totalExpectedQuantity).toBe(0)
    expect(totals.totalReceivedQuantity).toBe(0)
    expect(totals.openPackageCount).toBe(0)
    expect(totals.issuePackageCount).toBe(0)
  })

  it('excludes cancelled shipments from all totals', () => {
    const totals = deriveShipmentTotals([
      makeShipment({ status: 'cancelled', expectedQuantity: 5, receivedQuantity: 5, receivedAt: new Date() }),
    ])
    expect(totals.totalExpectedQuantity).toBe(0)
    expect(totals.totalReceivedQuantity).toBe(0)
  })

  it('sums expected quantities across active shipments', () => {
    const totals = deriveShipmentTotals([
      makeShipment({ id: 'a', expectedQuantity: 3, trackingNumber: 'A' }),
      makeShipment({ id: 'b', expectedQuantity: 2, trackingNumber: 'B' }),
    ])
    expect(totals.totalExpectedQuantity).toBe(5)
  })

  it('sums received quantities from received and issue shipments', () => {
    const totals = deriveShipmentTotals([
      makeShipment({ id: 'a', status: 'received', expectedQuantity: 3, receivedQuantity: 3, receivedAt: new Date(), trackingNumber: 'A' }),
      makeShipment({ id: 'b', status: 'issue', expectedQuantity: 2, receivedQuantity: 1, receivedAt: new Date(), trackingNumber: 'B' }),
    ])
    expect(totals.totalReceivedQuantity).toBe(4)
  })

  it('counts draft and shipped as open packages', () => {
    const totals = deriveShipmentTotals([
      makeShipment({ id: 'a', status: 'draft', trackingNumber: 'A' }),
      makeShipment({ id: 'b', status: 'shipped', trackingNumber: 'B' }),
      makeShipment({ id: 'c', status: 'received', receivedQuantity: 1, receivedAt: new Date(), trackingNumber: 'C' }),
    ])
    expect(totals.openPackageCount).toBe(2)
  })

  it('counts issue packages separately', () => {
    const totals = deriveShipmentTotals([
      makeShipment({ id: 'a', status: 'issue', receivedQuantity: 1, receivedAt: new Date(), trackingNumber: 'A' }),
      makeShipment({ id: 'b', status: 'received', receivedQuantity: 2, receivedAt: new Date(), trackingNumber: 'B' }),
    ])
    expect(totals.issuePackageCount).toBe(1)
  })

  it('handles null receivedQuantity as 0 in sum', () => {
    const totals = deriveShipmentTotals([
      makeShipment({ status: 'received', receivedQuantity: null, receivedAt: new Date() }),
    ])
    expect(totals.totalReceivedQuantity).toBe(0)
  })
})

// ── Seller privacy assertion ──────────────────────────────────────────────────

describe('seller privacy', () => {
  it('SHIPMENT_WARNING_LABELS exports do not leak admin-only field names', () => {
    const labelValues = Object.values(SHIPMENT_WARNING_LABELS) as string[]
    for (const label of labelValues) {
      expect(label.toLowerCase()).not.toContain('adminnotes')
      expect(label.toLowerCase()).not.toContain('receivedby')
    }
  })
})

// ── Structural guards (source-level) ─────────────────────────────────────────

const ACTION_FILE = path.resolve(__dirname, '../actions/sellerInboundShipment.ts')
const SELLER_FORM_FILE = path.resolve(__dirname, '../../components/store/AddShipmentForm.tsx')

describe('action guards (structural)', () => {
  it('no carrier API imports', () => {
    const src = fs.readFileSync(ACTION_FILE, 'utf8')
    expect(src).not.toMatch(/carrier.*api|tracking.*api|shippo|easypost|shipengine/i)
  })

  it('no inventory/listing/payout creation', () => {
    const src = fs.readFileSync(ACTION_FILE, 'utf8')
    expect(src).not.toMatch(/inventoryItem\.create|listing\.create|payoutLine\.create/i)
  })

  it('lock order: SellerSubmission -> SellerInboundShipment -> IntakeDraft', () => {
    const src = fs.readFileSync(ACTION_FILE, 'utf8')
    expect(src).toMatch(/SellerSubmission.*SellerInboundShipment.*IntakeDraft/s)
  })

  describe('admin auth', () => {
    it('receiveSellerInboundShipment calls isAdminAuthenticated', () => {
      const src = fs.readFileSync(ACTION_FILE, 'utf8')
      // Find the receiveSellerInboundShipment function body and confirm auth guard is present
      const idx = src.indexOf('async function receiveSellerInboundShipment')
      expect(idx).toBeGreaterThan(-1)
      const body = src.slice(idx, idx + 300)
      expect(body).toMatch(/isAdminAuthenticated/)
    })

    it('adminCancelShipment calls isAdminAuthenticated', () => {
      const src = fs.readFileSync(ACTION_FILE, 'utf8')
      const idx = src.indexOf('async function adminCancelShipment')
      expect(idx).toBeGreaterThan(-1)
      const body = src.slice(idx, idx + 300)
      expect(body).toMatch(/isAdminAuthenticated/)
    })

    it('isAdminAuthenticated is imported from adminAuth', () => {
      const src = fs.readFileSync(ACTION_FILE, 'utf8')
      expect(src).toMatch(/from '@\/lib\/adminAuth'/)
    })
  })

  describe('receipt reconciliation guards', () => {
    it('second receipt blocked: received/issue status check present', () => {
      const src = fs.readFileSync(ACTION_FILE, 'utf8')
      // The status guard must appear inside receiveSellerInboundShipment
      expect(src).toMatch(/status.*received.*already been received|already been received/i)
    })

    it('existing intake receipt returns explicit error, not silent skip', () => {
      const src = fs.readFileSync(ACTION_FILE, 'utf8')
      // Must NOT contain the old "link shipment but leave intake receipt fields untouched" comment
      expect(src).not.toMatch(/link shipment but leave intake receipt fields untouched/i)
      // Must contain an explicit reconciliation error path
      expect(src).toMatch(/already received on|already has a receipt|TX_VALIDATION/i)
    })

    it('cross-submission intake rejected: submission match check present', () => {
      const src = fs.readFileSync(ACTION_FILE, 'utf8')
      expect(src).toMatch(/does not belong to this submission/)
    })

    it('rejected/converted intake blocked', () => {
      const src = fs.readFileSync(ACTION_FILE, 'utf8')
      expect(src).toMatch(/rejected.*converted.*intake|Cannot link to a.*intake/i)
    })
  })

  describe('seller guards', () => {
    it('accepted agreement required in saveSellerInboundShipment', () => {
      const src = fs.readFileSync(ACTION_FILE, 'utf8')
      expect(src).toMatch(/accepted agreement is required/)
    })

    it('conversion block: new shipment blocked when intake converted', () => {
      const src = fs.readFileSync(ACTION_FILE, 'utf8')
      expect(src).toMatch(/converted to inventory/)
    })

    it('seller form does not include admin-only fields (receivedBy, adminNotes, conditionStatus, receivedAt)', () => {
      const src = fs.readFileSync(SELLER_FORM_FILE, 'utf8')
      expect(src).not.toMatch(/name="receivedBy"/)
      expect(src).not.toMatch(/name="adminNotes"/)
      expect(src).not.toMatch(/name="receivedAt"/)
      expect(src).not.toMatch(/name="conditionStatus"/)
    })

    it('seller form does not expose adminNotes in display', () => {
      const src = fs.readFileSync(SELLER_FORM_FILE, 'utf8')
      expect(src).not.toMatch(/adminNotes/)
      expect(src).not.toMatch(/receivedBy/)
    })

    it('tracking normalization: insensitive mode used for duplicate check', () => {
      const src = fs.readFileSync(ACTION_FILE, 'utf8')
      expect(src).toMatch(/mode.*insensitive/)
    })
  })

  describe('case/event idempotency', () => {
    it('receipt event uses unique eventKey', () => {
      const src = fs.readFileSync(ACTION_FILE, 'utf8')
      expect(src).toMatch(/eventKey.*shipment-received/)
    })

    it('cancel event uses unique eventKey', () => {
      const src = fs.readFileSync(ACTION_FILE, 'utf8')
      expect(src).toMatch(/eventKey.*shipment-cancelled/)
    })

    it('issue case creation checks for existing open case before creating', () => {
      const src = fs.readFileSync(ACTION_FILE, 'utf8')
      expect(src).toMatch(/findFirst.*caseType.*issueCaseType|existingCase/)
    })
  })
})
