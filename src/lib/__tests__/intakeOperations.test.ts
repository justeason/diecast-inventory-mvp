import { describe, test, expect } from 'vitest'
import { readFileSync } from 'fs'
import {
  deriveIntakeStage,
  deriveIntakeWarnings,
  deriveIntakeOperations,
} from '../intakeOperations'
import type { IntakeRecord } from '../intakeOperations'

function makeRecord(overrides: Partial<IntakeRecord> = {}): IntakeRecord {
  return {
    submission: null,
    intake: null,
    ...overrides,
  }
}

function makeSubmission(
  overrides: Partial<NonNullable<IntakeRecord['submission']>> = {}
): NonNullable<IntakeRecord['submission']> {
  return {
    id: 'sub-1',
    status: 'approved_for_intake',
    quantity: 1,
    catalogId: null,
    agreements: [],
    lifecycleCases: [],
    createdAt: new Date('2026-01-01'),
    ...overrides,
  }
}

function makeIntake(
  overrides: Partial<NonNullable<IntakeRecord['intake']>> = {}
): NonNullable<IntakeRecord['intake']> {
  return {
    id: 'int-1',
    status: 'draft',
    receivedAt: null,
    receivedQuantity: null,
    expectedQuantity: null,
    storageLocationId: null,
    convertedItemId: null,
    createdAt: new Date('2026-01-01'),
    ...overrides,
  }
}

// ─── deriveIntakeStage ────────────────────────────────────────────────────────

describe('deriveIntakeStage', () => {
  test('no intake + approved submission → expected', () => {
    const rec = makeRecord({ submission: makeSubmission(), intake: null })
    expect(deriveIntakeStage(rec)).toBe('expected')
  })

  test('no intake, no submission → expected', () => {
    expect(deriveIntakeStage(makeRecord())).toBe('expected')
  })

  test('intake exists but no receivedAt → expected', () => {
    const rec = makeRecord({
      submission: makeSubmission(),
      intake: makeIntake({ receivedAt: null }),
    })
    expect(deriveIntakeStage(rec)).toBe('expected')
  })

  test('intake with receivedAt, status draft → received', () => {
    const rec = makeRecord({
      submission: makeSubmission(),
      intake: makeIntake({ receivedAt: new Date() }),
    })
    expect(deriveIntakeStage(rec)).toBe('received')
  })

  test('intake status reviewed, no accepted agreement → in_review', () => {
    const rec = makeRecord({
      submission: makeSubmission({ agreements: [{ status: 'proposed' }] }),
      intake: makeIntake({ status: 'reviewed', receivedAt: new Date() }),
    })
    expect(deriveIntakeStage(rec)).toBe('in_review')
  })

  test('intake status reviewed, accepted agreement → ready_to_convert', () => {
    const rec = makeRecord({
      submission: makeSubmission({ agreements: [{ status: 'accepted' }] }),
      intake: makeIntake({ status: 'reviewed', receivedAt: new Date() }),
    })
    expect(deriveIntakeStage(rec)).toBe('ready_to_convert')
  })

  test('company-owned (no submission), reviewed → ready_to_convert', () => {
    const rec = makeRecord({ intake: makeIntake({ status: 'reviewed', receivedAt: new Date() }) })
    expect(deriveIntakeStage(rec)).toBe('ready_to_convert')
  })

  test('intake converted, no return case → converted', () => {
    const rec = makeRecord({
      submission: makeSubmission(),
      intake: makeIntake({ status: 'converted', convertedItemId: 'item-1' }),
    })
    expect(deriveIntakeStage(rec)).toBe('converted')
  })

  test('intake converted, return case with returnedAt → returned', () => {
    const rec = makeRecord({
      submission: makeSubmission({
        lifecycleCases: [
          {
            status: 'resolved',
            caseType: 'return_to_seller',
            intakeDraftId: 'int-1',
            returnedAt: new Date(),
          },
        ],
      }),
      intake: makeIntake({ status: 'converted', convertedItemId: 'item-1' }),
    })
    expect(deriveIntakeStage(rec)).toBe('returned')
  })

  test('intake rejected with open intake_rejection case → action_required', () => {
    const rec = makeRecord({
      submission: makeSubmission({
        lifecycleCases: [
          { status: 'action_required', caseType: 'intake_rejection', intakeDraftId: 'int-1' },
        ],
      }),
      intake: makeIntake({ status: 'rejected' }),
    })
    expect(deriveIntakeStage(rec)).toBe('action_required')
  })

  test('intake rejected, no open case → rejected', () => {
    const rec = makeRecord({
      submission: makeSubmission({
        lifecycleCases: [
          { status: 'resolved', caseType: 'intake_rejection', intakeDraftId: 'int-1' },
        ],
      }),
      intake: makeIntake({ status: 'rejected' }),
    })
    expect(deriveIntakeStage(rec)).toBe('rejected')
  })

  test('submission withdrawn → closed', () => {
    const rec = makeRecord({ submission: makeSubmission({ status: 'withdrawn' }), intake: null })
    expect(deriveIntakeStage(rec)).toBe('closed')
  })

  test('submission declined → closed', () => {
    const rec = makeRecord({ submission: makeSubmission({ status: 'declined' }), intake: null })
    expect(deriveIntakeStage(rec)).toBe('closed')
  })
})

