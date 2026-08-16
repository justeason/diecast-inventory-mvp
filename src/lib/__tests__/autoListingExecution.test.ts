// 15K: behavioral coverage for the automation execution engine. Risk is mocked at
// the PURE evaluateRiskPolicy/getEffectiveRiskPolicy boundary (never checkRiskGate —
// this file also structurally proves checkRiskGate is never imported/called, since
// automation must never create/consume a RiskApprovalRequest).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({
  prisma: {
    itemInstance: { findUnique: vi.fn(), findMany: vi.fn() },
    autoListingRun: { create: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    autoListingAttempt: { create: vi.fn(), groupBy: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn(),
  },
}))
vi.mock('@/lib/readyToListQuery', () => ({ searchReadyToListPage: vi.fn(), getItemReadyToListStatus: vi.fn() }))
vi.mock('@/lib/pricingIntelligenceQuery', () => ({ getPricingIntelligence: vi.fn() }))
vi.mock('@/lib/riskPolicyQuery', () => ({ getEffectiveRiskPolicy: vi.fn() }))
vi.mock('@/lib/riskPolicy', async () => {
  const actual = await vi.importActual<typeof import('@/lib/riskPolicy')>('@/lib/riskPolicy')
  return { ...actual, evaluateRiskPolicy: vi.fn() }
})
vi.mock('@/lib/autoListingPolicyQuery', () => ({ getEffectiveAutoListingPolicy: vi.fn() }))
vi.mock('@/lib/listingActivation', () => ({ buildListingActivationContext: vi.fn().mockResolvedValue({}), createListingAtomic: vi.fn() }))
// checkRiskGate/consumeApprovedRiskGate/markApprovalConsumed are deliberately NOT
// mocked here at all — if autoListingExecution.ts ever imported them, this test file
// would fail to even load without a mock, which is itself a useful tripwire.

import { prisma } from '@/lib/prisma'
import { searchReadyToListPage, getItemReadyToListStatus } from '@/lib/readyToListQuery'
import { getPricingIntelligence } from '@/lib/pricingIntelligenceQuery'
import { getEffectiveRiskPolicy } from '@/lib/riskPolicyQuery'
import { evaluateRiskPolicy } from '@/lib/riskPolicy'
import { getEffectiveAutoListingPolicy } from '@/lib/autoListingPolicyQuery'
import { createListingAtomic } from '@/lib/listingActivation'
import { runAutoListingBatch, previewAutoListingCandidates, AUTO_LIST_BATCH_SIZE } from '@/lib/autoListingExecution'

beforeEach(() => vi.resetAllMocks())
afterEach(() => vi.restoreAllMocks())

const POLICY = { id: 'policy1', version: 1, effectiveFrom: new Date(), enabled: true, minimumPricingConfidence: 'high' as const, pricePositionBps: 5000, notes: null, createdBy: 'admin', createdAt: new Date() }
const READY_OUTCOME = (over: Record<string, unknown> = {}) => ({ status: 'ready', blockers: [], reviewReasons: [], listingPath: 'create', pricing: { status: 'supported', estimatedValueCents: 1500, confidenceLevel: 'high', isAskOnly: false }, ...over })
const GOOD_INTEL = { isAskOnly: false, confidence: { level: 'high' }, recommendedListing: { lowCents: 1000, highCents: 2000 } }
const ITEM_ROW = (over: Record<string, unknown> = {}) => ({ id: 'item1', status: 'available', catalogId: 'cat1', listing: null, sellerAgreement: null, catalog: { brand: 'Hot Wheels', name: 'GT3', year: 2024 }, ...over })