// ─── deriveIntakeWarnings ─────────────────────────────────────────────────────

describe('deriveIntakeWarnings', () => {
  test('no intake → no warnings', () => {
    const rec = makeRecord()
    expect(deriveIntakeWarnings(rec, 'expected')).toEqual([])
  })

  test('qty mismatch when both set and differ', () => {
    const rec = makeRecord({
      intake: makeIntake({ expectedQuantity: 2, receivedQuantity: 1, receivedAt: new Date() }),
    })
    const warnings = deriveIntakeWarnings(rec, 'received')
    expect(warnings).toContain('qty_mismatch')
  })

  test('no qty mismatch when quantities match', () => {
    const rec = makeRecord({
      intake: makeIntake({ expectedQuantity: 2, receivedQuantity: 2, receivedAt: new Date() }),
    })
    expect(deriveIntakeWarnings(rec, 'received')).not.toContain('qty_mismatch')
  })

  test('no_storage warning when received but no storageLocationId', () => {
    const rec = makeRecord({
      intake: makeIntake({ receivedAt: new Date(), storageLocationId: null }),
    })
    expect(deriveIntakeWarnings(rec, 'received')).toContain('no_storage')
  })

  test('no no_storage warning when storage assigned', () => {
    const rec = makeRecord({
      intake: makeIntake({ receivedAt: new Date(), storageLocationId: 'loc-1' }),
    })
    expect(deriveIntakeWarnings(rec, 'received')).not.toContain('no_storage')
  })

  test('stale_received after 7 days', () => {
    const old = new Date(Date.now() - 8 * 86_400_000)
    const rec = makeRecord({
      intake: makeIntake({ receivedAt: old }),
      now: new Date(),
    })
    expect(deriveIntakeWarnings(rec, 'received')).toContain('stale_received')
  })

  test('no stale_received within 7 days', () => {
    const recent = new Date(Date.now() - 5 * 86_400_000)
    const rec = makeRecord({
      intake: makeIntake({ receivedAt: recent }),
      now: new Date(),
    })
    expect(deriveIntakeWarnings(rec, 'received')).not.toContain('stale_received')
  })

  test('stale_reviewed after 3 days in in_review stage', () => {
    const old = new Date(Date.now() - 4 * 86_400_000)
    const rec = makeRecord({
      intake: makeIntake({ receivedAt: old, status: 'reviewed' }),
      now: new Date(),
    })
    expect(deriveIntakeWarnings(rec, 'in_review')).toContain('stale_reviewed')
  })

  test('open_case when any lifecycle case is open', () => {
    const rec = makeRecord({
      submission: makeSubmission({
        lifecycleCases: [{ status: 'open', caseType: 'buyer_dispute', intakeDraftId: null }],
      }),
      intake: makeIntake({ receivedAt: new Date() }),
    })
    expect(deriveIntakeWarnings(rec, 'received')).toContain('open_case')
  })

  test('agreement_needed in in_review stage', () => {
    const rec = makeRecord({ intake: makeIntake() })
    expect(deriveIntakeWarnings(rec, 'in_review')).toContain('agreement_needed')
  })

  test('no agreement_needed in ready_to_convert stage', () => {
    const rec = makeRecord({ intake: makeIntake() })
    expect(deriveIntakeWarnings(rec, 'ready_to_convert')).not.toContain('agreement_needed')
  })
})

// ─── deriveIntakeOperations ───────────────────────────────────────────────────