function mockTx(itemInstanceFresh: unknown, opts: { createResult?: { ok: boolean; id?: string }; attemptError?: unknown } = {}) {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue(undefined),
    itemInstance: { findUnique: vi.fn().mockResolvedValue(itemInstanceFresh) },
    autoListingAttempt: { create: opts.attemptError ? vi.fn().mockRejectedValue(opts.attemptError) : vi.fn().mockResolvedValue({}) },
  }
  ;(createListingAtomic as Mock).mockResolvedValueOnce(opts.createResult?.ok === false ? { ok: false, reason: 'already_listed' } : { ok: true, id: opts.createResult?.id ?? 'listing1', version: 1 })
  ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(tx))
  return tx
}

function baseMocks() {
  ;(getEffectiveAutoListingPolicy as Mock).mockResolvedValue(POLICY)
  ;(prisma.autoListingRun.create as Mock).mockResolvedValue({ id: 'run1' })
  ;(prisma.autoListingRun.update as Mock).mockResolvedValue({})
  ;(prisma.autoListingAttempt.create as Mock).mockResolvedValue({})
}

describe('runAutoListingBatch — guardrails', () => {
  it('refuses to run when no policy exists', async () => {
    ;(getEffectiveAutoListingPolicy as Mock).mockResolvedValue(null)
    await expect(runAutoListingBatch('admin', null)).rejects.toThrow(/not enabled/)
    expect(searchReadyToListPage).not.toHaveBeenCalled()
  })

  it('refuses to run when the policy is disabled (Part C section 5 — safe default)', async () => {
    ;(getEffectiveAutoListingPolicy as Mock).mockResolvedValue({ ...POLICY, enabled: false })
    await expect(runAutoListingBatch('admin', null)).rejects.toThrow(/not enabled/)
    expect(searchReadyToListPage).not.toHaveBeenCalled()
  })
})

describe('runAutoListingBatch — candidate discovery reuse (Part I/20)', () => {
  it('calls searchReadyToListPage with readiness="ready" and the bounded batch size — no second candidate definition', async () => {
    baseMocks()
    ;(searchReadyToListPage as Mock).mockResolvedValue({ items: [], nextCursor: null })
    await runAutoListingBatch('admin', 'cursor0')
    expect(searchReadyToListPage).toHaveBeenCalledWith('ready', expect.any(Object), 'cursor0', AUTO_LIST_BATCH_SIZE)
    expect(AUTO_LIST_BATCH_SIZE).toBe(25)
  })

  it('snapshots the run with the resolved policyId/policyVersion and requestedBy', async () => {
    baseMocks()
    ;(searchReadyToListPage as Mock).mockResolvedValue({ items: [], nextCursor: null })
    await runAutoListingBatch('admin', null)
    expect(prisma.autoListingRun.create).toHaveBeenCalledWith({ data: { policyId: 'policy1', policyVersion: 1, requestedBy: 'admin', startCursor: null } })
  })
})

describe('runAutoListingBatch — per-item outcomes (Part K/25-27, Part C)', () => {
  it('stale readiness (no longer ready at execution time) -> stale/readiness_changed, no listing, no pricing/risk calls', async () => {
    baseMocks()
    ;(searchReadyToListPage as Mock).mockResolvedValue({ items: [{ id: 'item1', sku: 'S1', brand: 'X', name: 'Y', status: 'available' }], nextCursor: null })
    ;(getItemReadyToListStatus as Mock).mockResolvedValue({ ...READY_OUTCOME(), status: 'review_required' })
    const result = await runAutoListingBatch('admin', null)
    expect(result.stale).toBe(1)
    expect(getPricingIntelligence).not.toHaveBeenCalled()
    expect(evaluateRiskPolicy).not.toHaveBeenCalled()
    expect(prisma.autoListingAttempt.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ outcome: 'stale', reasonCode: 'readiness_changed' }) }))
  })

  it('item deleted/not found between preview and revalidation -> failed/concurrent_state_change', async () => {
    baseMocks()
    ;(searchReadyToListPage as Mock).mockResolvedValue({ items: [{ id: 'item1', sku: 'S1', brand: 'X', name: 'Y', status: 'available' }], nextCursor: null })
    ;(getItemReadyToListStatus as Mock).mockResolvedValue(READY_OUTCOME())
    ;(prisma.itemInstance.findUnique as Mock).mockResolvedValue(null)
    const result = await runAutoListingBatch('admin', null)
    expect(result.failed).toBe(1)
  })

  it('already listed by the time of the row lock -> already_listed, no pricing/risk evaluated (Part 1: re-verified INSIDE the transaction, not from a stale pre-check)', async () => {
    baseMocks()
    ;(searchReadyToListPage as Mock).mockResolvedValue({ items: [{ id: 'item1', sku: 'S1', brand: 'X', name: 'Y', status: 'available' }], nextCursor: null })
    ;(getItemReadyToListStatus as Mock).mockResolvedValue(READY_OUTCOME())
    mockTx(ITEM_ROW({ listing: { id: 'existing-listing' } }))
    const result = await runAutoListingBatch('admin', null)
    expect(result.alreadyListed).toBe(1)
    expect(getPricingIntelligence).not.toHaveBeenCalled()
  })

  it('ask-only pricing -> review_required/pricing_ask_only, never listed', async () => {
    baseMocks()
    ;(searchReadyToListPage as Mock).mockResolvedValue({ items: [{ id: 'item1', sku: 'S1', brand: 'X', name: 'Y', status: 'available' }], nextCursor: null })
    ;(getItemReadyToListStatus as Mock).mockResolvedValue(READY_OUTCOME())
    const tx = mockTx(ITEM_ROW())
    ;(getPricingIntelligence as Mock).mockResolvedValue({ ...GOOD_INTEL, isAskOnly: true })
    const result = await runAutoListingBatch('admin', null)
    expect(result.reviewRequired).toBe(1)
    expect(evaluateRiskPolicy).not.toHaveBeenCalled()
    expect(tx.autoListingAttempt.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ reasonCode: 'pricing_ask_only' }) }))
  })

  it('low confidence below policy minimum -> review_required/pricing_confidence_below_policy', async () => {
    baseMocks()
    ;(searchReadyToListPage as Mock).mockResolvedValue({ items: [{ id: 'item1', sku: 'S1', brand: 'X', name: 'Y', status: 'available' }], nextCursor: null })
    ;(getItemReadyToListStatus as Mock).mockResolvedValue(READY_OUTCOME())
    const tx = mockTx(ITEM_ROW())
    ;(getPricingIntelligence as Mock).mockResolvedValue({ ...GOOD_INTEL, confidence: { level: 'medium' } })
    const result = await runAutoListingBatch('admin', null)
    expect(result.reviewRequired).toBe(1)
    expect(tx.autoListingAttempt.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ reasonCode: 'pricing_confidence_below_policy' }) }))
  })

  it('15F deny -> denied, no listing created', async () => {
    baseMocks()
    ;(searchReadyToListPage as Mock).mockResolvedValue({ items: [{ id: 'item1', sku: 'S1', brand: 'X', name: 'Y', status: 'available' }], nextCursor: null })
    ;(getItemReadyToListStatus as Mock).mockResolvedValue(READY_OUTCOME())
    mockTx(ITEM_ROW())
    ;(getPricingIntelligence as Mock).mockResolvedValue(GOOD_INTEL)
    ;(getEffectiveRiskPolicy as Mock).mockResolvedValue({ version: 1 })
    ;(evaluateRiskPolicy as Mock).mockReturnValue({ outcome: 'deny', reasons: ['nope'], policyCode: 'x' })
    const result = await runAutoListingBatch('admin', null)
    expect(result.denied).toBe(1)
    expect(createListingAtomic).not.toHaveBeenCalled()
  })

  it('15F require_approval -> review_required, NO RiskApprovalRequest created, no listing (Part G/16, Part T)', async () => {
    baseMocks()
    ;(searchReadyToListPage as Mock).mockResolvedValue({ items: [{ id: 'item1', sku: 'S1', brand: 'X', name: 'Y', status: 'available' }], nextCursor: null })
    ;(getItemReadyToListStatus as Mock).mockResolvedValue(READY_OUTCOME())
    const tx = mockTx(ITEM_ROW())
    ;(getPricingIntelligence as Mock).mockResolvedValue(GOOD_INTEL)
    ;(getEffectiveRiskPolicy as Mock).mockResolvedValue({ version: 1 })
    ;(evaluateRiskPolicy as Mock).mockReturnValue({ outcome: 'require_approval', riskLevel: 'medium', reasons: ['high value'], policyCode: 'x' })
    const result = await runAutoListingBatch('admin', null)
    expect(result.reviewRequired).toBe(1)
    expect(createListingAtomic).not.toHaveBeenCalled()
    expect(tx.autoListingAttempt.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ reasonCode: 'risk_approval_required' }) }))
  })

  it('15F allow -> executes atomically: row lock, re-verify, tx-aware pricing, create, attempt row, all inside one SERIALIZABLE transaction', async () => {
    baseMocks()
    ;(searchReadyToListPage as Mock).mockResolvedValue({ items: [{ id: 'item1', sku: 'S1', brand: 'X', name: 'Y', status: 'available' }], nextCursor: null })
    ;(getItemReadyToListStatus as Mock).mockResolvedValue(READY_OUTCOME())
    const tx = mockTx(ITEM_ROW())
    ;(getPricingIntelligence as Mock).mockResolvedValue(GOOD_INTEL)
    ;(getEffectiveRiskPolicy as Mock).mockResolvedValue({ version: 1 })
    ;(evaluateRiskPolicy as Mock).mockReturnValue({ outcome: 'allow', reasons: [] })
    const result = await runAutoListingBatch('admin', null)
    expect(result.listed).toBe(1)
    expect(tx.$queryRaw).toHaveBeenCalled()
    // Pricing was read via the SAME tx client the item lock/create used — never the
    // plain global prisma client (Part 1 fix).
    expect(getPricingIntelligence).toHaveBeenCalledWith('cat1', expect.any(Date), tx)
    expect(createListingAtomic).toHaveBeenCalledWith(tx, expect.objectContaining({ itemId: 'item1', catalogId: 'cat1', price: 15 }))
    expect(tx.autoListingAttempt.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ outcome: 'listed', listingId: 'listing1' }) }))
    // Serializable isolation is the isolation level actually requested.
    const txCallOpts = (prisma.$transaction as Mock).mock.calls[0][1]
    expect(txCallOpts?.isolationLevel).toBe('Serializable')
  })

  it('race: item became listed between the pre-check and the row lock -> already_listed, never a second Listing', async () => {
    baseMocks()
    ;(searchReadyToListPage as Mock).mockResolvedValue({ items: [{ id: 'item1', sku: 'S1', brand: 'X', name: 'Y', status: 'available' }], nextCursor: null })
    ;(getItemReadyToListStatus as Mock).mockResolvedValue(READY_OUTCOME())
    mockTx(ITEM_ROW({ listing: { id: 'raced-listing' } }))
    const result = await runAutoListingBatch('admin', null)
    expect(result.alreadyListed).toBe(1)
    expect(createListingAtomic).not.toHaveBeenCalled()
  })

  it('item status changed (no longer available) by the time of the row lock -> stale, never listed', async () => {
    baseMocks()
    ;(searchReadyToListPage as Mock).mockResolvedValue({ items: [{ id: 'item1', sku: 'S1', brand: 'X', name: 'Y', status: 'available' }], nextCursor: null })
    ;(getItemReadyToListStatus as Mock).mockResolvedValue(READY_OUTCOME())
    mockTx(ITEM_ROW({ status: 'reserved' }))
    const result = await runAutoListingBatch('admin', null)
    expect(result.stale).toBe(1)
    expect(getPricingIntelligence).not.toHaveBeenCalled()
    expect(createListingAtomic).not.toHaveBeenCalled()
  })

  it('a P2002 on the final create is treated as already_listed, never a crash (defensive backstop, Part L/28)', async () => {
    baseMocks()
    ;(searchReadyToListPage as Mock).mockResolvedValue({ items: [{ id: 'item1', sku: 'S1', brand: 'X', name: 'Y', status: 'available' }], nextCursor: null })
    ;(getItemReadyToListStatus as Mock).mockResolvedValue(READY_OUTCOME())
    mockTx(ITEM_ROW(), { createResult: { ok: false } })
    ;(getPricingIntelligence as Mock).mockResolvedValue(GOOD_INTEL)
    ;(getEffectiveRiskPolicy as Mock).mockResolvedValue({ version: 1 })
    ;(evaluateRiskPolicy as Mock).mockReturnValue({ outcome: 'allow', reasons: [] })
    const result = await runAutoListingBatch('admin', null)
    expect(result.alreadyListed).toBe(1)
  })

  it('pricing is read via getPricingIntelligence exactly ONCE per candidate — never "fetch twice and hope nothing changed" (Part 1 explicit prohibition)', async () => {
    baseMocks()
    ;(searchReadyToListPage as Mock).mockResolvedValue({ items: [{ id: 'item1', sku: 'S1', brand: 'X', name: 'Y', status: 'available' }], nextCursor: null })
    ;(getItemReadyToListStatus as Mock).mockResolvedValue(READY_OUTCOME())
    mockTx(ITEM_ROW())
    ;(getPricingIntelligence as Mock).mockResolvedValue(GOOD_INTEL)
    ;(getEffectiveRiskPolicy as Mock).mockResolvedValue({ version: 1 })
    ;(evaluateRiskPolicy as Mock).mockReturnValue({ outcome: 'allow', reasons: [] })
    await runAutoListingBatch('admin', null)
    expect(getPricingIntelligence).toHaveBeenCalledTimes(1)
  })

  it('the successful attempt\'s pricingSnapshot/proposedPriceCents/riskSnapshot are all derived from the SAME intel object used to create the Listing — never a separately-fetched evidence set', async () => {
    baseMocks()
    ;(searchReadyToListPage as Mock).mockResolvedValue({ items: [{ id: 'item1', sku: 'S1', brand: 'X', name: 'Y', status: 'available' }], nextCursor: null })
    ;(getItemReadyToListStatus as Mock).mockResolvedValue(READY_OUTCOME())
    const tx = mockTx(ITEM_ROW())
    ;(getPricingIntelligence as Mock).mockResolvedValue(GOOD_INTEL) // low=1000 high=2000 -> price 1500 at bps=5000
    ;(getEffectiveRiskPolicy as Mock).mockResolvedValue({ version: 1 })
    ;(evaluateRiskPolicy as Mock).mockReturnValue({ outcome: 'allow', reasons: [] })
    await runAutoListingBatch('admin', null)

    const attemptData = (tx.autoListingAttempt.create as Mock).mock.calls[0][0].data
    const createArgs = (createListingAtomic as Mock).mock.calls[0][1]
    expect(attemptData.proposedPriceCents).toBe(1500)
    expect(createArgs.price).toBe(15) // 1500 cents == $15.00, the SAME price
    expect(attemptData.pricingSnapshot).toEqual({ isAskOnly: false, confidenceLevel: 'high', recommendedLowCents: 1000, recommendedHighCents: 2000 })
    expect(attemptData.listingId).toBe('listing1')
  })

  it('when a Listing is NOT created (any non-listed outcome), no listingId is ever recorded on the attempt, and createListingAtomic is never called — a Listing can never exist without its corresponding attempt row (Part 14)', async () => {
    baseMocks()
    ;(searchReadyToListPage as Mock).mockResolvedValue({ items: [{ id: 'item1', sku: 'S1', brand: 'X', name: 'Y', status: 'available' }], nextCursor: null })
    ;(getItemReadyToListStatus as Mock).mockResolvedValue(READY_OUTCOME())
    const tx = mockTx(ITEM_ROW())
    ;(getPricingIntelligence as Mock).mockResolvedValue(GOOD_INTEL)
    ;(getEffectiveRiskPolicy as Mock).mockResolvedValue({ version: 1 })
    ;(evaluateRiskPolicy as Mock).mockReturnValue({ outcome: 'deny', reasons: ['x'], policyCode: 'y' })
    await runAutoListingBatch('admin', null)
    expect(createListingAtomic).not.toHaveBeenCalled()
    const attemptData = (tx.autoListingAttempt.create as Mock).mock.calls[0][0].data
    expect(attemptData.listingId).toBeNull()
    expect(attemptData.outcome).toBe('denied')
  })

  it('a serialization conflict (P2034 — concurrent pricing-evidence write) reports stale/serialization_conflict, never blindly retries into a listing (Part 1)', async () => {
    baseMocks()
    ;(searchReadyToListPage as Mock).mockResolvedValue({ items: [{ id: 'item1', sku: 'S1', brand: 'X', name: 'Y', status: 'available' }], nextCursor: null })
    ;(getItemReadyToListStatus as Mock).mockResolvedValue(READY_OUTCOME())
    const { Prisma } = await import('@prisma/client')
    const p2034 = new Prisma.PrismaClientKnownRequestError('write conflict', { code: 'P2034', clientVersion: '5.22.0' })
    ;(prisma.$transaction as Mock).mockImplementationOnce(async () => { throw p2034 })
    const result = await runAutoListingBatch('admin', null)
    expect(result.stale).toBe(1)
    expect(createListingAtomic).not.toHaveBeenCalled()
    expect(prisma.autoListingAttempt.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ outcome: 'stale', reasonCode: 'serialization_conflict' }) }))
  })
})