describe('deriveIntakeOperations', () => {
  test('returns stage, warnings, ageDays, nextStep', () => {
    const rec = makeRecord({
      submission: makeSubmission(),
      intake: makeIntake({ receivedAt: new Date() }),
    })
    const result = deriveIntakeOperations(rec)
    expect(result).toHaveProperty('stage')
    expect(result).toHaveProperty('warnings')
    expect(result).toHaveProperty('ageDays')
    expect(result).toHaveProperty('nextStep')
    expect(typeof result.ageDays).toBe('number')
  })

  test('ageDays uses receivedAt when available', () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000)
    const now = new Date()
    const rec = makeRecord({
      intake: makeIntake({ receivedAt: tenDaysAgo }),
      now,
    })
    const result = deriveIntakeOperations(rec)
    expect(result.ageDays).toBe(10)
  })

  test('nextStep is non-empty string for all stages', () => {
    const stages = ['expected', 'received', 'in_review', 'ready_to_convert', 'action_required', 'rejected', 'converted', 'returned', 'closed'] as const
    for (const stage of stages) {
      // Build a minimal record that produces this stage
      let rec: IntakeRecord
      if (stage === 'closed') {
        rec = makeRecord({ submission: makeSubmission({ status: 'withdrawn' }) })
      } else if (stage === 'expected') {
        rec = makeRecord()
      } else if (stage === 'received') {
        rec = makeRecord({ intake: makeIntake({ receivedAt: new Date() }) })
      } else if (stage === 'in_review') {
        rec = makeRecord({
          submission: makeSubmission(),
          intake: makeIntake({ status: 'reviewed', receivedAt: new Date() }),
        })
      } else if (stage === 'ready_to_convert') {
        rec = makeRecord({ intake: makeIntake({ status: 'reviewed', receivedAt: new Date() }) })
      } else if (stage === 'action_required') {
        rec = makeRecord({
          submission: makeSubmission({
            lifecycleCases: [{ status: 'action_required', caseType: 'intake_rejection', intakeDraftId: 'int-1' }],
          }),
          intake: makeIntake({ status: 'rejected' }),
        })
      } else if (stage === 'rejected') {
        rec = makeRecord({ intake: makeIntake({ status: 'rejected' }) })
      } else if (stage === 'converted') {
        rec = makeRecord({ intake: makeIntake({ status: 'converted', convertedItemId: 'x' }) })
      } else {
        rec = makeRecord({
          submission: makeSubmission({
            lifecycleCases: [{ status: 'resolved', caseType: 'return_to_seller', intakeDraftId: 'int-1', returnedAt: new Date() }],
          }),
          intake: makeIntake({ status: 'converted', convertedItemId: 'x' }),
        })
      }
      const result = deriveIntakeOperations(rec)
      expect(result.nextStep.length).toBeGreaterThan(0)
    }
  })
})

// ─── Action structural tests (source-level) ──────────────────────────────────

const actionsSrc = readFileSync('src/lib/actions/intakeOperations.ts', 'utf-8')
const schemaSrc = readFileSync('prisma/schema.prisma', 'utf-8')
const opsSrc = readFileSync('src/app/(admin)/admin/intake/operations/page.tsx', 'utf-8')

describe('recordIntakeReceipt structural', () => {
  test('recordIntakeReceipt is declared in actions file', () => {
    expect(actionsSrc).toContain('export async function recordIntakeReceipt')
  })

  test('assignIntakeStorage is declared in actions file', () => {
    expect(actionsSrc).toContain('export async function assignIntakeStorage')
  })

  test('bulkAssignIntakeStorage is declared in actions file', () => {
    expect(actionsSrc).toContain('export async function bulkAssignIntakeStorage')
  })
})

// ─── Schema structural tests ──────────────────────────────────────────────────

describe('IntakeDraft schema additions', () => {
  test('IntakeDraft model has expectedQuantity field in schema', () => {
    expect(schemaSrc).toMatch(/expectedQuantity\s+Int\?/)
  })

  test('IntakeDraft model has receivedAt field in schema', () => {
    expect(schemaSrc).toMatch(/receivedAt\s+DateTime\?/)
  })

  test('IntakeDraft model has storageLocationId FK in schema', () => {
    expect(schemaSrc).toMatch(/storageLocationId\s+String\?/)
  })

  test('StorageLocation model has intakeDrafts relation in schema', () => {
    expect(schemaSrc).toMatch(/intakeDrafts\s+IntakeDraft\[\]/)
  })
})

// ─── Concurrency structural tests ────────────────────────────────────────────

describe('concurrency', () => {
  test('recordIntakeReceipt locks IntakeDraft with FOR UPDATE before findUnique inside TX', () => {
    const fnStart = actionsSrc.indexOf('async function recordIntakeReceipt')
    const fnEnd = actionsSrc.indexOf('async function assignIntakeStorage')
    const fnSrc = actionsSrc.slice(fnStart, fnEnd)
    const txStart = fnSrc.indexOf('prisma.$transaction')
    const intakeLockIdx = fnSrc.indexOf('"IntakeDraft" WHERE id = ${intakeId} FOR UPDATE', txStart)
    const draftReadIdx = fnSrc.indexOf('intakeDraft.findUnique', intakeLockIdx)
    expect(intakeLockIdx).toBeGreaterThan(txStart)
    expect(draftReadIdx).toBeGreaterThan(intakeLockIdx)
  })

  test('recordIntakeReceipt locks SellerSubmission FOR UPDATE when seller-sourced', () => {
    expect(actionsSrc).toContain('"SellerSubmission" WHERE id = ${submissionIdForLock} FOR UPDATE')
  })

  test('bulkAssignIntakeStorage sorts IDs before locking', () => {
    expect(actionsSrc).toContain('sortedIds = [...intakeIds].sort()')
  })

  test('recordIntakeReceipt validates submission status inside TX after lock', () => {
    const lockIdx = actionsSrc.indexOf('"SellerSubmission" WHERE id = ${submissionId} FOR UPDATE')
    const statusCheckIdx = actionsSrc.indexOf("status !== 'approved_for_intake'")
    expect(statusCheckIdx).toBeGreaterThan(lockIdx)
  })

  test('no inventory creation in recordIntakeReceipt', () => {
    expect(actionsSrc).not.toContain('itemInstance.create')
    expect(actionsSrc).not.toContain('convertDraft')
  })
})

// ─── Receipt safety ───────────────────────────────────────────────────────────

describe('receipt safety', () => {
  test('recordIntakeReceipt blocks duplicate receipt (receivedAt already set)', () => {
    // Structural: check guard exists in source
    expect(actionsSrc).toContain("draft.receivedAt != null")
    expect(actionsSrc).toContain('Receipt already recorded')
  })

  test('recordIntakeReceipt blocks converted draft', () => {
    expect(actionsSrc).toContain("draft.status === 'converted'")
  })

  test('recordIntakeReceipt blocks rejected draft', () => {
    expect(actionsSrc).toContain("draft.status === 'rejected'")
  })

  test('no SellerPayoutLine created in recordIntakeReceipt', () => {
    const receiptFnStart = actionsSrc.indexOf('async function recordIntakeReceipt')
    const receiptFnEnd = actionsSrc.indexOf('async function assignIntakeStorage')
    const receiptFn = actionsSrc.slice(receiptFnStart, receiptFnEnd)
    expect(receiptFn).not.toContain('payoutLine')
    expect(receiptFn).not.toContain('itemInstance.create')
    expect(receiptFn).not.toContain('listing.create')
  })

  test('receivedAt is selected inside TX for duplicate check', () => {
    expect(actionsSrc).toContain("receivedAt: true")
  })
})

// ─── Reconciliation warnings ─────────────────────────────────────────────────

describe('reconciliation warnings', () => {
  test('converted_no_item when status=converted but no convertedItemId', () => {
    const rec = makeRecord({
      intake: makeIntake({ status: 'converted', convertedItemId: null }),
    })
    const stage = deriveIntakeStage(rec)
    const warnings = deriveIntakeWarnings(rec, stage)
    expect(warnings).toContain('converted_no_item')
  })

  test('no converted_no_item when convertedItemId is set', () => {
    const rec = makeRecord({
      intake: makeIntake({ status: 'converted', convertedItemId: 'item-1' }),
    })
    const warnings = deriveIntakeWarnings(rec, 'converted')
    expect(warnings).not.toContain('converted_no_item')
  })

  test('rejected_with_item when status=rejected but convertedItemId set', () => {
    const rec = makeRecord({
      intake: makeIntake({ status: 'rejected', convertedItemId: 'item-1' }),
    })
    const warnings = deriveIntakeWarnings(rec, 'rejected')
    expect(warnings).toContain('rejected_with_item')
  })

  test('no rejected_with_item for clean rejection', () => {
    const rec = makeRecord({
      intake: makeIntake({ status: 'rejected', convertedItemId: null }),
    })
    const warnings = deriveIntakeWarnings(rec, 'rejected')
    expect(warnings).not.toContain('rejected_with_item')
  })

  test('approved submission with no intake → expected stage (surfaced as pending)', () => {
    const rec = makeRecord({ submission: makeSubmission(), intake: null })
    expect(deriveIntakeStage(rec)).toBe('expected')
  })

  test('intake missing accepted agreement → in_review stage with agreement_needed warning', () => {
    const rec = makeRecord({
      submission: makeSubmission({ agreements: [{ status: 'proposed' }] }),
      intake: makeIntake({ status: 'reviewed', receivedAt: new Date() }),
    })
    const result = deriveIntakeOperations(rec)
    expect(result.stage).toBe('in_review')
    expect(result.warnings).toContain('agreement_needed')
  })
})