describe('runAutoListingBatch — batch/time-budget/resume (Part J)', () => {
  it('a fully-processed page resumes from 15J\'s own nextCursor', async () => {
    baseMocks()
    ;(searchReadyToListPage as Mock).mockResolvedValue({ items: [{ id: 'item1', sku: 'S1', brand: 'X', name: 'Y', status: 'available' }], nextCursor: 'resume-here' })
    ;(getItemReadyToListStatus as Mock).mockResolvedValue({ ...READY_OUTCOME(), status: 'blocked' })
    const result = await runAutoListingBatch('admin', null)
    expect(result.nextCursor).toBe('resume-here')
    expect(result.sourceExhausted).toBe(false)
  })

  it('true exhaustion (empty page, no cursor) reports sourceExhausted=true', async () => {
    baseMocks()
    ;(searchReadyToListPage as Mock).mockResolvedValue({ items: [], nextCursor: null })
    const result = await runAutoListingBatch('admin', null)
    expect(result.sourceExhausted).toBe(true)
    expect(result.nextCursor).toBeNull()
    expect(result.processed).toBe(0)
  })

  it('a run-level time-budget expiry stops mid-page and resumes from the last FULLY PROCESSED item, never claiming exhaustion', async () => {
    baseMocks()
    ;(searchReadyToListPage as Mock).mockResolvedValue({
      items: [
        { id: 'item1', sku: 'S1', brand: 'X', name: 'Y', status: 'available' },
        { id: 'item2', sku: 'S2', brand: 'X', name: 'Y', status: 'available' },
      ],
      nextCursor: null, // 15J itself says exhausted, but OUR run-level budget still cuts in first
    })
    ;(getItemReadyToListStatus as Mock).mockResolvedValue({ ...READY_OUTCOME(), status: 'blocked' })

    let callCount = 0
    const realNow = Date.now
    vi.spyOn(Date, 'now').mockImplementation(() => {
      callCount++
      // First call: the deadline computation. Second call (loop guard): still within
      // budget so item1 processes. Third call (loop guard for item2): budget expired.
      if (callCount <= 2) return realNow()
      return realNow() + 10 * 60 * 1000
    })

    const result = await runAutoListingBatch('admin', null)
    expect(result.processed).toBe(1)
    expect(result.nextCursor).toBe('item1') // resumable — NOT 15J's nextCursor (null), which would falsely claim exhaustion
    expect(result.sourceExhausted).toBe(false)
  })
})