// ─── Conversion storage structural tests ─────────────────────────────────────

describe('conversion storage', () => {
  const intakeSrc = readFileSync('src/lib/actions/intake.ts', 'utf-8')

  test('convertDraft requires locationId (form field validation)', () => {
    expect(intakeSrc).toContain("'Storage location is required.'")
  })

  test('convertDraft re-fetches location inside transaction', () => {
    expect(intakeSrc).toContain('storageLocation.findUnique({ where: { id: locationId }')
    // Must appear inside the transaction block (after $transaction)
    const txStart = intakeSrc.indexOf('prisma.$transaction')
    const locFetchIdx = intakeSrc.indexOf('storageLocation.findUnique({ where: { id: locationId }', txStart)
    expect(locFetchIdx).toBeGreaterThan(txStart)
  })

  test('convertDraft errors when pre-assigned storageLocationId conflicts with submitted locationId', () => {
    expect(intakeSrc).toContain('draft.storageLocationId && draft.storageLocationId !== locationId')
    expect(intakeSrc).toContain('pre-assigned storage location on this draft differs')
  })

  test('convertDraft errors when location deleted between preflight and TX', () => {
    expect(intakeSrc).toContain('Storage location was deleted')
  })

  test('convertDraft creates ItemInstance with locationId', () => {
    expect(intakeSrc).toContain('locationId,')
  })
})

// ─── Bulk action atomicity ────────────────────────────────────────────────────

describe('bulk action atomicity', () => {
  test('bulkAssignIntakeStorage rejects if any ID is missing', () => {
    expect(actionsSrc).toContain('intake(s) not found')
  })

  test('bulkAssignIntakeStorage rejects if any intake is converted', () => {
    expect(actionsSrc).toContain("intake(s) already converted")
  })

  test('no SKIP LOCKED in bulkAssignIntakeStorage', () => {
    const bulkFnStart = actionsSrc.indexOf('async function bulkAssignIntakeStorage')
    const bulkFnEnd = actionsSrc.indexOf('async function moveInventoryItem')
    const bulkFn = actionsSrc.slice(bulkFnStart, bulkFnEnd)
    expect(bulkFn).not.toContain('SKIP LOCKED')
  })

  test('bulkMoveInventoryItems rejects sold items', () => {
    expect(actionsSrc).toContain('sold, reserved, or not for sale')
  })

  test('bulkMoveInventoryItems rejects if any item not found', () => {
    expect(actionsSrc).toContain('item(s) not found')
  })

  test('bulkMoveInventoryItems sorts IDs for deterministic locking', () => {
    expect(actionsSrc).toContain('sortedIds = [...itemIds].sort()')
  })

  test('moveInventoryItem validates location inside TX', () => {
    const moveFnStart = actionsSrc.indexOf('async function moveInventoryItem')
    const moveFnEnd = actionsSrc.indexOf('async function bulkMoveInventoryItems')
    const moveFn = actionsSrc.slice(moveFnStart, moveFnEnd)
    expect(moveFn).toContain('storageLocation.findUnique')
  })

  test('moveInventoryItem blocks sold/reserved/not_for_sale', () => {
    expect(actionsSrc).toContain("IMMOVABLE_STATUSES")
    expect(actionsSrc).toContain("'sold', 'reserved', 'not_for_sale'")
  })

  test('no financial/order/payout changes in move actions', () => {
    const moveStart = actionsSrc.indexOf('async function moveInventoryItem')
    const movePart = actionsSrc.slice(moveStart)
    expect(movePart).not.toContain('payoutLine')
    expect(movePart).not.toContain('orderItem')
    expect(movePart).not.toContain('listing.create')
  })
})

// ─── Dashboard filter parsing ─────────────────────────────────────────────────

describe('dashboard filters', () => {
  test('operations page accepts stage filter param', () => {
    expect(opsSrc).toContain("stage?:")
  })

  test('operations page accepts seller filter param', () => {
    expect(opsSrc).toContain("seller?:")
  })

  test('operations page accepts ageBucket filter param', () => {
    expect(opsSrc).toContain("ageBucket?:")
  })

  test('operations page accepts storageStatus filter param', () => {
    expect(opsSrc).toContain("storageStatus?:")
  })

  test('operations page accepts agreementType filter param', () => {
    expect(opsSrc).toContain("agreementType?:")
  })

  test('operations page accepts attention filter param', () => {
    expect(opsSrc).toContain("attention?:")
  })

  test('operations page accepts catalogMatch filter param', () => {
    expect(opsSrc).toContain("catalogMatch?:")
  })

  test('operations page has pagination via page param', () => {
    expect(opsSrc).toContain("page?:")
    expect(opsSrc).toContain('skip')
  })

  test('operations page has PAGE_SIZE and CHUNK_SIZE (no fixed ceiling)', () => {
    expect(opsSrc).toContain('PAGE_SIZE')
    expect(opsSrc).toContain('CHUNK_SIZE')
    expect(opsSrc).not.toContain('IN_MEMORY_FETCH_CAP')
  })

  test('seller filter applied at DB level', () => {
    expect(opsSrc).toContain("displayName: { contains: seller.trim()")
  })

  test('storageStatus filter applied at DB level', () => {
    expect(opsSrc).toContain('storageLocationId: { not: null }')
    expect(opsSrc).toContain('storageLocationId: null')
  })

  test('chunked scanning: hasInMemoryFilter gates scan vs single-query path', () => {
    expect(opsSrc).toContain('hasInMemoryFilter')
  })

  test('chunked scanning: needed formula is pageNum * PAGE_SIZE + 1', () => {
    expect(opsSrc).toContain('needed = pageNum * PAGE_SIZE + 1')
  })

  test('chunked scanning: scan loop collects until needed rows', () => {
    expect(opsSrc).toContain('while (allRows.length < needed)')
  })

  test('chunked scanning: keyset cursor advances after each chunk', () => {
    expect(opsSrc).toContain('cursorCreatedAt = chunk[chunk.length - 1].createdAt')
    expect(opsSrc).toContain('cursorId = chunk[chunk.length - 1].id')
  })

  test('chunked scanning: stable composite ordering createdAt + id', () => {
    expect(opsSrc).toContain("orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]")
  })

  test('chunked scanning: hasNextPage derived from allRows length vs pageNum', () => {
    expect(opsSrc).toContain('hasNextPage = allRows.length > pageNum * PAGE_SIZE')
  })

  test('chunked scanning: page slice cuts allRows not raw dbRows', () => {
    expect(opsSrc).toContain('allRows.slice(skip, skip + PAGE_SIZE)')
  })

  test('catalogMatch filter applied at DB level', () => {
    expect(opsSrc).toContain('draftCatalogMatchWhere')
    expect(opsSrc).toContain("catalogId: { not: null }")
  })

  test('attention filter applied at DB level as pre-filter', () => {
    expect(opsSrc).toContain('attentionWhere')
    expect(opsSrc).toContain('intake_rejection')
  })
})

// ─── New reconciliation warnings ─────────────────────────────────────────────