describe('runAutoListingBatch — idempotency (Part S/41-42)', () => {
  it('a duplicate (runId, itemId) attempt insert on an early-exit path (P2002) is treated as already-recorded, not a new failure', async () => {
    baseMocks()
    const { Prisma } = await import('@prisma/client')
    const p2002 = new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: '5.22.0' })
    ;(prisma.autoListingAttempt.create as Mock).mockRejectedValueOnce(p2002)
    ;(searchReadyToListPage as Mock).mockResolvedValue({ items: [{ id: 'item1', sku: 'S1', brand: 'X', name: 'Y', status: 'available' }], nextCursor: null })
    ;(getItemReadyToListStatus as Mock).mockResolvedValue({ ...READY_OUTCOME(), status: 'blocked' })
    const result = await runAutoListingBatch('admin', null)
    // stale was the outcome computed; the duplicate insert doesn't change what
    // happened to the item, it just doesn't re-log it — the run still completes.
    expect(result.stale).toBe(1)
  })

  it('a duplicate (runId, itemId) attempt insert INSIDE the final execution transaction (P2002) is reported as already_listed, not failed', async () => {
    baseMocks()
    const { Prisma } = await import('@prisma/client')
    const p2002 = new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: '5.22.0' })
    ;(searchReadyToListPage as Mock).mockResolvedValue({ items: [{ id: 'item1', sku: 'S1', brand: 'X', name: 'Y', status: 'available' }], nextCursor: null })
    ;(getItemReadyToListStatus as Mock).mockResolvedValue(READY_OUTCOME())
    ;(getPricingIntelligence as Mock).mockResolvedValue(GOOD_INTEL)
    ;(getEffectiveRiskPolicy as Mock).mockResolvedValue({ version: 1 })
    ;(evaluateRiskPolicy as Mock).mockReturnValue({ outcome: 'allow', reasons: [] })
    ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => {
      // Simulate the attempt-insert step itself throwing P2002.
      return cb({
        $queryRaw: vi.fn().mockResolvedValue(undefined),
        itemInstance: { findUnique: vi.fn().mockResolvedValue(ITEM_ROW()) },
        autoListingAttempt: { create: vi.fn().mockRejectedValue(p2002) },
      })
    })
    ;(createListingAtomic as Mock).mockResolvedValueOnce({ ok: true, id: 'listing1', version: 1 })
    const result = await runAutoListingBatch('admin', null)
    expect(result.alreadyListed).toBe(1)
    expect(result.failed).toBe(0)
  })
})

describe('previewAutoListingCandidates — read-only (Part H/18)', () => {
  it('never creates a run and never writes anything', async () => {
    ;(searchReadyToListPage as Mock).mockResolvedValue({ items: [{ id: 'item1', sku: 'S1', brand: 'B', name: 'N', status: 'available', outcome: READY_OUTCOME() }], nextCursor: null })
    const result = await previewAutoListingCandidates(null)
    expect(result.items).toEqual([{ id: 'item1', sku: 'S1', brand: 'B', name: 'N' }])
    expect(prisma.autoListingRun.create).not.toHaveBeenCalled()
    expect(prisma.autoListingAttempt.create).not.toHaveBeenCalled()
  })
})