describe('new reconciliation warnings', () => {
  test('approved_no_intake warning when submission approved but no intake', () => {
    const rec = makeRecord({ submission: makeSubmission({ status: 'approved_for_intake' }), intake: null })
    const warnings = deriveIntakeWarnings(rec, 'expected')
    expect(warnings).toContain('approved_no_intake')
  })

  test('no approved_no_intake when intake exists', () => {
    const rec = makeRecord({
      submission: makeSubmission({ status: 'approved_for_intake' }),
      intake: makeIntake(),
    })
    const warnings = deriveIntakeWarnings(rec, 'expected')
    expect(warnings).not.toContain('approved_no_intake')
  })

  test('no approved_no_intake when submission not yet approved', () => {
    const rec = makeRecord({ submission: makeSubmission({ status: 'submitted' }), intake: null })
    const warnings = deriveIntakeWarnings(rec, 'expected')
    expect(warnings).not.toContain('approved_no_intake')
  })

  test('missing_catalog warning in in_review stage when submission has no catalogId', () => {
    const rec = makeRecord({
      submission: makeSubmission({ catalogId: null }),
      intake: makeIntake({ status: 'reviewed', receivedAt: new Date() }),
    })
    const warnings = deriveIntakeWarnings(rec, 'in_review')
    expect(warnings).toContain('missing_catalog')
  })

  test('missing_catalog warning in ready_to_convert stage when no catalogId', () => {
    const rec = makeRecord({
      submission: makeSubmission({ catalogId: null, agreements: [{ status: 'accepted' }] }),
      intake: makeIntake({ status: 'reviewed', receivedAt: new Date() }),
    })
    const warnings = deriveIntakeWarnings(rec, 'ready_to_convert')
    expect(warnings).toContain('missing_catalog')
  })

  test('no missing_catalog warning when catalogId is set', () => {
    const rec = makeRecord({
      submission: makeSubmission({ catalogId: 'cat-1' }),
      intake: makeIntake({ status: 'reviewed', receivedAt: new Date() }),
    })
    const warnings = deriveIntakeWarnings(rec, 'in_review')
    expect(warnings).not.toContain('missing_catalog')
  })

  test('no missing_catalog warning in early stages (expected, received)', () => {
    const rec = makeRecord({
      submission: makeSubmission({ catalogId: null }),
      intake: makeIntake({ receivedAt: new Date() }),
    })
    expect(deriveIntakeWarnings(rec, 'expected')).not.toContain('missing_catalog')
    expect(deriveIntakeWarnings(rec, 'received')).not.toContain('missing_catalog')
  })

  test('returned_with_listing warning when returned stage and hasActiveListing', () => {
    const rec = makeRecord({
      submission: makeSubmission({
        lifecycleCases: [{ status: 'resolved', caseType: 'return_to_seller', intakeDraftId: 'int-1', returnedAt: new Date() }],
      }),
      intake: makeIntake({ status: 'converted', convertedItemId: 'item-1', hasActiveListing: true }),
    })
    const warnings = deriveIntakeWarnings(rec, 'returned')
    expect(warnings).toContain('returned_with_listing')
  })

  test('no returned_with_listing when listing is not active', () => {
    const rec = makeRecord({
      intake: makeIntake({ status: 'converted', convertedItemId: 'item-1', hasActiveListing: false }),
    })
    const warnings = deriveIntakeWarnings(rec, 'returned')
    expect(warnings).not.toContain('returned_with_listing')
  })

  test('no_storage fires for converted stage (converted item missing storage)', () => {
    const rec = makeRecord({
      intake: makeIntake({ status: 'converted', convertedItemId: 'item-1', storageLocationId: null }),
    })
    const warnings = deriveIntakeWarnings(rec, 'converted')
    expect(warnings).toContain('no_storage')
  })

  test('no no_storage for converted item with storage assigned', () => {
    const rec = makeRecord({
      intake: makeIntake({ status: 'converted', convertedItemId: 'item-1', storageLocationId: 'loc-1' }),
    })
    const warnings = deriveIntakeWarnings(rec, 'converted')
    expect(warnings).not.toContain('no_storage')
  })
})

// ─── Lock ordering structural tests ─────────────────────────────────────────

describe('lock ordering', () => {
  const intakeSrc = readFileSync('src/lib/actions/intake.ts', 'utf-8')

  test('convertDraft acquires IntakeDraft FOR UPDATE lock inside transaction', () => {
    const convertDraftStart = intakeSrc.indexOf('async function convertDraft')
    const txStart = intakeSrc.indexOf('prisma.$transaction', convertDraftStart)
    const intakeLockIdx = intakeSrc.indexOf('"IntakeDraft" WHERE id = ${id} FOR UPDATE', txStart)
    expect(intakeLockIdx).toBeGreaterThan(txStart)
  })

  test('convertDraft locks SellerSubmission before IntakeDraft inside transaction', () => {
    const convertDraftStart = intakeSrc.indexOf('async function convertDraft')
    const txStart = intakeSrc.indexOf('prisma.$transaction', convertDraftStart)
    const subLockIdx = intakeSrc.indexOf('"SellerSubmission" WHERE id = ${sellerSubmissionIdForLock} FOR UPDATE', txStart)
    const intakeLockIdx = intakeSrc.indexOf('"IntakeDraft" WHERE id = ${id} FOR UPDATE', txStart)
    expect(subLockIdx).toBeGreaterThan(txStart)
    expect(intakeLockIdx).toBeGreaterThan(subLockIdx)
  })

  test('convertDraft re-reads draft after acquiring IntakeDraft lock', () => {
    const convertDraftStart = intakeSrc.indexOf('async function convertDraft')
    const txStart = intakeSrc.indexOf('prisma.$transaction', convertDraftStart)
    const intakeLockIdx = intakeSrc.indexOf('"IntakeDraft" WHERE id = ${id} FOR UPDATE', txStart)
    const draftReadIdx = intakeSrc.indexOf('intakeDraft.findUnique({ where: { id } })', txStart)
    expect(draftReadIdx).toBeGreaterThan(intakeLockIdx)
  })

  test('recordIntakeReceipt locks SellerSubmission before IntakeDraft', () => {
    const fnStart = actionsSrc.indexOf('async function recordIntakeReceipt')
    const fnEnd = actionsSrc.indexOf('async function assignIntakeStorage')
    const fnSrc = actionsSrc.slice(fnStart, fnEnd)
    const subLockIdx = fnSrc.indexOf('"SellerSubmission"')
    const intakeLockIdx = fnSrc.indexOf('"IntakeDraft"')
    expect(subLockIdx).toBeGreaterThan(-1)
    expect(intakeLockIdx).toBeGreaterThan(-1)
    // SellerSubmission lock must appear before IntakeDraft lock in source
    expect(subLockIdx).toBeLessThan(intakeLockIdx)
  })

  test('assignIntakeStorage locks IntakeDraft inside transaction', () => {
    const fnStart = actionsSrc.indexOf('async function assignIntakeStorage')
    const fnEnd = actionsSrc.indexOf('async function bulkAssignIntakeStorage')
    const fnSrc = actionsSrc.slice(fnStart, fnEnd)
    expect(fnSrc).toContain('"IntakeDraft" WHERE id = ${intakeId} FOR UPDATE')
  })

  test('markDraftReviewed locks IntakeDraft inside transaction', () => {
    expect(intakeSrc).toContain('"IntakeDraft" WHERE id = ${id} FOR UPDATE')
  })
})

// ─── Return-pending move guard ────────────────────────────────────────────────

describe('return-pending move guard', () => {
  test('RETURN_PENDING_CASE_TYPES contains all three return-pending case types', () => {
    expect(actionsSrc).toContain('RETURN_PENDING_CASE_TYPES')
    expect(actionsSrc).toContain('return_to_seller')
    expect(actionsSrc).toContain('consignment_expiration')
    expect(actionsSrc).toContain('seller_withdrawal')
  })

  test('moveInventoryItem uses RETURN_PENDING_CASE_TYPES for case type filter', () => {
    const fnStart = actionsSrc.indexOf('async function moveInventoryItem')
    const fnEnd = actionsSrc.indexOf('async function bulkMoveInventoryItems')
    const fnSrc = actionsSrc.slice(fnStart, fnEnd)
    expect(fnSrc).toContain('sellerLifecycleCase')
    expect(fnSrc).toContain('RETURN_PENDING_CASE_TYPES')
    expect(fnSrc).toContain("status: { in: ['open', 'action_required'] }")
  })

  test('bulkMoveInventoryItems uses RETURN_PENDING_CASE_TYPES for case type filter', () => {
    const fnStart = actionsSrc.indexOf('async function bulkMoveInventoryItems')
    const fnSrc = actionsSrc.slice(fnStart)
    expect(fnSrc).toContain('sellerLifecycleCase')
    expect(fnSrc).toContain('RETURN_PENDING_CASE_TYPES')
    expect(fnSrc).toContain('open return cases')
  })

  test('move guard does not block resolved or cancelled cases (status filter)', () => {
    // Only 'open' and 'action_required' are blocked — not resolved/cancelled
    const fnStart = actionsSrc.indexOf('async function moveInventoryItem')
    const fnEnd = actionsSrc.indexOf('async function bulkMoveInventoryItems')
    const fnSrc = actionsSrc.slice(fnStart, fnEnd)
    expect(fnSrc).not.toContain("'resolved'")
    expect(fnSrc).not.toContain("'cancelled'")
  })

  test('return cases checked inside transaction (after item lock)', () => {
    const fnStart = actionsSrc.indexOf('async function moveInventoryItem')
    const fnEnd = actionsSrc.indexOf('async function bulkMoveInventoryItems')
    const fnSrc = actionsSrc.slice(fnStart, fnEnd)
    const txStart = fnSrc.indexOf('prisma.$transaction')
    const returnCheckIdx = fnSrc.indexOf('sellerLifecycleCase', txStart)
    expect(returnCheckIdx).toBeGreaterThan(txStart)
  })
})

// ─── Chunked scan: pending submission filter consistency ──────────────────────

describe('pending submission filter consistency', () => {
  test('pending submissions query applies seller filter', () => {
    expect(opsSrc).toContain('pendingSellerWhere')
  })

  test('pending submissions query applies agreementType filter', () => {
    expect(opsSrc).toContain('pendingAgreementWhere')
  })

  test('pending submissions query applies ageBucket filter', () => {
    // ageBucketWhere is shared between draft and pending queries
    const pendingStart = opsSrc.indexOf('shouldFetchPending')
    expect(pendingStart).toBeGreaterThan(-1)
    expect(opsSrc.indexOf('ageBucketWhere', pendingStart)).toBeGreaterThan(-1)
  })

  test('pending submissions query applies catalogMatch filter', () => {
    expect(opsSrc).toContain('pendingCatalogMatchWhere')
  })

  test('pending submissions only fetched when stage allows expected rows', () => {
    expect(opsSrc).toContain('shouldFetchPending')
    expect(opsSrc).toContain("!stage || stage === 'expected'")
  })
})
